#!/usr/bin/env node

/**
 * channel-bridge — MCP server for agent-collab agents.
 *
 * Mirrors Slock's chat-bridge.js: exposes send_message, check_messages,
 * list_server, read_history, and task board tools over MCP stdio transport.
 * The tools call agent-collab's internal agent API (/api/internal/agent/:id/*).
 *
 * Usage:
 *   channel-bridge --agent-id <id> --server-url <url> [--auth-token <token>]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let agentId = '';
let conversationId = '';
let serverUrl = 'http://localhost:3100';
let authToken = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--agent-id' && args[i + 1]) agentId = args[++i];
  if (args[i] === '--conversation-id' && args[i + 1]) conversationId = args[++i];
  if (args[i] === '--server-url' && args[i + 1]) serverUrl = args[++i];
  if (args[i] === '--auth-token' && args[i + 1]) authToken = args[++i];
}

if (!agentId || !conversationId) {
  console.error('[channel-bridge] Missing --agent-id or --conversation-id');
  process.exit(1);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const commonHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
if (authToken) commonHeaders['Authorization'] = `Bearer ${authToken}`;

const base = `${serverUrl}/api/internal/agent/${agentId}`;

async function apiFetch(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: options?.method ?? 'GET',
    headers: commonHeaders,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function errText(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'error' in data) return String((data as Record<string, unknown>).error);
  return fallback;
}

function toText(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'chat', version: '1.0.0' });

// ── send_message ──────────────────────────────────────────────────────────────

server.tool(
  'send_message',
  'Send a message to the current conversation by default. You may optionally override the target to send to a specific channel, DM, or thread. Format: \'#channel\' for channels, \'dm:@peer\' for DMs, \'#channel:shortid\' for threads in channels, \'dm:@peer:shortid\' for threads in DMs. To start a NEW DM, use \'dm:@person-name\'.',
  {
    target: z.string().optional().describe(
      'Optional override for where to send. If omitted, the message replies to the current conversation. Format: \'#channel\' for channels, \'dm:@name\' for DMs, \'#channel:id\' for channel threads, \'dm:@name:id\' for DM threads. Examples: \'#general\', \'dm:@alice\', \'#general:abcd1234\'.',
    ),
    content: z.string().describe('The message content'),
    attachment_ids: z.array(z.string()).optional().describe('Optional attachment IDs to include'),
  },
  async ({ target, content }) => {
    try {
      const { ok, data } = await apiFetch('/send', {
        method: 'POST',
        body: { target, content, conversationId },
      });
      if (!ok) return toText(`Error: ${errText(data, 'send failed')}`);
      const d = data as Record<string, unknown>;
      const msgId = String(d.messageId ?? '');
      const deliveredTarget = String(d.target ?? target ?? 'current conversation');
      const shortId = msgId.slice(0, 8);
      const replyHint = shortId
        ? ` (to reply in this message's thread, use target "${deliveredTarget.includes(':') ? deliveredTarget : `${deliveredTarget}:${shortId}`}")`
        : '';
      return toText(`Message sent to ${deliveredTarget}. Message ID: ${msgId}${replyHint}`);
    } catch (err: unknown) {
      return toText(`Error: ${(err as Error).message}`);
    }
  },
);

// ── check_messages ────────────────────────────────────────────────────────────

server.tool(
  'check_messages',
  'Check for new messages without waiting. Returns immediately with any pending messages, or \'No new messages\' if none. Use this freely during work — at natural breakpoints, after notifications, or whenever you want to see if anything new came in.',
  {},
  async () => {
    try {
      const { ok, data } = await apiFetch('/receive');
      if (!ok) return toText(`Error: ${errText(data, 'receive failed')}`);
      const d = data as { messages?: unknown[] };
      if (d.messages && d.messages.length > 0) {
        const formatted = formatMessages(d.messages as MessageItem[]);
        return toText(
          formatted +
          '\n\n--- IMPORTANT: You MUST reply using mcp__chat__send_message(content="...") for the current conversation, or set target only when you intentionally want to send elsewhere. Do NOT output text directly. ---',
        );
      }
      return toText('No new messages.');
    } catch (err: unknown) {
      return toText(`Error: ${(err as Error).message}`);
    }
  },
);

// ── list_server ───────────────────────────────────────────────────────────────

server.tool(
  'list_server',
  'List all channels in this server, including which ones you have joined, plus all agents and humans. Use this to discover who and where you can message.',
  {},
  async () => {
    try {
      const { ok, data } = await apiFetch('/server');
      if (!ok) return toText(`Error: ${errText(data, 'server list failed')}`);
      const d = data as { channels?: ChannelItem[]; agents?: AgentItem[]; humans?: HumanItem[] };

      let text = '## Server\n\n';
      text += '### Channels\n';
      text += "Use `#channel-name` with send_message to post in a channel. `joined` means you currently belong to that channel.\n";
      if (d.channels?.length) {
        for (const ch of d.channels) {
          const status = ch.joined ? 'joined' : 'not joined';
          text += ch.description
            ? `  - #${ch.name} [${status}] — ${ch.description}\n`
            : `  - #${ch.name} [${status}]\n`;
        }
      } else {
        text += '  (none)\n';
      }

      text += '\n### Agents\n';
      text += 'Other AI agents in this server.\n';
      if (d.agents?.length) {
        for (const a of d.agents) text += `  - @${a.name} (${a.status})\n`;
      } else {
        text += '  (none)\n';
      }

      text += '\n### Humans\n';
      text += 'To start a new DM: send_message(target="dm:@name"). To reply in an existing DM: reuse the target from received messages.\n';
      if (d.humans?.length) {
        for (const u of d.humans) text += `  - @${u.name}\n`;
      } else {
        text += '  (none)\n';
      }

      return toText(text);
    } catch (err: unknown) {
      return toText(`Error: ${(err as Error).message}`);
    }
  },
);

// ── read_history ──────────────────────────────────────────────────────────────

server.tool(
  'read_history',
  "Read message history for a channel, DM, or thread. Use the same target format: '#channel', 'dm:@name', '#channel:id' for threads. Supports pagination: use 'before' to load older messages, 'after' to load messages after a seq number.",
  {
    channel: z.string().describe("The target to read history from — e.g. '#general', 'dm:@alice', '#general:abcd1234'"),
    limit: z.number().default(50).describe('Max number of messages to return (default 50, max 100)'),
    before: z.number().optional().describe('Return messages before this seq number (backward pagination).'),
    after: z.number().optional().describe('Return messages after this seq number (catching up on unread).'),
  },
  async ({ channel, limit, before, after }) => {
    try {
      const params = new URLSearchParams();
      params.set('channel', channel);
      params.set('limit', String(Math.min(limit, 100)));
      if (before !== undefined) params.set('before', String(before));
      if (after !== undefined) params.set('after', String(after));

      const { ok, data } = await apiFetch(`/history?${params}`);
      if (!ok) return toText(`Error: ${errText(data, 'history fetch failed')}`);

      const d = data as { messages?: HistoryMessage[]; has_more?: boolean };
      if (!d.messages?.length) return toText('No messages in this channel.');

      const formatted = d.messages.map((m) => {
        const senderType = m.senderType === 'agent' ? ' type=agent' : '';
        return `[seq=${m.seq} time=${m.createdAt}${senderType}] @${m.senderName}: ${m.content}`;
      }).join('\n');

      let footer = '';
      if (d.has_more && d.messages.length > 0) {
        if (after !== undefined) {
          const maxSeq = d.messages[d.messages.length - 1].seq;
          footer = `\n\n--- ${d.messages.length} messages shown. Use after=${maxSeq} to load more recent messages. ---`;
        } else {
          const minSeq = d.messages[0].seq;
          footer = `\n\n--- ${d.messages.length} messages shown. Use before=${minSeq} to load older messages. ---`;
        }
      }

      return toText(`## Message History for ${channel} (${d.messages.length} messages)\n\n${formatted}${footer}`);
    } catch (err: unknown) {
      return toText(`Error: ${(err as Error).message}`);
    }
  },
);

// ── list_tasks ────────────────────────────────────────────────────────────────

server.tool(
  'list_tasks',
  "List tasks on a channel's task board. Returns tasks with their number (#t1, #t2...), title, status, and assignee.",
  {
    channel: z.string().describe("The channel whose task board to view — e.g. '#general'"),
    status: z
      .enum(['all', 'todo', 'in_progress', 'in_review', 'done'])
      .default('all')
      .describe('Filter by status (default: all)'),
  },
  async ({ channel, status }) => {
    try {
      const params = new URLSearchParams({ channel });
      if (status !== 'all') params.set('status', status);

      const { ok, data } = await apiFetch(`/tasks?${params}`);
      if (!ok) return toText(`Error: ${errText(data, 'list tasks failed')}`);

      const d = data as { tasks?: TaskItem[] };
      if (!d.tasks?.length) {
        return toText(`No${status !== 'all' ? ` ${status}` : ''} tasks in ${channel}.`);
      }

      const formatted = d.tasks.map((t) => {
        const assignee = t.claimedByName ? ` → @${t.claimedByName}` : '';
        const creator = t.createdByName ? ` (by @${t.createdByName})` : '';
        return `#t${t.taskNumber} [${t.status}] "${t.title}"${assignee}${creator}`;
      }).join('\n');

      return toText(`## Task Board for ${channel} (${d.tasks.length} tasks)\n\n${formatted}`);
    } catch (err: unknown) {
      return toText(`Error: ${(err as Error).message}`);
    }
  },
);

// ── create_tasks ──────────────────────────────────────────────────────────────

server.tool(
  'create_tasks',
  "Create one or more tasks on a channel's task board. Returns the created task numbers.",
  {
    channel: z.string().describe("The channel to create tasks in — e.g. '#general'"),
    tasks: z
      .array(z.object({ title: z.string().describe('Task title') }))
      .describe('Array of tasks to create'),
  },
  async ({ channel, tasks }) => {
    try {
      const { ok, data } = await apiFetch('/tasks', { method: 'POST', body: { channel, tasks } });
      if (!ok) return toText(`Error: ${errText(data, 'create tasks failed')}`);

      const d = data as { tasks?: Array<{ taskNumber: number; title: string }> };
      const created = d.tasks?.map((t) => `#t${t.taskNumber} "${t.title}"`).join('\n') ?? '';
      return toText(`Created ${d.tasks?.length ?? 0} task(s) in ${channel}:\n${created}`);
    } catch (err: unknown) {
      return toText(`Error: ${(err as Error).message}`);
    }
  },
);

// ── claim_tasks ───────────────────────────────────────────────────────────────

server.tool(
  'claim_tasks',
  'Claim one or more tasks by their number. Returns which claims succeeded and which failed (e.g. already claimed by someone else).',
  {
    channel: z.string().describe("The channel whose tasks to claim — e.g. '#general'"),
    task_numbers: z.array(z.number()).describe('Task numbers to claim (e.g. [1, 3, 5])'),
  },
  async ({ channel, task_numbers }) => {
    try {
      const { ok, data } = await apiFetch('/tasks/claim', {
        method: 'POST',
        body: { channel, task_numbers },
      });
      if (!ok) return toText(`Error: ${errText(data, 'claim tasks failed')}`);

      const d = data as { results?: Array<{ taskNumber: number; success: boolean; reason?: string }> };
      const lines = (d.results ?? []).map((r) =>
        r.success ? `#t${r.taskNumber}: claimed` : `#t${r.taskNumber}: FAILED — ${r.reason ?? 'already claimed'}`,
      );
      const succeeded = (d.results ?? []).filter((r) => r.success).length;
      const failed = (d.results ?? []).length - succeeded;
      let summary = `${succeeded} claimed`;
      if (failed > 0) summary += `, ${failed} failed`;
      return toText(`Claim results (${summary}):\n${lines.join('\n')}`);
    } catch (err: unknown) {
      return toText(`Error: ${(err as Error).message}`);
    }
  },
);

// ── unclaim_task ──────────────────────────────────────────────────────────────

server.tool(
  'unclaim_task',
  'Release your claim on a task, setting it back to open.',
  {
    channel: z.string().describe("The channel — e.g. '#general'"),
    task_number: z.number().describe('The task number to unclaim (e.g. 3)'),
  },
  async ({ channel, task_number }) => {
    try {
      const { ok, data } = await apiFetch('/tasks/unclaim', {
        method: 'POST',
        body: { channel, task_number },
      });
      if (!ok) return toText(`Error: ${errText(data, 'unclaim failed')}`);
      return toText(`#t${task_number} unclaimed — now open.`);
    } catch (err: unknown) {
      return toText(`Error: ${(err as Error).message}`);
    }
  },
);

// ── update_task_status ────────────────────────────────────────────────────────

server.tool(
  'update_task_status',
  'Update a task\'s progress status. Valid transitions: todo→in_progress, in_progress→in_review, in_progress→done, in_review→done, in_review→in_progress. You must be the assignee (except in_review→done which anyone can do).',
  {
    channel: z.string().describe("The channel — e.g. '#general'"),
    task_number: z.number().describe('The task number to update (e.g. 3)'),
    status: z
      .enum(['todo', 'in_progress', 'in_review', 'done'])
      .describe('The new status'),
  },
  async ({ channel, task_number, status }) => {
    try {
      const { ok, data } = await apiFetch('/tasks/update-status', {
        method: 'POST',
        body: { channel, task_number, status },
      });
      if (!ok) return toText(`Error: ${errText(data, 'update status failed')}`);
      return toText(`#t${task_number} moved to ${status}.`);
    } catch (err: unknown) {
      return toText(`Error: ${(err as Error).message}`);
    }
  },
);

// ─── Transport ────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// ─── Types ────────────────────────────────────────────────────────────────────

type MessageItem = {
  message_id: string;
  sender_name: string;
  sender_type: string;
  target: string;
  content: string;
  seq: number;
  timestamp: string;
};

type HistoryMessage = {
  id: string;
  senderName: string;
  senderType: string;
  content: string;
  seq: number;
  createdAt: string;
};

type ChannelItem = { name: string; joined: boolean; description?: string };
type AgentItem = { name: string; status: string };
type HumanItem = { name: string };
type TaskItem = {
  taskNumber: number;
  title: string;
  status: string;
  claimedByName: string | null;
  createdByName: string | null;
};

// ─── Message formatter ────────────────────────────────────────────────────────

function formatMessages(messages: MessageItem[]): string {
  return messages
    .map((m) => {
      const senderType = m.sender_type === 'agent' ? ' type=agent' : '';
      return `[target=${m.target} msg=${m.message_id.slice(0, 8)} time=${m.timestamp}${senderType}] @${m.sender_name}: ${m.content}`;
    })
    .join('\n');
}
