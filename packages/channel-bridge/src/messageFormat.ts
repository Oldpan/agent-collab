export type IncomingMessageItem = {
  message_id: string;
  target: string;
  timestamp: string;
  sender_name: string;
  sender_type: string;
  content: string;
};

export type HistoryMessageItem = {
  seq: number;
  createdAt: string;
  senderName: string;
  senderType: string;
  content: string;
};

function formatMetadataBlock(lines: string[]): string {
  return ['[Message metadata]', ...lines].join('\n');
}

function formatBodyBlock(label: string, body: string): string {
  return `${label}\n${body}`;
}

export function formatMessages(messages: IncomingMessageItem[]): string {
  return messages
    .map((m) => {
      const metadata = formatMetadataBlock([
        `target: ${m.target}`,
        `msg: ${m.message_id.slice(0, 8)}`,
        `time: ${m.timestamp}`,
        `sender: @${m.sender_name}`,
        ...(m.sender_type === 'agent' ? ['sender_type: agent'] : []),
      ]);
      const body = formatBodyBlock('[Message body]', m.content);
      return `${metadata}\n\n${body}`;
    })
    .join('\n\n---\n\n');
}

export function formatHistoryMessages(messages: HistoryMessageItem[]): string {
  return messages
    .map((m) => {
      const metadata = formatMetadataBlock([
        `seq: ${m.seq}`,
        `time: ${m.createdAt}`,
        `sender: @${m.senderName}`,
        ...(m.senderType === 'agent' ? ['sender_type: agent'] : []),
      ]);
      const body = formatBodyBlock('[Message body]', m.content);
      return `${metadata}\n\n${body}`;
    })
    .join('\n\n---\n\n');
}
