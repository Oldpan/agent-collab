# Agent Collab — 跨机多 Agent 协作平台

基于 ACP (Agent Client Protocol) 的多机协作平台。中心节点 (`apps/core`) 提供 Web UI 和 REST/WebSocket API；远端机器运行 `apps/agent-node`，通过 WebSocket 注册到中心，并在本地执行 ACP Agent（Claude Code、Codex 等），将结果实时流回前端。

---

## 架构文档

详细的架构信息已整理到 [`architecture/`](./architecture/) 目录：

| 文档 | 内容 |
|------|------|
| [overview.md](./architecture/overview.md) | 项目总览、目录结构、技术栈、核心数据流 |
| [api.md](./architecture/api.md) | REST API 端点 |
| [protocol.md](./architecture/protocol.md) | WebSocket 协议（前端↔core、node↔core） |
| [database.md](./architecture/database.md) | 数据库表结构、migration 历史 |
| [configuration.md](./architecture/configuration.md) | core 和 agent-node 配置项 |
| [permissions.md](./architecture/permissions.md) | 权限系统：宿主层 vs Claude Code 内部层、实际控制方式 |
| [roadmap.md](./architecture/roadmap.md) | 已完成阶段 + 待开发 TODO |

---

## 快速开始

### 前置要求

- Node.js >= 18
- pnpm >= 9

### 安装依赖

```bash
pnpm install
```

### 开发模式

系统由三个独立进程组成，需要分别在不同终端中启动：

**终端 1 — Core 后端**

```bash
pnpm dev:core
# 监听 http://localhost:3100
```

**终端 2 — Web 前端**

```bash
pnpm dev:web
# 监听 http://localhost:5173，自动代理 /api → 3100
```

也可以用一条命令同时启动 core + web：

```bash
pnpm dev
```

**终端 3 — Agent Node（本地模拟）**

所有 Agent 执行必须通过 agent-node，core 本身不运行 Agent。本地开发时可在同一台机器上启动一个模拟节点：

```bash
CORE_URL=ws://localhost:3100 \
NODE_ID=local-node-1 \
NODE_HOSTNAME=local-sim \
DB_PATH=/tmp/agent-node-ws/db.sqlite \
pnpm --filter @agent-collab/agent-node run dev
```

> `DB_PATH` 是 agent-node 本地 SQLite 数据库路径，首次运行会自动创建。

启动后打开 `http://localhost:5173`，可以看到 `local-node-1` 机器状态变为 ● online，在其下创建 Agent 即可开始对话。

### 构建

```bash
pnpm build

# 修改了 packages/runtime-acp/src/ 下的文件后，需单独重新构建
pnpm --filter @agent-collab/runtime-acp run build
```

### 连接真实远端机器

若要在另一台机器上运行 agent-node：

**步骤一：在前端预置机器**

打开 `http://localhost:5173`，点击侧边栏顶部的 **+** 按钮填写机器名称。创建后 UI 会生成带有预分配 `NODE_ID` 的连接命令，机器状态显示为 ⏳ pending。

**步骤二：在目标机器执行连接命令**

复制 UI 生成的命令（形如下面的形式）并在目标机器上运行：

```bash
NODE_ID=<UI 预分配的 uuid> \
NODE_HOSTNAME=my-gpu-box \
CORE_URL=ws://your-core-host:3100 \
DB_PATH=/home/user/.agent-collab/db.sqlite \
pnpm --filter @agent-collab/agent-node run dev
```

命令执行后机器状态自动变为 ● online。

**步骤三：创建 Agent 并开始对话**

在侧边栏 Machine 行点击 **+** 创建 Agent，选择 agent type（`claude_acp` / `codex_acp`），创建对话即可。

---

## 配置

详见 [architecture/configuration.md](./architecture/configuration.md)。

首次启动 core 时，若 `~/.agent-collab/config.json` 不存在，会进入交互式配置向导。配置目录可通过 `AGENT_COLLAB_HOME` 环境变量修改。

---

## 当前进度

Phase 1–6 已完成，详见 [architecture/roadmap.md](./architecture/roadmap.md)。

当前架构：**纯远端执行**（所有 prompt 必须经 agent-node），**Machine → Agent → Conversations 三级侧边栏**，支持 Machine 预置（pending → online → offline 状态流转）。

待开发：**Phase 7**（取消执行、节点断线重连、生产部署优化等）。
