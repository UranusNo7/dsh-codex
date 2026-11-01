/**
 * dsh-net-proxy — host half.
 *
 * Vendored, with minimal integration edits, from the MIT-licensed dsh-net-proxy
 * host module (see `licenses/` for the licence text). The changes are limited to:
 * routes under the dsh-codex prefix, Codex-only vs whole-host scope, a
 * dispatcher-independent loopback controller transport, and a package-root bin
 * location. Behaviour of the core itself is unchanged.
 *
 * A self-contained outbound proxy for DeepSeek Harness:
 *   - ships its own mihomo core (no Clash, no system proxy, no extra install)
 *   - imports whatever subscription link the user pastes in the UI
 *   - measures every node itself and uses the fastest
 *   - on failure, cools that node down, switches to the next, and retries
 *
 * Three decisions here are load-bearing, each learned the hard way against the
 * real core — please do not "simplify" them away:
 *
 * 1. THE SUBSCRIPTION IS NEVER RESHAPED. mihomo's YAML parser rejects duplicate
 *    mapping keys (stricter than the YAML spec), so prepending our own keys
 *    fails, and moving a block out of the document breaks its neighbours. We
 *    therefore rewrite only listener/controller *scalars*, in place, and let
 *    every block (`dns:`, `proxies:`, `proxy-groups:`, `rules:`) stay exactly
 *    where the provider put it. Provider quirks — unquoted full-width colons in
 *    node names, for instance — then keep parsing exactly as they did for the
 *    provider's own client.
 *
 * 2. WE RIDE THE SUBSCRIPTION'S OWN GROUP instead of inventing one. Building a
 *    custom selector would mean editing the group list (see 1). Every real
 *    subscription ships a selector covering all its nodes, so we discover that
 *    group through the API and switch within it. The chosen group is recorded
 *    at runtime, not baked into the file.
 *
 * 3. THE PROXY IS SWAPPED WITHOUT A RESTART. Routing goes through one undici
 *    dispatcher installed into Node's global-dispatcher slot, which is the
 *    documented cross-package mechanism (@deepseek-ai/dsh-http-proxy ships the
 *    same coupling). A node switch therefore changes where the next request
 *    goes, with no process restart.
 *
 * Routes (all under /plugins/dsh-openai-codex/network-proxy):
 *   GET  /status          full snapshot for the settings page
 *   POST /enabled         { enabled }        master switch
 *   POST /scope           { scope }          "codex" (default) or "global"
 *   POST /subscription    { url }            save the subscription link
 *   POST /refresh         { preferCache? }   (re-)import the subscription
 *   POST /test            { targets? }       measure every node now
 *   POST /select          { node }           pin a node, or "auto"
 *   POST /kernel          { action }         start | stop | restart the core
 *   GET  /log             recent activity lines
 *
 * Two integration decisions differ from the standalone plugin:
 *   - `scope` decides who is proxied. "codex" (the default) never touches the
 *     process-wide dispatcher or the proxy environment; the Codex transport
 *     reads `networkProxyCodexUrl()` per request instead. "global" installs the
 *     original process-wide dispatcher + child environment takeover.
 *   - Every loopback controller call goes through `coreRequest()` (node:http,
 *     explicit 127.0.0.1, `agent: false`), so no global dispatcher or proxy
 *     environment can ever swallow a request to the bundled core.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis plugin name. */
export const name = 'dsh-net-proxy';

/** Services required before routes can mount. */
export const inject = ['webServer'];

/** Public route prefix for the network-proxy settings API. */
export const NETWORK_PROXY_BASE_PATH = '/plugins/dsh-openai-codex/network-proxy';

const BASE = NETWORK_PROXY_BASE_PATH;

/**
 * Adopt the subscription configured in an already-installed client (Clash Mi)
 * so the first run needs no typing. Only ever used when the user has not set a
 * link in this plugin, so it can never overwrite a deliberate choice.
 *
 * @returns the adopted URL, or undefined when there is nothing to adopt.
 */
function seedSubscriptionFromLocalClient() {
  if (state.config.subscriptionUrl !== '' || state.config.subscriptionSeeded === true) return undefined;
  const appData = process.env.APPDATA;
  if (typeof appData !== 'string' || appData === '') return undefined;
  try {
    const file = join(appData, 'clashmi', 'clashmi', 'profiles.json');
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const profiles = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
    const chosen = profiles.find((p) => p.id === parsed.current_id && typeof p.url === 'string' && p.url !== '')
      ?? profiles.find((p) => typeof p.url === 'string' && p.url !== '');
    if (chosen === undefined) return undefined;
    state.config.subscriptionUrl = chosen.url;
    state.config.subscriptionSeeded = true;
    log(`已从本机客户端「${chosen.remark ?? '未命名'}」读取订阅链接，可在界面里替换`);
    return chosen.url;
  } catch {
    return undefined;
  }
}

/** Built-in proxy types, i.e. anything that is not a real upstream node. */
const BUILTIN_TYPES = new Set([
  'Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay',
  'Direct', 'Reject', 'RejectDrop', 'Compatible', 'Pass', 'Dns',
]);

/** Default ranking targets, GitHub first: reaching GitHub is the point. */
const DEFAULT_TARGETS = ['https://github.com', 'https://www.gstatic.com/generate_204'];

const DEFAULT_CONFIG = {
  enabled: false,
  /**
   * Who this proxy covers. "codex" (default) hands the mixed-port URL to the
   * Codex transport only and never touches process-global state. "global"
   * installs the original process-wide dispatcher + child environment takeover.
   */
  scope: 'codex',
  subscriptionUrl: '',
  mixedPort: 0,
  apiPort: 0,
  apiSecret: '',
  testTargets: DEFAULT_TARGETS,
  testTimeoutMs: 4000,
  testConcurrency: 6,
  failoverCooldownMs: 300000,
  maxFailover: 4,
  autoTestIntervalMs: 1800000,
  refreshIntervalMs: 86400000,
  bypass: ['localhost', '127.0.0.1', '::1', '[::1]'],
  proxyModelCalls: false,
  pinnedNode: 'auto',
  /** Set once the first-run steps have happened, so they never repeat. */
  autoEnabled: false,
  subscriptionSeeded: false,
};

// ── paths ────────────────────────────────────────────────────────────────────

const dshHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh');
const stateDir = () => join(dshHome(), '.dsh-net-proxy');
const configPath = () => join(stateDir(), 'config.json');
const runtimeConfigPath = () => join(stateDir(), 'runtime.yaml');
const subscriptionPath = () => join(stateDir(), 'subscription.yaml');
const kernelLogPath = () => join(stateDir(), 'kernel.log');

/** Directory holding THIS module; differs between `src/` tests and the bundled `lib/` chunk. */
const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * The dsh-codex package root, found by walking up to its `package.json`.
 *
 * A source test loads this file as `src/net-proxy/index.js` and the shipped
 * bundle loads it from a `lib/<chunk>.js`; both must agree on where the
 * bundled mihomo assets live, so the answer is anchored to `package.json`
 * instead of a fixed relative hop.
 */
function resolvePackageRoot(dir) {
  let current = dir;
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8'));
      if (parsed?.name === 'dsh-codex') return current;
    } catch { /* keep walking */ }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Unknown layout: fall back to the two-level layout these builds use.
  return dirname(dirname(dir));
}

const pluginRoot = () => resolvePackageRoot(moduleDir);
/** Bundled core + geodata live at `package-root/bin/net-proxy`. */
const binDir = () => join(pluginRoot(), 'bin', 'net-proxy');

// ── utilities ────────────────────────────────────────────────────────────────

const logLines = [];
function log(message) {
  logLines.push(`${new Date().toISOString().slice(11, 19)}  ${message}`);
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
}

