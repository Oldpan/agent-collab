# 数据库

SQLite，当前 migration 版本 **v13**。

## 表结构

| 表 | 说明 |
|----|------|
| `sessions` | ACP session 状态（command、args、cwd、acp_session_id） |
| `bindings` | platform + chatId 到 session 的映射（key 格式：`web:{channelId}:{convId}:{agentType}` / `node:{convId}:-:node_user`） |
| `runs` | 每次 prompt 执行记录 |
| `events` | ACP session/update + node/event 原始事件（含 seq 用于回放） |
| `tool_policies` | 工具授权策略 |
| `channels` | 频道/工作空间（含默认 `default` 频道，当前 UI 不展示，保留兼容） |
| `conversations` | 会话/线程（含 `channel_id`、`env_vars`、`node_id`、`agent_id`） |
| `agents` | Agent 实体（名称、类型、system prompt、memory、所属 node、workspace 路径） |
| `nodes` | 已注册/预置的远端 Machine 记录（含 `display_name`、`env_var_keys`、`provisioned_at`） |

## nodes 表结构

```sql
CREATE TABLE nodes (
  node_id            TEXT PRIMARY KEY,
  hostname           TEXT NOT NULL,
  agent_types_json   TEXT NOT NULL,
  version            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'online',  -- 'pending' | 'online' | 'offline'
  last_seen          INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  display_name       TEXT,          -- 用户设定的机器名称（v13）
  env_var_keys       TEXT,          -- JSON string[]，如 ["ANTHROPIC_API_KEY"]（v13）
  provisioned_at     INTEGER NOT NULL DEFAULT 0  -- 预置时间戳（v13）
);
```

## agents 表结构

```sql
CREATE TABLE agents (
  agent_id       TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  agent_type     TEXT NOT NULL DEFAULT 'claude_acp',
  channel_id     TEXT NOT NULL DEFAULT 'default',   -- 保留兼容，UI 不展示
  system_prompt  TEXT NOT NULL DEFAULT '',
  memory         TEXT NOT NULL DEFAULT '',
  env_vars       TEXT,
  node_id        TEXT,              -- 所属 Machine 的 nodeId
  workspace_path TEXT,              -- agent 专属目录（~/.agent-collab/agents/<id>-<name>/）
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
```

## Migration 历史

| 版本 | 内容 |
|------|------|
| v1 | 初始表：`sessions`、`bindings`（FK sessions）、`events` |
| v2 | `runs` 表（每次执行记录） |
| v3 | `sessions.load_supported` 列 |
| v4 | `tool_policies` 表 |
| v5 | `events.seq` 列 |
| v6 | `sessions.cwd` 列 |
| v7 | `conversations` 表，`conversations.env_vars` |
| v8 | `nodes` 表，`bindings.platform` 新增 `'node'` |
| v9 | `channels` 表 + 默认 `default` 频道，`conversations.channel_id` 外键，旧 binding key 回填 |
| v10 | `conversations.node_id TEXT NULL`（标记路由到哪个远端节点） |
| v11 | `agents` 表，`conversations.agent_id` 外键 |
| v12 | `agents.channel_id TEXT NOT NULL DEFAULT 'default'` |
| v13 | `nodes.display_name TEXT`，`nodes.env_var_keys TEXT`，`nodes.provisioned_at INTEGER DEFAULT 0` |

## agent-node 本地 DB

agent-node 维护独立 SQLite（默认 `~/.agent-collab/agents/db.sqlite`），表结构相同，但：

- `sessions` / `bindings` / `runs` / `events` 由 executor 在收到 `run.dispatch` 时按需创建
- `conversations` / `channels` / `agents` / `nodes` 表存在但不使用（migration 全量执行）
