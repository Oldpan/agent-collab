# Changelog

## 2026-04-04 (replay prefers visible replies over empty fallback noise)

- `delta_fallback` 中包含 `Empty response: {'content': ...` 的空响应噪音现在不会再落到用户可见聊天记录。
- `resume` 时的 conversation replay 现在会优先回放该 run 真实发给用户的 agent 消息，而不是盲目拼接原始 `content.delta`。
- 如果某条旧 run 只有空响应噪音 delta、但已经有真实 `send_message` 回复，后续 fresh-session / restart replay 不会再把 `Assistant: (Empty response: ...)` 这类脏内容带回 prompt。

## 2026-03-29 (agent-to-agent channel mentions)

- Channel/thread 中的正式 agent 消息现在支持显式 `@agent` 协作唤醒：被提及的 agent 会在同一个 target 上被拉起并加入该 target 的 participants。
- 新增 `agent_mention_cooldowns`，schema 升到 `v34`；同一 `from_agent -> to_agent -> target` 在冷却窗口内不会被重复唤醒，避免两边来回 ping 形成回路。
- 只认正式 `agent_send` 消息中的 `@mention`；`delta_fallback`、原始 `content.delta` 和工具确认文本都不会触发 agent 唤醒。
- system prompt 同步补充了 channel/thread 中显式 `@` 其他 agent 请求协作的规则，与平台行为保持一致。

## 2026-03-29 (channel subscriptions + thread-task lifecycle completion)

- 新增 `channel_subscriptions`，schema 升到 `v33`；`subscribed_agents` 模式现在只唤醒显式订阅该频道的 agent，不再在无 participant 时回退唤醒全频道 agent。
- `joinChannel` / `leaveChannel` 会同步维护频道订阅；channel API 返回 `subscribedAgents`，前端设置页可以直接看到当前模式和订阅 agent。
- thread-task 协议补齐了显式 bind / unbind 路由；task `done` 后会清空 thread owner，但保留绑定，让 thread 继续作为结果讨论面。
- thread summary 与 task 列表前端去掉了旧占位文案，直接展示真实 `boundTask / owner / participants / linkedThread` 数据。
- Channel Settings 现在支持对频道成员逐个 `subscribe / unsubscribe`；`subscribed_agents` 模式下可以直接管理被动唤醒对象。
- ThreadPanel 和 TasksTab 都补上了显式 `bind / unbind task` 交互，围绕当前 thread 完成单 task 绑定。
- 剩余 roadmap 已收敛到更深的 thread 协作协议、任务分配和频道描述编辑，不再包含这批基础交互缺口。

## 2026-03-29 (thread-task binding + thread collaboration summary)

- 新增 `thread_task_bindings`，schema 升到 `v32`；一个 thread 现在最多绑定一个 task，后续 thread 协作可以围绕真实 task 收敛。
- agent 在 thread conversation 中调用 `claim_tasks` 时，会自动尝试把该 task 绑定到当前 thread；同一 thread 再绑定第二个 task 会被拒绝，不再隐式覆盖。
- 绑定成功后，thread 的协作 owner 会同步到该 task assignee；`unclaim_task` 会把该 thread 的 owner 清空回 participant-only 状态。
- channel/thread fresh activation context 现在支持注入 `bound task` 摘要；system prompt 也同步要求非 owner agent 默认以协调/讨论为主，不要直接抢执行。
- 新增 `GET /api/channels/:id/threads/:shortId/summary`，返回 `boundTask / owner / participants`；频道任务列表也会带 `linkedThreadId / linkedThreadShortId`。
- Thread 面板现在会实时拉取 summary，显示真实的 bound task、owner 和 participants；Tasks 面板里的 linked-thread 占位也能接真实数据。

## 2026-03-29 (target-first channel collaboration v1)

- Channel 新增 `collaboration_mode`（默认 `mention_only`，可选 `subscribed_agents`），为主频道协同触发提供明确模式开关。
- 新增 `target_participants` 持久化表，按 `channel + thread` 跟踪 owner/participant，thread reply 不再只依赖 root owner；当前 target 上已有参与 agent 时，会一起被唤醒协作。
- Channel/thread 激活上下文升级为协作摘要：fresh ACP session 现在可拿到同 target recent messages、thread root、unread summary、active participants 和 task board summary。
- Agent 在 channel/thread 上发送正式消息后会自动登记为该 target 的 participant，`clear channel chat` 和 agent 删除也会同步清理这层协作状态。
- DM 逻辑保持不变；正式消息仍优先走 `send_message`，`delta_fallback` 继续只做 run 结束时的兜底。

