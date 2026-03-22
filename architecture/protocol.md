# WebSocket 协议

## 前端 ↔ core

连接地址：`ws://host:3100/api/conversations/:id/stream`

### 客户端 → 服务端 (ClientEvent)

| 类型 | 说明 |
|------|------|
| `{ type: "prompt", text }` | 发送提示词 |
| `{ type: "approval.response", requestId, decision }` | 回复工具审批 |
| `{ type: "cancel" }` | 取消当前执行（待实现） |

### 服务端 → 客户端 (ServerEvent)

| 类型 | 说明 |
|------|------|
| `conversation.status` | 状态变更 idle/busy/error |
| `turn.begin` / `turn.end` | 一轮对话生命周期 |
| `content.delta` | 流式文本输出 |
| `thinking.delta` | 流式思考过程 |
| `tool.call` / `tool.result` | 工具调用及结果 |
| `approval.request` | 请求用户授权工具执行 |
| `history.user_message` | 历史回放：用户消息 |
| `history.complete` | 历史回放完成 |
| `error` | 错误消息 |

连接建立后会自动重放该会话已完成的 runs（history 事件序列），随后进入实时模式。

---

## agent-node ↔ core

连接地址：`ws://host:3100/api/nodes/connect`

### 节点 → core (NodeToCore)

| 类型 | 说明 |
|------|------|
| `node.register` | 注册节点（含 nodeId / hostname / agentTypes / version） |
| `node.heartbeat` | 心跳保活 |
| `run.event` | 转发 Agent 产生的 ServerEvent |
| `run.end` | 本地 run 结束（含 stopReason / error） |
| `permission.request` | 请求用户授权（工具审批） |

### core → 节点 (CoreToNode)

| 类型 | 说明 |
|------|------|
| `node.ack` | 注册确认 |
| `run.dispatch` | 下发任务（含 prompt / sessionKey / envVars 等） |
| `run.cancel` | 取消执行中的 run |
| `permission.response` | 用户审批决定转发给节点 |

### 协议流程

```
agent-node                          core                           前端
    │                                │                               │
    │──── node.register ────────────▶│                               │
    │◀─── node.ack ─────────────────│                               │
    │                                │◀──── prompt (ClientEvent) ────│
    │◀─── run.dispatch ─────────────│                               │
    │                                │                               │
    │──── run.event (content.delta) ▶│──── content.delta ───────────▶│
    │──── run.event (tool.call) ────▶│──── tool.call ───────────────▶│
    │──── permission.request ───────▶│──── approval.request ────────▶│
    │                                │◀──── approval.response ───────│
    │◀─── permission.response ──────│                               │
    │──── run.end ──────────────────▶│──── turn.end ────────────────▶│
    │                                │                               │
    │──── node.heartbeat ───────────▶│ (每 15s)                      │
```
