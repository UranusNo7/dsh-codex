# dsh Codex

English | [中文](README.zh.md)

**[Migration guide: repair Sessions created by dsh-codex versions before 0.3.0](docs/session-repair.md)**

Use a ChatGPT subscription in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through OpenAI's Codex sign-in flow—no OpenAI Platform API key required and no dsh source patch required.

`dsh-codex` is an independent dsh bundle. It adds:

- ChatGPT OAuth from the dsh Settings panel or a standalone CLI, with automatic token refresh
- a dynamic Codex GPT catalog refreshed from the official Codex endpoint with a 300-second TTL and a manual **Refresh from OpenAI** action, falling back to the Codex app cache and then bundled models (including GPT-6.1 Terra, 500K default context)
- a live client-side context-window capacity override for dsh's token meter and compaction policy
- streaming, tool calls, reasoning replay, prompt caching, and dsh compaction through the normal LLM service
- Codex standalone web search through dsh's existing `web_search` tool
- optional HTTP(S) URL input added to Harness's existing `read_image` tool
- an `imagegen` tool with a selectable GPT Image backend, workspace or conversation reference images, and automatic workspace output
- browser image input through dsh's existing paste and drop controls
- a per-conversation Fast Mode switch and compact weekly quota indicator in the Web composer
- optional backend-authorized model recovery, including hidden Luna Reserve routing
- legacy three-scope HTTP(S) proxy settings kept available through the existing API, CLI, and TUI configuration; saved values are preserved, not cleared automatically
- built-in outbound-proxy node management with a bundled mihomo core: subscription import, latency test, automatic or pinned node selection, Codex-only by default or whole dsh, Windows x64
- a `local_network_proxy` AI tool for status, enable, test, and node selection against the bundled proxy, so local shell commands can use its loopback URL

ChatGPT subscription authentication and usage-based OpenAI API access are different products. This plugin uses the ChatGPT Codex backend only; it does not turn a subscription into a general-purpose OpenAI API credential.

## Standalone bundle

Version `0.3.3-standalone.3` is the self-contained fork build, intended to be the only Codex plugin in a base dsh profile. It is distributed as the `v0.3.3-standalone.3` GitHub prerelease asset; it is not published to npm.

- **Codex-only redundancy cleanup.** A GPT model that habitually sends `sandbox_permissions` and `justification` on ordinary writes no longer fails those calls. The bundle strips those two arguments only when the current sandbox mode is known and the requested mode is not strictly wider than it (`requested <= current`), and only when the routed provider is exactly `openai-codex`, the tool is one of `bash`, `pwsh`, `write`, or `edit`, and that tool's schema declares dsh's native escalation contract. A request that genuinely widens the sandbox keeps both arguments and still enters dsh's own approval flow. On the Codex path this replaces the separate `dsh-gpt-compat` plugin; it does not change or replace compatibility handling for any other API provider.
- **No header spoofing.** The bundle does not globally rewrite `User-Agent` or `Originator`, and it does not uniformly impersonate `codex_cli_rs`; each provider and protocol path keeps the request headers it requires. The separate `dsh-custom-header` plugin is neither required nor bundled.
- **Requirements.** Development baseline is the dsh `0.2.0-rc.1` plugin surfaces in this checkout; the target is the `0.2.1-rc.2` desktop runtime, whose packaged tarball passed an isolated consumer smoke test against exact `0.2.1-rc.2` core packages and Cordis `4.0.5`. Other dsh versions are not promised, and installing into `0.2.1-rc.2` reports expected peer-range warnings. It needs the normal tools, sandbox-policy, LLM, web, settings, filesystem, and attachment services, plus a ChatGPT plan eligible for Codex. Installing performs no login by itself, keeps credentials in its own store, and never reads or copies `~/.codex/auth.json`.
- **Not included.** ChatGPT-web-only capabilities: it does not automate the web UI, read ChatGPT conversations or memories, or turn the subscription into a general-purpose OpenAI API credential.

The cleanup and its plugin lifecycle are exercised by [the standalone acceptance test](tests/standalone.spec.ts).

## Install

Install the prebuilt GitHub release tarball into the selected dsh profile:

```sh
dsh plugin --profile web add "https://github.com/UranusNo7/dsh-codex/releases/download/v0.3.3-standalone.3/dsh-codex-0.3.3-standalone.3.tgz"
dsh web
```

