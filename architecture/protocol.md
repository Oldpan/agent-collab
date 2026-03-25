# 协议

## 浏览器 ↔ core

连接地址：

`ws://host:3100/api/conversations/:id/stream`

### ClientEvent

- `prompt`
  - `{ type: "prompt", text, attachments? }`
- `approval.response`
  - `{ type: "approval.response", requestId, decision }`
- `cancel`
  - `{ type: "cancel" }`

### ServerEvent

- `conversation.status`
  - `idle | queued | active | recovering | awaiting_approval | failed`
- `turn.begin`
  - 含 `turnId`、可选 `startedAt`
- `turn.end`
  - 含 `turnId`、`stopReason?`、`endedAt?`、`error?`
- `content.delta`
- `thinking.delta`
- `tool.call`
  - 含 `toolCallId`、`name`、`input`、`startedAt?`
- `tool.result`
  - 含 `toolCallId`、`output`、`error?`、`endedAt?`
- `approval.request`
- `error`
- `history.user_message`
- `history.complete`
- `history.reset`
- `channel.message`
- `system.notice`

## 历史回放

连接建立后，core 会先回放历史，再进入 live 流。

### 已结束 run

回放顺序：

`history.user_message -> turn.begin -> 历史事件 -> turn.end`

### 未结束 run

回放顺序：

`history.user_message -> turn.begin -> 历史事件`

不会强行补 `turn.end`。

### recovering

若会话当前状态为 `recovering`：

- 前端会先收到 `conversation.status = recovering`
- 之后历史事件和 live 事件会继续接到同一 turn 上

## core ↔ agent-node

连接地址：

`ws://host:3100/api/nodes/connect`

### NodeToCore

- `node.register`
- `node.heartbeat`
- `run.event`
- `run.end`
- `permission.request`
- `workspace.list.response`
- `workspace.read.response`
- `workspace.reset.response`

### CoreToNode

- `node.ack`
- `run.dispatch`
- `run.cancel`
- `permission.response`
- `workspace.list.request`
- `workspace.read.request`
- `workspace.reset.request`

## run.dispatch

关键字段：

- `runId`
- `conversationId`
- `agentType`
- `sessionKey`
- `hostKey`
- `dispatchMode`
  - `cold_start`
  - `resume`
- `prompt`
- `contextText`
- `cwd`
- `envVars`
- `disabledToolKinds`

### 语义

- `hostKey` 当前用于 host 归属和复用
- `dispatchMode` 表示这次是新启动还是恢复已有 host/session
- `disabledToolKinds` 用于 agent 级禁用权限

## workspace 协议

当前 workspace 统一由远端 node 作为真实来源。

### 请求

- `workspace.list.request`
  - `requestId`
  - `workspaceRoot`
  - `relativePath`
- `workspace.read.request`
  - `requestId`
  - `workspaceRoot`
  - `relativePath`
- `workspace.reset.request`
  - `requestId`
  - `workspaceRoot`

### 响应

- `workspace.list.response`
- `workspace.read.response`
- `workspace.reset.response`

当前行为：

- list / read 只读
- reset 用于 agent reset 时重建 workspace

## 节点注册流程

1. node 发 `node.register`
2. core 校验该节点是否已被删除
3. core 更新 `nodes` 表状态为 `online`
4. core 回 `node.ack`

断线时：

- `core` 会把对应 node 标成 `offline`
- 非 idle conversation 会被标成 `failed`

当前 node 行为：

- `agent-node` 与 `core` 断线后不会直接退出
- 会按指数退避自动重连
- 重连成功后重新 `node.register`

## prompt 调度流程

1. 浏览器发 `prompt`
2. `wsHandler` 交给 `ExecutionDispatcher`
3. `ExecutionDispatcher` 判断：
   - 该 agent 是否已有活跃 thread
   - 当前 prompt 是立即 dispatch 还是入 `conversation_prompt_queue`
4. 若立即 dispatch：
   - 下发 `run.dispatch`
5. node 运行时持续发：
   - `run.event`
   - `permission.request`
6. 结束时发：
   - `run.end`

## Activity 时间戳

当前前端 Activity 依赖这些真实时间字段：

- run：
  - `turn.begin.startedAt`
  - `turn.end.endedAt`
- tool：
  - `tool.call.startedAt`
  - `tool.result.endedAt`

历史回放也会补齐这些时间，避免刷新后 duration 漂移。

## Activity 状态语义

前端对 run 会派生一类显示状态：

- `not dispatched`
  - 不是协议里的独立枚举，而是 UI 根据 `run.error` 派生
  - 当前主要覆盖：
    - `Node not connected`
    - `Node disconnected during dispatch`
  - 语义是：run 在真正开始执行前就失败，不应显示为 `completed`
