# Roadmap

记录已知的功能缺口、改进项和待办事项。按优先级排序。

---

## P0 — 核心体验缺口（改动小，价值高）

- [ ] **Channel 消息通知所有 channel 内 agent**
  - 现状：用户发消息到 channel，只有被 `@` 的 agent 才被唤醒
  - 目标：channel 内所有 agent 都收到通知（可配置：全通知 or 仅 @mention）
  - 改动：`POST /api/channels/:id/messages` 后端加一段逻辑

- [ ] **Thread 回复通知被回复的 agent**
  - 现状：用户在 agent 消息下回复 thread，agent 不会收到任何通知
  - 目标：thread 回复时，若根消息的发送者是 agent，自动 submitPrompt 唤醒该 agent
  - 改动：`POST /api/channels/:id/messages` 在 `replyTo` 存在时查询根消息 sender 并通知

---

## P1 — 功能完善

- [ ] **Agent channel 重新分配**
  - 现状：`UpdateAgentRequest` 无 `channelId`，agent 创建后无法换频道
  - 目标：在 AgentDetailPanel 里可以修改 agent 所属 channel
  - 改动：protocol + core PATCH handler + 前端 UI

- [ ] **Channel / Thread 历史消息分页**
  - 现状：固定加载最新 100 条，更早的历史消息无法访问
  - 目标：channel 和 thread 面板支持"加载更多"（向上滚动触发）
  - 改动：`useChannelStream` / `useThreadStream` 加 `loadMore`；后端已支持 `before` 参数

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
