# 开发路线图

## 已完成

### 1. Monorepo 与执行内核拆分

- `packages/runtime-acp` 已拆出并可独立复用
- `packages/protocol` 统一了前后端与 core-node 共享类型
- `apps/core / apps/agent-node / apps/web` 的职责已经明确

### 2. 远端执行主路径

- core 不再本地执行 agent
- 所有 prompt 都通过连接中的 `agent-node` 执行
- `NodeRegistry` / `node.register` / `run.dispatch` / `run.event` / `run.end` 已打通

### 3. Agent 第一公民

- `agents` 已成为长期身份实体
- agent 拥有：
  - `system_prompt`
  - `env_vars`
  - `disabled_tool_kinds`
  - `workspace_path`
  - `node_id`
- 前端已支持 agent 创建、编辑、删除

### 4. 执行层重构

- `ConversationManager` 已从执行单体退化为应用 façade
- `ExecutionDispatcher` 已统一 dispatch / cancel / approval / 串行排队
- `ConversationStatus` 已升级为：
  - `idle`
  - `queued`
  - `active`
  - `recovering`
  - `awaiting_approval`
  - `failed`

### 5. Host 化与恢复

- `AgentHost` 已引入
- host 支持 `cold_start / resume`
- 同 host 已支持 inbox 串行
- `node_dispatch_queue` 已持久化到 node 本地 DB
- node 重启后可恢复 pending dispatch
- core 启动时已能做 stale state reconcile

### 6. 私聊模型收敛

- 每个 agent 的 direct chat 只保留一个主 thread
- `thread_kind` / `is_primary_thread` 已落库
- `conversation_prompt_queue` 已落库，用于 agent 级串行
- 侧边栏不再暴露 direct chat 多线程入口

### 7. Workspace / Profile / Activity

- 远端 workspace 浏览已落地
- Profile 已集中展示 agent 基础信息
- Activity 已展示 runs、tool calls、run duration、tool duration、reasoning

### 8. Claude 隔离配置

- Claude agent 默认隔离到 `<workspacePath>/.claude-runtime`
- 已默认关闭 Claude auto memory
- 不再默认继承宿主机 `~/.claude` 的插件 / MCP

### 9. 当前 prompt / memory 口径

- `Platform Memory` 已移除
- 当前只保留：
  - `System Prompt`
  - `Local Memory`
- 默认 prompt 已要求 agent 主动维护：
  - `MEMORY.md`
  - `notes/*.md`
- 默认 prompt 也已强化：
  - 长任务前先短确认
  - 中途短更新
  - 完成后总结并写记忆

## 当前缺口

### 1. 节点连接恢复仍不够稳

- 重启 `core` 后，当前 `agent-node` 可能不会稳定自动重连
- 目前实践上需要重启 `agent-node`

### 2. 恢复语义还没完全收口

- recovering 下的 pending approval 恢复还不完整
- recovering 下的 cancel 语义还没完全明确
- host 的 idle TTL / 淘汰策略还没做

### 3. 前端自动化不足

- 后端测试已经较完整
- 前端组件 / 交互自动化仍偏弱
- 缺少黑盒端到端回归

### 4. Activity 聚合还可以继续优化

- 重复工具调用仍可聚合得更紧凑
- run / tool 的状态说明还可以更清晰

## 下一步建议

### P1

- 增加统一重启脚本：
  - `core`
  - `agent-node`
  - `web`
- 补 node 自动重连 / backoff
- 把 “Node not connected” 这类 0s run 在 UI 中显示得更准确

### P2

- 完成 recovering + approval / cancel 的恢复语义
- 给 host 增加 idle timeout / 回收
- 继续收敛 run / tool 状态机

### P3

- 补前端关键回归：
  - 无 agent 空状态
  - agent 主线程打开
  - machine 删除级联后的 UI 一致性
  - workspace / profile / activity 关键视图

### P4

- 重新推进 channel 中 `@agent` 的 branch thread 产品路径
- 在 direct chat 与 channel branch 之间形成清晰分层
