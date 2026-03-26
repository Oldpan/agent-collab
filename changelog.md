# Changelog

## 2026-03-26

- `send_message` 现在默认回复当前会话，不再要求 agent 在私聊里自己拼 `dm:@...` 目标。
- 当前私聊主线程默认目标为 `dm:@User`；branch thread 默认目标为当前 `#channel:shortid`。
- 仍然保留显式 `target` 覆盖，只有 agent 想跨会话或跨 channel 发送时才需要手动指定。
- 这次改动的目的，是减少 agent 因误判 DM 目标而重复补发消息的情况。
