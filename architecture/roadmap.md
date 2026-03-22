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

---

## 待开发

### Phase 4 剩余 — 前端多 Channel UI

- [ ] 前端 Channel / Thread 侧边栏 UI（创建频道、切换频道、thread 列表）

### Phase 5 — 生产就绪

- [ ] 取消执行（cancel）支持
- [ ] 节点断线重连 + 任务恢复
- [ ] 前端静态文件由 core `@fastify/static` 托管
- [ ] 用户认证 / 多用户支持
- [ ] 生产部署优化（shiki 按需加载）
