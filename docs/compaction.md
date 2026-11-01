# 压缩诊断与 codex_context（当前源码，未发布）

本文只说明本插件在**当前源码**中新增的压缩相关能力与边界。它不改 dsh core、协议、计量服务或任何外部 bundle/patch 配置；未发布、未自动重启宿主，包版本未变。图形与运行态结论以实际宿主为准。

## 模型工具：`codex_context`

单一工具，三个 action：

- `status`：只读事实——owner 状态、当前 queued ticket、最近一次边界执行结果，以及（可用时）本地估算与 provider usage。
- `request_compaction`：只**受理一次**并返回 `queued` 凭据；真正执行发生在本轮结束后的 idle 边界，由公开 `agent/status` 事件驱动。`queued` 不是完成，也不承诺原生路径一定被选中。
- `recall`：仅从**当前 Agent 自己的会话**读取有界纯文本；无 `sessionId` 参数。

约束：

- 会话身份固定来自调用 Agent（`exec.agent.session`），不接受模型传入的会话 id。
- 受理时绑定**来源 turn**：只读公开 `turnBoundary` 投影——`openTurnStartSeq` 非 null 时取其 `lastTurn` 作为逻辑 turn（seq 不是 turn）；能力缺失或 turn 未打开则在受理时直接拒绝（`source-turn`），不扫旧日志、不会先受理再必然失败。完成判定只来自既有 `session/event` 中该来源 turn 的 `turn/end`。
- 来源 turn 以 `completed` 结束才执行一次；若该 turn 被取消/中断（durable `turn/end` 事实）则不执行；不把邻近或最新 turn 归给该 ticket。
- 保留原自动压缩阈值与兜底路径；同 session 去重，完成后有冷却（默认 60s，测试可注入）。卸载/dispose 会 abort 并等待在飞 maintenance，不残留后台 promise。
- `recall` 有界：默认 20 条、上限 50、总字符 16KB、扫描窗口 2000 个事件，返回 `nextFromSeq`；只取 `user/assistant/tool` 文本。`system/developer` 隐藏提示与整块 v1 opaque marker **不返回**；有 `query` 时返回命中位置周边片段（`charOffset`/`totalChars`），否则取前 500 字符。读取经 Host 注入的只读历史端口完成（index 用公开 `sessionQuery.observeSession` 的冷观察并释放，不 resume Agent）；控制器不持有会话句柄、不自行扫描目录、不重建或激活 Agent；端口缺失/失败返回 `history-unavailable`。
- owner 判定以 **Agent 作用域 compaction 服务** + 进程级**外部声明**为依据，得到 `available` / `declared-takeover` / `conflict` / `unavailable` 四态；外部 gate 仅安装不等于接管，`declared-takeover` / `conflict` / `unavailable` 只报告、不主动执行，不修改任何外部配置。
- 仅对 `openai-codex` 路由的 Agent 暴露。若会话切换到其它 provider：首轮可能仍展示该 schema（无公开更早边界），但该轮所有调用一律拒绝（`reason: "provider"`），定义在已验证的 `agent/request`/`request/header` 边界重挂。

## 对话内展示（用户已见运行提示；字号调整后的视觉待确认）

- 压缩请求卡挂在公开 `tool.call.toolview` 的 `key: "codex_context"` 上；只有 `request_compaction` 渲染压缩请求卡，`status` / `recall` 各自保留结果并独立可折叠，不伪装成压缩 ticket。
- `src/client/CompactionTurnNotice.tsx` 通过公开 `conversation.chat.turnTail` 注册 `openai-codex-compaction-turn`（order 15），在工具组之外显示运行提示，不受其折叠影响；订阅 rc5 公开 `turnDataSource` 的本 turn 工具结果，以真实 `requestId` 精确查询现有 RPC。queued 等待空闲后开始，running 显示“正在压缩上下文，后续消息将排队等待”，终局时消失，成功历史保持不变。注册保留 `slots.inject/register` 的成员调用并返回 disposer；可选注册失败仅固定警告，不阻断 client 启动。
- 工具卡文案以准确性为先：排队态显示“压缩已排队，将在会话空闲后开始”（不暗示受理即阻止新对话）；运行态显示“正在压缩上下文，后续消息将排队等待”；只有同一 `compactionId` 的 `selected-native` 证据才称为远程压缩。
- 请求卡状态：`queued`（已受理、未开始）、`running`（执行中），以及无 checkpoint 的终局（`noop` / `busy` / 拒绝 / 失败 / 取消）；`completed` 只显示简短结论（原生检查点或普通摘要已提交），**详情仍复用现有压缩历史行**，不复制、不伪造、不重写 `/compact` 命令。
- 压缩期间的新消息由 Harness 既有机制（core FIFO）排队等待（不新增队列）：压缩完成/失败释放后按顺序继续；普通消息在释放前不会开始新 turn 或正常 LLM 请求。
- 关联以真实身份为准：`requestId` 来自本工具自己的 result；`snapshot.requests` 为 optional，按 phase + result 精确 join。只有在诊断记录持久保存成功且 link（`requestId` + `compactionId`）完整时才可恢复；持久化未成功、旧记录无 link、或 `noop`/`queued` 在重启后没有持久记录时，一律显示 `unknown`，不按时间或邻近猜测。
- 底栏仅移除 Codex 压缩 entry；Fast Mode 与 quota 指示保留。成功只能由核心 fact 证明（`compaction/end` 无错误 + 同 `compactionId` 的替换检查点）；实时 phase 与 `noop` 来自 controller 内存事实，不是持久承诺；重启后缺 metadata 一律 `unknown`。


## 状态与事实