The standalone tarball is distributed as the `v0.3.3-standalone.3` GitHub prerelease asset and is not published to npm. Download that release asset, not the GitHub-generated source archive. The npm registry package `dsh-codex` remains the upstream release and does not contain the standalone changes; `dsh plugin --profile web add dsh-codex` installs that upstream bundle instead. For the desktop app, use the same asset with `--profile desktop`.

From a DeepSeek Harness source checkout, use `pnpm dsh plugin --profile web add "https://github.com/UranusNo7/dsh-codex/releases/download/v0.3.3-standalone.3/dsh-codex-0.3.3-standalone.3.tgz"`. A plugin checkout can still be installed with `link:/absolute/path/to/dsh-codex` for development.

Open **Settings → OpenAI Codex** and choose **Browser sign-in** or **Device code**. Browser sign-in shows an authorization link; click it to open the system browser, which returns to the dsh host's localhost callback when both run on the same machine. Device code works when the browser is on another machine. The account page shows live Codex quota bars and exact remaining percentages; exact credit balances or workspace limits appear only when the account API supplies them.

Loopback Web pages are trusted automatically. If dsh runs on another machine, the account page shows the exact origin command that must be approved on the dsh host, for example `dsh plugin --profile web exec dsh-codex trust-origin http://host:port`. The allowlist is exact-origin, stored separately from OAuth credentials, and can be inspected or revoked with `trusted-origins` and `untrust-origin`.

The CLI remains available for terminal and headless installations:

```sh
dsh plugin --profile web exec dsh-codex login
dsh plugin --profile web exec dsh-codex login --device-code
dsh plugin --profile web exec dsh-codex status
dsh plugin --profile web exec dsh-codex doctor --json
dsh plugin --profile web exec dsh-codex logout
```

For `dsh-tui`, install the same tarball into that profile:

```sh
dsh plugin --profile dsh-tui add "https://github.com/UranusNo7/dsh-codex/releases/download/v0.3.3-standalone.3/dsh-codex-0.3.3-standalone.3.tgz"
```

After restarting the TUI, `/model` lists the `openai-codex` catalog. With no explicit route or saved selection, the TUI adopts the bundle's `gpt-5.6-sol` default. Use `/codex status|login|logout|usage|config` for the account and live settings; `/codex set backend-fallback on|off` controls automatic model recovery, while the remaining switches are listed by `/codex set`. `/codex login` shows a browser URL, and `/codex login device` shows a device code for remote terminals. The TUI's `/settings` also exposes Codex's scalar controls through the same dsh settings namespace. Model visibility and the proxy URL remain editable in Web Settings. Both front doors share credentials and live preferences.

Codex, Claude Code, and other automation agents should follow [INSTALL.md](INSTALL.md). It is a complete, idempotent runbook and does not require reading this repository's source or design notes.

The bundle selects `openai-codex` / `gpt-5.6-sol` for new agents and selects the Codex search provider. A model already saved in dsh settings still takes precedence; the model picker can select any other Codex model visible to the signed-in account. GPT-6.1 Terra is an optional bundled model; it does not change the `gpt-5.6-sol` default.

Automatic model fallback is off by default. When enabled under **Settings → OpenAI Codex**, the plugin follows only a recovery instruction returned by OpenAI for the current account. Ordinary recovery uses the backend's ordered replacement list; a `luna_reserve` instruction resolves the official hidden `gpt-reserve` route with Luna's context, reasoning, and image capabilities. The decision happens before dsh prepares the retry, so the actual model, context budget, image admission, and Session request header agree. A vision route never falls back to a text-only replacement, keeping attachments, `read_image`, and `imagegen` available. If no compatible fallback exists—or the usage refresh fails—the original quota failure continues through Harness's normal retry path. `imagegen` remains independent and uses the image backend selected in Settings.

## Model catalog

The picker reads the account's official Codex catalog from the internal ChatGPT endpoint `https://chatgpt.com/backend-api/codex/models?client_version=0.165.0`. The version is the official client version this parser was verified against; it does not mean the plugin implements every capability of that release, and it is not the public `/v1/models` API. The origin is fixed, redirects are refused, and the response can never retarget it.

