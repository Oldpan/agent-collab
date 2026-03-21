# Agent Collab — 跨机多 Agent 协作平台

基于 ACP (Agent Client Protocol) 的多机协作平台。中心节点 (`apps/core`) 提供 Web UI 和 REST/WebSocket API；远端机器运行 `apps/agent-node`，通过 WebSocket 注册到中心，并在本地执行 ACP Agent（Claude Code、Codex 等），将结果实时流回前端。

---

## 项目结构

```
agent-collab/
├── apps/
│   ├── core/           # @agent-collab/core — 中心服务 (HTTP + WS + 会话管理)
│   │   └── src/
│   │       ├── main.ts
│   │       ├── config.ts
│   │       ├── services/
│   │       │   └── nodeRegistry.ts       # 已连接远端节点注册表
│   │       └── web/
│   │           ├── server.ts             # Fastify HTTP + WS 路由
│   │           ├── wsHandler.ts          # 前端 WS 连接管理 & 事件广播
│   │           ├── nodeWsHandler.ts      # 远端节点 WS 连接处理
│   │           ├── wsSink.ts             # OutboundSink → ServerEvent
│   │           └── conversationManager.ts
│   ├── agent-node/     # @agent-collab/agent-node — 远端执行节点
│   │   └── src/
│   │       ├── main.ts                   # 启动入口，连接到 core
│   │       ├── config.ts                 # 环境变量配置
│   │       ├── connection.ts             # CoreConnection (WS 客户端 + 心跳)
│   │       ├── executor.ts               # 接收 run.dispatch，本地执行 BindingRuntime
│   │       └── nodeSink.ts               # OutboundSink → run.event 转发给 core
│   └── web/            # @agent-collab/web — React 前端
│       └── src/
│           ├── App.tsx
│           ├── features/
│           │   ├── sidebar/Sidebar.tsx   # 会话列表、创建、删除
│           │   └── chat/
│           │       ├── ChatPanel.tsx     # 消息流、工具调用、审批卡片
│           │       └── PromptComposer.tsx
│           ├── hooks/
│           │   ├── useConversationStream.ts
│           │   └── useConversations.ts
│           └── lib/api.ts
├── packages/
│   ├── protocol/       # @agent-collab/protocol — 前后端 + 节点间共享类型
│   │   └── src/index.ts  # ServerEvent / ClientEvent / NodeToCore / CoreToNode / REST 类型
│   └── runtime-acp/    # @agent-collab/runtime-acp — ACP 执行引擎 (可复用)
│       └── src/
│           ├── acp/           # ACP JSON-RPC 协议层
│           ├── gateway/       # BindingRuntime, ToolAuth, SessionStore …
│           └── db/            # SQLite migrations, 各 store
├── package.json
└── pnpm-workspace.yaml
```

---

## 技术栈

| 层 | 技术 |
|---|------|
| 包管理 | pnpm workspace monorepo |
| 后端 | Node.js 18+, Fastify 5, @fastify/websocket, better-sqlite3 |
| 前端 | React 19, Vite, TypeScript, Tailwind CSS 4, Zustand, Radix UI |
| Agent 通信 | ACP (Agent Client Protocol) — JSON-RPC 2.0 over subprocess stdio |
| Markdown 渲染 | streamdown 2.5 + shiki 代码高亮 |
| 测试 | Vitest (32 个单元/集成测试) |

---

## 快速开始

### 前置要求

- Node.js >= 18
- pnpm >= 9

### 安装依赖

```bash
pnpm install
```

### 开发模式（单机）

```bash
# 同时启动 core 后端 + web 前端
pnpm dev

# 或分别启动
pnpm dev:core   # 后端，默认端口 3100
pnpm dev:web    # 前端 Vite dev server，默认端口 5173（自动代理 /api → 3100）
```

首次启动 core 时，若 `~/.cli-gateway/config.json` 不存在，会进入交互式配置向导。

### 构建

```bash
pnpm build
```

### 启动远端 Agent Node

在另一台机器（或同机另一进程）上运行：

```bash
CORE_URL=ws://your-core-host:3100 \
NODE_ID=my-gpu-server \
NODE_HOSTNAME=gpu-01 \
WORKSPACE_ROOT=/home/user/projects \
pnpm --filter @agent-collab/agent-node run dev
```

节点连接后会自动出现在 `GET /api/nodes` 列表中。

---

## 配置

### core (`~/.agent-collab/config.json`)

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `webPort` | `3100` | HTTP + WebSocket 监听端口 |
| `webHost` | `0.0.0.0` | 监听地址 |
| `acpAgentCommand` | `npx` | 本地 ACP Agent 启动命令 |
| `acpAgentArgs` | `["-y", "@zed-industries/claude-code-acp@latest"]` | 启动参数 |
| `workspaceRoot` | `~` | 默认工作目录 |
| `maxBindingRuntimes` | `30` | 最大并发 Runtime 数 |
| `runtimeIdleTtlSeconds` | `900` | 空闲 Runtime 自动回收时间（秒） |

可通过环境变量 `AGENT_COLLAB_HOME` 修改配置目录（默认 `~/.agent-collab`）。

