# Changelog

## 2026-03-26 (@mention in channels)

- Channel 消息支持 `@agentName` 唤醒 agent：
  - 后端 `POST /api/channels/:id/messages` 解析 `@mention`，找到该频道的对应 agent，重置 checkpoint 后调 `submitPrompt` 发系统通知将其唤醒。
  - Agent 被唤醒后调用 `check_messages` 即可读到频道消息。
- 前端 ChannelPanel Composer 支持 `@` 触发 autocomplete 下拉（↑↓ 选择，Enter/点击 确认，Esc 关闭）。
- 消息气泡中 `@mention` 文字高亮显示为紫色。

## 2026-03-26 (channel window)

- 新增前端 Channel 窗口：侧边栏添加 Channels 区块，点击频道名打开 ChannelPanel。
- ChannelPanel：Chat tab 显示多发言人消息（user 蓝色 / agent 绿色），底部 composer 可发消息；Members tab 列出加入该频道的 agents。
- 后端新增 3 个接口：`GET /api/channels/:id/messages`、`POST /api/channels/:id/messages`、`GET /api/channels/:id/stream`（WebSocket）。
- `internalAgentRouter` agent 向公共频道发消息时同步广播到频道 WS 订阅者，实现实时更新。
- Agent 向 `#channel` 发 send_message → ChannelPanel 实时收到消息。
- 用户发消息 → Optimistic update + WS de-dup（按 messageId）防止重复。


## 2026-03-26

- `send_message` 现在默认回复当前会话，不再要求 agent 在私聊里自己拼 `dm:@...` 目标。
- 当前私聊主线程默认目标为 `dm:@User`；branch thread 默认目标为当前 `#channel:shortid`。
- 仍然保留显式 `target` 覆盖，只有 agent 想跨会话或跨 channel 发送时才需要手动指定。
- 这次改动的目的，是减少 agent 因误判 DM 目标而重复补发消息的情况。
