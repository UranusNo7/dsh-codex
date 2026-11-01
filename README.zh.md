# dsh Codex

[English](README.md) | 中文

**[迁移指南：修复 dsh-codex 0.3.0 之前版本写入的历史 Session](docs/session-repair.zh.md)**

通过 OpenAI Codex 登录流程，在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中使用 ChatGPT 订阅：无需 OpenAI Platform API Key，也无需修改 dsh 源码。

`dsh-codex` 是一个独立的 dsh bundle，提供：

- 在 dsh 设置面板或独立 CLI 中完成 ChatGPT OAuth 登录，并自动刷新 token
- 动态 Codex GPT 模型目录：从官方 Codex 接口按 300 秒 TTL 自动刷新，设置页可手动强制刷新；官方不可用时回退 Codex 应用缓存，再回退内置目录（含 GPT-6.1 Terra，默认 500K 上下文）
- 可实时覆盖 dsh 用于上下文用量显示与压缩策略的客户端窗口容量
- 经标准 LLM 服务运行的流式响应、工具调用、推理回放、提示词缓存与 dsh 压缩
- 通过 dsh 现有 `web_search` 工具使用 Codex 独立联网搜索
- 为 Harness 现有 `read_image` 工具增加可选的 HTTP(S) URL 输入
- 可选择 GPT Image 后端的 `imagegen` 工具，支持工作区／会话参考图和自动工作区输出
- 复用 dsh Web 输入框的粘贴和拖放图片能力
- 在 Web 输入框提供按会话生效的 Fast Mode 开关与紧凑的每周额度指示器
- 可选的后端授权模型恢复，包括隐藏的 Luna Reserve 路由
- 旧三态 HTTP(S) 代理设置继续通过既有 API、CLI 与 TUI 配置兼容；已保存值会保留，不会被自动清空
- 内置出网代理节点管理：打包 mihomo 内核，支持订阅导入、节点测速、自动或固定节点，默认仅 Codex、可切换整个 dsh，仅 Windows x64
- `local_network_proxy` AI 工具：对内置代理执行 status/enable/test/select，本地命令可用其 loopback 地址出网

ChatGPT 订阅认证与按量计费的 OpenAI API 是不同产品。本插件只使用 ChatGPT Codex 后端，不会把订阅转换成通用 OpenAI API 凭据。

## 一体化版本

`0.3.3-standalone.3` 是自包含的 fork 构建，定位为**基础 dsh profile 中唯一的 Codex 插件**。它以 `v0.3.3-standalone.3` 的 GitHub 预发布资源分发；未发布到 npm。

- **仅 Codex 的冗余提权清理。** GPT 模型在普通写操作中习惯性附带 `sandbox_permissions` 与 `justification` 时，工具调用不再因此失败。只有同时满足以下条件才会移除这两个参数：已能确定当前沙箱模式、且请求目标不严格宽于当前模式（`requested <= current`）、当前请求 provider 严格为 `openai-codex`、工具属于 `bash`／`pwsh`／`write`／`edit`、且该工具的 schema 声明了 dsh 原生提权契约。真正扩大沙箱权限的请求会完整保留参数，继续进入 dsh 自己的审批流程。在 Codex 路径上该能力取代独立的 `dsh-gpt-compat` 插件；它不改变也不替代其他 API provider 的兼容处理。
- **不做请求头伪装。** 本插件不会全局改写 `User-Agent`／`Originator`，也不会统一冒充 `codex_cli_rs`；各 provider 与协议路径保留自身需要的请求头。独立的 `dsh-custom-header` 插件既不需要，也没有被打包。
- **运行要求。** 开发基线是本 checkout 的 dsh `0.2.0-rc.1` 插件表层；目标是桌面端 `0.2.1-rc.2`，其安装包已在只使用精确 `0.2.1-rc.2` 核心包与 Cordis `4.0.5` 的隔离消费者中通过烟测。其他 dsh 版本不作承诺；安装到 `0.2.1-rc.2` 时会出现预期内的 peer 版本范围警告。需要常规 tools、sandbox-policy、LLM、web、settings、文件系统与附件服务，以及具备 Codex 资格的 ChatGPT 套餐。安装本身不会发起登录，凭据保存在插件自己的存储中，绝不读取或复制 `~/.codex/auth.json`。
- **不包含。** ChatGPT 网页版专属能力：不自动化网页界面、不读取 ChatGPT 会话或记忆，也不会把订阅转换成通用的 OpenAI API 凭据。

