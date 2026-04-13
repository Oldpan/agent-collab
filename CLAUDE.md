# AGENTS.md / CLAUDE.md

This repository treats `Agents.md` as a symlink to this file. Keep this file current.

# Repo Notes

- After important code changes, restart the affected local services before considering the task complete. This includes at least `core`, and also `agent-node` / `web` when the change impacts them.
- When restarting `agent-node`, do not start it with a random node identity. Use the existing local-node startup environment:
  - `https_proxy=http://127.0.0.1:7893`
  - `CORE_URL=ws://localhost:3100`
  - `NODE_ID=local-node-1`
  - `NODE_HOSTNAME=H20-253`


## Current State

Agent Collab is now a remote-only multi-agent platform with these product rules:

- `Agent` is the long-lived identity.
- Private chat with an agent uses one primary thread by default.
- `Thread` is a task/conversation branch under an agent.
- `Channel` remains in the model, but is optional for direct chat and is intended for future `@agent` branch threads.
- All execution happens on connected `agent-node` processes. `core` does not execute agents locally.

Current private-chat UX:

- Sidebar is flat at the agent level. Clicking an agent opens its primary private chat.
- Chat area has `Chat / Activity / Workspace / Profile` tabs.
- `Workspace` reads files from the agent's remote machine workspace.
- `Profile` shows agent metadata, runtime type, node id, workspace path, memory path, env-var keys, and Claude config dir when applicable.
- `Activity` shows run history, tool calls, run durations, and tool durations.
- Dispatch failures such as `Node not connected` are shown as `not dispatched`, not `completed`.
- Tool calls now carry explicit terminal status: `completed | failed | cancelled`.

Current channel UX:

- Agents keep one private chat entry plus `0..N` public channel subscriptions.
- `home channel` is no longer treated as a product concept, even though compatibility fields still exist in data.
- `ChannelPanel` now has `Chat / Tasks / Members`.
- The `Tasks` tab is implemented as a basic task board:
  - grouped by status
  - create task
  - advance task status
  - collapse done by default
- Task assignee is currently read-only in the UI.
- DM thread UI is intentionally deferred; private chat remains single-threaded.

Current memory model:

- `Platform Memory` has been removed.
- Only `[System Prompt]` and `[Local Memory]` remain.
- Both Claude and Codex read local memory from `<workspacePath>/MEMORY.md`.
- Agents are expected by prompt to maintain `MEMORY.md` and `notes/*.md` themselves.

Current runtime state model:

- Conversation status: `idle | queued | active | recovering | awaiting_approval | failed`
- Same agent's multiple threads are serialized at the dispatcher level.
- Node side uses `AgentHost` + inbox + resumable dispatch queue.
- Idle hosts are reaped automatically after `30min` by default.
- Approval-pending runs are not restored across reconnect/restart; they fail and must be re-run.

## Commands

```bash
# Build
pnpm -r build
pnpm --filter @agent-collab/core build
pnpm --filter @agent-collab/web build
pnpm --filter @agent-collab/agent-node build
pnpm --filter @agent-collab/runtime-acp build
pnpm --filter @agent-collab/protocol build

# Tests
pnpm --filter @agent-collab/core test
pnpm --filter @agent-collab/agent-node test
pnpm --filter @agent-collab/runtime-acp test

# Dev
pnpm --filter @agent-collab/core dev
pnpm --filter @agent-collab/web dev
pnpm --filter @agent-collab/agent-node dev
```

## Operational Rules

### Restart discipline

This repo has multiple long-running dev processes in tmux. Build success is not enough.

- If you change `apps/core`, restart `core`.
- If you change `apps/agent-node`, restart `agent-node`.
- If you change `packages/runtime-acp`, rebuild it and restart whichever services consume it.
- If you change `packages/protocol`, rebuild it and restart/build dependents.
- If you change frontend only, Vite HMR usually updates it, but a restart is safer after larger state/model changes.

Important current behavior:

- `agent-node` now auto-reconnects to `core` with exponential backoff after disconnect.
- Use the unified restart commands from repo root:
  - `pnpm run dev:restart:core`
  - `pnpm run dev:restart:node`
  - `pnpm run dev:restart:web`
  - `pnpm run dev:restart`
