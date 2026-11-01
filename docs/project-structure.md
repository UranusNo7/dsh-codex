# 项目结构

本文件记录仓库既有目录职责、`0.3.3-standalone.2`/`.3` 新增模块的落点，以及当前源码中尚未发布的改动，便于后续维护与打包白名单核对。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/` | 插件源码：`index.ts` 组合入口；`adapter.ts` 模型适配；`auth*.ts`/`oauth-*.ts`/`store.ts` 账号与凭据；`auth-routes.ts` 设置/登录路由；`model-catalog.ts`/`model-catalog-remote.ts` 模型目录与官方目录客户端；`proxy.ts` 代理与连通性探测；`search*.ts` 搜索；`image*.ts`/`read-image-enhancement.ts` 图像；`tool-policy.ts`/`tool-compat.ts` 工具策略与兼容；`net-proxy/index.js` 内置出网代理；`tui.ts` 终端入口。 |
| `src/client/` | Web 设置页与客户端 UI（`OpenAICodexSettings.tsx`、locales 等），经 `lib/client.js` 注入。 |
| `tests/` | Vitest 单元/集成测试；`tests/fixtures/` 为静态测试数据。 |
| `docs/` | 设计与行为文档（`design*`、`session-repair*`、`third-party-notices.md`、`standalone.md` 等），随 `files: docs` 发包。 |
| `lib/` | 构建产物（gitignored）：`index.js`、`client.js`、`bin.js`、`tui.js`、`invariant.js` 及 chunk/d.ts。 |
| `bin/net-proxy/` | 内置出网代理运行时：mihomo Windows x64 内核（`mihomo-windows-amd64-compatible.exe`）与 geodata（`geoip.metadb`、`geosite.dat`）。二进制原样随包分发，实际字节哈希见 `docs/third-party-notices.md`。 |
| `licenses/` | 随包第三方组件的许可全文；`licenses/dsh-net-proxy/LICENSE.txt` 为内置代理运行时的 MIT 许可。 |
| `dist-package/` | 本地发布/打包工作区（gitignored）：干净的 source stage、`.tgz`、consumer 烟测目录。 |

## 本轮新增与变化

- `src/tool-compat.ts`：仅面向 Codex 的 fail-closed 安全清理。只在请求路由为 `openai-codex`、
  工具属于 `bash`/`pwsh`/`write`/`edit` 且 schema 明确声明升级 contract 时，移除不会扩大当前权限的
  `sandbox_permissions`/`justification`；真扩权、未知值、缺 agent/session、策略异常与第三方工具
  一律保留。代码改编自 MIT 许可的 dsh-gpt-compat，来源与许可见 `docs/third-party-notices.md`。
- `src/index.ts`：以 `ctx.inject(["tools", "sandboxPolicy"], ...)` 可选挂载上述清理，listener 随
  插件 fiber 释放；无 tools/sandboxPolicy 的基础组合仍可加载，未新增硬依赖或配置开关。
- `src/adapter.ts`：内置模型目录补充 `gpt-6.1-terra`（复用 pi-ai 的 `gpt-5.6-terra` 请求模板，
  默认 `contextWindow` 500,000、`maxTokens` 128,000，文本/图片输入；目录不声明 `off`，DSH 将
  `minimal` 映射为 `low` 并支持 `low`/`medium`/`high`/`xhigh`/`max`，`ultra` 因 pi-ai
  `ThinkingLevel` 类型边界不提供），排序与其他 `gpt-6-*` 条目同级；未新增模块、依赖或配置开关。
- `tests/tool-compat.spec.ts`：真实 ToolRuntime + approval seam 下的清理/审批/路由/生命周期覆盖。
- `tests/standalone.spec.ts`：仅基础 DSH 服务 + 本插件的端到端能力矩阵，见
  [standalone.md](./standalone.md)。
- `src/net-proxy/index.js`：内置出网代理主逻辑（自 MIT 许可的 dsh-net-proxy 合入并做最小集成），
  Web 设置入口负责订阅导入、节点测速、固定/自动选节点与启停；默认仅代理 Codex，可切换整个 dsh。
- `src/local-network-proxy-tool.ts`：AI 工具 `local_network_proxy`（status/enable/test/select），仅调用
  net-proxy 管理器；不改变 scope、不自动重放模型/业务请求、不返回订阅/凭据/日志/节点错误原文；
  测速与设置页共用串行保护，`select` 固定节点、仅 `auto` 或 `auto_select=true` 解除固定。
- `src/proxy.ts` / `src/auth-routes.ts`：保留的旧三态 HTTP(S) 代理设置与保存时连通性测试，供既有
  API、CLI 与 TUI 兼容使用；已保存值不会被自动清空或迁移。
- `bin/net-proxy/` + `licenses/dsh-net-proxy/` + `docs/third-party-notices.md`：内置 mihomo 内核
  （Windows x64）、geodata 与对应许可/来源/哈希声明；不要与独立 `dsh-net-proxy` 插件同时启用。

## 官方动态模型目录（本轮源码，未发布）

- `src/model-catalog-remote.ts`（新增）：官方目录客户端。固定来源
  `https://chatgpt.com/backend-api/codex/models?client_version=0.165.0`（`0.165.0` 只是验证所对照的
  官方客户端版本，不代表实现其全部能力；非公开 `/v1/models`），拒绝重定向；TTL 300 秒、失败冷却
  60 秒、单次请求 20 秒超时、响应体 4 MiB 流式上限、最多 200 条；请求合并、账号切换/销毁时使旧的
  在途结果失效；失败只返回固定脱敏码。