## 2026-03-28 (queued activation context persistence)

- 修复了 channel/thread 激活上下文在排队后丢失的问题：`conversation_prompt_queue` 现在会持久化 `activation_context_text`。
- 当同一 agent 正忙、mention 或 thread reply 被排队时，等到该 prompt 真正出队派发，thread root / recent messages / unread summary 仍能在 fresh ACP session 上下文里恢复。
- DB schema 升到 v30，新增 `conversation_prompt_queue.activation_context_text` 列，并补了 queued path 的回归测试。

## 2026-03-27 (sidebar unread badges)

- Sidebar 现在会在 agent 私聊入口和 channel 入口显示未读数字，并把已读锚点持久化到本地浏览器。
- unread 统计只计算不是用户自己发出的新消息；打开对应私聊或 channel 后，数字会立即清零。
- 为了支撑这层状态，新增了 `POST /api/unread-summary` 汇总接口；私聊历史和 `channel.message` 事件也补出了稳定的 `seq` 字段。
- channel thread replies 会计入所属 channel 的 unread，而不会在 sidebar 单独拆出 thread badge。
- channel 场景的 prompt 规则也同步收紧：普通进度更新不需要反复 `@User`，只有完成、重大阻塞或需要决策时才主动 `@User`。

## 2026-03-27 (channel memory reset markers)

- Channel memory 开始按频道独立组织到 `notes/channels/<channel>.md`，同时保留对旧 `notes/channels.md` 的兼容追加。
- `clear channel chat` 现在不会删除 agent 关于该频道的长期记忆；它会给已加入该频道的 agent 远程 workspace note 追加一条 `History Reset` 标记，明确旧内容是 durable memory，不代表当前 UI 里仍可见的 live transcript。
- 为此新增了最小远程 workspace 文本写能力：`workspace.write.request/response`，仅用于在 agent 所在 node 的 workspace 内安全写入文本 note。
- `ensureWorkspaceScaffold()` 现在会预建 `notes/channels/` 目录，system prompt 也同步改成优先使用 `notes/channels/*.md` 管理频道上下文和 reset 标记。

## 2026-03-26 (channel-bridge test wiring)

- `@agent-collab/channel-bridge` 现在补了独立的 `vitest` 测试入口。
- `messageFormat.test.ts` 已可直接通过 `pnpm --filter @agent-collab/channel-bridge test` 运行。
- 这保证了消息元信息格式化改动不再只能靠手工验证。

## 2026-03-26 (message metadata formatting cleanup)

- `check_messages()` 和 `read_history()` 现在把消息元信息与正文分块展示，不再输出容易被模型原样复述的单行 header。
- 动态 system prompt 同步补充规则：`target/msg/time/type` 仅用于路由与上下文，不要原样回给用户。
- 这减少了 agent 回复开头出现 `[target=...] @User: ...` 这类系统头泄漏的概率。

## 2026-03-27 (channel activation + thread checkpoints)

- Channel 中的 `@mention` 和 thread reply 不再只发一条“去 `check_messages`”的系统通知；激活 prompt 现在会直接携带触发消息本身和 exact target，agent 只在需要更多上下文时再调用 `read_history(...)`。
- `agent_message_checkpoints` 从 channel 粒度收紧成 thread 粒度，内部主键变成 `agent + channel + thread stream`，避免同一个 channel 下多个 thread 互相推进 checkpoint、误消费消息。
- `/receive` 现在按 `thread_root_id` 分别推进 checkpoint；主频道根流和各个 thread 的未读不再串在一起。
- system prompt 同步更新：channel 激活时优先使用 prompt 里已经附带的触发消息，不要为读取同一条消息再机械调用 `check_messages`。

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

## 2026-03-27 (direct DM activation parity)

