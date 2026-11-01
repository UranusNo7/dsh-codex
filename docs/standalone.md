# 一体化构建（standalone）：能力、验收与边界

本文件说明 `0.3.3-standalone.3` 的定位、随包能力、已验证范围和尚未验证的部分。目标是**基础 dsh + 本插件**即可使用 Codex 订阅能力，不再安装 `dsh-custom-header` 或 `dsh-gpt-compat`。标注「源码，未发布」的小节描述当前 checkout 中尚未包含在已发布 `.3` 资源里的改动。

## 定位

- 目标 profile 只包含基础 DeepSeek Harness 组成与本 bundle。以 **GitHub 预发布**（tag `v0.3.3-standalone.3`）分发；未发布到 npm。
- 需要具备 Codex 资格的 ChatGPT 套餐；套餐资格、模型权限、配额和后端行为由 OpenAI 控制。
- 不会全局重写、也不会统一冒充 `codex_cli_rs` 请求头；各 provider 与协议路径保留自身需要的请求头。不自动化 ChatGPT 网页界面，也不读取 ChatGPT 会话或记忆。
- 在 Codex 路径上替代 `dsh-gpt-compat` 的兼容处理，但不影响、也不替代其他 API provider 的兼容逻辑。
- npm 上的 `dsh-codex` 仍是上游 `0.3.2`，不包含本文件描述的改动。

## 随包能力与职责

| 能力 | 源码职责 |
| --- | --- |
| `openai-codex` 路由、内置模型目录（含 `gpt-6.1-terra`）、OAuth 登录与刷新 | `src/index.ts`、`src/adapter.ts`、`src/model-catalog.ts`、`src/oauth-*.ts`、`src/store.ts` |
| 官方动态模型目录（**源码，未发布**） | `src/model-catalog-remote.ts`、`src/model-catalog.ts`、`src/service.ts`、`src/auth-routes.ts`、`src/client/` |
| Codex 独立搜索 | `src/search.ts`、`src/search-event.ts` |
| 设置页与账号页接口 | `src/auth-routes.ts`、`src/client/` |
| `read_image` 的 HTTP(S) 输入与 `imagegen` | `src/read-image-enhancement.ts`、`src/imagegen.ts`、`src/public-http.ts` |
| 三态网络代理与保存时连通性测试（旧 API/CLI/TUI 兼容；Web 入口现为内置网络代理） | `src/proxy.ts`、`src/auth-routes.ts` |
| 内置出网代理节点管理（mihomo 内核 + geodata、订阅/测速/自动选节点、Codex-only/全局） | `src/net-proxy/index.js`、`bin/net-proxy/`、`cordis.patch.yml` |
| AI 本地代理控制工具 `local_network_proxy`（status/enable/test/select） | `src/local-network-proxy-tool.ts`、`src/net-proxy/index.js` |
| **仅 Codex 的冗余提权清理** | `src/tool-compat.ts`，由 `src/index.ts` 通过 `ctx.inject(['tools', 'sandboxPolicy'])` 挂载 |
| bundle 组成补丁 | `cordis.patch.yml` |

内置模型目录补充（`src/adapter.ts`）：`gpt-6.1-terra` 复用 pi-ai 的 `gpt-5.6-terra` 请求模板，默认
`context_window` 500,000、`maxTokens` 128,000，输入为文本与图片。推理档位不由目录声明 `off`
（Codex 官方元数据未提供该档位，内置映射为 `off: null`）；DSH 将 `minimal` 映射为 `low`，并支持
`low`/`medium`/`high`/`xhigh`/`max`。`ultra` 不提供，因为当前 pi-ai `ThinkingLevel` 类型边界未包含
该档位。Codex `models_cache.json` 中该模型的新元数据（名称、输入模态、推理档位、默认
`context_window`）会在加载后覆盖内置值。默认路由仍为 `gpt-5.6-sol`，本次目录补充不改变
`0.3.3-standalone.2` 版本或发布物。

### 官方动态模型目录（源码，未发布）

- 目录来源固定为 ChatGPT 内部接口 `https://chatgpt.com/backend-api/codex/models?client_version=0.165.0`。
  `0.165.0` 是解析器验证时对照的完整官方客户端版本，不代表插件实现该版本的全部能力，也不是公开的
  `/v1/models` API。请求拒绝重定向，响应不能改写目标地址。