function readConfigFile() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function persist() {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(configPath(), `${JSON.stringify(state.config, null, 2)}\n`, 'utf8');
  } catch (error) {
    log(`保存配置失败：${error?.message ?? error}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A free loopback port, obtained by binding to 0 and releasing. */
async function freePort() {
  const { createServer } = await import('node:net');
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ── live state ───────────────────────────────────────────────────────────────

const state = {
  config: { ...DEFAULT_CONFIG },
  kernel: { status: 'stopped', pid: undefined, error: undefined },
  nodes: [],
  /** The subscription's own selector we switch within, discovered from the core. */
  group: undefined,
  current: undefined,
  testing: false,
  lastTestAt: undefined,
  lastRefreshAt: undefined,
  /** 'enable' while the master switch is coming up, for the page's progress state. */
  busy: undefined,
  /**
   * Last failure of a background operation.
   *
   * Enabling answers immediately and finishes in the background, so a throw
   * there has no HTTP response to travel in. Without this the page would just
   * sit there looking like nothing happened.
   */
  lastError: undefined,
  /** Set to abandon an in-flight measurement sweep (see disableProxy). */
  testAbort: false,
  routing: { installed: false, via: 'none', error: undefined },
};

/**
 * Serialises start/stop.
 *
 * Enabling and disabling both drive the kernel and the node roster, and running
 * them concurrently produced a reproducible failure: a disable landing in the
 * middle of a start left the freshly spawned kernel to kill itself, and the
 * start reported "内核启动失败". Chaining the operations is what makes the
 * switch behave the way a switch is expected to.
 */
let lifecycleChain = Promise.resolve();
function serialize(operation) {
  const result = lifecycleChain.then(operation, operation);
  lifecycleChain = result.then(() => {}, () => {});
  return result;
}

// ── scope contract ───────────────────────────────────────────────────────────

/** Default proxy scope: cover Codex model traffic only, leave the host alone. */
export const NETWORK_PROXY_SCOPE_DEFAULT = 'codex';

function normalizeScope(value) {
  if (value === 'codex' || value === 'global') return value;
  throw new Error('scope 只能是 "codex" 或 "global"');
}

/** Current proxy scope; unknown persisted values fall back to the safe default. */
export function getNetworkProxyScope() {
  return state.config.scope === 'global' ? 'global' : 'codex';
}

/**
 * Change the proxy scope at runtime and re-apply routing when the proxy is on.
 *
 * "codex" never touches process-global state, so a live host that already has
 * dsh-http-proxy (or the user's own launcher) in charge keeps it. "global"
 * installs the original process-wide takeover, which the Codex transport then
 * inherits instead of stacking a second one.
 */
export async function setNetworkProxyScope(scope) {
  const next = normalizeScope(scope);
  const changed = getNetworkProxyScope() !== next;
  state.config.scope = next;
  persist();
  if (changed && state.config.enabled) await reconcileScopeRouting();
  return snapshot();
}

/**
 * The managed mixed-port URL for Codex traffic, or undefined when Codex traffic
 * must stay on the host's own routing.
 *
 * Read per request by the Codex proxy transport, so switching the proxy on/off
 * (or a kernel restart giving the core a new port) needs no wiring elsewhere.
 */
export function networkProxyCodexUrl() {
  if (getNetworkProxyScope() !== 'codex') return undefined;
  if (!state.config.enabled || !state.routing.installed) return undefined;
  if (state.kernel.status !== 'running' || !(state.config.mixedPort > 0)) return undefined;
  return proxyUrl();
}

/** True when this plugin owns the process-wide dispatcher right now. */
export function networkProxyOwnsGlobal() {
  return state.routing.installed && state.routing.via === 'global dispatcher + child env';
}

// ── core API ─────────────────────────────────────────────────────────────────

/**
 * Bumped whenever the kernel is stopped or (re)started.
 *
 * Every core call captures it and aborts quietly if it changed while the call
 * was in flight. Without this, switching the proxy off while a measurement is
 * running kills the kernel underneath that request, the failed `fetch` becomes
 * an unhandled rejection, and Node tears the whole host process down — which is
 * exactly how the disable path used to take the app with it.
 */
let kernelGeneration = 0;
const generationNow = () => kernelGeneration;

/**
 * One loopback HTTP request to the bundled core.
 *
 * Deliberately implemented on `node:http` instead of `fetch`: the host process
 * may carry a global undici dispatcher (this plugin's own "global" scope, or
 * dsh-http-proxy), and the environment may carry HTTP(S)_PROXY. The controller
 * lives on 127.0.0.1, so neither must ever apply to it — a proxy that cannot
 * reach loopback turns "measure the nodes" into "every node is dead", which is
 * exactly the regression this helper exists to prevent.
 *
 * `agent: false` keeps the call off any pooled agent, so it shares no state with
 * the dispatcher the plugin installs for real outbound traffic.
 */
function coreRequest({ port, path, method = 'GET', body, secret, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { authorization: `Bearer ${secret ?? ''}` };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers,
      agent: false,
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          finish(reject, new Error(`core API ${method} ${path} -> ${status} ${text.slice(0, 160)}`));
          return;
        }
        if (text === '') return finish(resolve, undefined);
        try {
          finish(resolve, JSON.parse(text));
        } catch {
          finish(reject, new Error(`core API ${method} ${path} -> invalid JSON`));
        }
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error(`core API timeout ${method} ${path}`));
    });
    request.on('error', (error) => finish(reject, error));
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

async function api(path, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  const generation = generationNow();
  try {
    return await coreRequest({
      port: state.config.apiPort,
      path,
      method,
      body,
      secret: state.config.apiSecret,
      timeoutMs,
    });
  } catch (error) {
    // The kernel went away mid-call: that is a superseded operation, not a
    // fault, and callers should treat it as "stop what you are doing".
    if (generation !== generationNow()) {
      const superseded = new Error('内核已重启，此操作已作废');
      superseded.code = 'SUPERSEDED';
      throw superseded;
    }
    throw error;
  }
}

/** True when an error is a superseded core call rather than a real failure. */
const isSuperseded = (error) => error?.code === 'SUPERSEDED';

// ── kernel lifecycle ─────────────────────────────────────────────────────────

function findKernel() {
  const dir = binDir();
  if (!existsSync(dir)) return undefined;
  const found = readdirSync(dir).find((file) => /^mihomo.*\.exe$/i.test(file));
  return found === undefined ? undefined : join(dir, found);
}

/**
 * The geodata databases the subscription's rules need.
 *
 * The core looks for these in its WORKING directory (`-d`), not beside the
 * executable, and it refuses to finish starting without them — the rules
 * reference `GEOIP,CN`/`GEOSITE`, so it either deadlocks downloading them or
 * dies parsing the rule. They therefore ship inside the plugin (`bin/`) and are
 * placed into the working directory before every start. Copying rather than
 * pointing at them keeps the working directory self-describing, and keeps a
 * user's manually updated database from being overwritten only when absent.
 */
const GEODATA_FILES = ['geoip.metadb', 'geosite.dat'];

function ensureGeodata() {
  const source = binDir();
  const target = stateDir();
  const copied = [];
  for (const file of GEODATA_FILES) {
    const from = join(source, file);
    const to = join(target, file);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      copyFileSync(from, to);
      copied.push(file);
    } catch (error) {
      log(`规则库放置失败（${file}）：${error?.message ?? error}`);
    }
  }
  if (copied.length > 0) log(`规则库已就位：${copied.join(', ')}`);
  return copied;
}

let child;
let kernelOutput = [];

async function startKernel() {
  if (state.kernel.status === 'running') return state.kernel;

  const kernel = findKernel();
  if (kernel === undefined) {
    state.kernel = { status: 'missing', error: `bin/ 里没有 mihomo 内核：${binDir()}` };
    log(state.kernel.error);
    return state.kernel;
  }
  if (!existsSync(subscriptionPath())) {
    state.kernel = { status: 'unconfigured', error: '还没有订阅，请先导入' };
    return state.kernel;
  }

  mkdirSync(stateDir(), { recursive: true });
  ensureGeodata();

  // The runtime config is rebuilt from the saved subscription on EVERY start,
  // using the ports held in memory. Writing it once and reusing it left the
  // file and the state able to disagree — a stale port in the file means the
  // plugin polls an address nothing is listening on, and reports a core that
  // actually started as a failure.
  await acquirePorts();
  const configChanged = !existsSync(runtimeConfigPath())
    || !readFileSync(runtimeConfigPath(), 'utf8').includes(`external-controller: 127.0.0.1:${state.config.apiPort}`);
  if (configChanged) {
    writeFileSync(runtimeConfigPath(), buildRuntimeConfig(readFileSync(subscriptionPath(), 'utf8')), 'utf8');
  }

  kernelOutput = [];
  const spawned = spawn(kernel, ['-d', stateDir(), '-f', runtimeConfigPath()], {
    cwd: stateDir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const generation = kernelGeneration;
  const output = [];
  child = spawned;
  spawned.stdout.on('data', (chunk) => { output.push(String(chunk)); kernelOutput.push(String(chunk)); });
  spawned.stderr.on('data', (chunk) => { output.push(String(chunk)); kernelOutput.push(String(chunk)); });
  spawned.on('exit', (code) => {
    // Only ever speak for the process this handler was created for. Stopping a
    // kernel can take seconds (signal, then a forced kill), and in that window a
    // replacement may already be running — without this guard the old process's
    // exit would tear down the new one's state and "kill" the switch.
    if (child !== spawned) return;
    const tail = output.join('').trim().slice(-400);
    if (state.kernel.status !== 'stopped') log(`内核退出，code=${code}${tail === '' ? '' : ` — ${tail.slice(-200)}`}`);
    state.kernel = { status: 'stopped', error: `内核退出 (${code})${tail === '' ? '' : `: ${tail.slice(-300)}`}` };
    try { writeFileSync(kernelLogPath(), output.join(''), 'utf8'); } catch { /* ignore */ }
    child = undefined;
    kernelGeneration = Math.max(kernelGeneration, generation + 1);
  });

  state.kernel = { status: 'starting', pid: spawned.pid };

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(250);
    if (child === undefined) break; // it died; the exit handler recorded why
    try {
      await api('/version', { timeoutMs: 1500 });
      state.kernel = { status: 'running', pid: child.pid };
      log(`内核已启动 pid=${child.pid}`);
      return state.kernel;
    } catch { /* keep waiting */ }
  }

  const tail = kernelOutput.join('').slice(-800);
  try { writeFileSync(kernelLogPath(), kernelOutput.join(''), 'utf8'); } catch { /* ignore */ }
  state.kernel = { status: 'failed', error: tail.trim() === '' ? '内核未在 20 秒内就绪' : tail.trim() };
  log(`内核启动失败：${state.kernel.error.slice(0, 300)}`);
  await stopKernel();
  return state.kernel;
}

/**
 * Stop the kernel and WAIT for the process to actually be gone.
 *
 * `child.kill()` only delivers the signal. Starting the replacement while the
 * old process still holds its listening ports and the working directory is a
 * race, and it showed up as a second start hanging during geodata load with no
 * error at all. Waiting is the cheap, deterministic fix.
 */
async function stopKernel() {
  // Invalidate in-flight core calls FIRST, so anything mid-flight treats the
  // shutdown below as "superseded" instead of surfacing a connection reset.
  kernelGeneration += 1;
  const dying = child;
  child = undefined;
  if (dying !== undefined) {
    const exited = new Promise((resolve) => {
      if (dying.exitCode !== null || dying.signalCode !== null) return resolve();
      dying.once('exit', resolve);
      setTimeout(resolve, 5000);
    });
    try { dying.kill(); } catch { /* already gone */ }
    await exited;
    if (dying.exitCode === null && dying.signalCode === null) {
      try { dying.kill('SIGKILL'); } catch { /* give up */ }
      log('内核未响应终止信号，已强制结束');
    }
  }
  if (state.kernel.status === 'running' || state.kernel.status === 'starting') {
    state.kernel = { status: 'stopped' };
  }
  // Ports are released here but the values are left alone: startKernel()
  // re-acquires a fresh pair before it spawns, and persisting zeros in the
  // meantime is what previously let memory and the config file disagree.
  state.config.mixedPort = 0;
  state.config.apiPort = 0;
}

// ── subscription → runtime config ────────────────────────────────────────────

/**
 * Rewrite top-level scalar keys in place, appending any that the document did
 * not declare. Blocks are never touched: only lines whose key we own and whose
 * value is a scalar on the same line.
 */
function rewriteScalars(text, values) {
  const lines = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (match !== null && Object.hasOwn(values, match[1])) {
      lines.push(`${match[1]}: ${values[match[1]]}`);
      seen.add(match[1]);
      continue;
    }
    lines.push(line);
  }
  const missing = Object.entries(values).filter(([key]) => !seen.has(key));
  if (missing.length > 0) {
    // A key we own that the document omits: safe to add at the very top,
    // because it is by definition not declared anywhere else.
    lines.unshift(...missing.map(([key, value]) => `${key}: ${value}`));
  }
  return lines.join('\n');
}

function buildRuntimeConfig(subscriptionText) {
  return rewriteScalars(subscriptionText, {
    'mixed-port': state.config.mixedPort,
    'port': 0,
    'socks-port': 0,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    'external-controller': `127.0.0.1:${state.config.apiPort}`,
    'secret': state.config.apiSecret,
  });
}

async function acquirePorts() {
  const patch = {};
  if (!(state.config.mixedPort > 0)) patch.mixedPort = await freePort();
  if (!(state.config.apiPort > 0)) patch.apiPort = await freePort();
  if (typeof state.config.apiSecret !== 'string' || state.config.apiSecret === '') {
    patch.apiSecret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  Object.assign(state.config, patch);
  if (Object.keys(patch).length > 0) persist();
}

// ── downloading through our own core ─────────────────────────────────────────

/**
 * A core config that needs no subscription, no nodes and no geodata: one
 * rule sending everything DIRECT. It exists purely to act as an HTTP proxy for
 * one download.
 */
function buildDirectConfig(mixedPort, apiPort, secret) {
  return [
    `mixed-port: ${mixedPort}`,
    `port: 0`,
    `socks-port: 0`,
    `allow-lan: false`,
    `bind-address: 127.0.0.1`,
    `mode: rule`,
    `log-level: warning`,
    `ipv6: false`,
    `external-controller: 127.0.0.1:${apiPort}`,
    `secret: ${secret}`,
    `geodata-mode: false`,
    `geox-url: {geoip: "file:///dev/null", geosite: "file:///dev/null", mmdb: "file:///dev/null"}`,
    `proxies: []`,
    `proxy-groups: []`,
    `rules:`,
    `  - MATCH,DIRECT`,
  ].join('\n');
}

/**
 * One GET through an HTTP proxy, following redirects. Returns the response
 * stream. Written against `node:http(s)` rather than `fetch` so it does not go
 * through — or get affected by — the global dispatcher the plugin manipulates.
 */
function proxiedGet(url, proxyPort, timeoutMs, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('重定向次数过多'));
    const target = new URL(url);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return reject(new Error(`不支持的协议：${target.protocol}`));
    }
    const secure = target.protocol === 'https:';
    const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port);

    const connect = httpRequest({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}` },
      timeout: timeoutMs,
    });
    connect.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`代理 CONNECT 返回 ${response.statusCode}`));
      }
      const send = secure ? httpsRequest : httpRequest;
      const request = send({
        host: target.hostname,
        port,
        path: target.pathname + target.search,
        method: 'GET',
        socket,
        agent: false,
        headers: { host: target.hostname, 'user-agent': 'ClashMeta/1.19.31; mihomo/1.19.31' },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location !== undefined) {
          res.resume();
          socket.destroy();
          resolve(proxiedGet(new URL(res.headers.location, url).toString(), proxyPort, timeoutMs, redirects + 1));
          return;
        }
        resolve(res);
      });
      request.on('error', (error) => reject(new Error(`${error.code ?? 'ERR'} ${error.message}`)));
      request.end();
    });
    connect.on('timeout', () => { connect.destroy(); reject(new Error('连接订阅服务器超时')); });
    connect.on('error', (error) => reject(new Error(`${error.code ?? 'ERR'} ${error.message}`)));
    connect.end();
  });
}

