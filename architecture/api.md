# REST API

## 端点列表

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/conversations` | 获取所有会话列表 |
| `POST` | `/api/conversations` | 创建会话 (`{ agentType?, workspacePath?, title?, channelId?, envVars?, nodeId? }`) |
| `DELETE` | `/api/conversations/:id` | 删除会话 |
| `GET` | `/api/conversations/:id/history` | 获取会话历史（runs 列表） |
| `GET` | `/api/channels` | 获取所有 channel 列表 |
| `POST` | `/api/channels` | 创建 channel (`{ name, workspacePath? }`) |
| `GET` | `/api/channels/:id/conversations` | 获取指定 channel 下的会话列表 |
| `GET` | `/api/nodes` | 获取已连接的远端节点列表 |

## 说明

- 会话创建时可传入 `envVars` 对象，注入到 Agent 进程环境变量中
- `channelId` 用于将会话归属到指定频道（默认 `default`）
- `agentType` 当前支持 `claude_acp` / `codex_acp`
- `nodeId` 指定远端执行节点 ID（从 `GET /api/nodes` 获取）；不传则本地执行
