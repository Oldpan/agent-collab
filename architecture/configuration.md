# 配置

## core (`~/.agent-collab/config.json`)

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `webPort` | `3100` | HTTP + WebSocket 监听端口 |
| `webHost` | `0.0.0.0` | 监听地址 |
| `acpAgentCommand` | `npx` | 本地 ACP Agent 启动命令 |
| `acpAgentArgs` | `["-y", "@zed-industries/claude-code-acp@latest"]` | 启动参数 |
| `workspaceRoot` | `~` | 默认工作目录 |
| `maxBindingRuntimes` | `30` | 最大并发 Runtime 数 |
| `runtimeIdleTtlSeconds` | `900` | 空闲 Runtime 自动回收时间（秒） |

配置目录可通过环境变量 `AGENT_COLLAB_HOME` 修改（默认 `~/.agent-collab`）。

首次启动 core 时，若 config.json 不存在，会进入交互式配置向导。

---

## agent-node（环境变量）

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
| `RECONNECT_INITIAL_DELAY_MS` | `1000` | 首次重连等待时间（毫秒） |
| `RECONNECT_MAX_DELAY_MS` | `30000` | 最大重连等待时间（毫秒） |
| `HOST_IDLE_TIMEOUT_MS` | `1800000` | 空闲 host 自动回收 TTL（毫秒） |
| `HOST_SWEEP_INTERVAL_MS` | `60000` | 空闲 host 扫描周期（毫秒） |