- 刷新触发：插件启动和登录成功会在后台刷新；打开设置（`GET /plugins/dsh-openai-codex/models`）先恢复
  持久快照，再按 300 秒 TTL 决定是否在返回前刷新；`POST /plugins/dsh-openai-codex/models/refresh` 强制
  刷新。单次请求 20 秒超时，响应体按 4 MiB 流式上限截断并最多接受 200 个条目；失败后冷却 60 秒，
  强制刷新不受冷却限制。
- 缓存：插件在自身凭据文件旁写 `<credential file>.models-cache.json`（写入时请求 POSIX mode 0600），
  只保存 slug、显示名、`visibility`、默认 `context_window`、输入模态与推理档位，以及账号 SHA-256 与
  获取时间；不保存 token、ChatGPT 账号 ID、响应头或工具策略。读取时校验账号哈希，其他账号的快照会被
  忽略；切换账号或退出登录会丢弃上一账号的目录。
- 离线恢复只读取本地已保存身份、不刷新 token，因此过期 token 离线时仍能看到上次成功目录；真正的刷新通过
  provider 原生 OAuth 生命周期（pi-ai `getAuth`）解析凭据。
- 候选优先级：成功获取且 `visibility: list` 的官方条目为权威；刷新失败保留同一账号上次成功的官方快照并
  优先于回退来源，没有可用快照时才回退既有 Codex `models_cache.json`
  （`DSH_CODEX_MODELS_CACHE` → `CODEX_HOME/models_cache.json` → `~/.codex/models_cache.json`），最后回到
  随包目录。Codex 缓存可以补充传输模板，但绝不覆盖官方元数据。失败时只回传固定的脱敏原因
  `official-model-catalog-unavailable` / `official-model-catalog-unauthorized`。
- 选择：刷新替换候选并保留已保存的 `models`，新模型默认不勾选；已保存但当前不可用的 ID 由后端保留。从官方
  列表与 Codex 缓存中消失的非随包模型只会在同进程保留传输元数据以便已恢复会话仍可解析；跨重启仍依赖随包
  目录、当前 Codex 缓存或官方目录，不承诺任意历史模型永久解析。无随包价格的新模型按 0 价格估算，不代表
  免费；`ultra` 仍不支持。目录元数据不保证当前账号实际可用。
- 设置页：模型选择区域新增双语「从 OpenAI 刷新」按钮，并显示来源与最后成功时间；失败时保留当前列表并显示
  本地化说明，不展示原始错误正文。
- 该能力只存在于当前源码 checkout，未包含在已发布的 `v0.3.3-standalone.3` 资源中；版本号与发布状态
  未变。本地构建已完成，宿主未重启，当前 GUI 未做新功能运行态验收。
- 测试：`tests/model-catalog-remote.spec.ts`（模拟远端）、`tests/model-catalog.spec.ts`、
  `tests/service.spec.ts`、`tests/auth-routes.spec.ts`、`tests/openai-codex-settings.client.spec.tsx`。

### 原生压缩安全预检与降级（源码，未发布）

- 原生 V2 压缩结果不会无条件成为检查点：插件用 Host token meter 的同口径本地估算，要求
  `estimate(marker) + 256 < sourceText 预算`（严格小于）才发布原生检查点。256 是已验证的当前 Harness
  检查点 frame 保守余量，不承诺适配任意 runtime；该估算是保守收缩判断，不是对加密 compaction item
  的真实 token 计量。
- 缺少 token meter、没有有效源文本预算、估算异常/非有限或结果过大时，同一次调用回退普通 Harness
  摘要；失败路径可能先产生一次 native 请求、再产生一次普通摘要。核心 `dsh-compaction-basic` 收缩 gate
  保留；完整 retained/opaque 数据原样保留，不截断、不外置；旧 v1 marker 重放不变。
- 源预算来自 Harness 原始 `GenerateOptions.messages` 的既有 text 块（去 system、去最后压缩指令，
  不计 reasoning、tool-call 参数、image、file），不是转换后的 PiContext 文本。
