export type IncomingMessageItem = {
  message_id: string;
  target: string;
  timestamp: string;
  sender_name: string;
  sender_type: string;
  content: string;
  task_number?: number | null;
  task_status?: string | null;
  task_assignee_name?: string | null;
};

export type HistoryMessageItem = {
  seq: number;
  createdAt: string;
  senderName: string;
  senderType: string;
  content: string;
  taskNumber?: number | null;
  taskStatus?: string | null;
  taskAssigneeName?: string | null;
};

const MESSAGE_SEPARATOR = '\n\n---\n\n';

function formatMetadataBlock(lines: Array<string | null | undefined>): string {
  return ['[Message metadata]', ...lines.filter(Boolean)].join('\n');
}

function formatBodyBlock(label: string, body: string): string {
  return `${label}\n${body}`;
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.filter((part) => Boolean(part)).join('  ');
}

export function formatMessages(messages: IncomingMessageItem[]): string {
  return messages
    .map((m) => {
      const taskLine = m.task_number != null
        ? `task: #${m.task_number} [${m.task_status ?? 'todo'}]${m.task_assignee_name ? ` @${m.task_assignee_name}` : ''}`
        : null;
      const metadata = formatMetadataBlock([
        joinParts([
          `target: ${m.target}`,
          `msg: ${m.message_id.slice(0, 8)}`,
        ]),
        joinParts([
          `time: ${m.timestamp}`,
          `sender: @${m.sender_name}`,
          m.sender_type === 'agent' ? 'sender_type: agent' : null,
        ]),
        taskLine,
      ]);
      const body = formatBodyBlock('[Message body]', m.content);
      return `${metadata}\n\n${body}`;
    })
    .join(MESSAGE_SEPARATOR);
}

export function formatHistoryMessages(messages: HistoryMessageItem[]): string {
  return messages
    .map((m) => {
      const taskLine = m.taskNumber != null
        ? `task: #${m.taskNumber} [${m.taskStatus ?? 'todo'}]${m.taskAssigneeName ? ` @${m.taskAssigneeName}` : ''}`
        : null;
      const metadata = formatMetadataBlock([
        joinParts([
          `seq: ${m.seq}`,
          `time: ${m.createdAt}`,
        ]),
        joinParts([
          `sender: @${m.senderName}`,
          m.senderType === 'agent' ? 'sender_type: agent' : null,
        ]),
        taskLine,
      ]);
      const body = formatBodyBlock('[Message body]', m.content);
      return `${metadata}\n\n${body}`;
    })
    .join(MESSAGE_SEPARATOR);
}