/**
 * Download the subscription using the bundled core as the transport.
 *
 * `fetch` inside the DSH host is subject to whatever proxy environment the host
 * carries, and on a censored network it may simply have no route out. The core
 * is a separate process with its own network stack, so it is a genuine second
 * chance — and on the machines this plugin exists for, the subscription provider
 * is usually the one host that IS reachable directly.
 *
 * Deliberately self-contained: it starts its own core on its own ports, on its
 * own config file, and removes both afterwards, so it can run at a moment when
 * the main core is not up yet — which is exactly when a first run needs it.
 */
async function downloadViaCore(url, timeoutMs = 45000) {
  const dir = join(stateDir(), 'direct-download');
  mkdirSync(dir, { recursive: true });

  const mixedPort = await freePort();
  const apiPort = await freePort();
  const secret = randomBytes(12).toString('hex');
  const configFile = join(dir, 'direct.yaml');
  writeFileSync(configFile, buildDirectConfig(mixedPort, apiPort, secret), 'utf8');

  const kernel = findKernel();
  if (kernel === undefined) throw new Error('内核缺失，无法用它下载订阅');

  const helper = spawn(kernel, ['-d', dir, '-f', configFile], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const helperLog = [];
  helper.stdout.on('data', (chunk) => helperLog.push(String(chunk)));
  helper.stderr.on('data', (chunk) => helperLog.push(String(chunk)));

  /**
   * Kill the helper and WAIT for it to be gone before touching its directory.
   *
   * `kill()` only delivers a signal: returning immediately left a live core
   * holding geoip.metadb, so the workdir removal failed and the process stayed
   * resident. Mirroring stopKernel()'s discipline here keeps a one-off download
   * from leaking a proxy process.
   */
  const stop = async () => {
    if (helper.exitCode === null && helper.signalCode === null) {
      const exited = new Promise((resolve) => {
        helper.once('exit', resolve);
        setTimeout(resolve, 5000);
      });
      try { helper.kill(); } catch { /* already gone */ }
      await exited;
      if (helper.exitCode === null && helper.signalCode === null) {
        try { helper.kill('SIGKILL'); } catch { /* give up */ }
        await sleep(400);
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(300); }
    }
  };

  try {
    // Wait for the helper's API to answer, then for its proxy port to accept.
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      await sleep(200);
      if (helper.exitCode !== null) break;
      try {
        await coreRequest({ port: apiPort, path: '/version', secret, timeoutMs: 1500 });
        ready = true;
        break;
      } catch { /* keep waiting */ }
    }
    if (!ready) {
      throw new Error(`辅助内核未就绪：${helperLog.join('').trim().slice(-200) || '无输出'}`);
    }

    const response = await proxiedGet(url, mixedPort, timeoutMs);
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(`HTTP ${response.statusCode}`);
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response) {
      chunks.push(chunk);
      total += chunk.length;
      if (total > 8 * 1024 * 1024) throw new Error('订阅超过 8 MB，已停止');
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.length < 64) throw new Error(`订阅内容过短（${text.length} 字节）`);
    return text;
  } finally {
    await stop();
  }
}

