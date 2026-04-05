# REST API

## Machine（节点预置）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/machines` | 获取所有 Machine 列表（含 pending/online/offline） |
| `POST` | `/api/machines` | 预置 Machine（`{ name, envVarKeys? }`），返回含连接命令所需的 `nodeId` |
| `GET` | `/api/machines/:id` | 获取单个 Machine |
| `DELETE` | `/api/machines/:id` | 删除 Machine（同时解绑其下 agents 的 node_id） |

`POST /api/machines` 响应示例：
```json
{
  "nodeId": "550e8400-e29b-41d4-a716-446655440000",
  "name": "my-gpu-box",
  "hostname": null,
  "status": "pending",
  "envVarKeys": ["ANTHROPIC_API_KEY"],
  "provisionedAt": 1711000000000,
  "createdAt": 0
}
```

## Agent（持久化 Agent 实体）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/agents` | 获取所有 Agent 列表 |
| `POST` | `/api/agents` | 创建 Agent（`{ name, agentType?, nodeId, systemPrompt?, memory?, envVars?, workspacePath? }`） |
| `GET` | `/api/agents/:id` | 获取单个 Agent |
| `PATCH` | `/api/agents/:id` | 更新 Agent（`{ name?, systemPrompt?, memory? }`） |
| `DELETE` | `/api/agents/:id` | 删除 Agent（关联 conversations 的 agent_id 置 NULL） |
| `GET` | `/api/agents/:id/conversations` | 获取该 Agent 下的所有 Conversation |

## Conversation（对话线程）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/conversations` | 获取所有 Conversation 列表 |
| `POST` | `/api/conversations` | 创建 Conversation（`{ agentId?, agentType?, nodeId?, workspacePath?, title?, channelId?, envVars? }`） |
| `DELETE` | `/api/conversations/:id` | 删除 Conversation |
| `GET` | `/api/conversations/:id/history` | 获取会话历史（runs 列表） |

## Channel（保留兼容）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/channels` | 获取所有 Channel |
| `POST` | `/api/channels` | 创建 Channel（`{ name, workspacePath? }`） |
| `GET` | `/api/channels/:id/conversations` | 获取指定 Channel 下的 Conversation |

Channel 当前已经在 UI 中作为协作空间使用，包含 `Chat / Tasks / Members / Settings` 视图。所有新 Conversation 默认归属 `default` channel。

## Task（Channel Task Board）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/channels/:id/tasks` | 获取指定 Channel 的 task board |
| `POST` | `/api/channels/:id/tasks` | 新建 task；会同时创建 task message |
| `POST` | `/api/channels/:id/tasks/claim-message` | 把一条 channel 根消息提升为 task，并立即 claim 给当前用户 |
| `POST` | `/api/channels/:id/tasks/:num/claim` | claim 指定 task |
| `POST` | `/api/channels/:id/tasks/:num/unclaim` | 释放自己 claim 的 task |
| `PATCH` | `/api/channels/:id/tasks/:num/status` | 更新 task 状态 |
| `DELETE` | `/api/channels/:id/tasks/:num` | 删除 task |
| `POST` | `/api/channels/:id/clear-chat` | 清空 channel 聊天历史；同时清空该 channel 的 task board |

补充说明：

- task 状态流转为 `todo -> in_progress -> in_review -> done`
- `claim-message` 会把任务直接置为 `in_progress`
- 除 `in_review -> done` 外，其它状态更新都要求当前用户就是 assignee
- `clear-chat` 不再保留 tasks，避免留下失去 task message / thread 的悬空任务

## Nodes（兼容，仅返回在线节点）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/nodes` | 获取当前 in-memory 已连接节点（NodeRegistry），已被 `/api/machines` 替代 |

## WebSocket

| 路径 | 方向 | 说明 |
|------|------|------|
| `WS /api/conversations/:id/stream` | 前端 ↔ core | 实时对话流（prompt / approval.response / 历史回放） |
| `WS /api/nodes/connect` | agent-node → core | 节点注册、心跳、run.event 转发 |

## 说明

- `agentType` 支持 `claude_acp` / `codex_acp`
- 创建 Agent 时若不传 `workspacePath`，core 自动派生：`~/.agent-collab/agents/<agentId>-<slugName>/`
- Conversation 创建时若传 `agentId`，自动继承 agent 的 `nodeId`、`agentType`、`workspacePath`、`envVars`
- 所有执行只走远端路径（`nodeId` 必须设置），没有 nodeId 的 Conversation 发 prompt 会返回错误