- `src/model-catalog-remote.ts` 缓存：`<credentialFile>.models-cache.json`（写入时请求 POSIX mode
  0600），按宿主机凭据文件隔离，文件内以账号 SHA-256 校验；只存转换所需字段（slug、显示名、
  `visibility`、默认 `context_window`、输入模态、推理档位）与 `fetchedAt`，不存 token、账号 ID、
  响应头或工具策略。`restore()` 只读本地身份以便离线恢复；`refresh()` 通过 provider 原生 OAuth
  （pi-ai `getAuth`）解析凭据。
- `src/model-catalog.ts`：官方快照可用时以 `visibility: list` 列表作为选择器权威子集
  （`advertised()`）；刷新失败保留同账号最后成功的官方快照并优先于回退来源，没有可用快照时才回退既有
  Codex `models_cache.json`，再回退随包目录（`fallbackSource()`）；Codex 缓存只补传输模板、不覆盖官方
  元数据；官方/缓存中消失的非随包模型仅在同进程保留传输元数据，账号变化时清空。`ultra` 仍不受 pi-ai
  `ThinkingLevel` 支持，无随包价格的新模型按 0 价格估算。
- `src/service.ts`：目录生命周期绑定插件凭据文件；`warmModelCatalog` 在组合时后台预热；
  `refreshModelCatalog(force)` 先 `restore()` 再按 TTL（或强制）刷新；登录成功 adopt 新账号、退出登录
  丢弃旧目录；`modelCatalogSettings()` 投影 `discovery` 来源/时间/脱敏错误。
- `src/auth-routes.ts`：`GET /plugins/dsh-openai-codex/models` 恢复快照后按 TTL 刷新；
  `POST /plugins/dsh-openai-codex/models/refresh` 强制刷新；保存勾选的 POST 返回同结构（含
  `discovery`）；登录采用/退出清理回调接入；账号与设置路由由 12 条增至 13 条。
- `src/index.ts` / `src/adapter.ts`：把官方快照源与 provider 懒连接，报告非官方回退来源；设置候选
  改为 `advertised()` 子集，隐藏/已保存模型仍可解析。
- `src/tool-policy.ts`：新增共享 `ModelCatalogSource`、`ModelCatalogDiscovery`，`ModelCatalogSettings`
  增加可选 `discovery`；不含任何凭据字段。
- `src/client/OpenAICodexSettings.tsx` / `src/client/locales.ts`：模型选择区域新增双语「从 OpenAI 刷新」
  按钮，刷新期间与勾选保存互斥；显示来源与最后成功时间；失败保留列表并本地化提示，不展示原始错误
  正文；沿用现有 slot 与视觉 token，无新增模块/工具/slot。
