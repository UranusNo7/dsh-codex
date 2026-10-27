# 一体化构建（standalone）：能力、验收与边界

本文件说明 `0.3.3-standalone.3` 的定位、随包能力、已验证范围和尚未验证的部分。目标是**基础 dsh + 本插件**即可使用 Codex 订阅能力，不再安装 `dsh-custom-header` 或 `dsh-gpt-compat`。

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
| Codex 独立搜索 | `src/search.ts`、`src/search-event.ts` |
| 设置页与账号页接口 | `src/auth-routes.ts`、`src/client/` |
| `read_image` 的 HTTP(S) 输入与 `imagegen` | `src/read-image-enhancement.ts`、`src/imagegen.ts`、`src/public-http.ts` |
| 三态网络代理与保存时连通性测试 | `src/proxy.ts`、`src/auth-routes.ts` |
| 内置出网代理节点管理（mihomo 内核 + geodata、订阅/测速/自动选节点、Codex-only/全局） | `src/net-proxy/index.js`、`bin/net-proxy/`、`cordis.patch.yml` |
| **仅 Codex 的冗余提权清理** | `src/tool-compat.ts`，由 `src/index.ts` 通过 `ctx.inject(['tools', 'sandboxPolicy'])` 挂载 |
| bundle 组成补丁 | `cordis.patch.yml` |

内置模型目录补充（`src/adapter.ts`）：`gpt-6.1-terra` 复用 pi-ai 的 `gpt-5.6-terra` 请求模板，默认
`context_window` 500,000、`maxTokens` 128,000，输入为文本与图片。推理档位不由目录声明 `off`
（Codex 官方元数据未提供该档位，内置映射为 `off: null`）；DSH 将 `minimal` 映射为 `low`，并支持
`low`/`medium`/`high`/`xhigh`/`max`。`ultra` 不提供，因为当前 pi-ai `ThinkingLevel` 类型边界未包含
该档位。Codex `models_cache.json` 中该模型的新元数据（名称、输入模态、推理档位、默认
`context_window`）会在加载后覆盖内置值。默认路由仍为 `gpt-5.6-sol`，本次目录补充不改变
`0.3.3-standalone.2` 版本或发布物。

提权清理规则（失败即保留，fail-closed）：

- 仅当**已能确定当前沙箱策略**、请求目标**不严格宽于**当前模式（`requested <= current`），且请求 provider 严格为 `openai-codex`、工具属于 `bash`／`pwsh`／`write`／`edit`、该工具 schema 声明了 dsh 原生提权契约时才介入。该契约要求 `sandbox_permissions` 枚举包含 dsh 的两个合法提权目标 `workspace-write` 与 `danger-full-access`（`read-only` 只是当前策略模式，不是提权目标），并要求 `justification` 为字符串。
- 仅移除 `sandbox_permissions` 与 `justification`；真正扩权、未知目标、当前策略未知或解析失败、provider 或 session 缺失时保持原样，交由 dsh 原生审批与拒绝逻辑。
- 不修改沙箱策略、调用标识或信号；插件 fiber 释放后监听器随之解绑。

**刻意不包含**：`dsh-custom-header` 的全局请求头改写。本插件不会全局重写 `User-Agent`，也不会统一冒充 `codex_cli_rs`；各 provider 与协议路径保留自身既有的 originator（pi-ai 协议默认 `pi`，独立搜索与生图为 `deepseek-harness`，原生压缩为 `dsh-codex`）。另外，“仅 Codex”代理模式直接经 `undici` 发送，不会经过全局 `fetch` 中间件。

## 内置出网代理

- 随包内置 `dsh-net-proxy` 的节点管理：mihomo 内核与 geodata 位于 `bin/net-proxy/`，无需另装代理客户端。
- 插件设置页负责订阅导入、节点测速、固定节点或自动选择最快节点，以及代理启停。
- 代理范围默认 **仅 Codex**，只影响 Codex 流量；可切换为 **整个 dsh**。
- 内置内核仅支持 **Windows x64**；插件自身代码与平台无关。
- **不要与独立的 `dsh-net-proxy` 插件同时启用**：两者会各自启动内核，并争用同一份本地状态与端口。
- 内置内核与 geodata 的许可、来源与实际字节 SHA-256 见 [third-party-notices.md](./third-party-notices.md)。

## 验收矩阵

| 范围 | 证据 | 结果 |
| --- | --- | --- |
| 一体化挂载（仅核心 + 本插件，无第三方插件） | `tests/standalone.spec.ts`：真实 `Context`、`ToolRuntime`、`SandboxPolicyService`、`SessionProjectionRuntime`、`SandboxedFileSystem`、`LlmRuntime`、`WebRuntime` | 通过 |
| 模型目录 | 同上：`llm.listProviders()` 仅 `openai-codex`，`llm.listModels()` 含 `gpt-6-sol` 与内置 `gpt-6.1-terra`；`tests/model-catalog.spec.ts` 覆盖 Terra 的 500K 默认窗口与缓存元数据合并 | 通过 |
| 独立搜索挂载 | 同上：真实 Web 注册表中的 `openai-codex` 搜索 provider | 通过 |
| 账号／设置接口挂载 | 同上：记录 `webServer.register` 的 12 条路由，覆盖 auth、fast-mode、image-tools、response-api、context-window、models、model-fallback、proxy | 通过 |
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
  协议、默认模型与既有能力不变。

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

## 安装

从 GitHub 预发布资源安装（桌面端用 `--profile desktop`，Web 用 `--profile web`）：

```sh
dsh plugin --profile desktop add "https://github.com/UranusNo7/dsh-codex/releases/download/v0.3.3-standalone.3/dsh-codex-0.3.3-standalone.3.tgz"
```

该安装包以 `v0.3.3-standalone.3` GitHub 预发布资源分发，未发布到 npm。安装后重启桌面端
dsh，再在 **设置 → OpenAI Codex** 完成账号登录。不要安装 GitHub 自动生成的源码压缩包，也
不要再安装 `dsh-custom-header` 或 `dsh-gpt-compat`。
