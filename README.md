# Agent Collab — 跨机多Agent协作平台

基于 cli-gateway 的 Web 化改造，将原有的 Discord/Telegram/Feishu 聊天频道替换为浏览器端 UI，通过 ACP (Agent Client Protocol) 与 Claude/Codex 等 Agent 进行交互。

## 项目结构

```
agent-collab/
├── packages/
│   ├── wire-types/       # 前后端共享的 TypeScript 类型定义
│   │   └── src/index.ts  # ServerEvent / ClientEvent / REST 类型
│   ├── node/             # 后端服务 (Fastify + WebSocket)
│   │   └── src/
│   │       ├── main.ts              # 入口：加载配置 → 打开DB → 启动服务
│   │       ├── config.ts            # 配置 schema (webPort, webHost, ACP 参数等)
│   │       ├── web/
│   │       │   ├── server.ts        # Fastify HTTP + WS 服务
│   │       │   ├── wsHandler.ts     # WebSocket 连接管理 & 事件路由
│   │       │   ├── wsSink.ts        # OutboundSink 实现 (Agent 输出 → WS 事件)
│   │       │   └── conversationManager.ts  # 会话 CRUD、ACP Runtime 管理、LRU GC
│   │       ├── acp/                 # ACP 协议层 (保留原有代码)
│   │       ├── gateway/             # 核心运行时 (BindingRuntime, SessionStore 等)
│   │       └── db/                  # SQLite 数据层 + migrations
│   └── web/              # 前端 (React 19 + Vite + Tailwind CSS 4)
│       └── src/
│           ├── App.tsx              # 主布局 (侧边栏 + 聊天面板)
│           ├── features/
│           │   ├── sidebar/Sidebar.tsx      # 会话列表、创建、删除
│           │   └── chat/
│           │       ├── ChatPanel.tsx        # 消息列表、工具调用、审批卡片
│           │       └── PromptComposer.tsx   # 输入框
│           ├── hooks/
│           │   ├── useConversationStream.ts # WebSocket 流式 hook
│           │   └── useConversations.ts      # Zustand 会话状态管理
│           ├── components/
│           │   ├── ai-elements/     # 从 kimi-cli 移植的 AI 组件
│           │   └── ui/              # 基础 UI 组件 (Radix 封装)
│           └── lib/api.ts           # REST API 客户端
├── package.json          # monorepo 根配置
└── pnpm-workspace.yaml   # pnpm workspace 定义
```

## 技术栈

| 层 | 技术 |
|---|------|
| 包管理 | pnpm workspace monorepo |
| 后端 | Node.js 18+, Fastify 5, @fastify/websocket, better-sqlite3, Zod |
| 前端 | React 19, Vite, TypeScript, Tailwind CSS 4, Zustand, Radix UI |
| Markdown 渲染 | streamdown 2.5 + shiki 代码高亮 |
| Agent 通信 | ACP (Agent Client Protocol) — JSON-RPC over subprocess |

## 快速开始

### 前置要求

- Node.js >= 18
- pnpm >= 9

### 安装依赖

```bash
cd /code/agi/agent-collab
pnpm install
```

### 开发模式

同时启动前后端（后端默认端口 3100，前端 Vite dev server 默认端口 5173 并自动代理 `/api` 到后端）：

```bash
pnpm dev
```

或分别启动：

```bash
# 终端 1 — 后端
pnpm dev:node

# 终端 2 — 前端
pnpm dev:web
```

首次启动后端时，如果 `~/.cli-gateway/config.json` 不存在，会进入交互式配置向导，可直接回车使用默认值。

### 构建

```bash
pnpm build
```

### 生产模式

```bash
# 构建后端
pnpm --filter @agent-collab/node run build

# 构建前端静态文件
pnpm --filter @agent-collab/web run build

# 启动后端 (前端静态文件可用 nginx 或 @fastify/static 托管)
pnpm --filter @agent-collab/node run start
```

## 配置

配置文件位于 `~/.cli-gateway/config.json`，主要字段：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `webPort` | `3100` | HTTP + WebSocket 监听端口 |
| `webHost` | `0.0.0.0` | 监听地址 |
| `acpAgentCommand` | `npx` | ACP Agent 启动命令 |
| `acpAgentArgs` | `["-y", "@zed-industries/codex-acp@latest"]` | ACP Agent 启动参数 |
| `workspaceRoot` | `~` | 默认工作目录 |
| `maxBindingRuntimes` | `30` | 最大并发 Runtime 数 |
| `runtimeIdleTtlSeconds` | `900` | 空闲 Runtime 自动回收时间 (秒) |

可通过环境变量 `CLI_GATEWAY_HOME` 修改配置目录（默认 `~/.cli-gateway`）。

## API

### REST

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/conversations` | 获取所有会话列表 |
| `POST` | `/api/conversations` | 创建会话 (`{ agentType?, workspacePath?, title? }`) |
| `DELETE` | `/api/conversations/:id` | 删除会话 |
| `GET` | `/api/conversations/:id/history` | 获取会话历史 |

### WebSocket

连接 `ws://host:3100/api/conversations/:id/stream` 后进行双向通信：

**客户端 → 服务端 (ClientEvent):**
- `{ type: "prompt", text: "..." }` — 发送提示词
- `{ type: "approval.response", requestId, decision: "allow"|"deny" }` — 回复工具审批
- `{ type: "cancel" }` — 取消当前执行

**服务端 → 客户端 (ServerEvent):**
- `conversation.status` — 会话状态变更 (idle/busy/error)
- `turn.begin` / `turn.end` — 一轮对话的生命周期
- `content.delta` — 流式文本输出
- `thinking.delta` — 流式思考过程输出
- `tool.call` / `tool.result` — 工具调用及结果
- `approval.request` — 请求用户授权工具执行
- `error` — 错误消息
- `history.complete` — 历史回放完成信号

## 当前进度

### Phase 0.5 — 单机 Web 化 (已完成)

- [x] pnpm monorepo 搭建 (wire-types / node / web)
- [x] 共享类型定义 (ServerEvent / ClientEvent / REST types)
- [x] 移除 Discord / Telegram / Feishu / Scheduler 通道代码
- [x] ConversationManager (会话 CRUD + LRU Runtime 管理)
- [x] Fastify HTTP + WebSocket 服务
- [x] WebSocket 事件路由 + WsSink (OutboundSink 实现)
- [x] SQLite migration v6 (conversations 表)
- [x] 配置精简 (webPort / webHost)
- [x] React 前端 — 侧边栏 + 聊天面板布局
- [x] WebSocket 流式 hook (session identity guard + ref accumulators)
- [x] ai-elements 组件移植 (streamdown / code-block / tool / confirmation)
- [x] TypeScript 全量编译通过 (node + web)
- [x] Vite 生产构建通过

### 待完成 (后续 Phase)

- [ ] 实际联调验证 (启动 ACP Agent 端到端测试)
- [ ] 上下文重放 (context replay on reconnect)
- [ ] 取消执行 (cancel) 支持
- [ ] 多机协作 (跨节点 Agent 调度)
- [ ] 用户认证 / 多用户支持
- [ ] 前端静态文件由后端 @fastify/static 托管
- [ ] 生产部署优化 (shiki 按需加载减小 bundle)