Opening **Settings → OpenAI Codex** first restores the persisted snapshot for the signed-in account, then applies a 300-second TTL: a fresh snapshot answers without a request, while an expired or missing one triggers one bounded refresh (20-second timeout) before the answer. **Refresh from OpenAI** forces a refresh and skips the TTL; the plugin also refreshes in the background at startup and after a completed sign-in. Ordinary chat turns never wait on this network work.

Only successfully fetched official entries with `visibility: list` are authoritative. When no usable official snapshot exists for the signed-in account, the plugin falls back to the existing Codex `models_cache.json` metadata (`DSH_CODEX_MODELS_CACHE`, then `CODEX_HOME/models_cache.json`, then `~/.codex/models_cache.json`), and finally to bundled models including GPT-6 Astra, Sol, Luna, and Terra. A failed refresh keeps the last successful same-account official snapshot and prefers it over the fallback sources, so fallback metadata applies only when that snapshot is missing. A Codex cache file can add transport templates but never overrides official metadata; the plugin does not launch a Codex subprocess or read Codex credentials.

The plugin keeps its own catalog cache at `<credential file>.models-cache.json` beside the plugin credential document, written with POSIX mode 0600. It stores only the fields this plugin converts (slug, display name, visibility, default context window, input modalities, reasoning levels) plus a SHA-256 account hash and the fetch time. Access tokens, the ChatGPT account id, response headers, tool policy, and other response metadata are never written. A cache written by another account is ignored, and switching or signing out drops the previous account's catalog. Restoring the snapshot uses the locally stored identity and never refreshes the token, so an expired session that is offline still sees its last successful catalog; an actual refresh resolves the credential through the provider-native OAuth lifecycle instead.

A failed refresh keeps the last successful same-account snapshot and exposes only a fixed, sanitized reason. Non-forced reads wait 60 seconds after a failure before retrying; the manual refresh button retries immediately. The settings page keeps the current list on failure and adds a localized explanation; provider text, status codes, and response bodies are never shown.

Saved model selections are preserved; a refresh replaces the candidate list, keeps already saved model IDs, and leaves newly discovered models unchecked. Models that disappear from the official list and the Codex cache keep their transport metadata only for the current process so resumed sessions can still resolve them; across a restart, resolution still depends on the bundled catalog, the current Codex cache, or the official catalog, so permanent resolution of arbitrary historical models is not promised. Discovered models without bundled pricing use a zero cost estimate, which does not mean the model is free. The `ultra` reasoning level remains unsupported because the current pi-ai `ThinkingLevel` type boundary does not include it. Catalog metadata does not guarantee that the signed-in account may use a model.

The initial checkbox selection is seeded from the catalog available when the provider is initialized (bundled models plus any existing Codex cache). An official list loaded later updates the candidates but does not automatically check newly discovered models, so they stay unchecked until you enable them. Open **Settings → OpenAI Codex** and use the model checkboxes to choose which entries remain visible. The selection is live and durable; dsh refreshes the Web and TUI model directories after it changes.

This dynamic catalog exists in the current source checkout. The published `v0.3.3-standalone.3` release asset does not include it, and the version number and release status are unchanged; using the refresh control requires rebuilding the host from this source and restarting it.

The same initial subset can be seeded through `models` on the `llm-openai-codex` entry while preserving provider order:

```yaml
- id: llm-openai-codex
  config:
    models:
      - gpt-6-luna
      - gpt-6-sol
```

The checkboxes and `models` setting control discovery only. A hidden model already stored in an existing session or supplied explicitly remains resolvable, so narrowing the picker does not invalidate older records. Omit `models` to start with the full catalog; an empty list advertises no models.

## Context window

Open **Settings → OpenAI Codex → Context window** to override the client-side capacity in K tokens. For example, enter `512` for 512,000 tokens. Leave the field empty to restore each model's pi-ai catalog default. The saved value applies to every Codex model on its next request and is shown by `/codex config`; an open conversation's meter refreshes after that request.

The initial value can also be seeded in exact tokens:

```yaml
- id: llm-openai-codex
  config:
    contextWindow: 512000
```

This mirrors Codex CLI's `model_context_window` concept on the Harness side; no context-window field is sent to the Responses endpoint. The resolved capacity drives dsh's context meter, overflow classification, output-token clamping, and automatic-compaction threshold. A smaller value compacts earlier. A larger value does not increase the backend model's real capacity, so unsupported values can still end in a provider overflow error.

## Network proxy

