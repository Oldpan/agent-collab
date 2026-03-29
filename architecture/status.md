# Status Model

Agent Collab 有三层独立的状态，粒度依次细化：**Machine → Agent → Conversation**。

---

## 1. Machine 状态

**数据来源**：`MachineInfo.status`，由 core 在节点注册 / 心跳超时时维护。

**取值**：

| 值 | 含义 |
|---|---|
| `online` | 节点已连接并注册到 core，可接收 dispatch |
| `pending` | 节点正在连接 / 注册中 |
| `offline` | 节点断开连接，或 core 启动时标记为 stale |

**UI 位置**：sidebar 左侧机器行左侧的状态点（绿 / 黄 / 灰）。

**关键文件**：
- `apps/core/src/web/nodeWsHandler.ts` — 节点注册时置 `online`，断开时置 `offline`
- `apps/core/src/web/nodeStateReconciler.ts` — core 启动时将 stale online 节点批量置 `offline`

---

## 2. Agent 状态（派生）

Agent 没有独立的状态字段，其"可用性"由以下两个字段联合推导：

- `agent.nodeId` → 找到对应 machine → 取 `machine.status`
- `primaryConversation.status` → 叠加运行状态

**推导规则**：

| 条件 | 显示状态 | 颜色 |
|---|---|---|
| `agent.nodeId` 无对应 machine，或 machine = `offline` | offline | 灰 |
| machine = `pending` | connecting | 黄 |
| machine = `online` + conversation = `active` | running | 橙 |
| machine = `online` + conversation = `queued` | queued | 蓝 |
| machine = `online` + 其他 | online | 绿 |

**UI 位置**：sidebar agent 行头像左侧的状态点。

**实现**：`apps/web/src/features/sidebar/Sidebar.tsx` — `AgentStatusDot` 组件。

---

## 3. Conversation 状态

**数据来源**：`ConversationInfo.status`，由 core 在 dispatch / run 生命周期中维护。

**取值**：

| 值 | 含义 |
|---|---|
| `idle` | 无活跃 run，等待下一条消息（ACP 进程可能已被 reap） |
| `queued` | 有 prompt 等待 dispatch，当前 agent 正忙于另一个 run |
| `active` | 当前有 run 正在执行 |
| `recovering` | 尝试恢复上一个未完成的 run（断线重连后） |
| `awaiting_approval` | run 暂停，等待用户审批工具调用 |
| `failed` | 最后一次 run 以错误结束 |

**UI 派生状态**（ChatPanel 额外处理）：

| 派生值 | 条件 | 颜色 |
|---|---|---|
| `unavailable` | 有 dispatch failure 错误（Node not connected / Node disconnected during dispatch） | 灰 |
| `active` | status = `submitted` 或 `streaming` | 橙 |
| `idle` | status = `error` 但已有 assistant 回复，或 `failed` 但已有回复 | 绿 |
| `failed` | status = `error` 且无 assistant 回复 | 红 |

**UI 位置**：打开 DM 聊天后，header 里 agent 名字旁边的状态点。

**关键文件**：
- `apps/core/src/execution/executionDispatcher.ts` — dispatch 时置 `active` / `queued`
- `apps/core/src/web/nodeWsHandler.ts` — run.end 时置 `idle` / `failed`
- `apps/web/src/features/chat/ChatPanel.tsx` — `displayStatus` 派生逻辑（line ~107）

---

## 注意事项

- **`idle` ≠ 进程存活**：`idle` 只代表没有活跃 run，ACP 进程可能已被 executor 按 30min TTL 回收。下次 dispatch 时会冷启动或 resume。
- **`failed` 不代表永久不可用**：仅表示上一次 run 失败，下次 dispatch 可正常进行。
- **真正阻塞 dispatch 的只有**：machine offline 或 machine 未分配（`agent.nodeId = null`）。
- **`unavailable` 是被动感知**：只有在发出 dispatch 后收到 "Node not connected" 错误时才变成该状态，不是主动探测。
