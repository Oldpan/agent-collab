# 权限系统

## 总览

Agent Collab 涉及两套完全独立的权限系统，理解它们的边界是正确配置安全策略的前提。

```
用户
 │
 ▼
前端 WebSocket (approval.request / approval.response)
 │
 ▼
宿主层权限系统 (tool_policies / tool_allow_prefixes)   ← 仅对"宿主工具"有效
 │
 ▼
Claude Code 进程 (unified_exec / Bash tool)            ← 大多数命令走这里
 │
 └─ allowDangerouslySkipPermissions: true              ← claude-code-acp 硬编码
```

---

## 层一：宿主层权限系统

### 触发条件

只有以下三类 ACP Request 消息会被宿主拦截：

| ACP 消息 | 对应操作 | 代码位置 |
|----------|----------|----------|
| `fs/read_text_file` | 读文件 | `client.ts → ensureAuthorized('read')` |
| `fs/write_text_file` | 写文件 | `client.ts → ensureAuthorized('edit')` |
| `terminal/create` | 开终端 | `client.ts → ensureAuthorized('execute')` |
| `session/request_permission` | Agent 主动申请 | `client.ts → onPermissionRequest` |

Agent 通过 `session/update` Notification 上报的操作（包括绝大多数 bash 命令）**不经过此层**，宿主只能观察，无法拦截。

### 判断逻辑（三层）

```
ensureAuthorized(kind) 被调用
        ↓
toolAuth.consume(sessionKey, kind)
        ↓
  ┌─────────────────────────────────────────────┐
  │ tool_policies 表：有 allow → 直接通过        │
  │ tool_policies 表：有 reject → 直接拒绝       │
  │ 无记录 → 继续                                │
  └──────────────────────────────────────────────┘
        ↓
  tool_allow_prefixes 表：路径/命令前缀匹配？
  是 → 直接通过
  否 → 调用 onPermissionRequest
        ↓
  sink.requestPermission() → 前端弹 approval.request
        ↓
  用户点击 allow_once / allow_always / reject_once / reject_always
        ↓
  allow_always / reject_always → 写入 tool_policies 表持久化
```

### 数据库存储

| 表 | 主键 | 说明 |
|----|------|------|
| `tool_policies` | `(binding_key, tool_kind)` | 持久化 allow/reject 策略 |
| `tool_allow_prefixes` | `(binding_key, tool_kind, arg_prefix)` | 路径/命令前缀白名单 |

`binding_key` 格式：`web:{channelId}:{conversationId}:{agentType}`，每个会话独立策略。

`tool_kind` 分类：`read / edit / delete / move / search / execute / think / fetch / switch_mode / other`

---

## 层二：Claude Code 内部权限系统

### `claude-code-acp` 的实际行为（源码实证）

`@zed-industries/claude-agent-acp` 启动 Claude Code SDK 时：

```ts
// src/acp-agent.ts
const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;
const ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX;

await query({
  allowDangerouslySkipPermissions: ALLOW_BYPASS,  // 非 root 时恒为 true
  permissionMode,
  canUseTool: this.canUseTool(sessionId),
  ...
});
```

`canUseTool` 回调内部：

```ts
if (session.modes.currentModeId === "bypassPermissions") {
  return { behavior: "allow" };  // 直接通过，不发 session/request_permission
}
// 否则才会向 ACP 客户端发权限请求
```

**结论**：非 root 运行时，`claude-code-acp` 等价于 `--dangerously-skip-permissions`，Claude Code 的所有内部权限检查被绕过，`canUseTool` 对所有工具返回 allow，不发 `session/request_permission`。

### bash 命令的执行路径（DB 实证）

对话中执行 `free -h` 时，DB `events` 表记录：

```json
{
  "sessionUpdate": "tool_call",
  "source": "unified_exec_startup",
  "command": ["/bin/bash", "-lc", "free -h"],
  "process_id": "91863"
}
```

`source: "unified_exec_startup"` 表明 Claude Code 用自己的内部 exec 机制直接 fork 了 OS 进程，**未经过宿主的 `terminal/create` 接口**，宿主层权限系统对此操作完全无感知。

### 两套系统的覆盖范围

| 操作 | 宿主层能拦截？ | Claude Code 内部检查？ |
|------|--------------|----------------------|
| bash 命令（`free -h`、`ls`、`rm` 等） | **否**（`unified_exec`，只发 `session/update`） | **否**（bypass 已开启） |
| 文件读取 | 取决于是否用 `fs/read_text_file` | 否 |
| 文件写入 | 取决于是否用 `fs/write_text_file` | 否 |
| 宿主工具被显式调用时 | **是** | — |

---

## 如何真正控制权限

### 方式一：Claude Code 原生 deny 规则（推荐）

在 `workspaceRoot` 下创建 `.claude/settings.json`：

```json
{
  "permissions": {
    "deny": [
      "Bash(rm -rf *)",
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(ssh *)"
    ]
  }
}
```

deny 规则在 `unified_exec` 之前由 Claude Code 检查，是硬拦截，比宿主层更可靠。

### 方式二：启动参数限制工具白名单

在 `~/.agent-collab/config.json` 中修改 `acpAgentArgs`：

```bash
# 只允许读写文件，不允许执行命令
--allowedTools "Read,Write,Edit"

# 只允许 git 相关命令
--allowedTools "Bash(git *)"

# 只规划不执行
--permission-mode plan
```

### 方式三：Docker 容器隔离（生产环境推荐）

将 Claude Code 关进容器，容器提供 OS 级边界：

```bash
docker run --rm \
  -v /ai/code/myproject:/workspace \
  --network=none \
  my-claude-image \
  claude-code-acp --dangerously-skip-permissions
```

容器内用 `--dangerously-skip-permissions` 反而是最佳实践——容器本身就是沙箱，内部不再需要交互式权限提示。

### 方式四：以 root 运行（不推荐）

`ALLOW_BYPASS = !IS_ROOT`，root 时 `allowDangerouslySkipPermissions = false`，Claude Code 恢复内部权限提示。但 root 运行本身带来更大安全风险，不建议。

---

## 总结

| 控制方式 | 对 bash 命令有效？ | 持久化？ | 适用场景 |
|----------|-------------------|---------|---------|
| 宿主 `tool_policies` 表 | **否** | 是（DB） | 宿主工具白名单 |
| Claude Code `.claude/settings.json` deny | **是** | 是（文件） | 个人/团队策略 |
| `--allowedTools` 启动参数 | **是** | 需写入 config | 精细工具控制 |
| `--permission-mode plan` | **是**（阻止执行） | 需写入 config | 只读规划模式 |
| Docker 容器 | **是**（OS 隔离） | 容器配置 | 生产/多用户 |
