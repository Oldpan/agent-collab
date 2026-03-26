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
- `Node not connected` / `Node disconnected during dispatch` 这类 0s run 已显示为 `not dispatched`

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

### 10. 开发运行时收敛

- 已增加统一 tmux 重启入口：
  - `dev:restart:core`
  - `dev:restart:node`
  - `dev:restart:web`
  - `dev:restart`
- `agent-node` 已支持与 `core` 断线后的自动重连 / backoff

### 11. 恢复与状态机收口第一版

- `node_dispatch_queue.state` 已支持：
  - `queued`
  - `running`
  - `awaiting_approval`
- 等待审批中的 run 在 reconnect / restart 后不再尝试恢复旧 request，而是失败收口并要求重跑
- host 已支持默认 `30min` idle TTL 自动回收
- tool 结果已带显式终态：
  - `completed`
  - `failed`
  - `cancelled`
- Activity 对 run / tool 的状态说明比之前更明确

### 12. Channel 与任务看板第一版

- agent 的公共频道关系已收口为：
  - 固定私聊入口
  - `0..N` 个 channel 订阅
- `channel.description` 已落库并打通到前后端
- `list_server` 中的：
  - `joined`
  - `humans`
  已有基础实现
- ChannelPanel 已新增 `Tasks` tab
- task board 前端基础版已落地：
  - 按状态分组
  - 新建任务
  - 推进状态
  - `done` 默认折叠
- assignee 当前只读展示，用户侧分配尚未开放

## 当前缺口

### 1. 前端自动化不足

- 后端测试已经较完整
- 前端组件 / 交互自动化仍偏弱
- 缺少黑盒端到端回归

### 2. Activity 聚合还可以继续优化

- 重复工具调用仍可聚合得更紧凑
- run / tool 的状态说明还可以更清晰

### 3. 恢复策略还可以继续深化

- 当前 approval 在 reconnect / restart 后是 fail-and-rerun，不是完整 replay
- cancel / recovering 还可以继续细化成更完整的终态模型
- host TTL 目前是固定策略，还没有按 runtime / 负载做差异化

### 4. Channel 协作仍是基础版

- task board 还没有用户侧 assign / unassign
- 频道描述当前只有数据链路，编辑入口还不完整
- `list_server` / 多频道订阅虽然可用，但还没做完整的产品打磨
- DM Thread UI 已按当前产品模型 defer

## 下一步建议

### P1

- 补前端关键回归：
  - 无 agent 空状态
  - agent 主线程打开
  - machine 删除级联后的 UI 一致性
  - workspace / profile / activity 关键视图

### P2

- 改善 Activity 聚合：
  - 重复 `send_message/check_messages` 归并
  - `not dispatched / cancelled / failed / completed` 的说明更紧凑

### P3

- 评估是否要持久化 approval request 本体，以支持真正的 approval replay
- 评估 host TTL 是否需要按 agentType / workspace 活跃度做差异化策略

### P4

- 给 task board 补用户侧任务分配能力
- 补 channel description 的前端编辑入口
- 继续推进 channel 中 `@agent` 的 branch thread 产品路径
- 维持 direct chat 单主 thread，不恢复 DM thread UI
