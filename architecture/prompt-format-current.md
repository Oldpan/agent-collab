# 当前 Prompt 格式（2026-04-05）

这份文档记录 **当前生效** 的 prompt 拼装格式，重点覆盖：

- DM / channel / thread 的 activation prompt
- fresh-session / resume 下的 `contextText`
- replay 的瘦身规则
- `[Message metadata]` / `[Message body]` 的紧凑格式

相关代码入口：

- `packages/memory/src/systemPrompt.ts`
- `packages/memory/src/resolve.ts`
- `apps/core/src/web/directActivationPrompt.ts`
- `apps/core/src/web/channelActivationPrompt.ts`
- `apps/core/src/execution/executionDispatcher.ts`
- `packages/runtime-acp/src/gateway/history.ts`
- `packages/channel-bridge/src/messageFormat.ts`

---

## 1. 三层结构

当前运行时里的用户侧输入，按语义分成三层：

1. `systemPromptText`
   - session 级规则
   - 只在 fresh ACP session 建立时写入 session
2. `contextText`
   - 本地 memory
   - fresh-session 下的 replay
   - channel/thread 的 recent messages、participants、task summary
3. `promptText`
   - 当前这一次真正触发 run 的 activation prompt

其中：

- cold start / fresh session: `contextText + promptText`
- warm resume: 只发新的 `promptText`
- resume 但 session 丢了: 会重新发 `contextText + promptText`，其中 `contextText` 里会带 replay

---

## 2. 当前 activation prompt

### 2.1 Direct message

格式：

```text
[Reply contract]
...

[System: yanzong sent you a direct message.]

[Current conversation target]
reply_target: dm:@yanzong

[Triggered message metadata]
recipient: @kimi
sender: @yanzong

[Triggered message body]
再看下机器的内存状态
```

特点：

- 保留最小路由结构：`reply_target`、trigger metadata、trigger body
- 不再重复注入这些通用操作说明：
  - 不要重新 `check_messages`
  - 优先 `send_message(... )` 无 target
  - 需要更多上下文时 `read_history(...)`

这些规则现在统一由 system prompt 负责。

### 2.2 Channel mention / channel activity / thread reply

格式：

```text
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

特点：

- `reason` 仍然体现在第一行 `[System: ...]`
- 保留 `[Current conversation target]` 与 `[Triggered message metadata]`
- transcript/debug 仍可稳定解析 `reply_target` 和 trigger target

---

## 3. 当前 contextText

fresh-session 下，`contextText` 可能包含下面几类块：

### 3.1 Local memory

```text
[Local Memory Guide]
...

[Local Memory]
...
```

### 3.2 Thread / channel activation context

可能包含：

- `[Thread root message]`
- `[Recent messages on this exact target]`
- `[History cursor]`
- `[Unread summary]`
- `[Active participants on this target]`
- `[Bound task-message for this thread]`
- `[Task-message board summary]`

### 3.3 Replay

resume 且 session 丢失时，会追加：

```text
Context (previous messages, for continuity after restart):
User: ...
kimi: ...
User: ...
kimi: ...
```

这里的 replay 已经做了两点收敛：

1. 不再回放旧 activation envelope
2. 不再写死 `Assistant:`

---

## 4. Replay 当前规则

### 4.1 用户侧内容只回放“有效正文”

旧逻辑会直接回放整段旧 `promptText`，所以会把这些壳一起带回去：

- `[Reply contract]`
- `[System: ...]`
- `[Current conversation target]`
- `[Triggered message metadata]`
- `[Triggered message body]`

现在的规则是：

- 如果旧 prompt 里有 `[Triggered message body]`，只回放它后面的正文
- 否则才回放原始 prompt 文本

所以 replay 现在更接近：

```text
User: 再看下机器的内存状态
```

而不是整段 activation prompt。

### 4.2 agent 侧标签优先用真实 agent 名

旧逻辑：

```text
Assistant: 当前机器显存状态如下...
```

当前逻辑：

- 优先用该 run 的可见 agent message 的 `sender_name`
- 取不到时：
  - core conversation replay 走当前 conversation 对应 agent 名
  - generic runtime replay 走 session system prompt 里的 agent 名
- 最后才 fallback 到 `Assistant`

所以现在更接近：

```text
kimi: 当前机器显存状态如下...
```

---

## 5. 当前 message block 格式

### 5.1 基本结构

所有 recent/history/message list 现在统一为：

```text
[Message metadata]
target: #pure-cal-related:f550d695c3e21b7  msg: 2e50a80d  seq: 8
time: 2026-04-04T16:56:46.508Z  sender: @kimi  sender_type: agent

[Message body]
当前机器显存状态如下...
```

多条消息之间使用明确分隔：

```text
---
```

### 5.2 各字段说明

- `target`
  - 只在带 target 语义的 message block 中出现
- `msg`
  - message UUID 的前 8 位
- `seq`
  - channel 内顺序号
- `time`
  - ISO 时间
- `sender`
  - 发送者名
- `sender_type: agent`
  - 仅 agent 发送者才显示
- `task: #N [status] @assignee`
  - 仅 message/task history 需要时追加

### 5.3 为什么改成这种形式

目标有两个：

1. 更紧凑
   - 常见字段压成两行 metadata
2. 更好区分消息边界
   - message 内部仍是 metadata/body 两块
   - message 与 message 之间强制 `---`

这样对模型和人都更容易区分：

- 哪些行属于同一条 message
- 哪一段是正文
- 多条 recent/history message 的边界在哪里

---

## 6. 现在不再在 activation prompt 里重复的规则

这些规则仍然存在，但只保留在 system prompt，不再每轮 activation prompt 重复注入：

- 不要为了取当前触发消息再去 `check_messages`
- 优先 `send_message(content="...")` 无 target 回复当前会话
- 需要更多上下文时用 `read_history(...)`
- 正常提到 agent 名时不要随手加 `@`

这样做的目的：

- 减少 prompt 噪音
- 让 activation prompt 更像“结构化事件载荷”
- 避免 resume/fresh-session 时把同一套操作说明重复带入上下文

---

## 7. 当前口径与旧文档的关系

`architecture/message.md` 里仍保留了一些更早期的 prompt 示例，其中有些文案已经比当前实现更长。  
如果出现冲突，以这份文档和当前代码为准。
