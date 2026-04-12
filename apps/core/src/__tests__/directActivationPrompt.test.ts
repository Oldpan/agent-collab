import { describe, expect, it } from 'vitest';
import { buildDirectActivationContextText } from '../web/directActivationPrompt.js';

describe('directActivationPrompt', () => {
  it('DM task-thread context text 应包含 thread root 和 Context from DM snapshot', () => {
    const threadRootId = 'deadbead00000000';
    const text = buildDirectActivationContextText({
      target: `dm:@oldpan:${threadRootId}`,
      rootMessage: {
        messageId: 'deadbead-0000-0000-0000-000000000000',
        seq: 9,
        target: '#dm:agent-kimi',
        senderName: 'Kimi',
        senderType: 'agent',
        content: '查看系统显存使用情况',
        createdAt: 9,
        attachmentIds: ['11111111-1111-1111-1111-111111111111'],
      },
      recentMessages: [
        {
          messageId: 'thread-reply-1',
          seq: 10,
          target: `dm:@oldpan:${threadRootId}`,
          senderName: 'Kimi',
          senderType: 'agent',
          content: '这是 thread 内的执行更新。',
          createdAt: 10,
        },
      ],
      unreadCount: 0,
      dmContextSnapshot: {
        triggerMessageId: 'trigger-msg-1',
        messages: [
          {
            messageId: 'trigger-msg-1',
            seq: 1,
            target: 'dm:@oldpan',
            senderName: 'oldpan',
            senderType: 'user',
            content: '请帮我检查一下当前系统显存占用。',
            createdAt: 1,
            attachmentIds: ['22222222-2222-2222-2222-222222222222'],
          },
          {
            messageId: 'agent-msg-2',
            seq: 2,
            target: 'dm:@oldpan',
            senderName: 'Kimi',
            senderType: 'agent',
            content: '我先看看。',
            createdAt: 2,
          },
        ],
      },
      dmActiveTaskThreads: [
        {
          agentTaskRef: 'task_deadbead1234',
          taskNumber: 4,
          title: '检查显存使用情况',
          status: 'in_progress',
          claimedByName: 'Kimi',
          threadTarget: `dm:@oldpan:${threadRootId}`,
        },
      ],
    });

    expect(text).toContain('[Thread root message]');
    expect(text).toContain('查看系统显存使用情况');
    expect(text).toContain('[Recent messages on this exact target]');
    expect(text).toContain('这是 thread 内的执行更新。');
    expect(text).toContain('[Context from DM]');
    expect(text).toContain('@oldpan [Trigger]: 请帮我检查一下当前系统显存占用。');
    expect(text).toContain('attachment_id: 11111111-1111-1111-1111-111111111111');
    expect(text).toContain('attachment_id: 22222222-2222-2222-2222-222222222222');
    expect(text).toContain('[Active DM task threads]');
    expect(text).toContain(`#4 [in_progress] @Kimi -> dm:@oldpan:${threadRootId} — 检查显存使用情况`);
    expect(text).not.toContain('msg: ');
  });
});
