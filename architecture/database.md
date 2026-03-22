# 数据库

SQLite，当前 migration 版本 **v9**。

## 表结构

| 表 | 说明 |
|----|------|
| `sessions` | ACP session 状态 |
| `bindings` | platform + chatId 到 session 的映射（key 格式：`web:{channelId}:{convId}:{agentType}`） |
| `runs` | 每次 prompt 执行记录 |
| `events` | ACP session/update 原始事件 |
| `channels` | 频道/工作空间（含默认 `default` 频道） |
| `conversations` | 会话/线程（含 `channel_id`、`env_vars`） |
| `tool_policies` | 工具授权策略 |
| `nodes` | 已注册的远端节点记录 |

## Binding Key 格式

```
web:{channelId}:{conversationId}:{agentType}
```

支持多 channel、多 agentType 的 session 隔离。每个 binding 对应一个独立的 ACP session。

## Migration 历史

- **v7**: conversations 表新增 `env_vars` 字段
- **v8**: 新增 `nodes` 表，`Platform` 新增 `'node'` 类型
- **v9**: 新增 `channels` 表 + 默认 `default` 频道、`conversations.channel_id` 外键、旧 binding key 回填为新格式
