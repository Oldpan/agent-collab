# 消息路径与 Prompt 格式

本文档基于当前代码（2026-04-05），记录三种触发路径的完整实现，以及 replay、message block 格式等相关细节。如与旧版本有出入，以本文档和代码为准。

相关代码入口：
- `apps/core/src/web/directActivationPrompt.ts`
- `apps/core/src/web/channelActivationPrompt.ts`
- `apps/core/src/execution/executionDispatcher.ts`
- `packages/runtime-acp/src/gateway/history.ts`
- `packages/channel-bridge/src/messageFormat.ts`

---

## 一、三种消息路径

### 1. DM（私聊）

触发入口：浏览器 WebSocket → `wsHandler.ts` chat.message 事件

```
wsHandler.ts
  └─ manager.submitPrompt(conversationId, text)
       └─ executionDispatcher.dispatchPrompt()
            recordAsUserMessage = true（默认）
            ├─ 消息写入 channel_messages（dm:{agentId}）
            ├─ promptText = buildDirectActivationPrompt({
            │    agentName, senderName, replyTarget, content
            │  })
            └─ dispatchedPrompt = prependTurnReplyContract(promptText)
                 → RunDispatchMsg → node → ACP
```

最终 prompt 结构（`dispatchedPrompt`）：

```
[Reply contract]
Reply only via mcp__chat__send_message(...). Do not output user-visible text directly.
Use mcp__chat__send_message(..., kind="progress") only while work is still ongoing.
Before this run ends, send one final user-visible message with mcp__chat__send_message(..., kind="final").
Use kind="final" only when your current answer is complete. The runtime decides when the run ends.

[System: yanzong sent you a direct message.]

[Current conversation target]
reply_target: dm:@yanzong

[Triggered message metadata]
recipient: @kimi
sender: @yanzong

[Triggered message body]
再看下机器的内存状态
```

**特点：**
- 不再在 activation prompt 里注入操作说明（check_messages、read_history 提示等），这些规则已移入 system prompt。
- `replyTarget` 由 `resolveConversationReplyTarget()` 解析，默认为 `dm:@{senderName}`。

---

### 2. Channel @mention

触发入口：浏览器 POST `/api/channels/:id/messages`（REST）

```
server.ts  POST /api/channels/:id/messages
  ├─ 消息写入 channel_messages（target="#general"）
  ├─ findMentionedAgents(content) → 被 @的 agent 列表
  └─ for each mentioned agent:
       ├─ openAgentChannelThread(agentId, channelId, null) → 获取/创建 conversation
       ├─ buildTargetActivationContext() → 近期消息、unread count、participants、tasks
       └─ submitPrompt(conv.id, buildChannelActivationPrompt({
            channelName, target: "#general",
            replyTarget: "#general",
            senderName, content,
            reason: 'mention',
          }), {
            recordAsUserMessage: false,
            activationContextText: buildChannelActivationContextText({...}),
          })
               └─ prependTurnReplyContract(channelPrompt) → node → ACP
```

最终 prompt 结构（`dispatchedPrompt`）：

```
[Reply contract]
...

[System: You were @mentioned in #pure-cal-related by yanzong.]

[Current conversation target]
reply_target: #pure-cal-related

[Triggered message metadata]
target: #pure-cal-related
sender: @yanzong

[Triggered message body]
再看下机器的内存状态
```

activation context（注入 `contextText`，仅 fresh session）：

```
[Recent messages on this exact target]
[Message metadata]
target: #pure-cal-related  msg: 2e50a80d  seq: 8
time: 2026-04-04T16:56:46.508Z  sender: @kimi  sender_type: agent

[Message body]
当前机器显存状态如下...

---

...（最多 8 条）

[History cursor]
oldest_visible_seq: 5

[Unread summary]
3 older unread messages on this exact target were not included above. Use read_history(channel="#pure-cal-related", before=5) if you need them.

[Active participants on this target]
@kimi (participant)
@yanzong (owner)

[Bound task-message for this thread]
#3 [in_progress] @kimi — 优化显存占用
This thread is the shared work surface for that task-message. ...

[Task-message board summary]
#1 [done] @kimi — 初始化环境
#2 [todo] unassigned — 整理评测数据
```

---

### 3. Channel Thread 回复

触发入口：POST `/api/channels/:id/messages` 带 `replyTo: <threadRootId>`

