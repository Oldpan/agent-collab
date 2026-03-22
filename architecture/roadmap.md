# 开发路线图

## 已完成

### Phase 1 — Monorepo 重组 (commit `4ce4087`)

- [x] 拆分 `packages/runtime-acp`（ACP 执行引擎，可独立复用）
- [x] 重命名 `packages/wire-types` → `packages/protocol`（统一通信协议类型）
- [x] `packages/node` → `apps/core`，`packages/web` → `apps/web`
- [x] `RuntimeConfig` 接口解耦（`BindingRuntime` 不再依赖完整 `AppConfig`）
- [x] SQLite migration v7（conversations 表 env_vars 字段）
- [x] 创建会话支持传入 `envVars`（注入 Agent 进程环境变量）
- [x] 历史回放（连接 WS 后自动重放已完成的 runs）
- [x] 全量 TypeScript 编译通过，32 个测试全部通过

### Phase 2 — 远端 Agent Node (commit `be297ac`)

- [x] `packages/protocol`：新增 `NodeToCore` / `CoreToNode` 消息类型
- [x] `packages/runtime-acp`：migration v8（`nodes` 表），`Platform` 新增 `'node'`
- [x] `apps/core`：`NodeRegistry` 服务（内存注册表）
- [x] `apps/core`：`GET /api/nodes` REST 端点
- [x] `apps/core`：`WS /api/nodes/connect` 端点（节点注册 / 心跳 / 事件转发）
- [x] `apps/agent-node`：新包，含 `CoreConnection`、`Executor`、`NodeSink`
- [x] 节点事件（`run.event`/`run.end`/`permission.request`）实时转发到前端 WS

### Phase 3 prep — Channel / Thread 多维路由 (commit `0a227a4`)

- [x] `packages/protocol`：新增 `ChannelInfo`、`CreateChannelRequest`，`ConversationInfo` 增加 `channelId` 字段
- [x] `packages/runtime-acp`：migration v9（`channels` 表 + 默认 `default` 频道、`conversations.channel_id`、旧 binding key 回填）
- [x] `apps/core`：`ConversationManager` 新增 `createChannel` / `listChannels` / `getChannel`，`listConversations(channelId?)` 支持过滤
- [x] `apps/core`：binding key 升级为 `web:{channelId}:{conversationId}:{agentType}`，支持多 channel 多 agentType 隔离
- [x] `apps/core`：新增 channel REST 路由（`GET/POST /api/channels`、`GET /api/channels/:id/conversations`）
- [x] `apps/web`：Vite `allowedHosts: true`，支持 cpolar 等反向代理隧道
- [x] 配置目录统一为 `~/.agent-collab`（旧 `~/.cli-gateway` 兼容读取）
- [x] 测试覆盖：channel CRUD + migration v9，38 个测试全部通过

> 前端 Channel / Thread UI 暂时写死为 `default` channel，待后续完善。

### Phase 4 — 远端调度集成（已完成，未 commit）

- [x] `packages/protocol`：`CreateConversationRequest` 新增 `nodeId?`，`ConversationInfo` 新增 `nodeId?`
- [x] `packages/runtime-acp`：migration v10（`conversations.node_id` 列）
- [x] `apps/core`：`ConversationManager` 接受 `NodeRegistry`，存储 `nodeId`，新增 `dispatchToNode()` 方法
- [x] `apps/core`：`handleApproval` 按 `nodeId` 路由 `permission.response` 到对应节点
- [x] `apps/core`：`wsHandler` prompt 按 `conv.nodeId` 分支本地执行 vs 远端 dispatch
- [x] `apps/core`：`nodeWsHandler` `run.end` 时更新 conversations 状态到 DB
- [x] `apps/core`：`main.ts` 创建 `NodeRegistry` 并注入 `ConversationManager`
- [x] `apps/web`：`api.ts` 新增 `listNodes()`，`Sidebar` 创建表单加节点选择器（Local / 远端节点）
- [x] Bug fix：`executor.ts` 在 `upsertBinding` 前先 `createSession`，修复 FK 约束失败
- [x] 日志：remote 执行链路各关键节点加结构化 `log`（`wsHandler`、`conversationManager`、`nodeWsHandler`、`executor`）
- [x] 38 个测试全部通过，migration version 断言升至 v10

### Phase 5 — Agent 第一公民（已完成）

