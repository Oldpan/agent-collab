# 项目总览

## 简介

Agent Collab 是基于 ACP (Agent Client Protocol) 的跨机多 Agent 协作平台。

- **中心节点** (`apps/core`)：提供 Web UI 和 REST/WebSocket API，管理 Machines、Agents、Conversations
- **远端执行节点** (`apps/agent-node`)：通过 WebSocket 注册到中心，在本地执行 ACP Agent（Claude Code、Codex 等），将结果实时流回前端
- **前端** (`apps/web`)：React SPA，侧边栏展示 Machine → Agent → Conversation 三级结构，实时对话流

**只支持远端执行**：所有 prompt 必须通过已连接的 agent-node 执行，core 进程本身不运行 BindingRuntime。

当前执行面已经进入“host 化 + 可恢复”阶段：

- `core` 侧由 `ExecutionDispatcher` 统一负责 dispatch / cancel / approval 路由
- `agent-node` 侧由 `AgentHost` 托管单个 host/session 的生命周期
- host 支持 `cold_start` / `resume` 两种 dispatch 模式
- node 本地持久化 `node_dispatch_queue`，node 进程重启后可恢复未完成 dispatch
- 会话状态已升级为 `idle / active / recovering / awaiting_approval / failed`

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
│   │       │   ├── nodeRegistry.ts       # 已连接远端节点内存注册表
│   │       │   └── nodeStateReconciler.ts # core 启动时收敛 stale online node / active conversation
│   │       ├── execution/
│   │       │   └── executionDispatcher.ts # 统一 dispatch / cancel / approval 路由
│   │       └── web/
│   │           ├── server.ts             # Fastify HTTP + WS 路由
│   │           ├── wsHandler.ts          # 前端 WS 连接管理 & 事件广播
│   │           ├── nodeWsHandler.ts      # 远端节点 WS 连接处理（注册/事件转发/DB 持久化）
│   │           ├── wsSink.ts             # OutboundSink → ServerEvent（历史回放用）
│   │           └── conversationManager.ts  # 应用 façade：Machine/Agent/Conversation/Channel CRUD
│   ├── agent-node/     # @agent-collab/agent-node — 远端执行节点
│   │   └── src/
│   │       ├── main.ts                   # 启动入口，连接到 core
│   │       ├── config.ts                 # 环境变量配置（CORE_URL, NODE_ID, NODE_HOSTNAME…），默认生成稳定 node-id
│   │       ├── connection.ts             # CoreConnection (WS 客户端 + 心跳)
│   │       ├── executor.ts               # 管理 host、恢复 pending dispatch
│   │       ├── agentHost.ts              # 单 host 生命周期：idle/active/failed + inbox
│   │       ├── dispatchQueueStore.ts     # node 本地持久队列（node_dispatch_queue）
│   │       └── nodeSink.ts               # OutboundSink → run.event 转发给 core
│   └── web/            # @agent-collab/web — React 前端
│       └── src/
│           ├── App.tsx
│           ├── prompts/
│           │   └── default-system-prompt.md   # 可编辑的默认 system prompt
│           ├── features/
│           │   ├── sidebar/
│           │   │   ├── Sidebar.tsx            # Machine → Agent → Conversation 三级侧边栏
│           │   │   ├── AgentDetailPanel.tsx   # Agent 编辑面板（name + Platform Memory）
│           │   │   └── MachineCreatePanel.tsx # Machine 预置面板（生成连接命令）
│           │   └── chat/
│           │       ├── ChatPanel.tsx
│           │       └── PromptComposer.tsx
│           ├── hooks/
│           │   ├── useConversationStream.ts
│           │   ├── useConversations.ts
│           │   ├── useAgents.ts
│           │   └── useMachines.ts
│           └── lib/api.ts
├── packages/
│   ├── protocol/       # @agent-collab/protocol — 前后端 + 节点间共享类型
│   │   └── src/index.ts  # ServerEvent / ClientEvent / NodeToCore / CoreToNode / MachineInfo / AgentInfo / RuntimeDriver / 状态类型
│   ├── runtime-acp/    # @agent-collab/runtime-acp — ACP 执行引擎 (可复用)
│   │   └── src/
│   │       ├── acp/           # ACP JSON-RPC 协议层
│   │       ├── gateway/       # BindingRuntime, ToolAuth, SessionStore …
│   │       └── db/            # SQLite migrations (v14), 各 store
│   └── memory/         # @agent-collab/memory — Agent 记忆读取
│       └── src/
│           ├── index.ts       # buildAgentContextText()
│           ├── claude.ts      # ClaudeMemoryBackend（读 ~/.claude/projects/…/MEMORY.md）
│           └── workspace.ts   # WorkspaceMemoryBackend（读 <agentDir>/MEMORY.md）
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
| 测试 | Vitest（core 48 个测试，agent-node 1 个恢复测试） |