清理行为及其插件生命周期由[一体化验收测试](tests/standalone.spec.ts)覆盖。

## 安装

把 GitHub Release 中预构建的一体化安装包安装到选定的 dsh profile：

```sh
dsh plugin --profile web add "https://github.com/UranusNo7/dsh-codex/releases/download/v0.3.3-standalone.3/dsh-codex-0.3.3-standalone.3.tgz"
dsh web
```

该安装包以 `v0.3.3-standalone.3` 的 GitHub 预发布资源分发，未发布到 npm。请下载 Release 资源，不要安装 GitHub 自动生成的源码压缩包。npm registry 上的 `dsh-codex` 仍是上游版本，不包含这些一体化改动；`dsh plugin --profile web add dsh-codex` 安装的是那个上游 bundle。桌面端应用请改用同一资源并传 `--profile desktop`。

从 DeepSeek Harness 源码 checkout 运行时，使用 `pnpm dsh plugin --profile web add "https://github.com/UranusNo7/dsh-codex/releases/download/v0.3.3-standalone.3/dsh-codex-0.3.3-standalone.3.tgz"`。开发插件时仍可用 `link:/absolute/path/to/dsh-codex` 安装本地 checkout。

打开 **设置 → OpenAI Codex**，选择 **浏览器登录** 或 **设备码登录**。浏览器登录会给出授权链接；点击后在系统浏览器完成授权。当浏览器和 dsh 宿主位于同一台机器时，localhost 回调会完成登录；远端浏览器可以使用设备码。账号页面会显示实时 Codex 额度进度条与精确剩余百分比；只有账号接口提供信用余额或工作区限额时，才会一并显示精确数值。

回环地址上的 Web 页面会自动受信任。若 dsh 运行在另一台机器上，账号页面会显示需要在 dsh 主机执行的精确 origin 授权命令，例如 `dsh plugin --profile web exec dsh-codex trust-origin http://host:port`。allowlist 按完整 origin 匹配，与 OAuth 凭据分开保存，并可通过 `trusted-origins` 和 `untrust-origin` 查看或撤销。

终端和无界面环境仍可使用 CLI：

```sh
dsh plugin --profile web exec dsh-codex login
dsh plugin --profile web exec dsh-codex login --device-code
dsh plugin --profile web exec dsh-codex status
dsh plugin --profile web exec dsh-codex doctor --json
dsh plugin --profile web exec dsh-codex logout
```

在 `dsh-tui` 中使用时，把 bundle 安装到同一个 profile：

```sh
dsh plugin --profile dsh-tui add "https://github.com/UranusNo7/dsh-codex/releases/download/v0.3.3-standalone.3/dsh-codex-0.3.3-standalone.3.tgz"
```

重新启动 TUI 后，`/model` 会列出 `openai-codex` 的模型；没有显式模型配置或已保存选择时，TUI 会采用 bundle 注册的 `gpt-5.6-sol`。`/codex status|login|logout|usage|config` 用于管理账号与查看配置；`/codex set backend-fallback on|off` 控制自动模型恢复，其余开关可通过 `/codex set` 查看。`/codex login` 会给出浏览器链接，远端终端可用 `/codex login device` 获取设备码。TUI 的 `/settings` 也通过同一个 dsh 设置命名空间编辑 Codex 的标量设置；模型可见性与代理 URL 仍在 Web 设置页编辑。两个界面共用凭据和实时偏好。

Codex、Claude Code 及其他自动化 agent 应直接遵循 [INSTALL.md](INSTALL.md)。它是一份完整且可重复执行的 runbook，不要求安装者阅读源码或设计文档。

bundle 会为新建 agent 选择 `openai-codex` / `gpt-5.6-sol`，并选择 Codex 搜索提供方。dsh settings 中已经保存的模型仍然优先；模型选择器可以切换到当前账号可用的其他 Codex 模型。GPT-6.1 Terra 是可选的内置模型，不改变 `gpt-5.6-sol` 默认值。

自动模型回退默认关闭。启用 **设置 → OpenAI Codex** 中的开关后，插件只会遵循 OpenAI 为当前账号返回的恢复指令：普通恢复按后端给出的替代模型顺序选择；`luna_reserve` 指令则解析官方隐藏的 `gpt-reserve` 路由，并沿用 Luna 的上下文、推理与图片能力。该决定发生在 dsh 准备重试之前，因此实际模型、上下文预算、图片准入与 Session 请求头保持一致。视觉路由绝不会回退到纯文本模型，附件、`read_image` 与 `imagegen` 会继续可用。没有兼容回退或额度刷新失败时，原始额度错误会继续交给 Harness 的正常重试路径。`imagegen` 与该切换相互独立，并使用设置页中选定的图片后端。