- `pnpm run dev:restart` uses the safe order: `core -> node -> web`.

### Changelog discipline

Record meaningful product, architecture, protocol, runtime, or UX changes in:

- `changelog.md`

This should be updated as part of the same change, not deferred.

### tmux layout

Current dev sessions typically live in `tmux` session `agent-collab`:

- window `0`: `core`
- window `1`: `web`
- window `2`: `node`

### runtime-acp build rule

`packages/runtime-acp` is consumed from `dist/`.

If you change anything under `packages/runtime-acp/src`, run:

```bash
pnpm --filter @agent-collab/runtime-acp build
```

before trusting downstream behavior.

## Architecture

### Monorepo layout

```text
apps/core         central control plane: REST + WS + persistence + dispatch
apps/agent-node   remote execution host: node registration + AgentHost + ACP runtime
apps/web          React frontend
packages/protocol shared types for REST / WS / core-node protocol
packages/runtime-acp ACP execution engine + DB helpers + migrations
packages/memory   local-memory context assembly
packages/channel-bridge platform chat bridge tools for agents
```

### Core path

`apps/core` is the control plane.

Key pieces:

- `ConversationManager`
  - now acts mostly as application façade
  - owns CRUD for machines, agents, conversations
  - owns reset/delete flows
- `ExecutionDispatcher`
  - central dispatch / cancel / approval routing
  - computes `dispatchMode: cold_start | resume`
  - enforces per-agent serialization
- `nodeWsHandler`
  - receives `run.event`, `run.end`, `permission.request`
  - persists replay-worthy events
  - updates conversation status
- `wsHandler`
  - browser websocket
  - replays history from DB
  - forwards prompts to dispatcher
- `AgentWorkspaceBroker`
  - requests remote workspace listing / file reads / workspace reset via node
- `nodeStateReconciler`
  - on core startup:
    - stale online nodes -> offline
    - stale non-idle conversations -> failed
    - backfills some historical conversation-agent links

### Node path

`apps/agent-node` is a remote execution host, not just a thin forwarder.

Key pieces:

- `Executor`
  - manages hosts
  - persists dispatches into `node_dispatch_queue`
  - restores pending work on restart
  - reaps idle hosts by TTL
- `CoreConnection`
  - maintains a long-lived websocket to `core`
  - auto-reconnects with backoff + jitter
  - re-registers the node after reconnect
- `AgentHost`
  - one host per conversation/runtime key
  - keeps runtime, inbox, host state
  - supports `cold_start` and `resume`
  - exposes idle/pending-approval state for executor-level recovery and reaping
- `workspaceFs`
  - remote directory listing / file read / reset for agent workspaces
- `claudeConfig`
  - creates isolated Claude config under `<workspacePath>/.claude-runtime`

### Frontend

Key UI pieces:

- `Sidebar`
  - machine list
  - flat agent rows
  - create/edit/delete machine/agent
- `ChatPanel`
  - private chat header and status dot
  - `Chat / Activity / Workspace / Profile`
- `AgentActivityPanel`
  - runs, tool calls, durations
- `AgentWorkspacePanel`
  - remote workspace tree + markdown preview
- `AgentProfilePanel`
  - agent metadata and env-var keys

## Current Product Model

### Agent / Thread / Channel

- `Agent` is first-class and unique.
- Private chat uses one primary direct thread.
- Additional branch threads are reserved for channel-style workflows.
- Direct chat does not expose manual multi-thread branching anymore.
- Public channel presence is modeled as subscriptions, not a required home channel.

### Reset semantics

Agent reset does all of the following while keeping the agent record:

- reset remote workspace
- recreate `MEMORY.md` and `notes/`
- clear runs, events, queue, and visible chat history for that agent's conversation(s)
- rotate session key

### Delete semantics

- Deleting a machine now cascades through its agents.
- Deleting an agent removes related conversation/runs/events/session data.

## Memory / Prompt Rules

### Local memory

Agents should treat local memory as workspace files:

- `<workspacePath>/MEMORY.md`
- `<workspacePath>/notes/*.md`

They should use regular file tools, not MCP resource reads, to maintain them.

### System prompt

Default system prompt lives at:

- `apps/web/src/prompts/default-system-prompt.md`

Important current defaults:

- no Platform Memory
- long-running agent identity
- explicit responsibility to maintain `MEMORY.md` and `notes`
- long tasks should send a short acknowledgement / progress update before or during work
- completion summaries should include result, verification, risk, and memory updates when appropriate

## Claude vs Codex

### Common behavior

- both run remotely through ACP
- both use `<workspacePath>/MEMORY.md`
- both receive agent env vars merged with runtime defaults

### Claude-specific behavior

- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
- isolated Claude config at `<workspacePath>/.claude-runtime`
- should no longer inherit host `~/.claude` plugins/MCP by default

### Codex-specific behavior

- no Claude config dir
- currently more prone to upstream transport errors surfacing as ACP `-32603`

## Environment Variables

Agents can have per-agent env vars set from the UI.

Current behavior:

- users can paste `export KEY=value` blocks when creating or editing an agent
- env vars are stored on the agent
- dispatch merges:
  - agent env vars
  - conversation env vars
  - driver defaults

## Current Recovery Semantics

- `recovering` means the system is trying to continue an existing run, not starting a fresh one.
- `awaiting_approval` is treated as a live runtime condition. If reconnect/restart breaks that continuity, the run is ended with an approval-lost error instead of replaying the old request.
- `cancel` only targets the current run. It does not clear later queued prompts for the same conversation.
- Idle hosts are closed by TTL, but conversations, runs, and history stay intact.

## Database / Migrations

Important schema concepts already in use:

- `nodes`
- `agents`
- `conversations`
- `runs`
- `events`
- `channels`
- `sessions`
- `bindings`
- `conversation_prompt_queue`
- `node_dispatch_queue`

Do not assume `conversation_id` exists directly on `runs`; `runs` are linked through `session_key`.

Migration rules:

- migrations live in `packages/runtime-acp/src/db/migrations.ts`
- use sequential `if (current < N)` blocks
- keep `ALTER TABLE` statements isolated when needed
- **CRITICAL: always update `LATEST_VERSION` at the top of `migrations.ts` to match the new version number** — if `LATEST_VERSION` is not updated, core will refuse to start with `"DB schema version N is newer than app"` after the migration has already run on the DB. This error looks like data loss (machines/channels disappear) but is actually just a startup guard failing.
- after changing `migrations.ts`, always run `pnpm --filter @agent-collab/runtime-acp build` before restarting core
- also update the `schema_version 应为最新版本 N` test in `apps/core/src/__tests__/migrations.test.ts`

## Testing Status

Current backend test status is strong relative to the rest of the repo:

- `apps/core`: passing
- `apps/agent-node`: passing
- `packages/runtime-acp`: passing

Current weak areas:

- frontend automated tests are still minimal
- end-to-end black-box runtime coverage is limited

## Known Recent Issues

These have recently existed and are worth remembering:

- **better-sqlite3 bindings missing**: If agent-node fails to start with `Error: Could not locate the bindings file`, the native module needs to be rebuilt:
  ```bash
  cd node_modules/.pnpm/better-sqlite3@12.8.0/node_modules/better-sqlite3
  npx node-gyp rebuild
  ```
- Activity duration bugs on replay were caused by missing real timestamps during history replay.
- `Node not connected` / `Node disconnected during dispatch` runs are now treated as dispatch failures in Activity instead of `completed`.
- Approval-pending runs cannot currently be replayed after reconnect/restart; they intentionally fail closed and require re-run.
- Codex may return partial tool activity and then fail with transport errors; UI status should not blindly treat all failed runs as "chat has no useful history".
- Workspace / memory operations must be treated as regular workspace file operations, not MCP resource reads.

## Recommended Next Work

Highest-value remaining items:

- expand frontend automated tests
- improve Activity aggregation for repetitive tool calls
- evaluate whether approval requests should ever be fully persisted and replayed instead of fail-and-rerun