The Web UI network-proxy entry now only exposes the bundled proxy (see [Bundled proxy nodes](#bundled-proxy-nodes)): subscription import, node latency tests, enable/disable, and the Codex-only or whole-dsh scope.

The earlier three-scope HTTP(S) proxy settings remain supported through the existing plugin API, CLI, and TUI configuration for compatibility. They are not removed by this build, and existing saved values are preserved rather than cleared or migrated automatically:

- **Follow dsh** leaves networking untouched. Codex inherits any process-wide proxy configured when dsh started.
- **Codex only** applies the selected proxy to Codex model SSE requests, native compaction, standalone search, image generation, quota reads, and OAuth login and refresh started from Settings or TUI. WebSocket transport and standalone CLI login follow the process policy.
- **All dsh** applies the proxy process-wide, including OAuth; requests from other plugins are affected too. Turning it off restores the policy that was active before this plugin overrode it.

The URL accepts `http://` and `https://` proxies. Leave it blank to use `DSH_CODEX_PROXY`, then the standard `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` environment variables. The default mode is **Follow dsh**, so installing the plugin never silently changes the process dispatcher.

Saving a proxy URL keeps the setting first, then checks connectivity from that URL with a 10-second deadline against OpenAI's public `https://auth.openai.com/.well-known/openid-configuration` endpoint. The check reports success, an HTTP rejection, a timeout, or a network error; a failed check keeps the saved URL and never blocks the save. It sends no OAuth, model, or quota traffic, does not change the selected scope, and says nothing about account permissions.

## Bundled proxy nodes

The bundle also ships the `dsh-net-proxy` node manager: a mihomo core and geodata are bundled under `bin/net-proxy/`, so the proxy works without installing another proxy client. The plugin settings page imports a Clash-format subscription link, measures node latency, pins a node or keeps the fastest one, and enables or disables the proxy.

- **Scope.** `Codex only` is the default and routes only Codex traffic. Switch to `Whole dsh` to route all host traffic through the selected node.
- **Platform.** The bundled core is Windows x64 only; the plugin code itself is platform-neutral.
- **Do not enable both.** Do not enable this built-in proxy and the standalone `dsh-net-proxy` plugin at the same time: both would start their own core and compete for the same local state and port.
- The bundled core and geodata keep their own licenses; third-party notices and the SHA-256 of the shipped bytes are in [docs/third-party-notices.md](docs/third-party-notices.md).

## AI control of the local proxy

The `local_network_proxy` tool lets an agent inspect and drive the bundled proxy without opening Settings. It has four actions:

- `status` — read-only: reports `enabled`, `scope`, readiness, kernel status, routing, the fixed/current node, node counts, and the current loopback `proxyUrl` (for example `http://127.0.0.1:<port>`) when ready. It starts no core and measures nothing.
- `enable` — starts the proxy for the Codex-only scope and returns only after the kernel is actually running with a listen port. It never changes scope: an already-running `Whole dsh` proxy is reused as-is; if scope is `global` and the proxy is off, enabling is refused instead of taking over host networking.
- `test` — measures only the proxy's configured targets and reports usable nodes. An ordinary test keeps the current fixed node; `auto_select=true` clears the pin first so the fastest node can be chosen automatically. Tests share one serialized sweep with the Settings page, so a second overlapping test fails with a busy message.
- `select` — pins an exact node name from the latest status/test result, or `"auto"` to clear the pin and return to automatic selection. Only `auto` (or `test` with `auto_select=true`) clears a pin; if the switch fails, the previous pin is restored.

The returned URL is a loopback HTTP proxy on the machine that runs dsh. Use it explicitly, for example `git -c http.proxy=http://127.0.0.1:<port> clone ...`, `curl --proxy http://127.0.0.1:<port> ...`, or per-command `HTTPS_PROXY`/`HTTP_PROXY` for `npm install`. On a Remote SSH session `127.0.0.1` is the remote host, not the dsh machine; do not use the address there unless that host itself exposes the same proxy. `web_fetch` is not guaranteed to honor an explicit proxy, so do not promise it will.

The tool never changes the selected scope, never replays model or business requests, and never returns subscription links, credentials, raw logs, or node error text. A failed probe or test is reported as a failure; it is not retried automatically and does not count as a successful connection.

This source no longer creates or modifies the global `AGENTS.md` or `.AGENTS.md` rule files. The retired `writeMemory` field has no effect and cannot enable rule writing; agent-facing proxy instructions come only from the existing `local_network_proxy` tool, whose definition is unchanged. Existing global rule files are left as they are and are not edited or removed automatically. This change is not in the published `v0.3.3-standalone.3` asset, and a running host loads it after the next restart.

## Third-party relay

The plugin can send Codex traffic through a compatible third-party relay instead of OpenAI's direct endpoints. Configure it under **Settings → OpenAI Codex** in the **Relay** card:

- **Relay base URL** is the complete Codex endpoint, for example `https://relay.example.com/backend-api/codex`. A trailing slash is ignored; plain `http://` is accepted only for loopback hosts (`localhost`, `127.0.0.1`, `::1`) for local testing, and URLs carrying credentials, a query, or a fragment are rejected.
- **Relay API key** is stored with the plugin settings and is never returned to the browser. The settings page reports only whether a key is configured, a saved key is never echoed back, and leaving the key field empty while saving keeps the stored key.
- An empty URL keeps direct mode. Clearing the URL returns to direct traffic; a saved key alone does not activate the relay.
- A URL without a key is still relay mode, not direct traffic: relay requests then fail with a fixed configuration error and never fall back to OAuth or the direct endpoints.

Relay traffic sends only the static key, and only to the configured origin. The plugin does not read OAuth credentials for relay requests, does not parse an account id, and does not send `chatgpt-account-id`; OAuth tokens are never sent to the relay. Relay mode has no account usage, so usage reads are refused with a fixed error and the composer quota indicator is hidden; Settings shows the relay mode instead. Relay mode does not fetch the first-party OAuth model catalog: it keeps the plugin's local bundled and cache metadata as candidates only. Which models the relay actually serves is up to the relay; the plugin does not discover relay models or guarantee that every listed model is available there. `web_search` has no standalone relay search and refuses with a fixed unsupported error. `imagegen` uses the selected GPT Image model against `<relay>/images/generations` and `<relay>/images/edits`. Relay traffic uses a dedicated direct dispatcher and is not routed by the bundled managed proxy. The request shape is unchanged: `store: false`, Fast Mode priority, and the native-compaction `compaction_trigger` flow stay as they are. WebSocket context reuse also works through a relay that accepts it: real-relay testing reused one connection across two turns without falling back to SSE. The same values can be seeded as `relayBaseUrl` and `relayApiKey` on the `llm-openai-codex` entry. This capability exists only in the current source and is not part of the published `v0.3.3-standalone.3`; a running host loads it after the next restart, after which the relay can be configured in Web Settings. See [docs/relay.md](docs/relay.md) for details, limits, and the acceptance record.

## Images

Image support uses dsh's durable attachment path:

- paste an image into the Web composer with <kbd>Ctrl</kbd>+<kbd>V</kbd>, or drag and drop it;
- on Windows, paste a clipboard image with <kbd>Ctrl</kbd>+<kbd>V</kbd> in the adapted dsh-tui, or enter `@relative/image.png`; clipboard images go straight to the attachment store, while path images use the active workspace filesystem;
- ask the model to call `read_image` with either `file_path` for a workspace image or `url` for an HTTP(S) image;
- PNG, JPEG, WebP, and GIF are accepted within the active dsh attachment limits;
- only a model that explicitly advertises image input may receive an image.

`imagegen` is available to any vision-capable conversation model. The current model writes an ordinary prompt and may select either `referenced_image_paths` or `num_last_images_to_include`; the plugin reads the bytes from `ctx.fs` or the attachment store and sends them to the configured GPT Image backend. The model never emits base64. Every result is shown inline, saved as a durable attachment, and written to the active workspace. `output_path` chooses the destination; omitting it creates a unique `generated-<timestamp>-<id>.png` file. Local saving is included in this plugin, while `dsh-remote-ssh` supplies the remote AHP write path when that plugin owns the workspace.

The Settings page selects `gpt-image-2` (the current Codex default), `gpt-image-2.5`, `gpt-image-2.5-sunburst`, or `gpt-image-2.5-flare`, and has separate **Enhance read_image** and **Image generation for other models** toggles. Both toggles default on. Turning off the first removes the plugin's agent-scoped override and restores Harness's original local-only `read_image` schema. Turning off the second keeps `imagegen` available to Codex vision models and rejects calls from other model providers at execution time.

`read_image` stores validated bytes as a dsh attachment before returning the actual image block. Local paths are delegated unchanged to Harness, including its configured filesystem and sandbox behavior. The URL extension bounds redirects and bytes, rejects credentials embedded in URLs, rejects local/private/special network targets, and pins each validated public address across the corresponding HTTP hop.

For an eligible Codex GPT conversation, the Web composer also exposes a session-local Fast Mode switch. Enabling it adds the provider's priority service tier only to that conversation; it does not change saved model settings. A neighboring quota bar shows the applicable weekly limit and provider-declared reset time. The Settings page also has a **Force 1.5× speed by default** switch (off by default) that applies Fast Mode to every conversation without the per-conversation toggle; quota is consumed faster while it is on.

## Search

The provider connects dsh's `web_search` tool to the standalone search protocol used by Codex. It returns ordinary dsh text and HTTP(S) citations, so later turns and compaction retain the tool history.

Configure the `llm-openai-codex` row in a profile patch:

```yaml
- id: llm-openai-codex
  config:
    searchMode: live
    searchContextSize: medium
```

| Field | Default | Values |
|---|---:|---|
| `searchModel` | `gpt-5.6-sol` | a Codex model id |
| `searchMode` | `cached` | `cached`, `indexed`, `live` |
| `searchContextSize` | `medium` | `low`, `medium`, `high` |
| `searchMaxOutputTokens` | `10000` | positive integer |

dsh-codex 0.3.0 no longer writes the retired `web/openai-codex-search-llm-request` event. Earlier releases wrote that external event without an ignorable envelope marker, so a later Harness format migration can refuse the otherwise intact Session. Ordinary `web_search` calls and results remain durable through Harness's existing `tool/call` and `tool/result` events.

Affected users should follow the **[historical Session repair guide](docs/session-repair.md)**. The command is dry-run by default, preserves the source generation, and requires explicit `--apply` after dsh is stopped.

## Responses API experiments

The Settings page provides two Codex-only switches. Both are off by default:

- **WebSocket context reuse** keeps `store: false` and selects pi-ai's Codex WebSocket continuation transport. While the same session keeps a reusable connection and the next request is an exact extension, it sends `previous_response_id` with only the new input. History edits, compaction, Fork, connection loss, and process restarts fall back to a full request. With the switch off, ordinary turns use SSE and always send the full Harness context.
- **Native Responses compaction** follows Codex's current V2 flow: it sends the existing history plus a `compaction_trigger` item through `codex/responses`, retains recent client messages with the returned encrypted compaction item inside the Harness checkpoint, and restores those native items on later requests. Before publishing that checkpoint, the plugin locally estimates the durable marker with the host token meter and a conservative 256-token frame margin, and uses it only when that estimate is strictly smaller than the source text it replaces. This is a conservative shrink check, not an exact token account of the opaque encrypted item. Without the meter or a usable source budget, or when the result is too large, the same call falls back to the ordinary Harness summary; the fallback can therefore add one native request before the summary. The core `dsh-compaction-basic` gate remains in force, the full retained payload is preserved (never truncated or stored out of band), and the 256-token margin tracks the verified current Harness checkpoint frame rather than promising compatibility with any runtime. Existing checkpoints remain readable after the switch is disabled. If V2 compaction is unavailable or fails, the same call falls back to the existing Harness model summary.

The switches are independent. Every ordinary Codex request keeps `store: false`; the default uses SSE with the text-summary path from `dsh-compaction-basic`.

A native checkpoint in chat history renders as the single label `Used Codex remote compaction` instead of its encrypted body; ordinary summaries, and histories without a complete native marker, keep their existing presentation. This is display-only: the persisted checkpoint, older logs, and request payloads are unchanged.

The current source also ships a `codex_context` tool (`status` / `request_compaction` / `recall`). It always acts on the calling agent's own session; `request_compaction` only accepts one request and returns a `queued` ticket, with the actual compaction running at the idle boundary after the current turn (`queued` is not success), and a cancelled source turn means no run while the automatic threshold and fallback path stay untouched. `recall` reads bounded plain text only and never returns hidden system/developer prompts or opaque encrypted blocks. Compaction diagnostics store only a small amount of metadata (no text, no credential tokens, no second history database; numeric token counts are kept) and are exposed read-only through the official Gateway and `sessionQuery` visibility. See [docs/compaction.md](docs/compaction.md). This capability exists only in the current source and is not released.

The current source provides an in-conversation compaction request card and an independent run notice: queued means waiting for the conversation to become idle; running says "Compacting context; further messages will queue until it finishes". The notice stays visible outside tool-group folding and disappears at a terminal state; success details remain in the existing compaction history row. Queuing uses the existing Harness mechanism; only the Codex compaction entry leaves the composer bar, while Fast Mode and the quota indicator remain. Automated tests pass (49 files / 573 tests via `pnpm run check`, including both tsc and the host/client builds); after a restart the user's screenshot showed the running notice and the running status, and `status` later returned `completed` for that same request, which shows the notice and the completion but not by itself a native path or a real FIFO. The screenshot predates a font-size reduction, so the smaller-size visual still needs confirmation. General HMR is not promised, and nothing is released yet.

## Credentials and privacy

dsh keeps this login separate from Codex CLI/Desktop by default:

- credentials are stored at `$DSH_HOME/.openai-codex-auth.json` (`~/.dsh` by default);
- writes are atomic and token refresh is locked across local dsh processes;
- browser status and diagnostics never return token values;
- `~/.codex/auth.json` is never copied or modified.

Keeping the stores separate prevents two clients from racing the same rotating refresh token. Removing the bundle does not delete the credential; use the account page or `logout` command when the local account should be removed.

To share an existing login, set the plugin's `credentialFile` to an absolute JSON file path, for example `C:/Users/you/.codex/auth.json`. Existing documents are recognized by shape: Codex `tokens`, CPA/CLIProxyAPI `type: codex`, OpenCode `openai`, Pi `openai-codex`, flat OAuth, or native dsh. Unknown, ambiguous, incomplete, and API-key-only documents fail explicitly; a missing file is created in native dsh format. Use a regular file, not a symlink or hard link, with owner-only permissions on POSIX.

The selected credential must contain only recognized fields; unknown fields are rejected before refresh or writing, with field names but not values in diagnostics. Updates preserve the detected layout, recognized metadata, and other providers' independent entries. A provider-local OAuth refresh handler retains and writes the new access, refresh, and ID tokens, plus email when available, instead of pi-ai's reduced token projection. Login reuses pi-ai's interaction flow followed by one full refresh before saving. A response without an ID token fails explicitly rather than silently retaining stale identity. Logout clears the selected OAuth fields rather than deleting the shared document, and affects other consumers of that login.

Explicit shared files use in-process serialization, with no `.lock` or refresh-intent protocol. Before writing, the plugin re-reads the document and rejects a detected competing credential change. Same-directory temporary-file replacement prevents partial JSON from this writer on supported local filesystems, but does not guarantee crash durability or mutual exclusion with other programs. Simultaneous refreshes can still race; read-back validation cannot solve that. Default separate dsh storage retains its existing cross-process lock.

## Compatibility notes

- Current source targets the DSH `0.2.0-rc.1` plugin surfaces and uses its official volatile settings and `dsh-http-proxy` implementations. It uses `@earendil-works/pi-ai` `0.85.1` and still migrates earlier pi-ai replay envelopes while reading history so existing reasoning/tool metadata remains usable after upgrades.
- The plugin runs on released dsh plugin surfaces and does not require a modified Harness checkout. It can generate attachments and save local output when installed alone.
- ChatGPT plan eligibility, model access, quotas, and backend behavior are controlled by OpenAI and may change.
- The Codex endpoint does not enforce the ordinary Responses `max_output_tokens` field. Compaction works, but its configured summary cap cannot be imposed server-side on this route.
- Filesystem, shell, skills, MCP, subagents, permissions, attachments, compaction, and the `web_search` tool itself still come from the active dsh profile.
- The standalone build is developed against the dsh `0.2.0-rc.1` surfaces in this checkout and targets the `0.2.1-rc.2` desktop runtime. [docs/standalone.md](docs/standalone.md) records which contracts were verified for each, and the boundary: repository tests simulate OpenAI traffic and never sign in with a real account.
- The standalone search endpoint is not a public OpenAI Platform API. Compatibility follows the pinned Codex/pi-ai implementation.

See [the design document](docs/design.md) for protocol, persistence, and lifecycle details.

## Development

```sh
pnpm install
pnpm run check
```

The check performs strict Host and browser TypeScript checking, focused tests, and both runtime bundles.

## License

Apache-2.0