- 该改动仅存在于当前源码 checkout（不在已发布的 `v0.3.3-standalone.3` 中），未发布。本轮
  已确认原生远端检查点真实落盘且后续请求正常（本会话 13:15 的 summary 含 native marker、
  checkpoint/end 无 error、后续 provider 输入正常）；新标签的目视验收尚未进行。
- 测试：`tests/codex-compaction.spec.ts`、`tests/response-runtime.spec.ts`（mock；用已核实的 core
  frame 契约与同款 chars/4 estimator 复刻 gate，不加载真实 core 包）。
- 聊天历史中的原生检查点只显示标签「已使用Codex远程压缩」（EN: `Used Codex remote compaction`），
  不展示 opaque 正文；普通摘要或缺少完整 v1 marker 的历史保持 stock 原样。这是 client 展示层对
  `compaction` 与 `manual-compaction` 两个 key 的遮蔽委托，持久检查点、旧日志与请求 payload 不变。
  当前 Client 已确认这两个渲染入口注册并生效（priority -1，对应 stock `priority 0` 未激活）；未做
  目视验收（Tabbit 不可用），不承诺一般 HMR。测试见
  `tests/native-compaction-presentation.client.spec.tsx`。
- 当前源码另有 Agent 工具 `codex_context`（status/request_compaction/recall）：只作用于当前会话；
  `request_compaction` 只受理并返回 queued 凭据，真正压缩在本轮结束后的 idle 边界执行，且仅当来源
  turn 以 `completed` 结束才执行一次（来源取消或无法证明则不执行，后者受理时直接拒绝），自动阈值与
  兜底保持不变。`recall` 有界读当前会话纯文本，不返回 system/developer 与 opaque 加密块。
- 压缩诊断仅向插件自有 `storageDomain` KV 写少量元数据（无正文/无 token 字符串/无第二 history DB），
  并经官方 Gateway 与 `sessionQuery` 可见性只读暴露；不 resume 冷 Agent、不声明 per-session
  capability，持久化缺失或无法关联时诚实 `unknown`。详细说明见 `docs/compaction.md`，未发布。
- 对话内展示（用户已见运行提示；字号调整后的视觉待确认）：`codex_context` 的 `request_compaction` 以公开
  `tool.call.toolview` 工具卡显示 queued/running 与无 checkpoint 终局；completed 只显示简短结论，
  成功详情仍复用既有压缩历史行；底栏仅移除 Codex 压缩 entry（Fast Mode/quota 保留）。新增
  `src/client/CompactionTurnNotice.tsx` 注册公开 turnTail 提示（order 15），通过 rc5 公开
  `turnDataSource` 订阅本 turn 工具结果，以真实 requestId 精确查询现有 RPC；queued 等待空闲后开始，
  running 显示“正在压缩上下文，后续消息将排队等待”，terminal 消失，成功历史不变。槽位本身可用；
  `unknown` 回归中复现两处作用域问题（缺 `typert` 注入时 `$mount` 失败、补注入后属性访问
  `remote.codexCompaction` 仍失败），与截图现象一致，不作唯一因果断言；产品侧仅两行（`inject` 补
  `typert`、读取改经 `ctx.get('remote.codexCompaction')`，`$mount` 以 `.call(ctx.remote, …)` 绑定
  接收者）。新接线使用成员调用并返回 disposer，可选失败仅固定警告。
  压缩期间新消息由 Harness 既有机制（core FIFO）排队，不新增队列，结束后按顺序继续。关联以工具
  result 的 `requestId` 为键；`compactionId` 来自同一次请求运行期核心 `compaction/start` 产生并由
  结果验证的标识；仅当持久记录保存成功且 link 完整时可恢复，否则 `unknown`。
- 运行态边界：`pnpm run check` 通过（`49 files / 573 tests`，双 tsc 与 host/client build 成功）。新增覆盖：
  UI 6 例、真实 slot 9 例、真实 client `$mount` 8 例、真 driver 13 例（含 held 进行中真实 query 可读并
  正常结束）；自动化联合测试基于 rc1，rc5 已做源码对照，尚无 rc5 真机自动化 E2E。用户重启后的截图确实
  看到运行提示“正在压缩上下文”与状态“运行中”，随后 `status` 对同一请求返回 `completed`——这证明提示
  可见与完成，不据此单独称 native 或真实 FIFO；截图发生在字号缩小之前，字号缩小后的视觉待用户确认。
  诊断 domain/key 与后端合同不符（本轮未改）：实际可能仅内存、重启后恢复不保证，核心会话历史不受影响。
  不承诺普遍 HMR（无 `dev:web` watcher）；本次字号/客户端作用域修复未改 Host 产品/协议/依赖/profile；未发布。