/** Import a subscription: re-download when a URL is set, else reuse the copy on disk. */
async function refreshSubscription({ preferCache = false } = {}) {
  const url = state.config.subscriptionUrl;

  if (url === '' || preferCache) {
    if (existsSync(subscriptionPath())) {
      log('使用本地已保存的订阅');
      await applySubscription(readFileSync(subscriptionPath(), 'utf8'));
      return { nodes: state.nodes.length, source: 'cache' };
    }
    if (url === '') throw new Error('尚未填写订阅链接');
  }

  log('正在下载订阅…');
  let text;
  let how = 'direct';
  let directError;
  {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'ClashMeta/1.19.31; mihomo/1.19.31' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
    } catch (error) {
      directError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  // Second chance: let the bundled core do the download. It is a different
  // process with a different network stack, and it is frequently the only thing
  // on a censored network that can reach the provider at all.
  if (text === undefined) {
    log(`直接下载失败（${directError?.message ?? directError}），改用内置内核下载…`);
    try {
      text = await downloadViaCore(url);
      how = 'core';
    } catch (coreError) {
      // A failed refresh must not cost the user the node list they already have.
      if (existsSync(subscriptionPath())) {
        log(`内核下载也失败（${coreError?.message ?? coreError}），改用本地已保存的订阅`);
        await applySubscription(readFileSync(subscriptionPath(), 'utf8'));
        return { nodes: state.nodes.length, source: 'cache-after-failure' };
      }
      throw new Error(`订阅下载失败。直连：${directError?.message ?? directError}；经内核：${coreError?.message ?? coreError}`);
    }
  }

  if (!/^\s*(proxies|proxy-groups|rules|mixed-port|port)\s*:/m.test(text)) {
    throw new Error('订阅内容不是 Clash 配置（若是 base64 订阅链接，请在服务商处改为 Clash 格式）');
  }

  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(subscriptionPath(), text, 'utf8');
  state.lastRefreshAt = Date.now();
  log(`订阅已下载（${text.length} 字节，${how === 'core' ? '经内置内核' : '直连'}）`);
  await applySubscription(text);
  return { nodes: state.nodes.length, source: 'network' };
}

async function applySubscription(text) {
  if (state.kernel.status === 'running' || state.kernel.status === 'starting') await stopKernel();
  await acquirePorts();
  writeFileSync(runtimeConfigPath(), buildRuntimeConfig(text), 'utf8');
  await startKernel();
  if (state.kernel.status !== 'running') {
    throw new Error(`内核未运行 — ${state.kernel.error ?? state.kernel.status}`);
  }

  await readNodesFromCore();
  log(`已从内核读到 ${state.nodes.length} 个节点，使用订阅自带的组「${state.group ?? '无'}」`);
}

/** Read the node roster and pick the subscription's own selector to steer. */
async function readNodesFromCore() {
  const all = await api('/proxies');
  const proxies = all?.proxies ?? {};

  const nodes = [];
  const selectors = [];
  for (const [nodeName, info] of Object.entries(proxies)) {
    if (BUILTIN_TYPES.has(info.type)) {
      if (info.type === 'Selector') selectors.push({ name: nodeName, members: info.all ?? [], now: info.now });
      continue;
    }
    nodes.push({ name: nodeName, type: info.type, delay: undefined, status: 'idle', failCount: 0, cooldownUntil: 0 });
  }

  // Prefer the selector that covers the most real nodes; skip the global one
  // when a subscription-provided group ties with it, since the provider's group
  // carries their own rules.
  selectors.sort((a, b) => {
    const coversA = a.members.filter((m) => nodes.some((n) => n.name === m)).length;
    const coversB = b.members.filter((m) => nodes.some((n) => n.name === m)).length;
    if (coversA !== coversB) return coversB - coversA;
    return a.name === 'GLOBAL' ? 1 : -1;
  });

  state.nodes = nodes;
  state.group = selectors[0]?.name;
  state.current = selectors[0]?.now;
  return nodes;
}

// ── measuring ────────────────────────────────────────────────────────────────

async function measureNode(nodeName, target, timeoutMs) {
  const query = new URLSearchParams({ url: target, timeout: String(timeoutMs) });
  const result = await api(`/proxies/${encodeURIComponent(nodeName)}/delay?${query}`, { timeoutMs: timeoutMs + 5000 });
  const delay = Number(result?.delay ?? 0);
  if (!Number.isFinite(delay) || delay <= 0) throw new Error('未返回延迟');
  return delay;
}

/** Measure every node concurrently and rank the survivors. */
async function testAllNodes({ targets } = {}) {
  if (state.kernel.status !== 'running') {
    await startKernel();
    if (state.kernel.status !== 'running') throw new Error(`内核未运行 — ${state.kernel.error ?? state.kernel.status}`);
  }
  if (state.nodes.length === 0) await readNodesFromCore();

  const requested = (targets ?? state.config.testTargets).filter((t) => typeof t === 'string' && t !== '');
  const effective = requested.length > 0 ? requested : DEFAULT_TARGETS;
  const { testConcurrency, testTimeoutMs } = state.config;

  state.testing = true;
  log(`开始测速：${state.nodes.length} 个节点 × ${effective.length} 个目标`);
  const queue = [...state.nodes];

  async function worker() {
    for (;;) {
      if (state.testAbort === true) return;
      const node = queue.shift();
      if (node === undefined) return;
      let best;
      let lastError;
      for (const target of effective) {
        try {
          const delay = await measureNode(node.name, target, testTimeoutMs);
          if (best === undefined || delay < best.delay) best = { delay, target };
        } catch (error) {
          // The kernel was stopped or replaced under us: abandon the sweep
          // rather than marking every remaining node dead.
          if (isSuperseded(error)) return;
          lastError = error;
        }
      }
      if (best !== undefined) {
        node.delay = best.delay;
        node.target = best.target;
        node.status = 'ok';
        node.failCount = 0;
        node.cooldownUntil = 0;
        node.error = undefined;
      } else {
        node.delay = undefined;
        node.status = 'dead';
        node.failCount = (node.failCount ?? 0) + 1;
        node.error = String(lastError?.message ?? 'timeout').slice(0, 120);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, testConcurrency) }, worker));
  } finally {
    state.testing = false;
    state.lastTestAt = Date.now();
  }

  state.nodes.sort((a, b) => {
    const aliveDiff = (a.status === 'ok' ? 0 : 1) - (b.status === 'ok' ? 0 : 1);
    if (aliveDiff !== 0) return aliveDiff;
    return (a.delay ?? Infinity) - (b.delay ?? Infinity);
  });

  const alive = state.nodes.filter((n) => n.status === 'ok');

  // A sweep that was abandoned must not then go and retarget the core: that is
  // what killed the kernel the user had just switched off.
  if (state.testAbort === true) {
    state.testAbort = false;
    log('测速已被取消');
    return { alive: alive.length, total: state.nodes.length, aborted: true };
  }

  log(`测速完成：${alive.length}/${state.nodes.length} 可用${alive.length > 0 ? `，最快「${alive[0].name}」${alive[0].delay}ms` : ''}`);

  if (state.config.pinnedNode === undefined || state.config.pinnedNode === 'auto') await selectBest();
  return { alive: alive.length, total: state.nodes.length };
}

