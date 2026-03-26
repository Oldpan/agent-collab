# Changelog

## 2026-03-26 (channel-bridge test wiring)

- `@agent-collab/channel-bridge` 现在补了独立的 `vitest` 测试入口。
- `messageFormat.test.ts` 已可直接通过 `pnpm --filter @agent-collab/channel-bridge test` 运行。
- 这保证了消息元信息格式化改动不再只能靠手工验证。

## 2026-03-26 (message metadata formatting cleanup)

- `check_messages()` 和 `read_history()` 现在把消息元信息与正文分块展示，不再输出容易被模型原样复述的单行 header。
- 动态 system prompt 同步补充规则：`target/msg/time/type` 仅用于路由与上下文，不要原样回给用户。
- 这减少了 agent 回复开头出现 `[target=...] @User: ...` 这类系统头泄漏的概率。

## 2026-03-26 (channel root reply normalization)

- 服务端现在会对“主频道 branch 会话”里的回复目标做归一化：
  - 如果 agent 试图把当前主频道会话回复到同频道的 thread（如 `#default:abcd1234`），会被自动收口回 `#default`
- 这进一步兜住了模型把主频道 `@mention` 错误改写成 thread 回复的问题。

## 2026-03-26 (channel mention prompt routing guard)

- 动态 system prompt 现在明确区分了主频道消息和 thread 消息：
  - 主频道里的 `@mention` 默认回复主频道
  - 只有收到的 `target` 本身已经带 `:shortid` 时，才继续在 thread 中回复
- 移除了“只要看到 `msg=` 就可以新开 thread”的错误暗示，避免 agent 把主频道问题改写成 thread 或 DM thread 回复。

## 2026-03-26 (channel mention replies to channel root)

- 主频道里的 `@agent` 不再默认创建 thread reply 目标。
- 现在普通 channel mention 会创建/复用一个 `thread_root_id = NULL` 的 channel branch conversation，agent 默认回复 `#channel`。
- 只有真正的 thread reply 才会绑定 `threadRootId`，并默认回复 `#channel:shortid`。
- 这修复了“在 `#default` 里 `@Bob`，Bob 却通过 thread 回复”的问题。

## 2026-03-26 (channel mention routing fix)

- 频道消息不再默认唤醒该频道中的所有 agent。
- 现在只有两种情况会触发 agent 执行：
  - 用户在频道中显式 `@agent`
  - 用户回复了某个 agent 在 thread 中的消息
- 这修复了“只 `@Tab`，但同频道的 Bob 也被唤醒并在私聊回复”的问题。

## 2026-03-26 (channel visibility vs trigger semantics)

- `read_history` 现在会校验 channel membership；agent 未加入某个频道时，不能直接读取该频道或其 thread 历史。
- 默认 system prompt 明确区分了“能看到 channel 上下文”和“应当主动回复”：
  - 加入频道表示可读历史和未读
  - 只有被 `@`、在当前 thread 被直接 addressed、或用户明确把问题路由给你时才应主动回复

## 2026-03-26 (channel creation UX)

- 创建 channel 时现在可以直接填写简介，并在创建表单中选择哪些 agent 立即加入该频道。
- 后端 `POST /api/channels` 支持 `agentIds`，创建完成后会一次性建立这些 agent 的 membership。

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

## 2026-03-26 (activity tool summaries)

- Activity 里的 tool call 头部现在会优先展示更完整的关键参数摘要，而不只是工具名。
- 常见操作会显示更明确的目标，例如文件路径、命令、URL、channel/target、task 编号等。
- 这让 `read file`、`send_message`、`read_history`、`execute` 一类操作在不展开详情时也能看出具体作用对象。

## 2026-03-26 (channel mention thread routing)

- 频道内 `@agent` 和 agent message 的 thread reply 不再复用 agent 的私聊主 thread。
- `ConversationManager` 新增 `openAgentChannelThread(agentId, channelId, threadRootId)`，会为 `agent + channel + root message` 复用或创建对应的 branch conversation。
- `conversations` 新增 `thread_root_id` 元数据；`send_message()` 在 channel branch 中默认回复到 `#channel:threadRootId`，而不是回私聊或生成孤立 thread id。
- 修复了“在 `#default` 里 `@Bob`，Bob 却在私聊里回复”的问题，并补了服务端与内部路由回归测试。

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

## 2026-03-26 (agent channel memberships)

- Agent 的 channel 关系开始按“DM 永远存在 + 0 到 N 个 channel 订阅”收口，前端不再把 `home channel` 当成必需概念。
- `AgentDetailPanel` 的频道编辑改成纯 checkbox 订阅列表，不再有 `home / set home` 交互，也允许 agent 离开全部公共频道。
- `ConversationManager.leaveChannel` 现在允许离开任意 membership；频道成员展示和 agent 内部收件箱也只基于真实 `channelIds`，不再偷偷 fallback 到旧 `channelId`。
- `createChannel` 这条链同时补齐了 `description` 透传，避免协议层已有字段但创建时被静默丢弃。

## 2026-03-26 (channel tasks tab)

- ChannelPanel 新增 `Tasks` tab，先落地基础版 task board。
- 前端接入公开 task API：支持按频道拉任务、新建任务、推进状态 `todo -> in_progress -> in_review -> done`。
- `done` 分组默认折叠；assignee 暂时只读展示，不提供用户侧分配交互。
- 原计划里的 DM Thread UI 暂缓，保持当前“私聊单主 thread、分支只在 channel 内出现”的产品语义。

## 2026-03-26 (silent mention wakeups)

- 频道内 `@agent` 和 thread reply 的内部唤醒 prompt 改成静默提交，不再写进 agent 私聊 DM 聊天记录。
- 频道被 `@mention` 时，会在对应 channel 实时插入一条 `channel.notice`，提示该 agent 已被通知。
- Agent `Activity` 现在会显示 run 的触发原因，例如 `mentioned in #default by User`、`thread reply in #default from User`。
- 为了保留静默语义，`conversation_prompt_queue` 新增 `record_as_user_message` 标记；队列中的内部 prompt 出队后也不会污染私聊消息流。
