import { describe, expect, it } from 'vitest';
import { buildChannelActivationContextText } from '../web/channelActivationPrompt.js';

describe('buildChannelActivationContextText', () => {
  it('应附带 history cursor，并只汇报未包含在 recent slice 内的旧 unread', () => {
    const text = buildChannelActivationContextText({
      target: '#default',
      recentMessages: [
        {
          messageId: 'm4',
          seq: 4,
          target: '#default',
          senderName: 'User',
          senderType: 'user',
          content: 'old-4',
          createdAt: 4000,
        },
        {
          messageId: 'm5',
          seq: 5,
          target: '#default',
          senderName: 'User',
          senderType: 'user',
          content: 'old-5',
          createdAt: 5000,
        },
      ],
      unreadCount: 3,
      oldestVisibleSeq: 4,
    });

    expect(text).toContain('[Recent messages on this exact target]');
    expect(text).toContain('[History cursor]\noldest_visible_seq: 4');
    expect(text).toContain('[Unread summary]\n3 older unread messages on this exact target were not included above. Use read_history(channel="#default", before=4) if you need them.');
    expect(text).toContain('\n\n---\n\n');
    expect(text).not.toContain('msg: ');
  });

  it('应在 bound task 上下注入任务 brief', () => {
    const threadRootId = 'deadbeef00000000';
    const text = buildChannelActivationContextText({
      target: `#default:${threadRootId}`,
      boundTask: {
        taskNumber: 4,
        title: 'Clarify the rollout',
        description: 'Goal: define the task brief flow. Done when create, promote, and edit all require a brief.',
        status: 'in_progress',
        claimedByName: 'kimi',
      },
    });

    expect(text).toContain('[Bound task-message for this thread]');
    expect(text).toContain('#4 [in_progress] @kimi — Clarify the rollout');
    expect(text).toContain('Task brief / goal / done criteria:');
    expect(text).toContain('Goal: define the task brief flow.');
  });

  it('应在消息上下文中暴露 attachment_id 引用', () => {
    const text = buildChannelActivationContextText({
      target: '#default',
      recentMessages: [
        {
          messageId: 'with-attachment',
          seq: 7,
          target: '#default',
          senderName: 'User',
          senderType: 'user',
          content: '请按这张图执行。',
          createdAt: 7000,
          attachmentIds: ['11111111-1111-1111-1111-111111111111'],
        },
      ],
    });

    expect(text).toContain('[Message attachments]');
    expect(text).toContain('attachment_id: 11111111-1111-1111-1111-111111111111');
    expect(text).toContain('Use view_file(attachment_id="<one of the IDs above>")');
  });
});