### agent-node（环境变量）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CORE_URL` | `ws://localhost:3100` | core 地址 |
| `NODE_ID` | `node-<pid>` | 节点唯一 ID |
| `NODE_HOSTNAME` | 系统 hostname | 显示名称 |
| `WORKSPACE_ROOT` | `/tmp` | 本地工作目录 |
| `DB_PATH` | `~/.agent-node/db.sqlite` | 本地 SQLite 路径 |
| `ACP_AGENT_COMMAND` | `npx` | ACP Agent 命令 |
| `ACP_AGENT_ARGS` | `["-y","@zed-industries/claude-code-acp@latest"]` | JSON 数组 |
| `HEARTBEAT_INTERVAL_MS` | `15000` | 心跳间隔（毫秒） |

---

## API

### REST

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/conversations` | 获取所有会话列表 |
| `POST` | `/api/conversations` | 创建会话 (`{ agentType?, workspacePath?, title?, envVars? }`) |
| `DELETE` | `/api/conversations/:id` | 删除会话 |
| `GET` | `/api/conversations/:id/history` | 获取会话历史（runs 列表） |
| `GET` | `/api/nodes` | 获取已连接的远端节点列表 |

### WebSocket — 前端 ↔ core

连接 `ws://host:3100/api/conversations/:id/stream`：

**客户端 → 服务端 (ClientEvent):**

| 类型 | 说明 |
|------|------|
| `{ type: "prompt", text }` | 发送提示词 |
| `{ type: "approval.response", requestId, decision }` | 回复工具审批 |
| `{ type: "cancel" }` | 取消当前执行（待实现） |

**服务端 → 客户端 (ServerEvent):**

| 类型 | 说明 |
|------|------|
| `conversation.status` | 状态变更 idle/busy/error |
| `turn.begin` / `turn.end` | 一轮对话生命周期 |
| `content.delta` | 流式文本输出 |
| `thinking.delta` | 流式思考过程 |
| `tool.call` / `tool.result` | 工具调用及结果 |
| `approval.request` | 请求用户授权工具执行 |
| `history.user_message` | 历史回放：用户消息 |
| `history.complete` | 历史回放完成 |
| `error` | 错误消息 |

### WebSocket — agent-node ↔ core

连接 `ws://host:3100/api/nodes/connect`：

**节点 → core (NodeToCore):**

| 类型 | 说明 |
|------|------|
| `node.register` | 注册节点（含 nodeId / hostname / agentTypes / version） |
| `node.heartbeat` | 心跳保活 |
| `run.event` | 转发 Agent 产生的 ServerEvent |
| `run.end` | 本地 run 结束（含 stopReason / error） |
| `permission.request` | 请求用户授权（工具审批） |

**core → 节点 (CoreToNode):**

| 类型 | 说明 |
|------|------|
| `node.ack` | 注册确认 |
| `run.dispatch` | 下发任务（含 prompt / sessionKey / envVars 等） |
| `run.cancel` | 取消执行中的 run |
| `permission.response` | 用户审批决定转发给节点 |

---

## 数据库

SQLite，migrations 版本 **v8**。主要表：

| 表 | 说明 |
|----|------|
| `sessions` | ACP session 状态 |
| `bindings` | platform + chatId 到 session 的映射 |
| `runs` | 每次 prompt 执行记录 |
| `events` | ACP session/update 原始事件 |
| `conversations` | Web 会话（含 env_vars） |
| `tool_policies` | 工具授权策略 |
| `nodes` | 已注册的远端节点记录 |

---

## 当前进度

### Phase 1 — Monorepo 重组（已完成，commit `4ce4087`）

- [x] 拆分 `packages/runtime-acp`（ACP 执行引擎，可独立复用）
- [x] 重命名 `packages/wire-types` → `packages/protocol`（统一通信协议类型）
- [x] `packages/node` → `apps/core`，`packages/web` → `apps/web`
- [x] `RuntimeConfig` 接口解耦（`BindingRuntime` 不再依赖完整 `AppConfig`）
- [x] SQLite migration v7（conversations 表 env_vars 字段）
- [x] 创建会话支持传入 `envVars`（注入 Agent 进程环境变量）
- [x] 历史回放（连接 WS 后自动重放已完成的 runs）
- [x] 全量 TypeScript 编译通过，32 个测试全部通过

### Phase 2 — 远端 Agent Node（已完成，commit `be297ac`）

- [x] `packages/protocol`：新增 `NodeToCore` / `CoreToNode` 消息类型
- [x] `packages/runtime-acp`：migration v8（`nodes` 表），`Platform` 新增 `'node'`
- [x] `apps/core`：`NodeRegistry` 服务（内存注册表）
- [x] `apps/core`：`GET /api/nodes` REST 端点
- [x] `apps/core`：`WS /api/nodes/connect` 端点（节点注册 / 心跳 / 事件转发）
- [x] `apps/agent-node`：新包，含 `CoreConnection`、`Executor`、`NodeSink`
- [x] 节点事件（`run.event`/`run.end`/`permission.request`）实时转发到前端 WS

### Phase 3 — 远端调度集成（待开发）

- [ ] `RuntimeAdapter` 抽象（`LocalRuntimeAdapter` / `RemoteNodeAdapter`）
- [ ] `ConversationManager` 按 agentType 选择本地或远端节点执行
- [ ] 前端节点选择 UI（创建会话时选择目标节点）
- [ ] `permission.response` 路由到对应节点的等待中的 BindingRuntime

### Phase 4 — 生产就绪（待开发）

- [ ] 取消执行（cancel）支持
- [ ] 节点断线重连 + 任务恢复
- [ ] 前端静态文件由 core `@fastify/static` 托管
- [ ] 用户认证 / 多用户支持
- [ ] 生产部署优化（shiki 按需加载）
