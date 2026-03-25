# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
pnpm dev            # core + web in parallel
pnpm dev:core       # core only (port 3100)
pnpm dev:web        # Vite dev server (port 5173, proxies /api → 3100)

# Build — must rebuild runtime-acp when editing its source, as apps import from dist/
pnpm build                                          # all packages
pnpm --filter @agent-collab/runtime-acp run build  # runtime-acp only

# Tests (only apps/core has tests)
pnpm test                                           # all
pnpm --filter @agent-collab/core run test           # core only
pnpm --filter @agent-collab/core run test -- --reporter=verbose
# Single test file:
pnpm --filter @agent-collab/core exec vitest run src/__tests__/conversationManager.test.ts

# Type check
pnpm -r exec tsc --noEmit

# Remote agent-node (simulated locally)
CORE_URL=ws://localhost:3100 NODE_ID=local-node-1 NODE_HOSTNAME=local-sim \
WORKSPACE_ROOT=/tmp/agent-node-ws DB_PATH=/tmp/agent-node-ws/db.sqlite \
pnpm --filter @agent-collab/agent-node run dev
```

## Architecture

### Monorepo layout

```
packages/protocol      — shared TypeScript types (ServerEvent, ClientEvent, NodeToCore, CoreToNode, REST types)
packages/runtime-acp   — ACP execution engine: BindingRuntime, ToolAuth, SessionStore, DB migrations
apps/core              — central server: Fastify HTTP + WS, ConversationManager, NodeRegistry
apps/agent-node        — remote execution node: connects to core via WS, runs BindingRuntime locally
apps/web               — React frontend: Sidebar, ChatPanel, WebSocket streaming
```

### Critical: runtime-acp exports from `dist/`

`packages/runtime-acp/package.json` points to `dist/index.js`. **After editing any file in `packages/runtime-acp/src/`, you must run `pnpm --filter @agent-collab/runtime-acp run build` before running tests or other apps will use stale code.** Tests failing with unexpected errors after editing runtime-acp almost always indicate a missing rebuild.

### Prompt routing: remote-only

`apps/core/src/web/wsHandler.ts` checks `conv.nodeId` on every incoming `prompt` event:

- **No `nodeId`**: immediately broadcasts `{ type: 'error', message: 'No agent node assigned...' }` — no local execution path exists
- **`nodeId` set**: calls `ConversationManager.dispatchToNode()` → `NodeRegistry.send(run.dispatch)` → agent-node executes and streams `run.event` messages back → `nodeWsHandler` broadcasts to frontend

`wsHandler` does **not** broadcast `turn.begin`, `turn.end`, or `idle` — all of those come from the node via `run.event` / `run.end`.

### Machine pre-provisioning

Machines (remote nodes) can be registered in DB before the physical machine connects:
1. `POST /api/machines` → inserts `nodes` row with `status='pending'`, returns `nodeId`
2. UI generates a connection command containing `NODE_ID=<nodeId>`
3. Running the command on the target machine → agent-node sends `node.register` → `nodeWsHandler` UPSERTs the row → `status='online'`
4. Disconnect → `UPDATE nodes SET status='offline'`

Machine CRUD lives in `ConversationManager` (`createMachine`, `listMachines`, `getMachine`, `deleteMachine`). `listMachines()` overlays live NodeRegistry status on top of DB-persisted status via `rowToMachineInfo(row, isOnline)`.

### agent-node nodeId & hostname 生成机制

agent-node 启动时自动生成并持久化 nodeId，逻辑在 `apps/agent-node/src/config.ts`：

**nodeId 取值优先级：**
1. 环境变量 `NODE_ID` —— 若设置则直接使用
2. `resolveStableNodeId(dbPath)` —— 从本地持久化文件读取或生成

**`resolveStableNodeId(dbPath)` 行为：**
- 取 `dbPath` 所在目录（如 `~/.agent-node/db.sqlite` → `~/.agent-node/`）
- 查找该目录下的 `node-id` 文件
- 若文件存在且非空，直接复用其中的值
- 若文件不存在或为空，生成 `node-${randomUUID()}` 并写入文件

**hostname 取值优先级：**
1. 环境变量 `NODE_HOSTNAME` —— 若设置则直接使用
2. `os.hostname()` —— 系统主机名

**典型场景示例：**
```
~/.agent-node/node-id 文件内容：
node-0eb45b1b-a0f1-42f9-9ed8-52b9b197dfd7

系统主机名：aitopatom-e2eb

最终上报给 core 的节点信息：
- nodeId: node-0eb45b1b-a0f1-42f9-9ed8-52b9b197dfd7
- hostname: aitopatom-e2eb
```

这使得同一台机器多次重启后仍保持相同的 nodeId（便于 core 识别），而 hostname 反映当前实际主机名。

### agent-node executor FK constraint

When `executor.ts` receives `run.dispatch`, it must call `createSession()` before `upsertBinding()`. The `bindings` table has a FK on `sessions(session_key)`, and the agent-node's local DB starts empty — the session row from core's DB does not exist there. The `sessionKey` sent in `run.dispatch` must be bootstrapped locally on first use.

### DB migrations

Migrations live in `packages/runtime-acp/src/db/migrations.ts`. Rules:
- Each version block uses `if (current < N)` (not `else if`), so all pending migrations run in sequence
- **`ALTER TABLE` must be in its own `db.exec()` call** — combining it with other statements (e.g. `UPDATE schema_version`) in one `exec()` string silently fails in better-sqlite3
- After adding a migration, update the `schema_version` assertion in `apps/core/src/__tests__/migrations.test.ts`

### ConversationManager owns all session lifecycle

`apps/core/src/web/conversationManager.ts` is the central coordinator:
- `createMachine()` / `listMachines()` / `getMachine()` / `deleteMachine()` — Machine (node) CRUD; `deleteMachine` nulls out `agents.node_id` before deleting
- `createAgent()` / `listAgents()` / `getAgent()` / `updateAgent()` / `deleteAgent()` — Agent CRUD
- `createConversation()` — creates session + binding rows in DB, inherits `nodeId`/`agentType`/`workspacePath`/`envVars` from agent if `agentId` provided
- `dispatchToNode()` — builds `contextText` (system prompt + platform memory + local memory), fire-and-forget dispatch via `NodeRegistry`
- `handleApproval()` — routes `permission.response` to remote node based on `nodeId`

### Logging

`packages/runtime-acp/src/logging.ts` exports a `log` object with `debug/info/warn/error`. Level is set via `LOG_LEVEL` env var (default `info`). Use `LOG_LEVEL=debug` to see `run.event` forwarding and session creation traces on the remote path.

### Test helpers

`apps/core/src/__tests__/helpers.ts` exports `createTestDb()` (temp file SQLite with all migrations applied) and `createTestConfig()`. Tests never use in-memory (`:memory:`) DB because better-sqlite3 temp-file DBs are needed for FK constraints to work correctly across the migration stack.