---

## 核心数据流

```
用户浏览器 ──WS──▶ apps/core ──WS──▶ apps/agent-node ──stdio──▶ ACP Agent
                                            │
                            run.event / run.end 流式回传 ──▶ core ──▶ 前端
                                            │
                           node_dispatch_queue / stable node-id
```

**只有远端路由**（所有 Conversation 必须有 `nodeId`）：

1. `wsHandler` 收到 prompt → `ConversationManager.dispatchToNode()` → `ExecutionDispatcher.dispatchPrompt()`
2. `ExecutionDispatcher` 计算 `hostKey` 与 `dispatchMode(cold_start|resume)`，再通过 `NodeRegistry.send(run.dispatch)` 下发
3. `agent-node` 的 `Executor` 将 dispatch 写入 `node_dispatch_queue`，并路由到对应 `AgentHost`
4. `AgentHost` 用 inbox 串行执行同一 host 的 run，底层仍由 `BindingRuntime` 驱动 ACP Agent
5. Agent 输出经 `NodeSink` → `run.event` → core `nodeWsHandler` → broadcast → 前端
6. 执行结束 → `run.end` → core 更新 conversations 状态 → broadcast `turn.end` + 最终状态
7. 若 node 重启，`Executor.resumePendingDispatches()` 会从 `node_dispatch_queue` 恢复未完成任务，并先广播 `recovering`

若 Conversation 无 `nodeId`，wsHandler 立即返回 error 事件。

---

## Machine 预置流程

```
前端 POST /api/machines  →  core 在 DB 插入 status='pending' 记录  →  返回 nodeId
         ↓
   UI 显示连接命令（含 NODE_ID=<nodeId>）
         ↓
   用户在目标机器执行命令  →  agent-node 启动  →  WS 连接 core
         ↓
   nodeWsHandler UPDATE nodes SET status='online'  →  UI 变绿
```

---

## Agent 记忆分层（contextText 注入）

每次 dispatch 前，`ExecutionDispatcher` 按 agent 配置构建 `contextText`。在 runtime 侧，只有 fresh session 会把完整 `contextText` 作为首段 prompt 注入；后续 `resume` 依赖同一 host/session 延续上下文。

```
[System Prompt]
{agent.systemPrompt}

[Platform Memory]
{agent.memory}        ← 用户可在 UI 的 AgentDetailPanel 编辑

[Local Memory]
{MEMORY.md 内容}      ← 从文件系统读取（只读）
  - claude_acp → ~/.claude/projects/<derived-key>/memory/MEMORY.md
  - 其他       → <agentDir>/MEMORY.md
```

其中 `agentDir` = `~/.agent-collab/agents/<agentId>-<slugName>/`。

---

## 日志

使用 `packages/runtime-acp/src/logging.ts` 的 `log` 对象，通过 `LOG_LEVEL` 环境变量控制级别（`debug` / `info` / `warn` / `error`，默认 `info`）。

关键 log 点：

| 位置 | 内容 |
|------|------|
| `wsHandler` `[ws] prompt → remote node` | prompt 路由到远端，含 nodeId |
| `executionDispatcher` `[dispatcher] dispatching prompt` | dispatch 发出，含 runId / hostKey / dispatchMode |
| `nodeStateReconciler` `[node-reconcile] ...` | core 启动时收敛 stale online node / active conversation |
| `executor` `[executor] dispatch received` | 节点收到任务，含 sessionKey / runtimeKey |
| `executor` `[executor] restoring pending dispatches...` | node 重启后恢复本地持久队列 |
| `agentHost` `[agent-host] waking existing host` | host resume / wake |
| `agentHost` `[agent-host] queued dispatch in inbox` | 同一 host 的并发 prompt 入 inbox |
| `nodeWsHandler` `[node-ws] run.end` | core 收到结束信号 |
| `nodeWsHandler` `[node-ws] registered/disconnected` | 节点连接/断线 |