提权清理规则（失败即保留，fail-closed）：

- 仅当**已能确定当前沙箱策略**、请求目标**不严格宽于**当前模式（`requested <= current`），且请求 provider 严格为 `openai-codex`、工具属于 `bash`／`pwsh`／`write`／`edit`、该工具 schema 声明了 dsh 原生提权契约时才介入。该契约要求 `sandbox_permissions` 枚举包含 dsh 的两个合法提权目标 `workspace-write` 与 `danger-full-access`（`read-only` 只是当前策略模式，不是提权目标），并要求 `justification` 为字符串。
- 仅移除 `sandbox_permissions` 与 `justification`；真正扩权、未知目标、当前策略未知或解析失败、provider 或 session 缺失时保持原样，交由 dsh 原生审批与拒绝逻辑。
- 不修改沙箱策略、调用标识或信号；插件 fiber 释放后监听器随之解绑。

**刻意不包含**：`dsh-custom-header` 的全局请求头改写。本插件不会全局重写 `User-Agent`，也不会统一冒充 `codex_cli_rs`；各 provider 与协议路径保留自身既有的 originator（pi-ai 协议默认 `pi`，独立搜索与生图为 `deepseek-harness`，原生压缩为 `dsh-codex`）。另外，“仅 Codex”代理模式直接经 `undici` 发送，不会经过全局 `fetch` 中间件。

## 内置出网代理

- 随包内置 `dsh-net-proxy` 的节点管理：mihomo 内核与 geodata 位于 `bin/net-proxy/`，无需另装代理客户端。
- 插件设置页负责订阅导入、节点测速、固定节点或自动选择最快节点，以及代理启停；Web 入口现在只有内置网络代理。
- AI 工具 `local_network_proxy`：`status` 只读（返回动态 loopback URL、就绪状态与节点摘要）；`enable` 仅按 Codex 范围启动并等待真正就绪，不改变 scope，scope=global 且代理关闭时拒绝启用；`test` 只测已配置目标，普通测速保留固定节点，`auto_select=true` 才清除固定节点，并与设置页测速共用串行保护；`select` 固定精确节点名或 `auto` 解除，切换失败恢复原固定节点。
- 该工具不自动重放模型或业务请求，不返回订阅链接、凭据、原始日志或节点错误原文；返回的 loopback URL 在 Remote SSH 下指远端主机而非 dsh 机器，`web_fetch` 不保证支持显式代理。本地命令可用 `git -c http.proxy=...`、`curl --proxy` 或单命令 `HTTPS_PROXY`/`HTTP_PROXY`。
- 旧的三态 HTTP(S) 代理配置仍通过既有 API、CLI 与 TUI 兼容，已保存值会保留，不会被自动清空或迁移。
- 代理范围默认 **仅 Codex**，只影响 Codex 流量；可切换为 **整个 dsh**。
- 内置内核仅支持 **Windows x64**；插件自身代码与平台无关。
- **不要与独立的 `dsh-net-proxy` 插件同时启用**：两者会各自启动内核，并争用同一份本地状态与端口。
- 内置内核与 geodata 的许可、来源与实际字节 SHA-256 见 [third-party-notices.md](./third-party-notices.md)。
- 不再创建或修改全局 `AGENTS.md` / `.AGENTS.md` 规则文件；旧 `writeMemory` 配置已无效，不能启用规则写入。
  面向 AI 代理的说明仅由既有 `local_network_proxy` 工具提供，工具定义未变；已有全局规则文件不会被自动编辑
  或删除。该改动仅存在于当前源码（不在已发布的 `v0.3.3-standalone.3` 中），宿主需下次重启后加载。

## 验收矩阵

