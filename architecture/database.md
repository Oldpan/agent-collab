# 数据库

SQLite，当前 migration 版本是 **v20**。

## 核心表

### runtime / execution

- `sessions`
  - ACP session 状态
- `bindings`
  - platform/binding -> session 映射
- `runs`
  - 每次执行记录
- `events`
  - 原始事件，含回放所需顺序
- `tool_policies`
- `tool_allow_prefixes`
- `delivery_checkpoints`
- `ui_prefs`

### product model

- `nodes`
- `agents`
- `conversations`
- `channels`
- `channel_messages`
- `tasks`
- `agent_message_checkpoints`

### queue / recovery

- `node_dispatch_queue`
  - node 本地恢复队列
- `conversation_prompt_queue`
  - 同一 agent 多 thread 串行队列

## 关键表说明

### nodes

保存机器/远端 node 记录。

当前重要字段：

- `node_id`
- `hostname`
- `agent_types_json`
- `version`
- `status`
  - `pending | online | offline | deleted`
- `last_seen`
- `display_name`
- `env_var_keys`
- `provisioned_at`

### agents

保存 agent 长期身份。

当前重要字段：

- `agent_id`
- `name`
- `agent_type`
  - `claude_acp | codex_acp`
- `channel_id`
  - 目前保留兼容，不是 direct chat 主路径
- `system_prompt`
- `env_vars`
- `disabled_tool_kinds`
- `node_id`
- `workspace_path`

注意：

- `memory` 仍可能在旧 schema/旧代码路径中存在，但当前产品语义上已经不再作为 Platform Memory 使用

### conversations

保存 thread / 会话状态。

当前重要字段：

- `id`
- `session_key`
- `status`
- `agent_id`
- `node_id`
- `workspace_path`
- `env_vars`
- `channel_id`
- `thread_kind`
  - `direct | branch`
- `is_primary_thread`

当前 direct chat 规则：

- 一个 agent 默认一个 primary direct thread

### runs

保存单次执行记录。

重要点：

- `runs` 通过 `session_key` 关联 conversation
- 不要假设 `runs` 表里直接有 `conversation_id`

关键字段：

- `run_id`
- `session_key`
- `prompt_text`
- `started_at`
- `ended_at`
- `stop_reason`
- `error`

### events

保存回放事件。

关键字段：

- `run_id`
- `seq`
- `method`
- `payload_json`
- `created_at`

当前前端 replay 依赖这些事件重建：

- `content.delta`
- `thinking.delta`
- `tool.call`
- `tool.result`
- 以及 `node/event`

### node_dispatch_queue

node 本地恢复队列。

关键字段：

- `run_id`
- `host_key`
- `session_key`
- `conversation_id`
- `payload_json`
- `state`
  - `queued | running | awaiting_approval`
- `created_at`
- `updated_at`

用途：

- node 收到 dispatch 时落盘
- node 重启后恢复 pending work
- 若 pending work 停在 `awaiting_approval`，当前策略是失败收口并要求重新执行

### conversation_prompt_queue

agent 级串行执行队列。

关键字段：

- `queue_id`
- `agent_id`
- `conversation_id`
- `prompt_text`
- `created_at`
- `updated_at`

用途：

- 同一 agent 的多个 thread 不并行执行
- 后续 prompt 入队，等待前一个 thread settle

## migration 历史

### v1-v5

runtime 基础表：

- `sessions`
- `bindings`
- `runs`
- `events`
- `tool_policies`
- `delivery_checkpoints`
- `ui_prefs`
- `tool_allow_prefixes`

### v6-v10

会话与远端节点基础：

- `conversations`
- `env_vars`
- `nodes`
- `channels`
- `conversations.channel_id`
- `conversations.node_id`

### v11-v14

agent 与 node 恢复：

- `agents`
- `agents.channel_id`
- `nodes.display_name`
- `nodes.env_var_keys`
- `nodes.provisioned_at`
- `node_dispatch_queue`

### v15-v17

thread 语义与权限：

- `conversations.thread_kind`
- `conversations.is_primary_thread`
- `conversation_prompt_queue`
- `agents.disabled_tool_kinds`

### v18-v20

channel 协作面：

- `channel_messages`
- `tasks`
- `agent_message_checkpoints`

## agent-node 本地 DB

agent-node 自己维护独立 SQLite。

实际重要用途：

- 本地 runtime session / binding / run / event
- 本地 `node_dispatch_queue`

虽然 migration 会建更多表，但 node 侧真正依赖的业务真相主要是：

- `sessions`
- `bindings`
- `runs`
- `events`
- `node_dispatch_queue`

## 当前注意点

- 改 migration 后要同步更新测试中的 schema version 断言
- `ALTER TABLE` 仍应谨慎处理，避免多语句混在一起导致迁移行为不稳定
- 现在的 DB 已经同时承载：
  - runtime replay
  - agent/product model
  - queue/recovery
  - channel collaboration groundwork
