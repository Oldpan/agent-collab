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

### 开发模式（单机）

```bash
# 同时启动 core 后端 + web 前端
pnpm dev

# 或分别启动
pnpm dev:core   # 后端，默认端口 3100
pnpm dev:web    # 前端 Vite dev server，默认端口 5173（自动代理 /api → 3100）
```

首次启动 core 时，若 `~/.agent-collab/config.json` 不存在，会进入交互式配置向导。

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

详见 [architecture/configuration.md](./architecture/configuration.md)。

首次启动 core 时，若 `~/.agent-collab/config.json` 不存在，会进入交互式配置向导。配置目录可通过 `AGENT_COLLAB_HOME` 环境变量修改。

---

## 当前进度

Phase 1-3 已完成，详见 [architecture/roadmap.md](./architecture/roadmap.md)。

当前待开发：**Phase 4**（前端多 Channel UI + 远端调度集成）和 **Phase 5**（生产就绪）。