- `facts.native` 是**成功事实**：核心 `compaction/end` 无错误，且替换检查点携带同一真实 `compactionId`。只有 `decision.selected-native` 才仅表示“选择了原生检查点”，不代表成功。`fallback` 是 ordinary 成功事实加触发降级的精确 metadata reason（如 `no-estimator` / `not-smaller` / `native-request-failed` 等），不是含糊的“失败”。`noop` 只来自 controller 真实返回 `null`（零日志写入），不是事件折叠出的成功。`failed` 的主要事实来自核心 `compaction/end`（其 `error` 是**字符串**，不作语义解析）；`cancelled` 只有在同一 `compactionId` 上存在明确 aborted 诊断证据时才细分，不靠错误消息文字猜测。
- 本地估算与 provider usage 是两类独立事实，各自带 `source` 与时间；不互相替代、不伪造 token。
- 失败只暴露固定 reason 词表（如 `busy` / `aborted` / `summary-failed` / `noop`），不返回原始错误正文、prompt 文本或 opaque payload。

## 诊断存储与只读读取

- 设计上每个真实 `compactionId` 的少量元数据写入插件自有 `storageDomain` KV（表 `attempts`，键 `<sessionId>/<compactionId>`）；无正文、无凭据 token 字符串、无第二份 history DB（token 计数等数字事实会保存）。**已知限制（本轮未改）**：当前后端对 domain 名与 key 的合同与该约定不符，实际大概率仅内存生效（`storageDomain` 缺失时同样仅内存），重启后旧诊断恢复可能不可用，不声称完全持久化；核心会话历史与该元数据相互独立，不受影响。本轮不改存储结构，文档不记录具体会话标识，无法关联时按 `unknown` 处理。
- 只读 Typert Remote `codexCompaction/read` 沿用官方冷读模式：认证 Gateway/profile 与 Connection、endpoint 权限、`sessionQuery` 会话可见性；不声称 per-session capability，不 resume、不创建冷 Agent。
- 持久化缺失、旧记录或无法关联时诚实返回 `unknown`，不做时间邻近推断。metadata 写入与 Session 事务**不原子**：不承诺与事件提交同步，两者之间缺失只能报 `unknown`。

## 依赖与测试边界（真实记录）

- 依赖：`zod` 4.4.3、`@deepseek-ai/dsh-typert-protocol` peer `^0.2.0-rc.1`；新增 8 个 dev 核心测试包都 `0.2.0-rc.1`，桌面实际 runtime 为 `0.2.1-rc.5`——不同版本事实，不混称、不暗示桌面 runtime 全 rc1。
- 本轮 `pnpm run check`：`49 files / 573 tests` 全绿，双 tsc 与 host/client build 均通过。新增覆盖：UI 6 例、真实 slot 9 例、真实 client `$mount` 8 例、真 driver 13 例（含 held 进行中真实 query 仍可读并正常结束）；自动化联合测试基于 rc1，rc5 已做源码对照，尚无 rc5 真机自动化 E2E（桌面 runtime 为 rc5）。本次字号/客户端作用域修复未新增依赖，也未改 Host 产品与存储结构。
- 工具 schema 的真 token meter 增量 973 local tokens：**只计 schema，不含 guidance，也不是 provider 账单**。
- 本次上传前的自动化检查未额外发起真实压缩请求；此前 native 成功证据属于既有能力，不替代新后端的验证。

## 当前运行态边界（重要）

- **上一轮重启后的旧能力已确认**：用户重启宿主后，`status` 显示 owner `available`（provider `openai-codex`），随后下一轮 `status` 的 `last_outcome` 为精确值 `completed`。同会话另有原生 closed fact；原始日志没有 `requestId`→`compactionId` 关联，故不凭相邻时间声称二者是同一次压缩。公开文档不记录该请求的具体标识。
- **`unknown` 的共因（回归证据，不作唯一因果断言）**：真实客户端回归中复现了两处足以导致读取失败的作用域问题——`$mount` 阶段缺少 `typert` 注入即失败（`cannot get property "typert" without inject`）；补上 `typert` 后直接以属性方式访问 `remote.codexCompaction` 仍失败（`cannot get property "remote.codexCompaction" without inject`）。两者与用户截图里工具卡显示 `unknown` 的现象一致；但没有浏览器网络证据能证明该截图由且仅由这两处导致，故不据此断言唯一原因。
- **产品侧修复（最小两行）与保留项**：`src/client/index.tsx` 仅在 client `inject` 声明中补 `typert`，并把远程命名空间读取改为 `ctx.get('remote.codexCompaction')`；`$mount` 以 `.call(ctx.remote, …)` 绑定接收者调用（不是直接成员调用）。未改 Host、未改存储结构、未加依赖。另保留此前的读取修复：client 正确解包 RemoteResult（`{ok:true,value}` / `{ok:false,error}`），避免把信封当 snapshot 而令工具卡一直未知；新 notice 沿用现有 RPC，不新增事件或队列。
- **用户侧运行证据**：用户重启后，截图确实看到运行提示“正在压缩上下文”与状态“运行中”；随后 `status` 对同一请求返回 `completed`。这只证明提示可见与压缩完成，不足以单独证明 native 路径或真实 FIFO。截图发生在字号缩小之前，字号缩小后的视觉效果仍待用户确认。
- **仍需确认的边界**：字号调整后的视觉与其它会话下的重复表现尚未逐项目视；不承诺普遍 HMR（无 `dev:web` watcher）。本次字号/客户端作用域修复未对 profile 做变更、未卸载/重装，也未改 Host 产品；未发布。

## 版本与发布

- 包版本未变；未发布、未自动重启。图形/运行态结论以实际宿主为准。
