# Task 模块使用说明

## 1. 目标

Task 模块用于把 channel 里的协作工作显式化，核心目的是：

- 把“要做什么”挂到 channel 的 task board 上
- 把“谁在做”通过 claim 固定下来，减少撞车
- 把“进展到哪一步”通过状态推进显式化
- 把“讨论和执行上下文”沉淀到 task 对应的 thread 中

当前 task 模型已经按“task-message + task thread + task board”收敛。

---

## 2. 核心对象

### 2.1 Task message

每个 task 都绑定一个 channel 根消息：

- 新建 task 时，系统会自动创建一条 `senderType=system` 的 task message
- 把普通 channel 消息提升为 task 时，原消息会被标记为 task message

这条 message 既是 chat 里的可见卡片，也是 task thread 的根。

### 2.2 Task thread

task message 的前 8 位 message id 会成为该 task 的 thread root。

这意味着：

- task 的讨论应该尽量放到它自己的 thread 里
- 打开 task thread，本质上是在打开“这条 task message 的协作工作面”
- thread summary 里的 bound task / owner / participants 都是围绕这条 task message 计算的

### 2.3 Task board

每个 channel 有独立 task board，按状态分组展示：

- `todo`
- `in_progress`
- `in_review`
- `done`

`done` 默认折叠。

---

## 3. 用户怎么用

### 3.1 新建一个 task

有两种入口：

1. 在 channel 的 `Tasks` tab 中直接新建
2. 在 `Chat` 里把一条已有 channel 根消息点 `Promote to task`

两种方式的差异：

- `Tasks` tab 新建：
  - 会创建新的 task message
  - 初始状态是 `todo`
  - 初始 assignee 为空
- `Promote to task`：
  - 复用当前消息作为 task message
  - 会立即 claim 给当前用户
  - 初始状态直接进入 `in_progress`

限制：

- 只能把 channel 根消息提升为 task
- 不能把 thread reply 提升为 task
- 已经是 task 的消息不能重复提升

### 3.2 开始做任务

开始做之前，先 claim。

在 `Tasks` tab 中：

- 未认领 task 会显示 `Claim`
- claim 后：
  - assignee 变为当前用户
  - 若原状态是 `todo`，会自动推进到 `in_progress`

claim 的目的不是仅做展示，而是显式表达“这项工作现在由谁负责”。

### 3.3 在哪里讨论 / 汇报进度

优先在 task thread 内讨论，而不是继续把细节刷在 channel 主时间线上。

建议流程：

1. 在 channel 或 `Tasks` tab 中打开 task thread
2. 在 thread 里同步排查过程、设计取舍、测试结果
3. 需要对全频道广播时，再在主 channel 发一条摘要

这样做的原因：

- task 的上下文会沉淀在固定 thread 内
- agent 侧激活上下文可以拿到 bound task 和 thread recent messages
- 主 channel 不会被细节噪音淹没

### 3.4 推进任务状态

标准状态流转是：

`todo -> in_progress -> in_review -> done`

当前前端的操作方式是：

- 只有当前 assignee 可以点击状态 badge 推进状态
- 未 claim 的任务不会显示状态推进入口

建议语义：

- `todo`
  - 任务已存在，但还没人开始
- `in_progress`
  - 已 claim，正在执行
- `in_review`
  - 工作内容已经完成，等待人工确认
- `done`
  - 已确认收口

服务端权限规则：

- 除 `in_review -> done` 之外，其它状态变更都要求当前用户就是 assignee
- `in_review -> done` 允许非 assignee 完成收口

### 3.5 释放任务

如果你不再继续负责该任务，可以 `Unclaim`。

当前行为：

- 只有当前 assignee 才能 unclaim
- `in_progress` unclaim 后会回退为 `todo`
- 其它未完成状态 unclaim 时保留原状态，但 assignee 清空

适用场景：

- 误领
- 做到一半发现不该由自己继续
- 需要重新分配

### 3.6 删除任务

可以从 task board 删除 task。

删除时会同步清理：

- `tasks` 记录
- task root thread 的 participants
- task root thread 的 checkpoints
- task message 上的 `message_kind='task'` 标记

删除任务后，对应消息仍然存在于 chat 历史中，但不再作为 task 展示。

### 3.7 Clear chat 的影响

`Clear chat history` 现在会一起清空当前 channel 的 task board。

也就是说它会同时移除：

- channel messages
- 该 channel 相关的 thread replies
- 该 channel branch conversation 的运行历史
- 该 channel 的 tasks / task bindings / task sequence

这么做是为了避免出现“任务还在，但 task message/thread 已经不存在”的悬空状态。

---

## 4. 推荐工作流

### 4.1 人工协作

推荐顺序：

1. 在 channel 中创建 task，或把用户请求提升为 task
2. 负责人先 `Claim`
3. 在 task thread 中持续更新进度
4. 完成实现后推进到 `in_review`
5. 人工确认后收口到 `done`

### 4.2 多 Agent 协作

推荐顺序：

1. 把大任务拆成多个独立 task
2. 每个 task 对应一个独立 task thread
3. 每个 agent 只 claim 自己负责的 task
4. thread 内汇报细节，主 channel 只汇报里程碑

不要把多个并行子任务塞进同一个 task thread。

---

## 5. 前端入口

### 5.1 ChannelPanel / Chat

在 chat 中可以看到：

- task message 卡片
- task 编号
- task 状态
- assignee
- 打开 task thread 的入口
- 普通消息上的 `Promote to task` 按钮

### 5.2 TasksTab

`Tasks` tab 提供：

- 按状态分组的任务列表
- 新建 task
- 打开 task thread
- `Claim`
- `Unclaim`
- 状态推进
- `Delete`

---

## 6. REST API

当前用户侧 task 接口如下：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/channels/:id/tasks` | 获取 channel task board |
| `POST` | `/api/channels/:id/tasks` | 新建 task message + task |
| `POST` | `/api/channels/:id/tasks/claim-message` | 把一条 channel 根消息提升为 task，并立即 claim 给当前用户 |
| `POST` | `/api/channels/:id/tasks/:num/claim` | claim 指定 task |
| `POST` | `/api/channels/:id/tasks/:num/unclaim` | 释放自己 claim 的 task |
| `PATCH` | `/api/channels/:id/tasks/:num/status` | 更新 task 状态 |
| `DELETE` | `/api/channels/:id/tasks/:num` | 删除 task |
| `POST` | `/api/channels/:id/clear-chat` | 清空 channel 聊天历史，并同时清空该 channel 的 task board |

---

## 7. 当前边界

当前 task 模块仍有一些明确边界：

- assignee 仍以“当前用户 claim 自己”为主，不提供完整的任意指派 UI
- 一个 task 只绑定一个 task message / 一个 task thread
- task thread 绑定依赖 `tasks.message_id`，不是旧的 `thread_task_bindings` 运行时主链路

如果后续要扩展“指派给其他用户/agent”“批量任务操作”“审批流”，应在这个模型上继续加，而不是回退到 message 与 task 解耦的旧设计。
