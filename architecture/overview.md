# 项目总览

## 简介

Agent Collab 当前是一套 **remote-only** 的多 Agent 协作平台：

- `apps/core`：控制平面，负责 REST / WebSocket / 持久化 / 调度
- `apps/agent-node`：远端执行宿主，负责连接 core、本地启动 ACP agent、托管 host 和 workspace
- `apps/web`：React 前端，负责 agent 私聊、活动、工作区和资料展示

当前产品语义已经收敛为：

- `Agent` 是长期唯一身份
- 私聊默认只有一个主 thread
- `Thread` 是该 agent 下的会话/任务分支
- `Channel` 仍保留在模型里，但 direct chat 不再依赖 channel

## 当前架构

### Core

`apps/core` 已经从单体 `ConversationManager` 演进成“应用 façade + 执行调度”的结构。

关键组件：

- `ConversationManager`
  - 负责 Machine / Agent / Conversation CRUD
  - 负责 agent reset / clear chat / delete 这类应用级流程
- `ExecutionDispatcher`
  - 统一 dispatch / cancel / approval response
  - 计算 `dispatchMode: cold_start | resume`
  - 对同一 agent 的多 thread 做串行排队
- `wsHandler`
  - 浏览器 websocket
  - 历史回放
  - prompt / cancel / approval.response 入口
- `nodeWsHandler`
  - 处理 node 注册、run.event、run.end、permission.request
  - 持久化可回放事件
  - 更新 conversation 状态
- `AgentWorkspaceBroker`
  - 通过 core ↔ node 协议读取远端 workspace
  - 支持 list / read / reset
- `nodeStateReconciler`
  - core 启动时把 stale online node 收敛为 offline
  - 把 stale active conversation 收敛为 failed

### Agent Node

`apps/agent-node` 已经不是单纯转发器，而是带恢复能力的 execution host。

关键组件：

- `Executor`
  - 管理 host
  - 持久化 dispatch 到 `node_dispatch_queue`
  - node 重启后恢复 pending dispatch
- `AgentHost`
  - 一个 host 对应一个 conversation/runtime key
  - 管理 runtime 生命周期、状态、inbox、cancel、permission response
- `dispatchQueueStore`
  - `node_dispatch_queue` 读写
- `workspaceFs`
  - 远端 workspace list / read / reset
- `claudeConfig`
  - 为 Claude agent 准备隔离配置目录 `<workspacePath>/.claude-runtime`

### Frontend

当前前端主视图是 agent 私聊视图，不再把 direct chat 暴露成多 thread 树。

关键界面：

- `Sidebar`
  - 机器列表
  - 扁平 agent 列表
  - 机器 / agent 创建编辑删除
- `ChatPanel`
  - 右侧主视图
  - `Chat / Activity / Workspace / Profile`
- `AgentActivityPanel`
  - run、tool call、duration、reasoning 摘要
- `AgentWorkspacePanel`
  - 左树右预览，读取远端 node 上的 workspace
- `AgentProfilePanel`
  - 显示 runtime 类型、node、workspace、memory 路径、env vars keys、Claude config dir

## 执行模型

### 远端执行唯一主路径

当前不再支持 core 本地执行 agent。

执行链路：

1. 前端向 `ws://.../api/conversations/:id/stream` 发送 `prompt`
2. `wsHandler` 调 `ExecutionDispatcher`
3. `ExecutionDispatcher` 计算：
   - `runId`
   - `hostKey`
   - `dispatchMode = cold_start | resume`
4. `core` 通过 `NodeRegistry` 下发 `run.dispatch`
5. `agent-node` 的 `Executor` 将 dispatch 写入 `node_dispatch_queue`
6. 对应 `AgentHost` 执行 run，并通过 `NodeSink` 回传 `run.event / run.end`
7. `core` 持久化事件并广播给前端

### Host 化恢复

当前执行面已进入 host 化：

- 同一 conversation 的 runtime 不再是“每次临时起一个”
- `AgentHost` 支持 `cold_start` / `resume`
- host 内部有 inbox
- node 进程重启后可从 `node_dispatch_queue` 恢复 pending work
- 前端会看到 `recovering` 状态

### Agent 串行

同一个 agent 的多个 thread 默认硬串行：

- 一个 agent 同时只允许一个 thread 真正执行
- 其他 prompt 进入 `conversation_prompt_queue`
- 当前 thread settle 后再调度下一个

## 当前产品行为

### 私聊

- 每个 agent 的 direct chat 只有一个主 thread
- 侧边栏点击 agent 时打开主 thread
- 不再在 direct chat 中暴露 `+ New Thread`
- 后续 channel 中 `@agent` 时，可基于 branch thread 扩展

### Workspace

agent 的 workspace 保存在远端 node 对应目录中，并通过 core 统一展示。

前端 `Workspace` 页：

- 读远端目录
- 默认可看 `MEMORY.md`
- 支持展开 `notes/` 下多个 `.md`
- markdown 渲染预览

### Profile

agent 详情中的基础信息集中在 `Profile`：

- agent 名称
- runtime 类型（Claude / Codex）
- agent id
- node id
- workspace path
- local memory path
- env vars key 列表
- Claude config dir（仅 Claude）

### Reset

agent reset 会：

- 重置远端 workspace
- 重新建 `MEMORY.md` 和 `notes/`
- 清空相关 run / event / queue / 可见聊天历史
- 保留 agent 本身与会话行本身
- 轮换 `session_key`

### Machine 删除

删除 machine 会级联删除其下 agents，而不再只是把 `node_id` 清空。

## Memory 模型

当前只有两层：

```text
[System Prompt]
[Local Memory]
```

已移除内容：

- `Platform Memory`

当前 local memory 规则：

- Claude 和 Codex 都只读 `<workspacePath>/MEMORY.md`
- `notes/*.md` 由 agent 自己维护
- prompt 已明确要求 agent 维护 `MEMORY.md` 和 `notes`
- 不应把 local memory 当成 MCP resource 读取

## Claude / Codex 差异

### 相同点

- 都通过 ACP 在远端 node 上运行
- 都读 `<workspacePath>/MEMORY.md`
- 都接收 agent env vars

### Claude

- 默认注入 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
- 运行前准备独立配置目录 `<workspacePath>/.claude-runtime`
- 不再默认继承宿主机 `~/.claude` 的插件 / MCP 配置

### Codex

- 不使用 Claude 配置目录
- 当前更容易把上游传输问题暴露成 ACP `-32603`

## 当前状态枚举

conversation 状态：

- `idle`
- `queued`
- `active`
- `recovering`
- `awaiting_approval`
- `failed`

前端右上角状态点是会话级状态，不是 agent 全局健康状态。

## 当前实现注意点

- 改 `apps/core` 后要重启 `core`
- 改 `apps/agent-node` 后要重启 `agent-node`
- 重启 `core` 后，当前实现下最好也重启 `agent-node`
- `packages/runtime-acp` 由 `dist/` 被引用，改源码后必须先 build

## 当前测试面

后端核心链路已覆盖到：

- dispatch / resume / cancel
- recovering / history replay
- agent reset / machine delete
- workspace broker
- node 恢复
- Claude config 隔离

仍然偏弱的地方：

- 前端自动化测试
- 黑盒端到端运行测试