## 模型目录

模型选择器从 ChatGPT 内部的官方 Codex 接口 `https://chatgpt.com/backend-api/codex/models?client_version=0.165.0` 读取当前账号的目录。该版本号只是本解析器验证时所对照的完整官方客户端版本，不代表插件实现了该版本的全部能力；它也不是公开的 `/v1/models` API。请求来源固定、拒绝重定向，响应无法改写目标地址。

打开 **设置 → OpenAI Codex** 时，插件先恢复已登录账号的持久快照，再套用 300 秒 TTL：快照仍新鲜时直接返回、不发起请求；过期或缺失时在返回前执行一次有界刷新（20 秒超时）。**从 OpenAI 刷新** 会强制刷新并跳过 TTL；插件启动和登录成功也会在后台刷新。普通聊天回合不会等待这项网络工作。

只有成功获取且 `visibility: list` 的官方条目才是权威候选。当前账号没有可用官方快照时，插件才回退到既有的 Codex `models_cache.json` 元数据（依次为 `DSH_CODEX_MODELS_CACHE`、`CODEX_HOME/models_cache.json`、`~/.codex/models_cache.json`），最后回退到随包模型（含 GPT-6 Astra、Sol、Luna 与 Terra）。刷新失败会保留同一账号上次成功的官方快照，并优先于回退来源；只有该快照不存在时才使用回退元数据。Codex 缓存只能补充传输模板，绝不能覆盖官方元数据；插件不会启动 Codex 子进程，也不会读取 Codex 凭据。

插件在自身凭据文档旁维护独立缓存 `<credential file>.models-cache.json`（写入时请求 POSIX mode 0600），只保存本插件需要转换的字段（slug、显示名、可见性、默认上下文窗口、输入模态、推理档位）以及账号 SHA-256 哈希和获取时间。访问令牌、ChatGPT 账号 ID、响应头、工具策略与其他响应元数据都不会落盘。其他账号写入的缓存会被忽略；切换账号或退出登录会丢弃上一账号的目录。恢复快照只使用本地已保存的身份、不会刷新 token，因此离线且 token 已过期的会话仍能看到上次成功目录；真正的刷新则通过 Provider 原生 OAuth 生命周期解析凭据。

刷新失败会保留同一账号上次成功的快照，只暴露固定的脱敏原因。非强制读取在失败后等待 60 秒再重试；手动刷新按钮会立即重试。设置页在失败时保留当前列表并显示本地化说明，绝不展示提供方原文、状态码或响应正文。

已保存的模型选择会保留：刷新替换候选列表、保留已保存的模型 ID，新发现的模型默认不勾选。从官方列表与 Codex 缓存中消失的模型只会在当前进程内保留传输元数据，以便已恢复的会话仍可解析；跨重启后，解析仍依赖随包目录、当前 Codex 缓存或官方目录，因此不能承诺任意历史模型永久可解析。没有随包价格信息的新发现模型按 0 价格估算，这不代表模型免费。`ultra` 推理档位仍不支持，因为当前 pi-ai 的 `ThinkingLevel` 类型边界未包含它。目录元数据不保证当前登录账号真的拥有某个模型的使用权限。

初始勾选来自 Provider 初始化时已可用的目录（随包模型加现有 Codex 缓存）。之后加载的官方列表更新候选，但不自动勾选新发现的模型，需要手动启用。打开 **设置 → OpenAI Codex**，通过复选框选择需要显示的条目；选择实时生效并持久保存，修改后 dsh 会刷新 Web 与 TUI 的模型目录。

该动态目录能力存在于当前源码 checkout。已发布的 `v0.3.3-standalone.3` 资源不包含它，版本号与发布状态均未改变；使用刷新控件需要从该源码重新构建并重启宿主。

也可以在 `llm-openai-codex` 条目上通过 `models` 设置初始子集，并保持提供方原有顺序：

```yaml
- id: llm-openai-codex
  config:
    models:
      - gpt-6-luna
      - gpt-6-sol
```