/** Resolve when no measurement sweep is running (or the wait runs out). */
async function waitForIdleTest(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (state.testing && Date.now() < deadline) await sleep(200);
  return state.testing !== true;
}

async function switchTo(nodeName, reason) {
  if (state.group === undefined) throw new Error('没有可用的选择组');
  await api(`/proxies/${encodeURIComponent(state.group)}`, { method: 'PUT', body: { name: nodeName } });
  state.current = nodeName;
  const node = state.nodes.find((n) => n.name === nodeName);
  log(`切换到「${nodeName}」${node?.delay === undefined ? '' : ` (${node.delay}ms)`} — ${reason}`);
  return nodeName;
}

/**
 * Health-check one node the honest way: does a tunnel to the ranking target
 * actually open through it?
 *
 * The core's own `/delay` probe only reports that the node answers *somewhere*.
 * What matters for failover is whether a real connection to the destination
 * succeeds, so this drives the core's mixed port with a CONNECT and hangs up as
 * soon as the tunnel is established.
 */
async function probeThroughNode(nodeName, target, timeoutMs) {
  const { request } = await import('node:http');
  const previous = state.current;
  try {
    // The core routes by its group's selection, so aim it at the node first.
    await api(`/proxies/${encodeURIComponent(state.group)}`, { method: 'PUT', body: { name: nodeName } });
    const tls = new URL(target);
    const port = tls.port === '' ? (tls.protocol === 'https:' ? 443 : 80) : Number(tls.port);
    return await new Promise((resolve) => {
      const connect = request({
        host: '127.0.0.1',
        port: state.config.mixedPort,
        method: 'CONNECT',
        path: `${tls.hostname}:${port}`,
        timeout: timeoutMs,
      });
      const finish = (ok, detail) => {
        try { connect.destroy(); } catch { /* already gone */ }
        resolve({ ok, detail });
      };
      connect.on('connect', (response, socket) => {
        const status = response.statusCode ?? 0;
        socket.destroy();
        finish(status === 200, `CONNECT ${status}`);
      });
      connect.on('timeout', () => finish(false, 'timeout'));
      connect.on('error', (error) => finish(false, error.code ?? error.message));
      connect.end();
    });
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  } finally {
    // A failed probe must not leave the group pointing at the bad node.
    if (previous !== undefined && previous !== nodeName) {
      try { await api(`/proxies/${encodeURIComponent(state.group)}`, { method: 'PUT', body: { name: previous } }); } catch { /* ignore */ }
    }
  }
}

/** Point the group at the fastest healthy node. */
async function selectBest() {
  const pinned = state.config.pinnedNode;
  if (pinned !== undefined && pinned !== 'auto') return await switchTo(pinned, '手动指定');

  const now = Date.now();
  const best = state.nodes.find((n) => n.status === 'ok' && (n.cooldownUntil ?? 0) <= now);
  if (best === undefined) {
    log('没有可用节点（全部不可用或处于冷却）');
    return undefined;
  }
  return await switchTo(best.name, '自动选最快');
}

/** Retire a failing node and move to the next candidate. */
async function failover(fromNode, error) {
  const node = state.nodes.find((n) => n.name === fromNode);
  if (node !== undefined) {
    node.failCount = (node.failCount ?? 0) + 1;
    node.cooldownUntil = Date.now() + state.config.failoverCooldownMs;
    node.status = 'cooldown';
    node.error = String(error ?? '').slice(0, 120);
  }
  log(`节点「${fromNode ?? '未知'}」失败，冷却 ${Math.round(state.config.failoverCooldownMs / 1000)}s`);
  return await selectBest();
}

/**
 * Walk candidate nodes until one really reaches the target.
 *
 * Each candidate is retired as it fails, so `maxFailover` bounds the walk and a
 * fully broken subscription cannot spin here. Returns the node that worked.
 */
async function failoverWalk(target, failureDetail) {
  if (state.group === undefined) throw new Error('没有可用的选择组');
  const attempted = [];
  for (let step = 0; step < state.config.maxFailover; step += 1) {
    const failed = state.current;
    if (failed !== undefined) await failover(failed, failureDetail);
    const candidate = state.current;
    if (candidate === undefined || candidate === failed || attempted.includes(candidate)) break;
    attempted.push(candidate);
    const probe = await probeThroughNode(candidate, target, state.config.testTimeoutMs);
    if (probe.ok) {
      const node = state.nodes.find((n) => n.name === candidate);
      if (node !== undefined) { node.status = 'ok'; node.failCount = 0; node.error = undefined; }
      return candidate;
    }
    failureDetail = probe.detail;
  }
  return undefined;
}

// ── outbound routing ─────────────────────────────────────────────────────────

const SLOT = Symbol.for('undici.globalDispatcher.1');
let originalDispatcher;
let ownedAgent;
let undiciModule;

/**
 * undici 8 kept the v1 global-dispatcher symbol only as a compatibility mirror
 * and reads the v2 one, so writing `globalThis[SLOT]` alone would install a
 * dispatcher that `fetch` never consults. Use the module's own accessors when
 * they exist (they keep both symbols in sync) and fall back to the documented
 * symbol for older builds.
 */
function currentGlobalDispatcher() {
  if (typeof undiciModule?.getGlobalDispatcher === 'function') return undiciModule.getGlobalDispatcher();
  return globalThis[SLOT];
}

function installGlobalDispatcher(dispatcher) {
  if (typeof undiciModule?.setGlobalDispatcher === 'function') {
    undiciModule.setGlobalDispatcher(dispatcher);
    return;
  }
  globalThis[SLOT] = dispatcher;
}

function restoreGlobalDispatcher(dispatcher) {
  if (typeof undiciModule?.setGlobalDispatcher === 'function') {
    if (dispatcher !== undefined) undiciModule.setGlobalDispatcher(dispatcher);
    return;
  }
  globalThis[SLOT] = dispatcher;
}

/**
 * Every plausible place `undici` can be resolved from, best first.
 *
 * The harness's own copy is preferred and the app-bundle copy is the reliable
 * fallback, but the install root is NOT hard-coded to one machine: DSH exposes
 * its own directories through the environment, and the executable path is the
 * last resort. A plugin that resolved a *second* undici would hand Node a
 * dispatcher built from foreign symbols, which is the cross-version coupling the
 * DSH docs explicitly warn about — so this list matters more than it looks.
 */
function undiciAnchors() {
  const anchors = [
    join(pluginRoot(), 'package.json'),
    join(dshHome(), 'profiles', process.env.DSH_PROFILE ?? 'desktop', 'package.json'),
  ];
  // Whatever root the desktop app advertises, if any.
  for (const key of ['DSH_APP_ROOT', 'DSH_DESKTOP_ROOT', 'DSH_INSTALL_ROOT']) {
    const root = process.env[key];
    if (typeof root === 'string' && root !== '') {
      anchors.push(join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    }
  }
  // Derived from the running executable: <install>/resources/app.asar/...
  const exe = process.execPath;
  if (typeof exe === 'string' && exe !== '') {
    const install = dirname(dirname(exe));
    for (const inner of ['dsh/node_modules/@deepseek-ai/dsh', 'dsh/node_modules/@deepseek-ai/dsh-desktop-host']) {
      anchors.push(join(install, 'resources', 'app.asar', inner, 'package.json'));
    }
  }
  return anchors;
}

async function loadUndici() {
  if (undiciModule !== undefined) return undiciModule;
  for (const anchor of undiciAnchors()) {
    try {
      undiciModule = createRequire(anchor)('undici');
      return undiciModule;
    } catch { /* next anchor */ }
  }
  throw new Error('无法解析 undici，代理无法挂载');
}

const proxyUrl = () => `http://127.0.0.1:${state.config.mixedPort}`;

/**
 * Whether one outbound host goes through the bundled core.
 *
 * `*.deepseek.com` is only bypassed for a Codex-only proxy: once the user picks
 * "whole DSH" the model traffic must be covered too, otherwise the setting does
 * not mean what the UI says. In "codex" scope this policy is never installed.
 */
function shouldProxyHost(host) {
  if (state.config.bypass.some((entry) => entry !== '' && (host === entry || host.endsWith(`.${entry}`)))) return false;
  if (state.config.scope !== 'global' && !state.config.proxyModelCalls && /(^|\.)deepseek\.com$/i.test(host)) return false;
  return true;
}

function buildAgent() {
  const { Agent, ProxyAgent } = undiciModule;
  const tunnels = new Map();
  const proxyFor = (origin) => {
    const host = new URL(origin).hostname;
    if (!shouldProxyHost(host)) return undefined;
    return proxyUrl();
  };
  return new Agent({
    factory: (origin) => {
      const proxy = proxyFor(origin.toString());
      if (proxy === undefined) return new Agent();
      let tunnel = tunnels.get(proxy);
      if (tunnel === undefined) {
        tunnel = new ProxyAgent({ uri: proxy });
        tunnels.set(proxy, tunnel);
      }
      return tunnel;
    },
  });
}

/** Proxy environment entries this plugin writes in "global" scope. */
const PROXY_ENVIRONMENT_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
  'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY',
];

