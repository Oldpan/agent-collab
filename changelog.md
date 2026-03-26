# Changelog

## 2026-03-26 (P0/P1 roadmap items)

- **P0: Channel 消息通知所有 channel 内 agent**
  - 之前只有被 `@` 的 agent 才被唤醒；现在 channel 内所有 agent 都会收到 `[System: New message ...]` 通知，被 `@` 的 agent 仍获得更高优先级的 checkpoint 重置。
- **P0: Thread 回复通知被回复的 agent**
  - `POST /api/channels/:id/messages` 带 `replyTo` 时，查询根消息的 sender；若为 agent，自动 submitPrompt 唤醒该 agent，提示其调 `check_messages` 读取该 thread。
- **P1: Agent channel 重新分配**
  - `UpdateAgentRequest` 新增 `channelId?` 字段。
  - `ConversationManager.updateAgent` 现在支持更新 `channel_id`。
  - `AgentDetailPanel` 编辑界面新增 Channel 下拉选择器，可修改 agent 所属频道。
- **P1: Channel / Thread 历史消息分页**
  - `GET /api/channels/:id/messages` 和 `GET /api/channels/:id/threads/:shortId/messages` 新增 `before` query 参数（基于 seq 锚定），支持加载更早消息。
  - 响应消息新增 `seq` 字段用于分页锚定。
  - 前端 `useChannelStream` / `useThreadStream` 新增 `loadMore` / `hasMore`。
  - `ChannelPanel` / `ThreadPanel` 顶部显示"Load earlier messages / replies"按钮（消息不足时自动隐藏）。

## 2026-03-26 (channel threads)

- Channel 消息支持 Thread（Slack 风格）：
  - DB migration v22：`channel_messages` 加 `thread_root_id TEXT` 列（NULL = 主频道，有值 = thread 回复），加索引。
  - `GET /api/channels/:id/messages` 只返回主频道消息（`thread_root_id IS NULL`），每条消息含 `replyCount`。
  - 新增 `GET /api/channels/:id/threads/:shortId/messages` 返回某 thread 的回复列表。
  - `POST /api/channels/:id/messages` 支持 `replyTo: shortId`，存入 thread。
  - `internalAgentRouter` send 解析 `#channel:shortId` 目标 → 存 `thread_root_id`；WS 广播带 `threadRootId`。
  - Agent history 查询 `#channel:shortId` 只返回该 thread 消息；`#channel` 只返回主频道消息。
  - 前端 ChannelPanel：消息 hover 显示 Reply 按钮；有回复时显示 "N replies" badge；点击打开右侧 ThreadPanel。
  - ThreadPanel：显示根消息 + 回复列表 + 独立 Composer（含 @mention autocomplete），右侧 slide-in 布局。
  - `useThreadStream`：订阅 channel WS，过滤 `threadRootId` 匹配的事件。

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