```
server.ts  POST /api/channels/:id/messages  (replyTo 有值)
  ├─ 消息写入 channel_messages（thread_root_id = threadRootId, target="#general:abc123def4567890"）
  └─ openAgentChannelThread(agentId, channelId, threadRootId) → thread 专属 conversation
       ├─ buildTargetActivationContext({ threadRootId }) →
       │    recentMessages: 近 8 条 thread 内消息，rootMessage，unreadCount
       └─ submitPrompt(conv.id, buildChannelActivationPrompt({
            channelName, target: "#general:abc123def4567890",
            replyTarget: "#general:abc123def4567890",
            senderName, content,
            reason: 'thread_reply',
          }), {
            recordAsUserMessage: false,
            activationContextText: buildChannelActivationContextText({rootMessage, ...}),
          })
```

最终 prompt 结构（比 mention 多了 `[Thread root message]`）：

```
[Reply contract]
...

[System: Your collaborative thread in #pure-cal-related received a reply from yanzong.]

[Current conversation target]
reply_target: #pure-cal-related:f550d695c3e21b7

[Triggered message metadata]
target: #pure-cal-related:f550d695c3e21b7
sender: @yanzong

[Triggered message body]
再看下机器的内存状态
```

activation context（`contextText`，仅 fresh session）：

```
[Thread root message]
[Message metadata]
target: #pure-cal-related:f550d695c3e21b7  msg: a1b2c3d4  seq: 1
time: 2026-04-01T10:00:00.000Z  sender: @kimi  sender_type: agent

[Message body]
我来负责这个任务

[Recent messages on this exact target]
...（thread 内近 8 条，格式同上）
```

---

## 二、三路径对比

| | DM | Channel @mention | Channel Thread |
|---|---|---|---|
| 触发方式 | WebSocket chat.message | REST POST（含@） | REST POST（含 replyTo） |
| 消息持久化 | dispatcher 内写入 dm:{agentId} | server.ts 写，dispatcher 不写 | server.ts 写，dispatcher 不写 |
| Prompt 构建 | `buildDirectActivationPrompt` | `buildChannelActivationPrompt(reason:'mention')` | `buildChannelActivationPrompt(reason:'thread_reply')` |
| 近期历史（contextText） | resume 时注入（同 target 最近消息） | fresh session 时注入（8 条） | fresh session 时注入（8 条 thread 内） |
| 含 root 消息 | — | — | 是 |
| reply_target | `dm:@User` | `#general` | `#general:threadId` |
| conversation 粒度 | 单个主 DM conversation | 每 agent × channel 一个 | 每 agent × channel × threadRootId 一个 |

**注意**：DM 的近期历史只在 `dispatchMode !== 'cold_start'` 时注入（即有历史的 resume），cold_start 不带。Channel 路径则在 `activationContextText` 里带，由 fresh session 判断决定是否注入。

---

## 三、contextText 三层结构

每次 dispatch 时，`contextText` 按顺序组合如下几块（均可为空）：

1. **Local memory**（从 workspace 读 `MEMORY.md`）
   ```
   [Local Memory Guide]
   ...

   [Local Memory]
   ...
   ```

2. **Replay**（仅 `dispatchMode === 'resume'`，从 DB 重建历史对话）
   ```
   Context (previous messages, for continuity after restart):
   User: 再看下机器的内存状态
   kimi: 当前机器显存状态如下...
   ```

3. **DM 激活上下文**（仅 `recordAsUserMessage=true` 且 `dispatchMode !== 'cold_start'`）
   - 同 target 的近期消息 + unread count

4. **Channel 激活上下文**（从 `options.activationContextText` 传入）
   - Thread root、recent messages、history cursor、unread summary、participants、bound task、task board

---

## 四、Reply contract

每个 dispatchedPrompt 最前面都会 prepend：

```
[Reply contract]
Reply only via mcp__chat__send_message(...). Do not output user-visible text directly.
Use mcp__chat__send_message(..., kind="progress") only while work is still ongoing.
Before this run ends, send one final user-visible message with mcp__chat__send_message(..., kind="final").
Use kind="final" only when your current answer is complete. The runtime decides when the run ends.
```

实现：`prependTurnReplyContract()`，仅在 promptText 尚未包含 `[Reply contract]` 时才加。

run.end 时的兜底机制（`persistDeltaFallbackMessages`）：
- 如果 agent 没有调用 `send_message`，core 从 `content.delta` 流拼合文本，作为 `delta_fallback` 消息强制写入 channel，保证用户侧不空白。

| 字段 | 含义 |
|---|---|
| `message_kind = 'final'` | agent 主动 `send_message(kind="final")` 发出的正式回复 |
| `message_kind = 'progress'` | agent 主动发出的进度消息 |
| `message_source = 'delta_fallback'` | core 从 delta 流兜底合成的消息 |