/** Remember the host's own values so uninstall restores them instead of deleting them. */
let originalEnvironment;

function snapshotProxyEnvironment() {
  return Object.fromEntries(PROXY_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
}

function restoreProxyEnvironment(saved) {
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    try {
      const value = saved?.[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    } catch { /* non-configurable env entry */ }
  }
}

async function installRouting() {
  try {
    await loadUndici();
    originalDispatcher ??= currentGlobalDispatcher();
    originalEnvironment ??= snapshotProxyEnvironment();
    ownedAgent = buildAgent();
    installGlobalDispatcher(ownedAgent);

    // Children (git, npm, curl) read the environment, never the dispatcher.
    const bypass = state.config.bypass.join(',');
    for (const [key, value] of Object.entries({
      HTTP_PROXY: proxyUrl(), HTTPS_PROXY: proxyUrl(),
      http_proxy: proxyUrl(), https_proxy: proxyUrl(),
      NO_PROXY: bypass, no_proxy: bypass,
      NODE_USE_ENV_PROXY: '1',
    })) process.env[key] = value;

    state.routing = { installed: true, via: 'global dispatcher + child env', error: undefined };
    log(`代理已挂载 → ${proxyUrl()}`);
    return true;
  } catch (error) {
    state.routing = { installed: false, via: 'none', error: String(error?.message ?? error) };
    log(`代理挂载失败：${state.routing.error}`);
    return false;
  }
}

/**
 * Put the process back on a direct connection.
 *
 * Every step is individually guarded, and the dispatcher slot is never
 * `delete`d: undici installs that property as non-configurable, so `delete`
 * throws a TypeError that would abort the whole request — which is exactly how
 * switching the proxy off used to fail. Restoring `undefined` puts Node back on
 * its own default dispatcher, which is the same effect without the throw.
 */
function uninstallRouting() {
  try {
    restoreGlobalDispatcher(originalDispatcher);
  } catch (error) {
    log(`恢复默认 dispatcher 失败：${error?.message ?? error}`);
  }
  ownedAgent = undefined;
  originalDispatcher = undefined;
  restoreProxyEnvironment(originalEnvironment);
  originalEnvironment = undefined;
  state.routing = { installed: false, via: 'none', error: undefined };
  log('代理已卸载，恢复直连');
}

/**
 * Mount the proxy for the selected scope.
 *
 * "global" keeps the original process-wide takeover. "codex" (the default)
 * only records that the mixed-port URL is available to the Codex transport; it
 * must not touch the global dispatcher or the environment, because those belong
 * to the host (dsh-http-proxy / the user's launcher).
 */
async function installScopeRouting() {
  if (state.config.scope === 'global') return await installRouting();
  ownedAgent = undefined;
  state.routing = { installed: true, via: 'codex-transport', error: undefined };
  log(`代理已交给 Codex 传输层 → ${proxyUrl()}`);
  return true;
}

/** Undo exactly the takeover that was installed, never a host-owned one. */
function uninstallScopeRouting() {
  const wasInstalled = state.routing.installed;
  if (state.routing.via === 'global dispatcher + child env') {
    uninstallRouting();
    return;
  }
  ownedAgent = undefined;
  state.routing = { installed: false, via: 'none', error: undefined };
  if (wasInstalled) log('Codex 传输层代理已卸载');
}

/** Re-apply routing after the scope or the mixed port changed. */
async function reconcileScopeRouting() {
  if (!state.config.enabled) return true;
  uninstallScopeRouting();
  const installed = await installScopeRouting();
  if (!installed) throw new Error(state.routing.error ?? '代理挂载失败');
  return true;
}

// ── orchestration ────────────────────────────────────────────────────────────

/**
 * Bring the proxy up, doing everything the user should not have to do by hand.
 *
 * One click must be enough, so this starts the kernel itself. It deliberately
 * does NOT re-download the subscription: that belongs to "更新订阅", and doing
 * it here made every start wait on the provider (and made a fresh start look
 * broken while it waited). The cached subscription is used instead, and the
 * background job refreshes it on its own schedule.
 */
async function enableProxy(isDisposed) {
  // The disposer can run while an enable is still in flight; starting a kernel
  // behind a plugin that is being torn down would leak a process.
  if (isDisposed !== undefined && isDisposed() === true) return false;
  await acquirePorts();

  if (state.nodes.length === 0) {
    // Bootstrap the node list from wherever it can be had: the saved copy
    // first, and the subscription URL when there is no copy yet (a fresh
    // install, or a user who only just pasted a link). Failing here without
    // trying the URL is what made the first click appear to do nothing.
    if (existsSync(subscriptionPath())) {
      await applySubscription(readFileSync(subscriptionPath(), 'utf8'));
    } else if (state.config.subscriptionUrl !== '') {
      await refreshSubscription();
    } else {
      throw new Error('还没有订阅：请在「订阅链接」里填入链接并点「更新订阅」');
    }
  }
  if (state.nodes.length === 0) throw new Error('订阅里没有解析出任何节点，请点「更新订阅」');

  // Ask the core whether it is actually serving, rather than trusting the status
  // field. That field can read "running" after the process died, and "stopped"
  // while nodes are still loaded from an earlier session — and installing
  // routing on top of a dead core is exactly how the agent ends up pointing at a
  // closed port and reporting the whole network as broken.
  let serving = false;
  try {
    await runtime.api('/version', { timeoutMs: 2000 });
    serving = true;
  } catch { /* not serving */ }

  if (!serving) {
    if (state.kernel.status === 'running') log('内核无响应，重新启动');
    state.kernel = { status: 'stopped' };
    await runtime.startKernel();
    if (state.kernel.status !== 'running') {
      throw new Error(`内核启动失败 — ${state.kernel.error ?? state.kernel.status}`);
    }
  }

  if (!await runtime.installScopeRouting()) throw new Error(state.routing.error ?? '代理挂载失败');
  state.config.enabled = true;
  persist();

  // Ranking always re-runs in the background after a successful enable. The
  // persisted roster carries delays from an earlier session, and trusting them
  // is exactly how an already-running proxy ended up reporting every node as
  // dead. The switch still answers as soon as traffic can flow.
  if (!state.testing) {
    void runtime.testAllNodes().catch((error) => {
      if (!isSuperseded(error)) log(`测速失败：${error?.message ?? error}`);
    });
  } else {
    await runtime.selectBest();
  }
  return true;
}

/**
 * Bring the proxy down. Must never throw: a failure here would leave a switch
 * that cannot be turned off, so the enabled flag is cleared no matter what.
 */
async function disableProxy() {
  try {
    if (state.routing.installed) uninstallScopeRouting();
  } catch (error) {
    log(`卸载路由出错（已忽略）：${error?.message ?? error}`);
  }
  // Abandon any sweep in progress and let it unwind before the kernel goes
  // away. Waiting is not politeness: a sweep that outlives the kernel will try
  // to retarget a core that is already gone.
  if (state.testing) {
    state.testAbort = true;
    const settled = await waitForIdleTest();
    if (!settled) log('测速未在超时内结束，仍然停止内核');
  }
  state.testAbort = false;
  try {
    await stopKernel();
  } catch (error) {
    log(`停止内核出错（已忽略）：${error?.message ?? error}`);
  }
  state.config.enabled = false;
  state.config.autoEnabled = true;
  state.lastError = undefined;
  try { persist(); } catch { /* config stays in memory */ }
  return true;
}

function snapshot() {
  return {
    enabled: state.config.enabled,
    scope: getNetworkProxyScope(),
    kernel: { ...state.kernel, path: findKernel(), log: kernelOutput.join('').slice(-1500) },
    routing: state.routing,
    group: state.group,
    current: state.current,
    testing: state.testing,
    busy: state.busy,
    lastError: state.lastError,
    lastTestAt: state.lastTestAt,
    proxyUrl: state.config.mixedPort > 0 ? proxyUrl() : undefined,
    mixedPort: state.config.mixedPort,
    testTargets: state.config.testTargets,
    pinnedNode: state.config.pinnedNode ?? 'auto',
    nodes: state.nodes.map((n) => ({
      name: n.name,
      type: n.type,
      delay: n.delay,
      status: n.status,
      error: n.error,
      cooldownMs: Math.max(0, (n.cooldownUntil ?? 0) - Date.now()),
      failCount: n.failCount ?? 0,
    })),
  };
}

// ── AI tool surface ──────────────────────────────────────────────────────────

/** True when the bundled proxy can actually serve the loopback URL right now. */
const networkProxyReady = () =>
  state.config.enabled && state.kernel.status === 'running' && state.config.mixedPort > 0;

/**
 * Read-only status for the AI tool.
 *
 * Deliberately trimmed: no subscription URL, no kernel log or install path, no
 * raw node errors, and no state.lastError. The tool can say whether a node is
 * usable without echoing provider data or log text.
 */
export function networkProxyToolStatus() {
  const ready = networkProxyReady();
  return {
    enabled: state.config.enabled,
    scope: getNetworkProxyScope(),
    ready,
    proxyUrl: ready ? proxyUrl() : undefined,
    mixedPort: state.config.mixedPort > 0 ? state.config.mixedPort : undefined,
    kernelStatus: state.kernel.status,
    routing: { installed: state.routing.installed, via: state.routing.via },
    fixedNode: state.config.pinnedNode ?? 'auto',
    fixedNodeAvailable: state.config.pinnedNode === undefined
      || state.config.pinnedNode === 'auto'
      || state.nodes.some((n) => n.name === state.config.pinnedNode),
    current: state.current,
    group: state.group,
    alive: state.nodes.filter((n) => n.status === 'ok').length,
    total: state.nodes.length,
    testing: state.testing,
    lastTestAt: state.lastTestAt,
    busy: state.busy,
    nodes: state.nodes.map((n) => ({ name: n.name, status: n.status, delay: n.delay })),
  };
}

/** Why enabling failed, translated into one fixed actionable sentence. */
function networkProxyEnableHint() {
  switch (state.kernel.status) {
    case 'unconfigured':
      return '尚未配置订阅。请让用户在 设置 → 网络代理 填写订阅链接并点击“更新订阅”后重试。';
    case 'missing':
      return '随包 mihomo 内核缺失。请重新安装完整的 dsh-codex 发布包后重试。';
    case 'failed':
      return '内核启动失败。请让用户在 设置 → 网络代理 检查内核状态（订阅与节点是否正确）后重试。';
    case 'starting':
      return '内核仍在启动。请稍后重试 status。';
    default:
      return '代理未就绪。请让用户在 设置 → 网络代理 检查订阅与内核状态后重试。';
  }
}

/** Tool wording for "whole-DSH scope exists but the proxy is not running". */
const NETWORK_PROXY_GLOBAL_IDLE_MESSAGE =
  '当前代理范围是“整个 DSH”且代理未启用。AI 工具不会擅自启用全局代理；请让用户在 设置 → 网络代理 中启用，或切换为“仅 Codex”后重试。';

/**
 * Enable the bundled proxy for Codex traffic and wait for real readiness.
 *
 * Never enables a "global" scope the user has not already turned on. When the
 * proxy is already running, both scopes are reused as-is; the tool never changes
 * scope, dispatcher ownership, or proxy environment.
 */
export async function enableNetworkProxyForTool() {
  if (networkProxyReady()) return { started: false, status: networkProxyToolStatus() };
  if (getNetworkProxyScope() === 'global') throw new Error(NETWORK_PROXY_GLOBAL_IDLE_MESSAGE);
  try {
    await serialize(async () => {
      if (networkProxyReady()) return;
      await enableProxy();
    });
  } catch {
    throw new Error(`本机代理未能启用：${networkProxyEnableHint()}`);
  }
  const status = networkProxyToolStatus();
  if (!status.ready) throw new Error(`本机代理未能启用：${networkProxyEnableHint()}`);
  return { started: true, status };
}

/** Busy message shared by the AI tool and the settings measurement route. */
const NETWORK_PROXY_TEST_BUSY_MESSAGE = '已有测速在进行中，请稍后重试；未启动第二次测速。';

/**
 * Synchronous gate for "a measurement request owns the queue".
 *
 * Acquired BEFORE queueing on the lifecycle chain, so a second request fails
 * immediately with the busy message instead of waiting for the first sweep to
 * finish and then starting another one. Released in `finally`.
 */
let testRequestPending = false;
function beginTestRequest() {
  if (testRequestPending || state.testing) throw new Error(NETWORK_PROXY_TEST_BUSY_MESSAGE);
  testRequestPending = true;
}
function endTestRequest() {
  testRequestPending = false;
}

/**
 * Run one measurement sweep through the shared lifecycle chain.
 *
 * Used by both the AI tool path and the settings `POST /test` route. The
 * synchronous gate rejects the second request up front; the in-body check still
 * covers a sweep that enable started in the background on its own.
 */
async function runGuardedTest(body) {
  beginTestRequest();
  try {
    return await serialize(async () => {
      if (state.testing) throw new Error(NETWORK_PROXY_TEST_BUSY_MESSAGE);
      return await body();
    });
  } finally {
    endTestRequest();
  }
}

/** Exclusively measure configured targets (used by the settings route). */
async function runExclusiveTest({ targets } = {}) {
  return await runGuardedTest(() => runtime.testAllNodes({ targets }));
}

/**
 * Measure nodes and let the existing selector pick the fastest one.
 *
 * Measurement targets always come from the saved proxy configuration; the tool
 * cannot introduce new network targets. Readiness, the busy gate, the optional
 * pin change, and the sweep share one transaction.
 */
export async function testNetworkProxyForTool({ autoSelect = false } = {}) {
  if (!networkProxyReady()) await enableNetworkProxyForTool();
  const measured = await runGuardedTest(async () => {
    if (!networkProxyReady()) throw new Error(`本机代理未就绪：${networkProxyEnableHint()}`);
    if (autoSelect === true) {
      state.config.pinnedNode = 'auto';
      persist();
    }
    try {
      return await runtime.testAllNodes();
    } catch {
      throw new Error('测速失败：请稍后重试；若持续失败，请让用户检查订阅与内核状态。');
    }
  });
  const status = networkProxyToolStatus();
  return {
    measured: {
      alive: measured?.alive ?? status.alive,
      total: measured?.total ?? status.total,
      aborted: measured?.aborted === true,
    },
    selected: state.current,
    autoSelected: status.fixedNode === 'auto',
    status,
  };
}

/**
 * Pin one existing node, or return to automatic selection.
 *
 * `"auto"` is the only way to clear a pin; ordinary selections never silently
 * remove the user's fixed node. The pin change and the switch share one
 * serialized transaction, so a failed switch restores the previous pin instead
 * of leaving a new one persisted. Requires an already-running proxy (reusing the
 * global scope when the user enabled it), and never changes the scope.
 */
export async function selectNetworkProxyNodeForTool(node) {
  if (typeof node !== 'string' || node.trim() === '') throw new Error('node 必须是非空节点名或 "auto"');
  if (!networkProxyReady()) {
    if (getNetworkProxyScope() === 'global') throw new Error(NETWORK_PROXY_GLOBAL_IDLE_MESSAGE);
    throw new Error('本机代理尚未启用：请先调用 action="test"（会按需启用并测速）或 action="enable"。');
  }
  const name = node.trim();
  return await serialize(async () => {
    if (!networkProxyReady()) throw new Error('本机代理未就绪：请先调用 action="status" 或 action="test"。');
    if (name === 'auto') {
      state.config.pinnedNode = 'auto';
      persist();
      await runtime.selectBest();
    } else {
      if (!state.nodes.some((n) => n.name === name)) {
        throw new Error(`未知节点「${name.slice(0, 80)}」：请先调用 action="test" 获取当前节点列表。`);
      }
      const previous = state.config.pinnedNode;
      state.config.pinnedNode = name;
      persist();
      try {
        await runtime.switchTo(name, 'AI 指定');
      } catch {
        state.config.pinnedNode = previous;
        persist();
        throw new Error('切换节点失败，已保留原固定节点设置；请先调用 action="test" 刷新节点后重试。');
      }
    }
    const status = networkProxyToolStatus();
    return { selected: state.current, fixedNode: status.fixedNode, status };
  });
}

// ── plugin body ──────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  state.config = { ...readConfigFile(), ...config };
  log('插件已加载');

  /**
   * Disposal flag for THIS load.
   *
   * Deliberately a local, not a field on the shared state: the state object
   * outlives one `apply()` (it is module-level), so a disposed load would
   * otherwise leave a flag behind that blocks every later enable.
   */
  let disposed = false;
  const isDisposed = () => disposed;

  // Adopt the subscription an installed client already has, so the first run
  // needs no typing. This only records a URL — it starts nothing.
  seedSubscriptionFromLocalClient();

  persist();

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '');
  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text === '' ? {} : JSON.parse(text);
  };

  ctx.effect(() => ctx.webServer.register({
    method: 'GET',
    path: `${BASE}/status`,
    handler: (req, res) => (isLocal(req) ? json(res, 200, snapshot()) : json(res, 403, { error: 'loopback only' })),
  }));

  ctx.effect(() => ctx.webServer.register({
    method: 'GET',
    path: `${BASE}/log`,
    handler: (req, res) => (isLocal(req) ? json(res, 200, { lines: logLines.slice(-200) }) : json(res, 403, { error: 'loopback only' })),
  }));

  const post = (path, handler) => ctx.effect(() => ctx.webServer.register({
    method: 'POST',
    path: `${BASE}${path}`,
    handler: async (req, res) => {
      if (!isLocal(req)) return json(res, 403, { error: 'loopback only' });
      try {
        json(res, 200, (await handler(await readBody(req))) ?? { ok: true });
      } catch (error) {
        log(`接口 ${path} 出错：${error?.message ?? error}`);
        json(res, 500, { error: String(error?.message ?? error) });
      }
    },
  }));

  /**
   * The master switch.
   *
   * Starting is done in the background and answered immediately: the kernel
   * needs a few seconds to come up, and holding the HTTP response open for that
   * made the button look stuck. The page polls `/status` anyway, so it shows the
   * real progress. Stopping is synchronous and cannot fail.
   */
  /**
   * The master switch.
   *
   * Starting is done in the background and answered immediately: the kernel
   * needs a few seconds to come up, and holding the HTTP response open for that
   * made the button look stuck. The page polls `/status` anyway, so it shows the
   * real progress. Stopping is synchronous and cannot fail.
   */
  post('/enabled', async ({ enabled }) => {
    if (enabled) {
      state.lastError = undefined;
      // Gate on the routing that is actually installed, not on the saved flag:
      // a flag that says "on" while nothing is mounted must not stop us from
      // bringing it up (and a flag that says "off" must not stop us either).
      if (!state.routing.installed) {
        state.busy = 'enable';
        void serialize(() => enableProxy(isDisposed))
          .catch((error) => {
            if (isSuperseded(error)) return;
            state.lastError = String(error?.message ?? error);
            log(`启用失败：${state.lastError}`);
          })
          .finally(() => { state.busy = undefined; });
      }
    } else {
      state.busy = 'disable';
      try {
        await serialize(() => disableProxy());
        state.lastError = undefined;
      } catch (error) {
        // disableProxy is already fail-safe; this is belt and braces so the
        // switch can never become impossible to turn off.
        state.lastError = String(error?.message ?? error);
        state.config.enabled = false;
        log(`停用出错（已强制关闭）：${state.lastError}`);
      } finally {
        state.busy = undefined;
      }
    }
    return snapshot();
  });

  post('/subscription', async ({ url }) => {
    state.config.subscriptionUrl = String(url ?? '').trim();
    persist();
    // Never echo the saved link: the UI stores it, it does not display it.
    return { ok: true };
  });

  post('/scope', async ({ scope } = {}) => {
    if (scope === undefined) return snapshot();
    await setNetworkProxyScope(scope);
    return snapshot();
  });

  post('/refresh', async ({ preferCache } = {}) => {
    const result = await runtime.refreshSubscription({ preferCache: preferCache === true });
    await reconcileScopeRouting();
    return { ...result, status: snapshot() };
  });

  post('/test', async ({ targets } = {}) => ({ ...await runExclusiveTest({ targets }), status: snapshot() }));

  post('/select', async ({ node }) => {
    if (node === undefined || node === 'auto') {
      state.config.pinnedNode = 'auto';
      persist();
      await runtime.selectBest();
    } else {
      state.config.pinnedNode = node;
      persist();
      await switchTo(node, '手动指定');
    }
    return snapshot();
  });

  post('/kernel', async ({ action } = {}) => {
    if (action === 'stop') await runtime.stopKernel();
    else if (action === 'restart') { await runtime.stopKernel(); await runtime.startKernel(); }
    else await runtime.startKernel();
    return snapshot();
  });

  /**
   * Walk the failover chain for real and report where it landed.
   *
   * `force` retires the current node first, which is how a user (or a test) can
   * exercise the self-healing path on demand instead of waiting for a genuine
   * outage.
   */
  post('/failover-test', async ({ target, force } = {}) => {
    if (state.kernel.status !== 'running') throw new Error('内核未运行');
    const chosen = target ?? state.config.testTargets[0] ?? DEFAULT_TARGETS[0];
    const before = state.current;
    if (force === true && before !== undefined) {
      log('手动触发故障切换测试');
      await failover(before, '手动触发测试');
    }
    const landed = await failoverWalk(chosen, '故障切换测试');
    return {
      target: chosen,
      from: before,
      landed,
      ok: landed !== undefined,
      status: snapshot(),
    };
  });

  // Housekeeping: expire cooldowns, re-measure on a schedule, re-import daily.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          if (state.config.enabled && !state.testing) {
            const now = Date.now();
            let expired = false;
            for (const node of state.nodes) {
              if (node.status === 'cooldown' && (node.cooldownUntil ?? 0) <= now) {
                node.status = 'idle';
                expired = true;
              }
            }
            const stale = state.lastTestAt === undefined || now - state.lastTestAt > state.config.autoTestIntervalMs;
            if (stale || expired) await testAllNodes();
          }
          if (state.config.subscriptionUrl !== '' && state.config.refreshIntervalMs > 0) {
            const last = state.lastRefreshAt ?? 0;
            if (state.lastRefreshAt === undefined) state.lastRefreshAt = Date.now();
            else if (Date.now() - last > state.config.refreshIntervalMs) {
              state.lastRefreshAt = Date.now();
              log('订阅定时更新');
              await refreshSubscription().catch((error) => log(`订阅更新失败：${error?.message ?? error}`));
            }
          }
        } catch (error) {
          log(`后台任务出错：${error?.message ?? error}`);
        }
      })();
    }, 60000);
    return () => clearInterval(timer);
  });

  // Leave the machine on a direct connection when the plugin goes away.
  ctx.effect(() => () => {
    disposed = true;
    try { if (state.routing.installed) uninstallScopeRouting(); } catch { /* shutting down */ }
    void stopKernel().catch(() => {});
  });

  /*
   * NOTHING starts here, ever. This is the whole point of the file's shape.
   *
   * Loading the plugin must be free: no kernel process, no subscription
   * download, no dispatcher. Someone who does not need a proxy on a given day
   * should never pay for one, and doing this work at boot put seconds onto every
   * app start. The kernel comes up when the user turns the proxy on — and a
   * previous session's "on" is NOT a reason to start now, because the user's
   * complaint was precisely that opening the app began work they had not asked
   * for. The saved flag only decides what the switch shows.
   */
  if (state.config.enabled) {
    log('上次会话里代理是开启的；本次等待你点「启用代理」后再启动内核');
    state.config.enabled = false;
    state.config.autoEnabled = true;
    persist();
  } else {
    log('就绪（未启动内核）。点「启用代理」即可开始。');
  }
}

