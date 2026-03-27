# Roadmap

记录已知的功能缺口、改进项和待办事项。按优先级排序。

---

## P0 — 核心体验缺口（改动小，价值高）

- [x] **Channel 消息通知所有 channel 内 agent**
  - 现状：用户发消息到 channel，只有被 `@` 的 agent 才被唤醒
  - 目标：channel 内所有 agent 都收到通知（可配置：全通知 or 仅 @mention）
  - 改动：`POST /api/channels/:id/messages` 后端加一段逻辑

- [x] **Thread 回复通知被回复的 agent**
  - 现状：用户在 agent 消息下回复 thread，agent 不会收到任何通知
  - 目标：thread 回复时，若根消息的发送者是 agent，自动 submitPrompt 唤醒该 agent
  - 改动：`POST /api/channels/:id/messages` 在 `replyTo` 存在时查询根消息 sender 并通知

---

## P1 — 功能完善

- [x] **Agent channel 重新分配**
  - 现状：`UpdateAgentRequest` 无 `channelId`，agent 创建后无法换频道
  - 目标：在 AgentDetailPanel 里可以修改 agent 所属 channel
  - 改动：protocol + core PATCH handler + 前端 UI

- [x] **Channel / Thread 历史消息分页**
  - 现状：固定加载最新 100 条，更早的历史消息无法访问
  - 目标：channel 和 thread 面板支持"加载更多"按钮
  - 改动：`useChannelStream` / `useThreadStream` 加 `loadMore`/`hasMore`；后端加 `before` 参数

---

## P1.5 — 消息投递可靠性 & 系统提示准确性

- [x] **`includeStdinNotification` 描述与实际行为不符**
  - 现状：system prompt 告诉 agent "你繁忙时会收到 `[System notification: ...]` 推送通知"，但 ACP run 是封闭循环，core 从未实际注入此通知；agent 只能靠主动轮询 `check_messages`
  - 目标：将该段描述改为"主动轮询"语义，去掉"you will receive a notification"的表述，或者实现真正的 mid-run 注入机制
  - 改动：`packages/memory/src/systemPrompt.ts` 的 `## Message Notifications` 章节措辞；`executionDispatcher.ts` 在每次 dispatch 时注入 `[Inbox]` 快照

- [x] **Checkpoint 先于 dispatch 确认就推进，导致 @mention 可能静默丢失**
  - 现状：channel @mention 和 DM 激活路径中，`bumpAgentMessageCheckpoint` 在 `submitPrompt` 之前调用；若 dispatch 失败（节点离线等），checkpoint 已推进，agent 再也看不到这条消息
  - 目标：checkpoint 推进移到 dispatch 成功确认之后，或失败时回滚
  - 影响路径：`apps/core/src/web/server.ts`（channel @mention）、`apps/core/src/execution/executionDispatcher.ts`（DM 激活）

- [x] **`check_messages` 无 channel 过滤，多 channel 场景下返回混合消息**
  - 现状：`/receive` 接口一次性返回所有已加入 channel + DM 的未读，agent 需自行识别来源和优先级
  - 目标：支持可选 `channel` 过滤参数，或按 channel 分组返回
  - 影响路径：`apps/core/src/web/internalAgentRouter.ts` `/receive` handler + `packages/channel-bridge/src/index.ts` `check_messages` 工具

---

## P2 — 新功能

- [ ] **Task board 前端 UI**
  - 现状：后端 task board API 完整（create / claim / update-status / list），但前端无任何展示
  - 目标：ChannelPanel 新增 Tasks tab，展示任务列表及状态，支持基本操作
  - 改动：新建 TasksTab 组件 + API 层调用

- [ ] **前端自动化测试**
  - 现状：前端 0 个测试文件，后端有 9 个
  - 目标：对核心 hooks（useChannelStream、useConversationStream）和关键组件写单元/集成测试
  - 参考：CLAUDE.md "expand frontend automated tests"

---

## P3 — 性能 / 冗余清理

- [ ] **dispatcher 每轮无条件读 MEMORY.md（resume 时不用）**
  - 现状：`buildAgentContextText()` 在每次 `dispatchPrompt()` 中无条件执行，读取 workspace 的 `MEMORY.md`；但 `bindingRuntime` 只在 `isFreshSession=true` 时注入 contextText，resume 且 ACP 进程存活时该文件读取结果被丢弃
  - 目标：仅在确实需要时（cold_start 或节点重启恢复）构建 contextText
  - 路径：`apps/core/src/execution/executionDispatcher.ts` `dispatchPrompt()`；需要 core 感知节点 ACP session 状态，或节点在响应中回传是否用了 contextText

- [ ] **dispatcher 每轮无条件 build systemPromptText（只在新建 session 时使用）**
  - 现状：`buildAgentSessionSystemPromptText()` 在每次 dispatch 时调用，但只在 ACP 新建 session（`isFreshSession`）时通过 `_meta.systemPrompt` 传入，resume 路径上为无效计算
  - 目标：同上，与 contextText 一起按需构建
  - 路径：同上

- [ ] **dispatcher 在 resume 时无条件跑 conversation replay SQL**
  - 现状：`dispatchMode !== 'cold_start'` 时总是执行 `buildConversationReplayText()`（多条 SQL + 字符串拼接），但 replay 只在 `isFreshSession=true`（ACP 进程重启）时被实际注入
  - 目标：仅当节点的 ACP session 确实丢失时才构建 replay
  - 路径：同上；或在 `RunDispatchMsg` 协议中增加 `contextNeeded` 标志，让节点先告知 core 是否需要 context

---

## P3 — 体验优化

- [ ] **Activity tab 重复工具调用聚合**
  - 现状：同一 run 内多次相同工具调用逐条展示，较冗余
  - 目标：相同工具调用折叠为 "read_file × 12" 形式
  - 参考：CLAUDE.md "improve Activity aggregation for repetitive tool calls"

- [ ] **Channel / Thread 消息搜索**

- [ ] **Channel 删除 / 重命名**

- [ ] **Approval request 持久化与重放**
  - 现状：重连/重启后 approval-pending run 直接 fail，需要用户重跑
  - 参考：CLAUDE.md "evaluate whether approval requests should ever be fully persisted and replayed"

---

## 已完成 ✓

- [x] Channel 窗口（侧边栏 + ChannelPanel Chat/Members tab）
- [x] Channel 实时 WS 消息流
- [x] 用户 @mention → 唤醒 agent
- [x] Composer @mention autocomplete
- [x] Agent 消息 Markdown 渲染
- [x] Thread 支持（Slack 风格，`#channel:shortId`）
- [x] ThreadPanel 右侧 slide-in
- [x] Thread 回复计数 badge
- [x] Thread 历史加载 + WS 实时更新
- [x] 重复消息 bug 修复（WS race condition）
