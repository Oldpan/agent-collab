# 项目总览

## 简介

Agent Collab 是基于 ACP (Agent Client Protocol) 的跨机多 Agent 协作平台。

- **中心节点** (`apps/core`)：提供 Web UI 和 REST/WebSocket API，管理会话、频道和远端节点
- **远端执行节点** (`apps/agent-node`)：通过 WebSocket 注册到中心，在本地执行 ACP Agent（Claude Code、Codex 等），将结果实时流回前端
- **前端** (`apps/web`)：React SPA，通过 WebSocket 实时展示对话流

---

## 目录结构

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
| 测试 | Vitest (38 个单元/集成测试) |

---

## 核心数据流

```
用户浏览器 ──WS──▶ apps/core ──WS──▶ apps/agent-node ──stdio──▶ ACP Agent (Claude Code)
                     │                       │
                     │ SQLite (sessions,      │ SQLite (local)
                     │  runs, events, …)      │
                     │                       │
                  REST API              本地执行 BindingRuntime
```

1. 用户在前端发送 prompt → 通过 WebSocket 到 core
2. core 的 `ConversationManager` 查找或创建 `BindingRuntime`（本地或远端节点）
3. BindingRuntime 通过 ACP JSON-RPC 协议与 Agent 子进程通信
4. Agent 输出流式回传：agent → BindingRuntime → OutboundSink → WebSocket → 前端