复选框与 `models` 设置都只控制模型发现。现有会话已经保存或显式指定的隐藏模型仍可解析，因此收窄选择器不会破坏旧记录。省略 `models` 时初始展示完整目录；空列表表示不展示任何模型。

## 上下文窗口

打开 **设置 → OpenAI Codex → 上下文窗口**，可以用 K tokens 为单位覆盖客户端容量。例如输入 `512` 表示 512,000 tokens；留空会恢复各模型在 pi-ai 目录中的默认值。保存后的值会在下一次请求时应用到全部 Codex 模型，并显示在 `/codex config` 中；已打开会话的用量分母会在该请求后刷新。

也可以在初始配置中填写精确 token 数：

```yaml
- id: llm-openai-codex
  config:
    contextWindow: 512000
```

该功能在 Harness 一侧对应 Codex CLI 的 `model_context_window` 概念，不会向 Responses 端点发送上下文窗口字段。解析后的容量会直接控制 dsh 的上下文用量分母、溢出判断、输出 token 收缩和自动压缩阈值；较小的值会更早压缩。较大的值不会提高后端模型的真实容量，模型不支持时仍可能返回上下文溢出错误。

## 网络代理

Web 设置中的网络代理入口现在仅提供内置代理（见 [内置出网代理](#内置出网代理)）：订阅导入、节点测速、启停，以及仅 Codex 或整个 dsh 范围。

旧的三态 HTTP(S) 代理设置仍通过既有插件 API、CLI 与 TUI 配置兼容，本次构建不会移除它们；已保存的值会保留，不会被自动清空或迁移：

- **跟随 dsh** 不由插件覆盖网络设置；Codex 继承 dsh 启动时已经配置的进程级代理。
- **仅 Codex** 把所选代理用于 Codex 模型 SSE 请求、原生压缩、独立搜索、生图、额度读取，以及从设置页或 TUI 发起的 OAuth 登录和刷新；WebSocket 与独立 CLI 登录仍遵循进程策略。
- **整个 dsh** 把代理应用到整个进程，并覆盖 OAuth；其他插件的请求也会受影响。关闭后会恢复插件覆盖前的宿主策略。

代理 URL 支持 `http://` 与 `https://`。留空时依次使用 `DSH_CODEX_PROXY`，以及标准的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY` 环境变量。默认模式是 **跟随 dsh**，因此安装插件不会静默改变整个进程的 dispatcher。

保存代理 URL 时会先保存设置，再用该 URL 在 10 秒内探测 OpenAI 的公开地址 `https://auth.openai.com/.well-known/openid-configuration`：结果分为成功、HTTP 拒绝、超时和网络错误。探测失败不会撤销已保存的 URL，也不会阻止保存；它不发送 OAuth、模型或额度请求，不改变所选代理范围，也不代表账号权限状况。

## 内置出网代理

本 bundle 同时打包了 `dsh-net-proxy` 的节点管理能力：mihomo 内核与 geodata 位于 `bin/net-proxy/`，无需再安装其他代理客户端。插件设置页可导入 Clash 格式订阅、测量节点延迟、固定节点或自动选择最快节点，并启用或停用代理。

- **范围。** 默认 **仅 Codex**，只代理 Codex 流量；可切换为 **整个 dsh**，让所有宿主流量走所选节点。
- **平台。** 内置内核仅支持 Windows x64；插件自身代码与平台无关。
- **不要同时启用。** 不要与独立的 `dsh-net-proxy` 插件同时启用：两者会各自启动一个内核，并争用同一份本地状态与端口。
- 内置内核与 geodata 各自保留原有许可；第三方声明与实际随包字节的 SHA-256 见 [docs/third-party-notices.md](docs/third-party-notices.md)。

## AI 控制本地代理

`local_network_proxy` 工具让 agent 无需打开设置页即可查询和驱动内置代理，包含四个动作：

- `status` —— 只读：返回 `enabled`、`scope`、是否就绪、内核状态、routing、固定/当前节点、节点计数，以及就绪时的 loopback `proxyUrl`（例如 `http://127.0.0.1:<port>`）。不启动内核、不测速。
- `enable` —— 以“仅 Codex”范围启动代理，并等到内核真正运行且已监听端口才返回。工具不会改变 scope：若用户已启用“整个 dsh”且代理在运行，则原样复用；若 scope 为 `global` 且代理关闭，则拒绝启用，不擅自接管宿主出网。
- `test` —— 只测代理已配置的目标并返回可用节点；普通测速保持当前固定节点，`auto_select=true` 会先清除固定节点，让最快节点自动生效。测速与设置页共用同一串行扫描，已有测速进行中时本次调用会明确报 busy，不会并发启动第二次。
- `select` —— 用最近一次 status/test 返回的精确节点名固定节点，或用 `"auto"` 清除固定并恢复自动选择。固定只由 `auto`（或 `test` 的 `auto_select=true`）解除；切换失败会恢复原固定节点。

返回的 URL 是运行 dsh 的机器上的 loopback HTTP 代理。请显式使用，例如 `git -c http.proxy=http://127.0.0.1:<port> clone ...`、`curl --proxy http://127.0.0.1:<port> ...`，或为 `npm install` 单次设置 `HTTPS_PROXY`/`HTTP_PROXY`。在 Remote SSH 会话中 `127.0.0.1` 指远端主机而非 dsh 机器，除非远端自身也暴露同一代理，否则不要使用该地址。`web_fetch` 不保证支持显式代理，不要承诺可用。

工具不会改变所选 scope、不会自动重放模型或业务请求，也不会返回订阅链接、凭据、原始日志或节点错误原文。探测或测速失败会按失败返回，不自动重试，也不代表连接成功。

当前源码不再创建或修改全局 `AGENTS.md` 或 `.AGENTS.md` 规则文件。旧 `writeMemory` 字段已无效，不能启用规则写入；面向 AI 代理的说明仅由现有 `local_network_proxy` 工具提供，工具定义未改变。已有的全局规则文件保持原样，不会被自动编辑或删除。该改动不在已发布的 `v0.3.3-standalone.3` 资源中，运行中的宿主需在下次重启后加载。

## 图片

图片功能使用 dsh 的持久附件路径：

- 在 Web 输入框中按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴图片，或把图片拖入输入框；
- 在 Windows 上的适配版 dsh-tui 按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴剪贴板图片，或输入 `@相对/图片.png`；剪贴板图片直接进入附件库，路径图片由当前 workspace 的文件系统读取；
- 让模型调用 `read_image`：工作区图片使用 `file_path`，HTTP(S) 图片使用 `url`；
- 在当前 dsh 附件限制内支持 PNG、JPEG、WebP 与 GIF；
- 只有明确声明支持图片输入的模型才能接收图片。

任何支持视觉输入的当前对话模型都可以使用 `imagegen`。当前模型只需编写普通提示词，并在 `referenced_image_paths` 与 `num_last_images_to_include` 中选择一种参考图来源；插件从 `ctx.fs` 或附件存储读取字节，再发送给配置的 GPT Image 后端。模型不会输出 base64。每个结果都会直接显示在对话中、保存为持久附件，并写入当前工作区。`output_path` 用来指定位置；省略时会创建唯一的 `generated-<时间戳>-<id>.png` 文件。本地保存能力包含在本插件中；当工作区由 `dsh-remote-ssh` 管理时，远程插件负责 AHP 写入路径。

设置页可选择 `gpt-image-2`（当前 Codex 默认）、`gpt-image-2.5`、`gpt-image-2.5-sunburst` 或 `gpt-image-2.5-flare`，并提供独立的 **增强 read_image** 与 **允许其他模型使用生图** 开关，两个开关默认开启。关闭第一项会撤销插件的 agent-scope 覆盖，恢复 Harness 原本只接受本地路径的 `read_image` Schema。关闭第二项后，Codex 视觉模型仍可使用 `imagegen`，其他模型提供方的调用会在执行入口被拒绝。

`read_image` 在返回实际图片块之前，会先验证图片并把字节持久化为 dsh 附件。本地路径原样委托给 Harness，继续沿用当前文件系统和沙箱行为；URL 扩展会限制重定向次数与下载字节数，拒绝内嵌凭据和本地／私网／特殊网络目标，并在每一跳把连接固定到已经验证的公网地址。

对符合条件的 Codex GPT 会话，Web 输入框还会显示仅对当前会话生效的 Fast Mode 开关。开启后只为该会话加入提供方的 priority service tier，不会修改已保存的模型设置；旁边的额度条显示对应的每周额度和提供方声明的重置时间。设置页另有默认关闭的 **默认强制开启 1.5 倍速** 开关，开启后所有会话默认使用 1.5 倍速，无需逐会话点击开关，但额度消耗更快。

## 搜索

提供方会把 dsh 的 `web_search` 工具连接到 Codex 使用的独立搜索协议。搜索结果是普通 dsh 文本和 HTTP(S) 引用，因此后续轮次与压缩会保留同一份工具历史。

在 profile patch 中配置 `llm-openai-codex`：

```yaml
- id: llm-openai-codex
  config:
    searchMode: live
    searchContextSize: medium
```

| 字段 | 默认值 | 可选值 |
|---|---:|---|
| `searchModel` | `gpt-5.6-sol` | Codex 模型 id |
| `searchMode` | `cached` | `cached`、`indexed`、`live` |
| `searchContextSize` | `medium` | `low`、`medium`、`high` |
| `searchMaxOutputTokens` | `10000` | 正整数 |

dsh-codex 0.3.0 不再写入已停用的 `web/openai-codex-search-llm-request` 事件。早期版本写入此外部事件时没有可忽略信封标记，后续 Harness 格式迁移可能因此拒绝原本完整的 Session。普通 `web_search` 调用与结果仍通过 Harness 现有的 `tool/call` 和 `tool/result` 事件持久化。

受影响的用户应按**[历史 Session 修复指南](docs/session-repair.zh.md)**操作。命令默认只做 dry-run，保留源 generation，并要求停止 dsh 后显式传入 `--apply`。

## Responses API 实验功能

设置页提供两个默认关闭、仅作用于 `openai-codex` 的开关：

- **WebSocket 上下文复用**：保持 `store: false`，并选择 pi-ai 的 Codex WebSocket continuation 传输。同一会话继续复用连接，且下一轮与已有上下文严格衔接时，请求会通过 `previous_response_id` 只发送新增输入；历史改写、压缩、Fork、连接中断或进程重启后会自动发送完整上下文。关闭开关时，普通轮次使用 SSE，每次都发送 Harness 完整上下文。
- **原生 Responses 压缩**：按 Codex 当前的 V2 流程，把现有历史和一个 `compaction_trigger` item 发给 `codex/responses`。近期客户端消息与返回的加密 compaction item 会一起保存在 Harness 检查点中，并在后续 Codex 请求发送前还原。发布该检查点前，插件会用 Host token meter 对持久化标记做本地保守估算，并附加 256 token 的 frame 余量，只有估算严格小于被替换的源文本时才使用原生检查点；这是保守的收缩判断，不是对加密项的真实 token 计量。缺少 token meter、没有可用的源文本预算或结果过大时，同一次调用回退普通 Harness 摘要，因此失败路径可能先产生一次 native 请求再产生普通摘要。核心 `dsh-compaction-basic` 的收缩 gate 仍然保留，完整 retained 数据不会被截断或外置；256 余量对应已验证的当前 Harness 检查点 frame，不承诺适配任意 runtime。关闭开关不会破坏已经生成的检查点。V2 压缩不可用或请求失败时，同一次调用会自动回退到原来的 Harness 模型摘要。

两个开关互相独立。所有普通 Codex 请求都保持 `store: false`；默认配置使用 SSE 和 `dsh-compaction-basic` 的文本摘要路径。

聊天历史里的原生检查点只显示「已使用Codex远程压缩」标签，不展开或展示其加密正文；普通摘要、以及缺少完整原生标记的历史仍按原样显示。该行为只作用于展示层：持久检查点、旧日志与请求 payload 均不改变。

当前源码还提供 `codex_context` 工具（`status` / `request_compaction` / `recall`）：只作用于当前会话；`request_compaction` 只受理并返回 `queued` 凭据，真正压缩在本轮结束后的 idle 边界执行，`queued` 不等于成功，来源 turn 被取消则不执行，自动阈值与兜底路径保持不变。`recall` 只读有界纯文本，不返回 system/developer 隐藏提示与 opaque 加密块。压缩诊断仅写入少量元数据（无正文、无凭据 token——数值 token 计数会保存；无第二份历史库），并经官方 Gateway 与 `sessionQuery` 可见性只读暴露。详见 [docs/compaction.md](docs/compaction.md)。该能力仅存在于当前源码，未发布。

当前源码提供对话内压缩请求卡和独立运行提示：queued 表示等待会话空闲，running 提示“正在压缩上下文，后续消息将排队等待”；提示不受工具组折叠影响，终局后消失，成功详情仍看原压缩历史行。排队由 Harness 既有机制处理；底栏只移除 Codex 压缩入口，Fast Mode 与额度指示保留。自动测试已通过（`pnpm run check`，49 files / 573 tests，含双 tsc 与 host/client build）；用户重启后的截图确实看到运行提示与“运行中”，随后 `status` 对同一请求返回 `completed`，这证明提示与完成，但不据此单独声称 native 或真实 FIFO。截图发生在字号缩小之前，字号缩小后的视觉效果仍待确认。不承诺普遍 HMR，未发布。

## 凭据与隐私

dsh 登录默认与 Codex CLI／Desktop 相互独立：

- 凭据存储于 `$DSH_HOME/.openai-codex-auth.json`，默认位于 `~/.dsh`；
- 文件原子写入，token 刷新会在本地 dsh 进程之间加锁；
- 浏览器状态和诊断不会返回 token 值；
- 绝不复制或修改 `~/.codex/auth.json`。

分离存储可以避免两个客户端竞争同一个会轮换的 refresh token。移除 bundle 不会删除凭据；需要移除本地账号时，请使用账号页面或 `logout` 命令。

若要共享现有登录，将插件配置 `credentialFile` 设为 JSON 文件的绝对路径，例如 `C:/Users/you/.codex/auth.json`。已有文件按形状识别：Codex 的 `tokens`、CPA/CLIProxyAPI 的 `type: codex`、OpenCode 的 `openai`、Pi 的 `openai-codex`、扁平 OAuth，以及 dsh 原生格式。不认识、有歧义、字段不完整或只有 API key 的文件会明确报错；文件不存在时创建 dsh 原生格式。请使用普通文件而非符号链接或硬链接，POSIX 下要求仅属主可读写。

选中的凭据只允许包含已识别的字段；存在未知字段时，在刷新或写入前拒绝使用，诊断仅指出字段名、不输出字段值。更新保留识别出的布局、已知元数据和其他 provider 的独立条目。provider 专属 OAuth 刷新函数保留并写回新的 access、refresh、ID token，以及可获取的 email，不再使用 pi-ai 丢弃身份字段的 token 投影。登录复用 pi-ai 的交互流程，随后补一次完整刷新再保存。响应缺少 ID token 时明确失败，而非悄悄保留过时身份。退出登录只清空选中的 OAuth 字段，不删除整个共享文件，也会影响使用该登录的其他程序。

显式共享文件仅做进程内串行化，不使用 `.lock` 或刷新意图协议。写入前重新读取文件，检测到同一凭据被其他写入者更新则报错。同目录临时文件替换可在支持该语义的本地文件系统上避免本插件写出半截 JSON，但不保证断电持久性或与其他程序互斥。同时刷新仍可能竞争，写后读回校验也无法解决这一点。默认独立 dsh 存储继续保留原有跨进程锁。

## 兼容性说明

- 当前源码面向成套发布的 DSH `0.2.0-rc.1` 插件表层，并使用其正式的 volatile settings 与 `dsh-http-proxy` 实现。同时使用 `@earendil-works/pi-ai` `0.85.1`；adapter 仍会在读取历史时迁移旧版 pi-ai replay envelope，因此升级后已有 reasoning／tool 元数据可继续使用。
- 插件只使用已发布的 dsh 插件表层，不要求修改版 Harness checkout。单独安装时即可生成附件并保存本地输出。
- ChatGPT 套餐资格、模型权限、配额及后端行为由 OpenAI 控制，可能发生变化。
- Codex 端点不执行普通 Responses 的 `max_output_tokens` 字段。压缩可以工作，但该路由无法在服务端落实配置的摘要上限。
- 文件系统、shell、skills、MCP、subagents、权限、附件、压缩和 `web_search` 工具本身仍来自当前 dsh profile。
- 一体化版本面向本 checkout 的 dsh `0.2.0-rc.1` 表层开发，目标运行时为桌面端 `0.2.1-rc.2`。各自的验证契约与边界记录在 [docs/standalone.md](docs/standalone.md)：仓库测试模拟 OpenAI 流量，不会使用真实账号登录。
- 独立搜索端点不是公开的 OpenAI Platform API；兼容性取决于固定版本的 Codex／pi-ai 实现。

协议、持久化与生命周期细节见[设计文档](docs/design.zh.md)。

## 开发

```sh
pnpm install
pnpm run check
```

该检查会执行严格的 Host 与浏览器 TypeScript 检查、聚焦测试以及两个运行时 bundle 的构建。

## 许可证

Apache-2.0
