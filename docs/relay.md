# 第三方中继（当前源码，未发布）

本文说明插件在当前源码中新增的第三方中继模式。默认保持直连；只有填写了中继地址才会切换。该能力仅存在于当前源码，未包含在已发布的 `v0.3.3-standalone.3` 中，版本号与发布状态未改变；运行中的宿主需在下次重启后加载新后端。

## 配置入口

- Web：**设置 → OpenAI Codex → 中继**，字段为「中继地址」「中继 API Key」，附「保存中继」「切换直连」「清除已保存 Key」。
- 配置文件：`llm-openai-codex` 条目中的 `relayBaseUrl` 与 `relayApiKey`。后者在 schema 中标记为 secret，不进入浏览器快照。
- 地址填完整的 Codex 端点，例如 `https://relay.example.com/backend-api/codex`；末尾斜杠会被去掉。
- 校验规则：只接受 `https://`；本机回环地址（`localhost`、`127.0.0.1`、`::1`）允许 `http://` 便于本地测试；拒绝带用户名/密码、query 或 fragment 的地址。Key 只接受可见 ASCII 字符，不允许空格、换行或控制字符。
- 地址留空即直连。清空地址立即回到直连；已保存的 Key 不会随之删除，但只有 Key 不会启用中继。
- 有地址但没有 Key 仍属于中继模式：请求前以固定配置错误（`missing-api-key`）拒绝，不读取 OAuth，也不回退直连。

## 安全边界

- 静态 Key 只发往用户配置的中继 origin，不发往 `chatgpt.com`；OAuth access token 也不会发往中继。
- 中继请求不读取 OAuth 凭据、不解析 JWT/账号 ID、不发送 `chatgpt-account-id`。
- Web 只返回 `{ relayBaseUrl, relayApiKeySet, enabled }` 形式的安全快照；已保存 Key 不回显，保存成功后输入框立即清空。设置保存只接受 `relayBaseUrl` 与 `relayApiKey` 两个字段，其他字段一律拒绝。
- 中继输入/上游错误只以固定文案与固定 HTTP 状态呈现，不转述第三方 error message 或响应正文（避免恶意正文回显 Key）；相关错误对象不附带可能夹带第三方文本的 cause。
- 浏览器授权状态在 relay 模式下返回 `{ status: "relay", relay }`，不查询 OAuth 状态或额度。

## 各功能行为

- 模型与压缩：中继模式下 Codex 模型请求与原生压缩请求发往中继基础地址上的对应路由；`store: false`、Fast Mode priority 与 `compaction_trigger` 原生压缩流程与直连一致。WebSocket 上下文复用同样可用：连接按 endpoint+Key+会话复用；真实中继实测两轮复用同一 socket，未回退 SSE。
- 模型目录：中继模式不获取第一方 OAuth 模型目录（不预热、不刷新、不复用旧账号官方快照），只沿用插件本地内置与缓存元数据作为候选。中继实际提供哪些模型由中继决定；插件不会自动发现中继模型，也不保证候选中的每个模型在中继可用。设置页读取/刷新不会为中继发起第一方目录请求；切回直连后恢复原有官方目录行为。
- 额度：中继模式没有账号额度；usage 读取在发出请求前即拒绝，输入框额度条隐藏，设置页显示中继模式提示；自动模型回退不读取旧 OAuth 额度。
- 搜索：独立搜索依赖第一方 Codex 端点；中继模式下 `web_search` 以固定 `WEB_PROVIDER_UNSUPPORTED` 错误拒绝，不读凭据、不触网，也不静默回退直连。
- 图片：`imagegen` 继续使用设置中选择的 GPT Image 模型，改为 POST `<中继地址>/images/generations` 或 `<中继地址>/images/edits`；只带静态 Key，不带 account 头；中继错误只返回固定 HTTP 状态。
- 代理：中继流量使用插件自带的直连 dispatcher，不经过内置出网代理的托管范围；直连流量仍按既有代理设置。
- 其它：`read_image`、附件、Fast Mode 与既有展示逻辑沿用原行为；不新增工具/slot，不更改现有工具 schema（本次新增的是插件 Config schema 字段）。

## 限制

- 中继需自行兼容 Codex 后端路由与响应格式；插件只负责传输与凭据隔离，不负责中继侧的鉴权、额度或模型策略。
- 中继模式不提供账号额度与独立搜索；这两项明确不支持，不做降级模拟。
- 官方模型目录、额度与账号相关缓存按直连/OAuth 隔离；切换模式会停用或清理对应路径。
- 中继地址是动态配置；模式切换不影响已发起请求的配置快照，但不保证跨模式复用连接缓存。
- 未发布：宿主重启加载前不生效。当前构建已编译，但运行中的 Host 未重启、未保存真实 Key/profile；用户需重启 DSH 加载新后端，再在 Web 设置中配置中继。

## 验收

最终实测已停止继续发真实请求。安全报告见 `dist-package/relay-acceptance/acceptance-report.json`（不含 Key 与完整密文），按用户关注顺序：

1. **SSE 对话**：`gpt-5.6-sol` 真实请求通过，回答携带验收 nonce（命中）。
2. **原生压缩与续聊**：actual-wire 确认 native 请求；`POST /backend-api/codex/responses` 返回 `status=200`、`output_item.type=compaction`、`encrypted_bytes=3020`；下一轮 HTTP 200，`input_types=[user,compaction,user]`，`markerText=false`、`plaintextCodeword=false`、`contextMatched=true`。
3. **图片**：GPT Image 2 真实生成一张 PNG（1034916 bytes）通过；本轮只生成一次。
4. **直连回退与分发**：清空中继地址回直连、relay 分发通过产品 mock 回归（非真实 OAuth 联网，本轮未读取 OAuth）；直连分支既有回归通过。
5. **WebSocket**：真实中继 WS 连接通过，两轮 `send` 复用同一 socket；`fallbackToSse=false`、`previous_response_id=true`，第二轮增量 2 项小于完整 3 项，记忆 nonce 命中。

验证边界：1/2/3/5 为真实中继联调（产品传输 + 合成夹具），4 为产品 mock 回归；不包含真实 OAuth 联网。源侧 `onPayload` 观察钩子曾导致“展开后的 marker 未实际发送”的误判，产品已按最小改动修复并补 wire 断言，本文按修复后结果记录。自动化方面：相关回归（58 例）与 Host 类型检查通过，Lead 构建 `exit 0`；全量基线 52 files / 624 passed / 4 skipped（4 例为真实环境用例）。
