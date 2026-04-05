import { describe, expect, it } from 'vitest';
import { formatHistoryMessages, formatMessages } from '../src/messageFormat.js';

describe('message formatting', () => {
  it('formatMessages 应将 metadata 与正文分块，避免单行 header+body', () => {
    const text = formatMessages([
      {
        message_id: '58573dd0-1111-2222-3333-444444444444',
        target: '#default',
        timestamp: '2026-03-26T15:28:20.626Z',
        sender_name: 'User',
        sender_type: 'user',
        content: '@Bob 我们刚才聊了什么',
      },
    ]);

    expect(text).toContain('[Message metadata]');
    expect(text).toContain('target: #default');
    expect(text).toContain('msg: 58573dd0');
    expect(text).toContain('[Message body]');
    expect(text).toContain('@Bob 我们刚才聊了什么');
    expect(text).not.toContain('[target=#default msg=58573dd0');
  });

  it('formatHistoryMessages 应将 seq/time 与正文分块显示', () => {
    const text = formatHistoryMessages([
      {
        seq: 12,
        createdAt: '2026-03-26T15:28:20.626Z',
        senderName: 'Bob',
        senderType: 'agent',
        content: '之前我们聊过 conda develop 环境。',
      },
    ]);

    expect(text).toContain('[Message metadata]');
    expect(text).toContain('seq: 12');
    expect(text).toContain('sender: @Bob');
    expect(text).toContain('sender_type: agent');
    expect(text).toContain('[Message body]');
    expect(text).toContain('之前我们聊过 conda develop 环境。');
    expect(text).not.toContain('[seq=12');
  });

  it('多条消息之间应有清晰分隔', () => {
    const text = formatMessages([
      {
        message_id: '11111111-1111-2222-3333-444444444444',
        target: '#default',
        timestamp: '2026-03-26T15:28:20.626Z',
        sender_name: 'User',
        sender_type: 'user',
        content: 'first',
      },
      {
        message_id: '22222222-1111-2222-3333-444444444444',
        target: '#default',
        timestamp: '2026-03-26T15:29:20.626Z',
        sender_name: 'Bob',
        sender_type: 'agent',
        content: 'second',
      },
    ]);

    expect(text).toContain('\n\n---\n\n');
    expect(text).toContain('target: #default  msg: 11111111');
    expect(text).toContain('sender: @Bob  sender_type: agent');
  });
});