- [x] `packages/runtime-acp`：migration v11（`agents` 表）、migration v12（`agents.channel_id`）
- [x] `packages/protocol`：新增 `AgentInfo`、`CreateAgentRequest`、`UpdateAgentRequest` 类型
- [x] `apps/core`：`ConversationManager` 新增 Agent CRUD（`createAgent` / `listAgents` / `getAgent` / `updateAgent` / `deleteAgent`）
- [x] `apps/core`：`server.ts` 新增 `/api/agents` REST 路由（GET/POST/PATCH/DELETE/GET-conversations）
- [x] `apps/core`：`dispatchToNode` 构建 `contextText`（System Prompt + Platform Memory + Local Memory）注入 ACP session
- [x] `packages/memory`：新包 `@agent-collab/memory`，`ClaudeMemoryBackend`（读 `~/.claude/projects/…/MEMORY.md`）+ `WorkspaceMemoryBackend`（读 `<agentDir>/MEMORY.md`）
- [x] `apps/web`：`useAgents` hook，`AgentDetailPanel`（名称 + Platform Memory 编辑），侧边栏改为 Channel → Agent → Conversations 三级
- [x] `apps/core/src/__tests__/conversationManager.test.ts`：Agent CRUD 测试，migration 断言升至 v12

### Phase 6 — Machine 预置 + 纯远端架构（已完成）

- [x] **移除本地执行路径**：`wsHandler` 不再支持 `nodeId=null`；`sendPrompt()`、`BindingRuntime`、`WsSink` 从 core 中删除
- [x] `packages/runtime-acp`：migration v13（`nodes` 表新增 `display_name TEXT`、`env_var_keys TEXT`、`provisioned_at INTEGER`）
- [x] `packages/protocol`：新增 `MachineInfo`、`CreateMachineRequest` 类型
- [x] `apps/core`：`ConversationManager` 新增 Machine CRUD（`createMachine` / `listMachines` / `getMachine` / `deleteMachine`）
- [x] `apps/core`：`nodeWsHandler` `node.register` 改为 UPSERT（pending → online），断线时 UPDATE `status='offline'`
- [x] `apps/core`：`server.ts` 新增 `/api/machines` REST 路由（GET/POST/GET:id/DELETE:id）
- [x] `apps/web`：新增 `useMachines` hook、`MachineCreatePanel`（生成含 `NODE_ID` 的连接命令，一键复制）
- [x] `apps/web`：侧边栏重构为 Machine → Agent → Conversations 三级，Machine 状态圆点（绿/黄/灰），移除 node 选择下拉
- [x] 测试：`conversationManager.test.ts` + `migrations.test.ts` 断言升至 v13，`server.test.ts` 更新 WS prompt 测试（无 nodeId → error 事件）

### Phase 7 — 执行层重构 + Host 化恢复（已完成，未 commit）

- [x] `packages/protocol`：新增 `RuntimeDriverDefinition`、`RUNTIME_DRIVERS`、`dispatchMode(cold_start|resume)`、`hostKey`
- [x] `packages/protocol`：`ConversationStatus` 升级为 `idle / active / recovering / awaiting_approval / failed`
- [x] `apps/core`：新增 `ExecutionDispatcher`，统一 dispatch / cancel / approval response
- [x] `apps/core`：`ConversationManager` 退化为 façade，主执行逻辑迁出
- [x] `apps/core`：新增 `nodeStateReconciler`，core 启动时把 stale `online` node 收敛为 `offline`，并将挂起中的会话标记为 `failed`
- [x] `apps/core`：`nodeWsHandler` 收到 `run.event(conversation.status)` 时会写回 DB
- [x] `apps/agent-node`：新增 `AgentHost`，host 状态 `idle / active / failed`
- [x] `apps/agent-node`：host 支持 inbox 串行调度，同一 host 的并发 prompt 不再直接叠到 runtime queue
- [x] `apps/agent-node`：新增 `dispatchQueueStore` + `node_dispatch_queue`（migration v14）
- [x] `apps/agent-node`：`Executor.resumePendingDispatches()` 支持 node 重启后恢复 `queued/running` dispatch
- [x] `apps/agent-node`：默认 `nodeId` 改为稳定持久 ID（`~/.agent-node/node-id`），不再跟 `pid` 绑定
- [x] `apps/web`：前端状态机支持 `recovering`，聊天面板显示 `Recovering session...`
- [x] 历史回放修复：未结束 run 回放时不再强行发送 `turn.end`，允许 recovering 场景下 live 事件接续同一 turn
- [x] 测试：
  - [x] core：`ExecutionDispatcher`、`nodeStateReconciler`、`nodeWsHandler(recovering)`、`server(recovering replay)` 已覆盖
  - [x] agent-node：新增 node 重启恢复测试链（`resumePendingDispatches()`）

---

## 待开发

### Phase 8 — 恢复路径补全

- [ ] recovering 场景下的 pending approval 恢复
- [ ] recovering 场景下的 cancel 语义收敛
- [ ] node 连接层自动重连 / backoff，而不是当前手动重启
- [ ] host 级 idle TTL / 淘汰策略
- [ ] session 级 resume 能力与 driver 能力矩阵进一步对齐
- [ ] `node_dispatch_queue` 的恢复失败原因落库与可视化

### Phase 9 — 生产就绪

- [x] 取消执行（cancel）基础链路
- [ ] 前端静态文件由 core `@fastify/static` 托管
- [ ] 用户认证 / 多用户支持
- [ ] 生产部署优化（shiki 按需加载）