| 范围 | 证据 | 结果 |
| --- | --- | --- |
| 一体化挂载（仅核心 + 本插件，无第三方插件） | `tests/standalone.spec.ts`：真实 `Context`、`ToolRuntime`、`SandboxPolicyService`、`SessionProjectionRuntime`、`SandboxedFileSystem`、`LlmRuntime`、`WebRuntime` | 通过 |
| 模型目录 | 同上：`llm.listProviders()` 仅 `openai-codex`，`llm.listModels()` 含 `gpt-6-sol` 与内置 `gpt-6.1-terra`；`tests/model-catalog.spec.ts` 覆盖 Terra 的 500K 默认窗口与缓存元数据合并 | 通过 |
| 独立搜索挂载 | 同上：真实 Web 注册表中的 `openai-codex` 搜索 provider | 通过 |
| 账号／设置接口挂载 | 同上：记录 `webServer.register` 的 13 条路由，覆盖 auth、fast-mode、image-tools、response-api、context-window、models、models/refresh、model-fallback、proxy | 通过 |
| 官方动态模型目录（**源码，未发布**） | `tests/model-catalog-remote.spec.ts`、`tests/model-catalog.spec.ts`、`tests/service.spec.ts`、`tests/auth-routes.spec.ts`、`tests/openai-codex-settings.client.spec.tsx`：模拟端点，未使用真实账号 | 源码测试覆盖；未随 `.3` 发布 |
| `imagegen` 与 `read_image` 增强 | 同上：`imagegen` 工具已注册；agent 作用域上出现带 `url` 参数的 `read_image` 影子定义 | 通过 |
| 无第三方插件依赖 | 同上：`package.json` 的 dependencies／devDependencies／peerDependencies 均不含两个被取代插件；组合前后 `globalThis.fetch` 不变 | 通过 |
| Codex 冗余提权清理（端到端） | 同上：真实工具执行后参数只剩业务字段 | 通过 |
| 冗余清理卸载 | 同上：`plugin.dispose()` 后同样的调用不再被清理，provider 与 `imagegen` 一并移除 | 通过 |
| 真正扩权保留 | `tests/standalone.spec.ts` 断言参数原样到达下游策略；审批本身不在该用例内断言 | 通过 |
| 审批拒绝／deny／cancel／provider 门控／allowlist／异常路径 | `tests/tool-compat.spec.ts`（含 `approval.rejected` 时工具主体未执行） | 通过 |
| OAuth 登录与刷新 | `tests/oauth-provider.spec.ts`（模拟端点） | 通过 |
| 流式、压缩、模型恢复 | `tests/codex-compaction.spec.ts`、`tests/response-runtime.spec.ts`、`tests/model-fallback.spec.ts` | 通过 |
| 搜索 | `tests/search.spec.ts` | 通过 |
| 图片能力 | `tests/imagegen.spec.ts`、`tests/read-image-enhancement.spec.ts` | 通过 |
| 网络代理 | `tests/proxy.spec.ts` | 通过 |
| 设置页交互 | `tests/openai-codex-settings.client.spec.tsx`、`tests/openai-codex-quota-indicator.client.spec.tsx`、`tests/openai-codex-fast-mode.client.spec.tsx` | 通过 |
| Loader 组成 | `tests/loader-composition.spec.ts` | 通过 |
| 消费者安装（精确桌面核心） | `dist-package/` 内隔离消费者：`file:` 安装 tgz（非 link），真实 `ToolRuntime`/`SandboxPolicyService` 下 23 项检查，含冗余清理先于审批门控、审批拒绝时工具主体未执行、非 Codex provider 不清理、卸载撤销 | 通过 |

`tests/standalone.spec.ts` 中只有 `webServer` 与 `agents` 两个核心服务的**记录型 fixture**，用于观察注册行为和触发 `read_image` 增强；它们不代表任何第三方插件。工具、沙箱策略、文件系统、附件、LLM、Web 均为真实服务实现。

## 版本与契约