- 私聊用户消息的激活方式现在与 channel mention 对齐：触发消息直接注入 run prompt，不再先发一条“调用 `check_messages`”的通知 prompt。
- 私聊用户消息仍然继续写入 `dm:{agentId}` 的 `channel_messages`，用于历史、刷新和 `read_history(channel="dm:@User")`。
- 对于已直接注入 prompt 的这条私聊触发消息，DM root checkpoint 会立即推进，避免 agent 紧接着再从 `check_messages` 重复读回同一条消息。
- 动态 system prompt 现在明确把这条规则扩展到 direct message / channel mention / thread reply 三种唤醒场景。

## 2026-03-27 (activity output visibility)

- Activity 里运行中但没有活跃工具调用时，提示文案改成了更准确的 `Waiting for run to finish...`。
- Activity 现在会显示每轮 run 的 `content.delta` 聚合结果，放在 `Output stream` 折叠区里，便于排查“消息已发出但 run 还在继续输出”的问题。
- `/api/conversations/:id/history` 会聚合返回 `assistantText` 和 `thinkingText`，所以刷新后 Activity 也能继续看到这些调试输出。

## 2026-03-27 (channel settings clear chat)

- ChannelPanel 新增 `Settings` tab，与 `Chat / Tasks / Members` 同级；当前先提供 `Clear chat history` 动作。
- 新增 `POST /api/channels/:id/clear-chat`，会删除该 channel 的主流与 thread 消息、对应 checkpoints，并重置该 channel 下 branch conversations 的 runs / events / queued prompts / session。
- 该清理动作会保留 channel 本身、成员关系、description 与 tasks，不会影响 agent 私聊主 thread 或 workspace。
- 新增 `channel.history.reset` 事件；前端收到后会立即清空频道消息并关闭已打开的 thread 面板，无需手动刷新。

## 2026-03-27 (final reply contract)

- `send_message` 现在支持可选 `kind="progress" | "final"`，用于区分中间进度和最终用户可见回复。
- `channel_messages` 新增 `message_kind` 字段，平台会把 `send_message(kind=...)` 的语义持久化下来。
- run 结束时，平台不再只检查“是否发送过某条消息”，还会检查是否发送过最终回复：
  - 没有任何 `send_message` 仍然报 `Agent did not reply via send_message`
  - 只有进度消息、且之后还有明显正文输出但没有最终回复时，报 `Agent did not send a final reply via send_message`
- 兼容旧行为：如果 run 里只有一条未标注 kind 的正常回复，且后面没有明显正文尾流，仍然视为隐式最终回复，避免把现有单句回答全部打坏。

## 2026-03-27 (empty send_message hardening)

- `send_message` 现在会在工具层直接拒绝空白内容：`content` 改成 `trim().min(1)`，空串或纯空白不再允许发起发送。
- core 内部 `/api/internal/agent/:id/send` 也同步做了 `trim()` 后的硬校验，并统一返回 `content must not be empty`。
- `channel-bridge` 对 `/send` 的失败不再包成普通文本结果，而是直接抛出工具错误；这样前端 Activity 里会把这类发送失败显示成真正的 `failed`，而不是看起来像 `completed`。
- runtime 在 summary 模式下也会把工具失败/结果的简短 detail 继续透传到前端，便于定位 `send_message` 为什么失败。

## 2026-03-27 (reply contract repair hardening)

- reply contract 的“是否已经正式回复”现在按 `run_id + sender_type='agent'` 统计，不再错误地只看私聊 DM，因此 channel branch runs 也会进入同一套补救逻辑。
- 新增了 channel branch 场景的回归测试：如果 agent 在频道里只产出内部正文却没调用 `send_message`，core 会先静默派发一次 repair run，要求它补发最终可见回复。
- `node-ws` 现在会记录 reply-contract repair 的调度、派发和派发失败日志，便于排查“明明该补救却没有补出去”的问题。
- 2026-03-27 (unread badge visibility fix)
  - Fixed unread badges being prematurely cleared on the frontend.
  - Bumped local unread anchor storage keys to `v2` to discard stale/bad read state from the previous implementation.
  - Sidebar unread anchors are now only auto-advanced while the document is visible.
  - Active DM/channel streams no longer mark incoming/history messages as seen while the page is hidden.
- 2026-03-27 (final reply prompt hardening)
  - Strengthened prompt rules around `send_message(kind="final")`.
  - Final replies must now contain the actual result, not just a heading, teaser, or half-finished sentence.
  - Added explicit guidance that a final reply should be self-contained and that agents must keep working until the full answer is ready.
