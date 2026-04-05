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
  });
});