/**
 * Core-facing operations used by the orchestration paths.
 *
 * Grouped in one object so a test can swap the kernel/ranking/routing pieces
 * without spawning a real mihomo process; production always uses these exact
 * implementations.
 */
const runtime = {
  api,
  startKernel,
  stopKernel,
  testAllNodes,
  selectBest,
  switchTo,
  installScopeRouting,
  uninstallScopeRouting,
  refreshSubscription,
};

const paths = {
  stateDir,
  configPath,
  runtimeConfigPath,
  subscriptionPath,
  kernelLogPath,
  binDir,
  pluginRoot,
};

export {
  state as _state,
  snapshot as _snapshot,
  api as _api,
  coreRequest as _coreRequest,
  runtime as _runtime,
  paths as _paths,
  testAllNodes as _testAllNodes,
  selectBest as _selectBest,
  failover as _failover,
  failoverWalk as _failoverWalk,
  refreshSubscription as _refreshSubscription,
  downloadViaCore as _downloadViaCore,
  enableProxy as _enableProxy,
  disableProxy as _disableProxy,
  installRouting as _installRouting,
  uninstallRouting as _uninstallRouting,
  installScopeRouting as _installScopeRouting,
  uninstallScopeRouting as _uninstallScopeRouting,
  reconcileScopeRouting as _reconcileScopeRouting,
  shouldProxyHost as _shouldProxyHost,
  findKernel as _findKernel,
  resolvePackageRoot as _resolvePackageRoot,
  normalizeScope as _normalizeScope,
};