- 开发基线：本 checkout 的 dsh `0.2.0-rc.1` 表层，实际验证 `tools/pre-execute` waterfall、`ctx.tools.get`、`session.requestHeader()` 与 `ctx.sandboxPolicy.resolve()`。
- 目标运行时：桌面端 dsh `0.2.1-rc.2`。消费者烟测使用精确 `0.2.1-rc.2` 核心包与 Cordis `4.0.5`，从打包后的 `.tgz` 安装并加载本插件，23 项检查全部通过；其他 dsh 版本不作承诺。
- `package.json` 的 peerDependencies 仍声明 `^0.2.0-rc.1` 系列，安装到 `0.2.1-rc.2` 时 `pnpm` 会报告 peer 范围冲突（例如 `@deepseek-ai/dsh-fs` 与 `@deepseek-ai/dsh-subagent` 的版本要求），安装本身成功且烟测通过；这不代表接口不兼容，也不构成全面升级依赖的理由。
- 当前发布版本：`0.3.3-standalone.3`（GitHub 预发布，未发布 npm）。相对 `0.3.3-standalone.2`，
  本轮新增内置 mihomo 出网代理（含 `bin/net-proxy/` 内核与 geodata）、Codex-only/整个 DSH 两种 scope、
  代理测速与 controller 直连修复及对应测试/文档同步；`.2` 相对 `.1` 新增内置 `gpt-6.1-terra` 目录。
  协议、默认模型与既有能力不变。当前源码 checkout 另含尚未发布的官方动态模型目录（见上文
  「源码，未发布」小节）；它不改变 `0.3.3-standalone.3` 的发布内容、版本号或协议。

## 真实桌面基础 QA（历史记录：`0.3.3-standalone.1`，本会话）

- 在真实桌面 dsh `0.2.1-rc.2` 的 profile 中，bundle 清单不含 `dsh-custom-header` 与
  `dsh-gpt-compat`；其他无关插件未为本次 QA 移除。当时已安装本地 `link:` 的
  `0.3.3-standalone.1`（源码与当时的发布包同源）。以下为 `.1` 轮次的历史记录，不描述
  `0.3.3-standalone.2` 的桌面 QA。
- 实测 `openai-codex` 路由下可选择 `gpt-6.1-sol`；`pwsh`、`write`、`read`、`edit` 对临时文件
  执行成功，并完成临时文件清理。
- 该实测**未主动构造**带 `sandbox_permissions`/`justification` 的提权调用，也**未做**全量
  真实搜索、生图或账号功能验收；因此不等同于“账号全部功能已通过”。它与下方隔离消费者中
  真实 `ToolRuntime` 的 23 项原生 ask 烟测是两个不同层级的证据。

## 尚未验证的边界

- **自动化测试使用模拟端点，不读取用户真实凭据**：测试流量为模拟或本地 fixture，未发起
  OAuth 登录；当前会话仅验证已有登录下的基础对话和工具调用，未重新执行真实 OAuth 登录，
  也未做全面搜索、生图或账号功能验收。
- **尚未在真实桌面 dsh 运行时加载本发布 tgz**：桌面实测使用的是本地 `link:` 的同一源码构建；
  发布 tgz 的验证限于隔离消费者中的安装、导入、原生 ask 烟测与元数据检查，真实运行时加载
  仍需在桌面端重启后确认。
- 套餐资格、额度、模型可用性与后端行为由 OpenAI 控制，可能随时变化。
- 提权清理只处理可证明冗余的请求，不会让模型获得额外权限，也不会替代 dsh 的审批流程。
- **官方动态模型目录尚未做运行态验收**：本地构建已完成，宿主未重启，当前 GUI 未做新功能运行态验收；
  新增实现未单独进行真实账号联调，最终测试已隔离身份并使用 mock。已发布的 `v0.3.3-standalone.3`
  资源不包含该实现，使用刷新控件需要从当前源码重新构建并重启宿主。

## 安装

从 GitHub 预发布资源安装（桌面端用 `--profile desktop`，Web 用 `--profile web`）：

```sh
dsh plugin --profile desktop add "https://github.com/UranusNo7/dsh-codex/releases/download/v0.3.3-standalone.3/dsh-codex-0.3.3-standalone.3.tgz"
```

该安装包以 `v0.3.3-standalone.3` GitHub 预发布资源分发，未发布到 npm。安装后重启桌面端
dsh，再在 **设置 → OpenAI Codex** 完成账号登录。不要安装 GitHub 自动生成的源码压缩包，也
不要再安装 `dsh-custom-header` 或 `dsh-gpt-compat`。