---

## 五、Message block 格式

### 5.1 activation context 中的消息块（`channelActivationPrompt.ts`）

```
[Message metadata]
target: #pure-cal-related:f550d695c3e21b7  msg: 2e50a80d  seq: 8
time: 2026-04-04T16:56:46.508Z  sender: @kimi  sender_type: agent

[Message body]
当前机器显存状态如下...
```

多条消息之间分隔：`\n\n---\n\n`

字段说明：
- `target`：channel 或 thread target
- `msg`：message UUID 前 8 位
- `seq`：channel 内顺序号
- `time`：ISO 时间
- `sender`：发送者名（带 `@`）
- `sender_type: agent`：仅 agent 才显示
- `task: #N [status] @assignee`：仅有任务关联时追加

### 5.2 channel-bridge 工具返回的消息块

#### `formatMessages`（check_messages 返回）

包含 `target`、`msg`，不包含 `seq`：

```
[Message metadata]
target: #general  msg: 2e50a80d
time: 2026-04-04T16:56:46.508Z  sender: @kimi  sender_type: agent

[Message body]
...
```

#### `formatHistoryMessages`（read_history 返回）

包含 `seq`，不包含 `target` 和 `msg`：

```
[Message metadata]
seq: 8  time: 2026-04-04T16:56:46.508Z
sender: @kimi  sender_type: agent

[Message body]
...
```

---

## 六、Replay 规则

### 6.1 用户侧内容只回放"有效正文"

旧 activation prompt 的结构外壳（`[Reply contract]`、`[System: ...]`、`[Current conversation target]`、`[Triggered message metadata]`）不回放。

规则（`normalizeReplayUserText()`）：
- 若旧 prompt 里有 `[Triggered message body]`，只回放其后正文
- 否则回放去掉 `[Reply contract]` 后的原始 prompt 文本

结果：

```
User: 再看下机器的内存状态
```

### 6.2 agent 侧标签优先用真实 agent 名

优先级（`buildConversationReplayText()` in `executionDispatcher.ts`）：
1. 该 run 的 `final` 类型 channel message 的 `senderName`
2. 该 run 最后一条 agent channel message 的 `senderName`
3. conversation 对应的 agent 名（`getConversationAgentName()`）
4. fallback 到 `'Assistant'`

`packages/runtime-acp/src/gateway/history.ts` 中的 `buildReplayContextFromRecentRuns`（generic runtime replay）：
- 用 session system prompt 里 `You are "agentName"` 提取 agent 名
- fallback 到 `'Assistant'`

---

## 七、cold_start vs resume + isFreshSession=true

| 概念 | 判断依据 | 含义 |
|---|---|---|
| **cold_start** (dispatchMode) | runs 表中该 session_key 是否有记录 | Conversation 历史上**第一次**被唤醒 |
| **isFreshSession=true** | acpSessionId 不存在 | 当前**运行时**没有活跃的 ACP session |

四种实际组合：

| 场景 | dispatchMode | isFreshSession | 说明 |
|---|---|---|---|
| 全新 Conversation | cold_start | true | 第一次使用这个 agent |
| History 存在，ACP 重启恢复 | resume | true | 有历史，但 session 丢了 |
| History 存在，ACP Session 活着 | resume | false | 正常运行中的连续对话 |
| 不可能的情况 | cold_start | false | 逻辑上不可能 |

**resume + isFreshSession=true** 的 prompt 组成：

```
[System Prompt]
[Memory]
[Replay - 最近 N 轮对话历史]   ← 受 contextReplayRuns 上限控制
[DM/Channel 激活上下文]         ← 如果有
[Trigger Message]
```

**cold_start** 的 prompt 组成：

```
[System Prompt]
[Memory]
（无 Replay）
[Channel 激活上下文]            ← 如果有
[Trigger Message]
```

为什么需要两个维度：

| 用途 | dispatchMode | isFreshSession |
|---|---|---|
| Node 侧恢复逻辑 | ✅ 决定 cold_start/resume | — |
| 是否注入 contextText | — | ✅ 只有 fresh 才注入 |
| UI 显示运行模式 | ✅ | — |
| 是否构建 replay | ✅ resume 时才构建 | — |

---

## 八、Agent 回复路径

Agent 通过 ACP 内的 `mcp__chat__send_message` 调用，HTTP POST 到 `POST /api/internal/agent/:agentId/send`（`internalAgentRouter.ts`），core 再把消息写入 `channel_messages` 并通过 WS `broadcastToChannel` / `broadcastToAgent` 推送给前端。