- 测试：新增 `tests/model-catalog-remote.spec.ts`、`tests/service.spec.ts`；更新
  `tests/model-catalog.spec.ts`、`tests/auth-routes.spec.ts`、`tests/service-config.spec.ts`、
  `tests/openai-codex-settings.client.spec.tsx`；`tests/standalone.spec.ts` 本轮未修改，仅作为既有
  挂载/路由验证覆盖沿用。
- 该能力仅存在于当前源码，未包含在已发布的 `v0.3.3-standalone.3` 中；版本号与发布状态未改变。本地构建
  已完成，宿主未重启，当前 GUI 未做新功能运行态验收。

## 取消全局规则写入（本轮源码，未发布）

- `src/net-proxy/index.js`：删除安装时写入全局代理说明的逻辑，不再创建或修改 `AGENTS.md` /
  `.AGENTS.md`；旧 `writeMemory` 配置不再启用任何写入；已有全局规则文件不会被自动编辑或删除。
- `src/local-network-proxy-tool.ts`：AI 代理说明仍由既有 `local_network_proxy` 工具提供，工具定义与行为
  未变。
- 该改动仅存在于当前源码，未包含在已发布 `v0.3.3-standalone.3` 中；未发布，宿主需下次重启后加载。

## 原生压缩安全预检（本轮源码，未发布）

- `src/responses.ts`：新增 `TokenEstimator` 与 `OPENAI_CODEX_CHECKPOINT_FRAME_ALLOWANCE = 256`；
  `OpenAICodexResponseRuntime` 第 3 参数可选 estimator，`enterCompaction(sessionId, sourceText?)` 绑定
  每次压缩的源预算；只有 `estimate(marker) + 256 < sourceBudget`（严格小于）才发布 native marker，
  否则复用同一次调用的 standard summary 流。取消不 fallback；估算/解码异常安全降级；v1 marker 重放不变。
- `src/adapter.ts`：从原始 `GenerateOptions.messages` 提取 text-only source 预算（去 system、去最后
  压缩指令，不计 reasoning/tool-call 参数/image/file），经 `createOpenAICodexAdapter` 末尾可选参数的
  estimator 传入 runtime。
- `src/index.ts`：惰性读取 `ctx.get('tokenMeter').estimateMessage`；服务缺失返回 `undefined`，native
  直接禁用，不发 native 请求。
- `src/client/locales.ts`：仅更新既有 `nativeCompactionHint` 双语提示，说明保守预检与自动回退；未新增
  UI 或工具定义。
- 未增加 hard deps、未使用新 session 事件、未改核心 gate/协议；仅存在于当前源码，未发布。

## 原生压缩历史展示（本轮源码，未发布）

- `src/client/NativeCompactionPresentation.tsx`：新增展示层模块。仅处理 `conversation.chat.node` 的
  `compaction`（自动）与 `manual-compaction`（手动）两个 keyed cell：从 `slots.entries()` 捕获 stock
  组件与其 priority/locale，在 `priority - 1` 注册委托包装；stock 带 `inject`/`children`/`store` 时
  不遮蔽。仅当 summary 是**完整有效的 v1 marker**（闭合标记 + 可解析 JSON + 含 `type:"compaction"` 项）
  时，浅拷贝 node 并把 summary 投影为标签（自动 `data.summary`、手动 `data.compaction.summary`），
  同时只覆盖 `message.compaction` / `message.compaction.commandTitle` 两个标题键；其余节点按引用原样
  传给 stock，不做任何修改。
- `src/client/index.tsx`：`apply` 中经 `ctx.effect` 安装上述包装，传入本地化标签 getter；未新增
  slot 或工具，复用 stock UI 结构，普通摘要与无 marker 历史行为不变。
- `src/client/locales.ts`：新增 `nativeCompactionLabel`（EN `Used Codex remote compaction`、ZH
  `已使用Codex远程压缩`）；不改既有 `nativeCompactionHint` 语义。
- 仅展示层：持久检查点、旧日志与请求 payload 均不改变；不新增 hard deps（`entries()` 为公开
  Slot 服务方法，`component: unknown` 属 render-erased，故保留拒遮蔽的安全闸门）。仅存在于当前源码，
  未发布。
