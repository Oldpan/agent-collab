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

> 前端 Channel / Thread UI 暂时写死为 `default` channel，待 Phase 4 前端部分完善。

---

## 待开发

### Phase 4 — 前端多 Channel UI + 远端调度集成

- [ ] 前端 Channel / Thread 侧边栏 UI（创建频道、切换频道、thread 列表）
- [ ] `RuntimeAdapter` 抽象（`LocalRuntimeAdapter` / `RemoteNodeAdapter`）
- [ ] `ConversationManager` 按 agentType 选择本地或远端节点执行
- [ ] 前端节点选择 UI（创建会话时选择目标节点）
- [ ] `permission.response` 路由到对应节点的等待中的 BindingRuntime

### Phase 5 — 生产就绪

- [ ] 取消执行（cancel）支持
- [ ] 节点断线重连 + 任务恢复
- [ ] 前端静态文件由 core `@fastify/static` 托管
- [ ] 用户认证 / 多用户支持
- [ ] 生产部署优化（shiki 按需加载）
