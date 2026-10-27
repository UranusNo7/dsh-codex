# 项目结构

本文件只记录仓库既有目录职责与 `0.3.3-standalone.2` 新增模块的落点，便于后续维护与打包白名单核对。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/` | 插件源码：`index.ts` 组合入口；`adapter.ts` 模型适配；`auth*.ts`/`oauth-*.ts`/`store.ts` 账号与凭据；`auth-routes.ts` 设置/登录路由；`proxy.ts` 代理与连通性探测；`search*.ts` 搜索；`image*.ts`/`read-image-enhancement.ts` 图像；`tool-policy.ts`/`tool-compat.ts` 工具策略与兼容；`net-proxy/index.js` 内置出网代理；`tui.ts` 终端入口。 |
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
  设置页负责订阅导入、节点测速、固定/自动选节点与启停；默认仅代理 Codex，可切换整个 dsh。
- `bin/net-proxy/` + `licenses/dsh-net-proxy/` + `docs/third-party-notices.md`：内置 mihomo 内核
  （Windows x64）、geodata 与对应许可/来源/哈希声明；不要与独立 `dsh-net-proxy` 插件同时启用。
