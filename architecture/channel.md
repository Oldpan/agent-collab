# Channel Collaboration

## Root User Messages

- A user-authored channel-root message wakes two groups on the same batch:
  - agents explicitly `@mentioned` in that message
  - recent root participants that are still inside the active window
- `default` follows the same routing as any other channel root. Its reply target is `#default` for root and `#default:<threadRootId>` for thread branches.
- When there are no explicit mentions and no recent root participants, the message is only broadcast to the channel and does not dispatch any agent runs.

## Active Participants

- Root and thread participation is tracked in `target_participants`.
- The active window is currently 15 minutes.
- Root-channel `owner` is not a unique leader role. It effectively means the agent was explicitly pulled into the root collaboration surface and can appear on multiple agents at once.

## Suppressing Duplicate Peer Wakeups

- For a single user-authored root-channel message, every agent woken in that same batch receives `mentionSuppression` activation metadata when there is at least one peer in the batch.
- The legacy metadata field name `peerMentionedAgentIds` now means "other peers already notified by this same root-user wake batch", not only peers explicitly mentioned in the raw user text.
- This matters for mixed cases such as:
  - `A` was already a recent root participant
  - the next user root message explicitly `@mentions B`
  - both `A` and `B` are woken together
- If `A` then mentions `B` during its initial root-channel output window, routing suppresses the extra `agent_mention` wake because `B` is already awake from the same user batch.
- The suppression only skips the redundant extra dispatch. `A`'s message is still written to `channel_messages`, broadcast on the channel, and available to `B` through the normal channel bridge / receive flow.
