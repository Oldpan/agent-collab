// ─── 服务端 → 客户端 事件 ───

export type AgentType = 'claude_acp' | 'codex_acp';
export type ConversationStatus = 'idle' | 'queued' | 'active' | 'recovering' | 'awaiting_approval' | 'failed';
export type ThreadKind = 'direct' | 'branch';
export type AgentPermissionKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type RuntimeDispatchMode = 'cold_start' | 'resume';

export type RuntimeDriverDefinition = {
  agentType: AgentType;
  command: string;
  args: string[];
  supportsResume: boolean;
  supportsPushNotifications: boolean;
  nativeMemoryBackend: 'claude' | 'workspace';
  defaultEnv?: Record<string, string>;
};

export const CODEX_ACP_DEFAULT_ARGS = [
  '-c',
  'sandbox_mode="danger-full-access"',
  '-c',
  'approval_policy="never"',
] as const;

export const RUNTIME_DRIVERS: Record<AgentType, RuntimeDriverDefinition> = {
  claude_acp: {
    agentType: 'claude_acp',
    command: 'claude-code-acp',
    args: [],
    supportsResume: true,
    supportsPushNotifications: true,
    nativeMemoryBackend: 'workspace',
    defaultEnv: {
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    },
  },
  codex_acp: {
    agentType: 'codex_acp',
    command: 'codex-acp',
    args: [...CODEX_ACP_DEFAULT_ARGS],
    supportsResume: true,
    supportsPushNotifications: false,
    nativeMemoryBackend: 'workspace',
  },
};

export function getRuntimeDriver(agentType: AgentType): RuntimeDriverDefinition {
  return RUNTIME_DRIVERS[agentType];
}

export function listRuntimeDrivers(): RuntimeDriverDefinition[] {
  return Object.values(RUNTIME_DRIVERS);
}

export const BEIJING_TIME_ZONE = 'Asia/Shanghai';

type TimeInput = number | string | Date;

const BEIJING_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: BEIJING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const BEIJING_DATE_TIME_NO_SECONDS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: BEIJING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const BEIJING_MONTH_DAY_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: BEIJING_TIME_ZONE,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const BEIJING_MONTH_DAY_TIME_WITH_SECONDS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: BEIJING_TIME_ZONE,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const BEIJING_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: BEIJING_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const BEIJING_TIME_WITH_SECONDS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: BEIJING_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function normalizeTimeInput(input: TimeInput): Date | null {
  const date = input instanceof Date ? input : new Date(input);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getDateTimeParts(
  formatter: Intl.DateTimeFormat,
  input: TimeInput,
): Record<string, string> | null {
  const date = normalizeTimeInput(input);
  if (!date) return null;
  const parts = formatter.formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return values;
}

export function formatBeijingDateTime(input: TimeInput, options?: { withSeconds?: boolean }): string {
  const parts = getDateTimeParts(
    options?.withSeconds === false
      ? BEIJING_DATE_TIME_NO_SECONDS_FORMATTER
      : BEIJING_DATE_TIME_FORMATTER,
    input,
  );
  if (!parts) return '';
  const dateText = `${parts.year}-${parts.month}-${parts.day}`;
  const timeText = options?.withSeconds === false
    ? `${parts.hour}:${parts.minute}`
    : `${parts.hour}:${parts.minute}:${parts.second}`;
  return `${dateText} ${timeText}`;
}

export function formatBeijingPromptTimestamp(input: TimeInput): string {
  const formatted = formatBeijingDateTime(input);
  return formatted ? `${formatted} UTC+8` : '';
}

export function formatBeijingMonthDayTime(input: TimeInput, options?: { withSeconds?: boolean }): string {
  const parts = getDateTimeParts(
    options?.withSeconds
      ? BEIJING_MONTH_DAY_TIME_WITH_SECONDS_FORMATTER
      : BEIJING_MONTH_DAY_TIME_FORMATTER,
    input,
  );
  if (!parts) return '';
  const timeText = options?.withSeconds
    ? `${parts.hour}:${parts.minute}:${parts.second}`
    : `${parts.hour}:${parts.minute}`;
  return `${parts.month}/${parts.day} ${timeText}`;
}

export function formatBeijingTime(input: TimeInput, options?: { withSeconds?: boolean }): string {
  const date = normalizeTimeInput(input);
  if (!date) return '';
  return (options?.withSeconds ? BEIJING_TIME_WITH_SECONDS_FORMATTER : BEIJING_TIME_FORMATTER).format(date);
}

export const THREAD_SHORT_ID_LENGTH = 16;

export function stripIgnoredMentionContexts(content: string): string {
  let sanitized = content;

  sanitized = sanitized.replace(/```[\s\S]*?```/g, ' ');
  sanitized = sanitized.replace(/~~~[\s\S]*?~~~/g, ' ');
  sanitized = sanitized.replace(/`[^`\n]*`/g, ' ');
  sanitized = sanitized.replace(/^\s*>.*$/gm, ' ');

  const quotedSpanPatterns = [
    /"[^"\n]*"/g,
    /“[^”\n]*”/g,
    /‘[^’\n]*’/g,
    /「[^」\n]*」/g,
    /『[^』\n]*』/g,
  ];
  for (const pattern of quotedSpanPatterns) {
    sanitized = sanitized.replace(pattern, ' ');
  }

  return sanitized;
}

export function extractMentionedNames(content: string): string[] {
  const sanitizedContent = stripIgnoredMentionContexts(content);
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  const mentioned = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(sanitizedContent)) !== null) {
    mentioned.add(match[1].toLowerCase());
  }

  return [...mentioned];
}

export function normalizeThreadShortIdInput(threadRootId: string | null | undefined): string | null {
  const normalized = threadRootId?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function normalizeMessageIdForThreadShortId(messageId: string): string {
  const trimmed = messageId.trim().toLowerCase();
  const withoutClientPrefix = trimmed.startsWith('client-') ? trimmed.slice('client-'.length) : trimmed;
  const alnumOnly = withoutClientPrefix.replace(/[^a-z0-9]/g, '');
  return alnumOnly || trimmed.replace(/[^a-z0-9]/g, '') || trimmed;
}

export function buildThreadShortId(messageId: string): string {
  const normalized = normalizeMessageIdForThreadShortId(messageId);
  return normalized.slice(0, THREAD_SHORT_ID_LENGTH);
}

export type RecentMessageSourceType = 'dm' | 'channel' | 'thread' | 'task';

export type RecentMessageSourceItem = {
  sourceKey: string;
  sourceType: RecentMessageSourceType;
  channelId: string;
  channelName?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  threadRootId?: string | null;
  taskRef?: string | null;
  taskNumber?: number | null;
  taskTitle?: string | null;
  latestMessageId: string;
  latestSeq: number;
  latestCreatedAt: string;
  latestSenderName: string;
  latestSenderType: 'user' | 'agent' | 'system';
  latestSnippet: string;
  unreadCount: number;
};

export function buildRecentMessageSourceKey(params: {
  sourceType: RecentMessageSourceType;
  channelId?: string | null;
  agentId?: string | null;
  threadRootId?: string | null;
}): string {
  if (params.sourceType === 'dm') {
    return `dm:${encodeURIComponent((params.agentId ?? '').trim())}`;
  }
  if (params.sourceType === 'channel') {
    return `channel:${encodeURIComponent((params.channelId ?? '').trim())}`;
  }
  return `${params.sourceType}:${encodeURIComponent((params.channelId ?? '').trim())}:${encodeURIComponent((params.threadRootId ?? '').trim())}`;
}

export function parseRecentMessageSourceKey(sourceKey: string): (
  | { sourceType: 'dm'; agentId: string }
  | { sourceType: 'channel'; channelId: string }
  | { sourceType: 'thread' | 'task'; channelId: string; threadRootId: string }
) | null {
  const separatorIndex = sourceKey.indexOf(':');
  if (separatorIndex <= 0) return null;
  const sourceType = sourceKey.slice(0, separatorIndex);
  const rest = sourceKey.slice(separatorIndex + 1);

  try {
    if (sourceType === 'dm') {
      const agentId = decodeURIComponent(rest).trim();
      return agentId ? { sourceType: 'dm', agentId } : null;
    }
    if (sourceType === 'channel') {
      const channelId = decodeURIComponent(rest).trim();
      return channelId ? { sourceType: 'channel', channelId } : null;
    }
    if (sourceType === 'thread' || sourceType === 'task') {
      const secondSeparatorIndex = rest.indexOf(':');
      if (secondSeparatorIndex <= 0) return null;
      const channelId = decodeURIComponent(rest.slice(0, secondSeparatorIndex)).trim();
      const threadRootId = decodeURIComponent(rest.slice(secondSeparatorIndex + 1)).trim();
      return channelId && threadRootId
        ? { sourceType, channelId, threadRootId }
        : null;
    }
  } catch {
    return null;
  }

  return null;
}

export type ConversationStatusEvent = {
  type: 'conversation.status';
  status: ConversationStatus;
  conversationId: string;
};

export type TurnBeginEvent = {
  type: 'turn.begin';
  turnId: string;
  startedAt?: number;
  promptText?: string;
};

export type TurnEndEvent = {
  type: 'turn.end';
  turnId: string;
  stopReason?: string;
  endedAt?: number;
  error?: string;
};

export type ContentDeltaEvent = {
  type: 'content.delta';
  text: string;
};

export type ThinkingDeltaEvent = {
  type: 'thinking.delta';
  text: string;
};

export type PlanUpdateEvent = {
  type: 'plan.update';
  title: string;
  detail?: string;
  createdAt?: number;
};

export type TaskUpdateEvent = {
  type: 'task.update';
  title: string;
  detail?: string;
  createdAt?: number;
};

export type ToolCallEvent = {
  type: 'tool.call';
  toolCallId: string;
  name: string;
  input: unknown;
  startedAt?: number;
};

export type ToolResultEvent = {
  type: 'tool.result';
  toolCallId: string;
  output: string;
  error?: boolean;
  status?: 'completed' | 'failed' | 'cancelled';
  endedAt?: number;
};

export type ApprovalRequestEvent = {
  type: 'approval.request';
  requestId: string;
  toolName: string;
  toolArgs: unknown;
  toolKind?: string | null;
};

export type ErrorEvent = {
  type: 'error';
  message: string;
};

export type HistoryCompleteEvent = {
  type: 'history.complete';
};

export type HistoryResetEvent = {
  type: 'history.reset';
};

// 历史回放：用户消息
export type HistoryUserMessageEvent = {
  type: 'history.user_message';
  text: string;
};

export type ChannelMessageEvent = {
  type: 'channel.message';
  message: {
    id: string;
    senderName: string;
    senderType: 'user' | 'agent' | 'system';
    content: string;
    createdAt: string;
    seq?: number;
    /** Thread short ID derived from the root message ID. Present only for thread replies. */
    threadRootId?: string;
    /** Present only when the message was synthesized from raw deltas as a fallback. */
    messageSource?: string;
    /** Present when this message IS a task thread root. */
    taskNumber?: number;
    taskStatus?: string;
    taskAssigneeName?: string | null;
    /** Attachment UUIDs uploaded with this message. */
    attachmentIds?: string[];
  };
};

export type ChannelNoticeEvent = {
  type: 'channel.notice';
  notice: {
    message: string;
    createdAt: string;
  };
};

export type ChannelHistoryResetEvent = {
  type: 'channel.history.reset';
};

export type ChannelTasksChangedEvent = {
  type: 'channel.tasks.changed';
  channelId: string;
  changedAt: number;
};

export type ChannelConversationStatusEvent = {
  type: 'channel.conversation.status';
  channelId: string;
  conversation: ConversationInfo;
};

export type SystemNoticeEvent = {
  type: 'system.notice';
  message: string;
};

export type ServerEvent =
  | ConversationStatusEvent
  | TurnBeginEvent
  | TurnEndEvent
  | ContentDeltaEvent
  | ThinkingDeltaEvent
  | PlanUpdateEvent
  | TaskUpdateEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalRequestEvent
  | ErrorEvent
  | HistoryCompleteEvent
  | HistoryResetEvent
  | HistoryUserMessageEvent
  | ChannelMessageEvent
  | ChannelNoticeEvent
  | ChannelHistoryResetEvent
  | ChannelTasksChangedEvent
  | ChannelConversationStatusEvent
  | SystemNoticeEvent;

// ─── 客户端 → 服务端 事件 ───

export type FileRef = {
  uri: string;
  mimeType?: string;
};

export type PromptEvent = {
  type: 'prompt';
  text: string;
  attachments?: FileRef[];
};

export type ApprovalResponseEvent = {
  type: 'approval.response';
  requestId: string;
  decision: 'allow' | 'deny';
};

export type CancelEvent = {
  type: 'cancel';
};

export type ClientEvent =
  | PromptEvent
  | ApprovalResponseEvent
  | CancelEvent;

// ─── Core ↔ Agent-Node 协议 ───

// Node → Core

export type NodeRegisterMsg = {
  type: 'node.register';
  nodeId: string;
  hostname: string;
  agentTypes: string[];
  version: string;
  terminalBackendAvailable: boolean;
};

export type NodeHeartbeatMsg = {
  type: 'node.heartbeat';
  nodeId: string;
};

/** Agent subprocess event forwarded by node to core */
export type RunEventMsg = {
  type: 'run.event';
  runId: string;
  conversationId: string;
  event: ServerEvent;
};

export type RunEndMsg = {
  type: 'run.end';
  runId: string;
  conversationId: string;
  stopReason?: string;
  error?: string;
};

export type RunAcceptedMsg = {
  type: 'run.accepted';
  runId: string;
  conversationId: string;
};

export type NodePermissionRequestMsg = {
  type: 'permission.request';
  runId: string;
  conversationId: string;
  requestId: string;
  toolName: string;
  toolArgs: unknown;
  toolKind?: string | null;
};

export type WorkspaceErrorCode =
  | 'not_found'
  | 'not_directory'
  | 'not_file'
  | 'path_outside_workspace'
  | 'binary_file'
  | 'file_too_large'
  | 'io_error';

export type WorkspaceWriteMode = 'overwrite' | 'append';

export type AgentWorkspaceEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  size: number | null;
  modifiedAt: number | null;
};

export type AgentSkillEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  size: number | null;
  modifiedAt: number | null;
};

export type AgentSkillSummary = {
  name: string;
  path: string;
  sourceRoot: string;
  description?: string;
};

export type WorkspaceListResponseMsg = {
  type: 'workspace.list.response';
  requestId: string;
  relativePath: string;
  entries?: AgentWorkspaceEntry[];
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type WorkspacePreviewMimeType =
  | 'text/markdown'
  | 'text/plain'
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | 'image/svg+xml'
  | 'image/avif'
  | 'image/bmp'
  | 'image/x-icon';

export type WorkspaceReadResponseMsg = {
  type: 'workspace.read.response';
  requestId: string;
  relativePath: string;
  content?: string;
  mimeType?: WorkspacePreviewMimeType;
  size?: number;
  modifiedAt?: number | null;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type WorkspaceWriteResponseMsg = {
  type: 'workspace.write.response';
  requestId: string;
  relativePath: string;
  ok?: boolean;
  modifiedAt?: number | null;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type WorkspaceResetRequestMsg = {
  type: 'workspace.reset.request';
  requestId: string;
  workspaceRoot: string;
};

export type WorkspaceResetResponseMsg = {
  type: 'workspace.reset.response';
  requestId: string;
  workspaceRoot: string;
  ok?: boolean;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type WorkbenchWorkspaceKind = 'local_checkout' | 'worktree' | 'directory';

export type WorkspaceInspectResult = {
  workspaceRoot: string;
  isGit: boolean;
  repoRoot: string | null;
  workspaceKind: WorkbenchWorkspaceKind;
  branchName: string | null;
  remoteUrl: string | null;
};

export type WorkspaceInspectRequestMsg = {
  type: 'workspace.inspect.request';
  requestId: string;
  workspaceRoot: string;
};

export type WorkspaceInspectResponseMsg = {
  type: 'workspace.inspect.response';
  requestId: string;
  inspect?: WorkspaceInspectResult;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type WorkbenchTerminalInfo = {
  terminalId: string;
  workspaceRoot: string;
  cwd: string;
  name: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivityAt: number;
  exited: boolean;
  exitCode?: number | null;
  signal?: string | null;
};

export type TerminalListRequestMsg = {
  type: 'terminal.list.request';
  requestId: string;
  workspaceRoot: string;
};

export type TerminalListResponseMsg = {
  type: 'terminal.list.response';
  requestId: string;
  workspaceRoot: string;
  terminals?: WorkbenchTerminalInfo[];
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type TerminalCreateRequestMsg = {
  type: 'terminal.create.request';
  requestId: string;
  workspaceRoot: string;
  cwd?: string;
  name?: string;
  cols?: number;
  rows?: number;
};

export type TerminalCreateResponseMsg = {
  type: 'terminal.create.response';
  requestId: string;
  terminal?: WorkbenchTerminalInfo;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type TerminalSnapshotRequestMsg = {
  type: 'terminal.snapshot.request';
  requestId: string;
  terminalId: string;
};

export type TerminalSnapshotResponseMsg = {
  type: 'terminal.snapshot.response';
  requestId: string;
  terminal?: WorkbenchTerminalInfo;
  buffer?: string;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type TerminalInputRequestMsg = {
  type: 'terminal.input.request';
  requestId: string;
  terminalId: string;
  data: string;
};

export type TerminalInputResponseMsg = {
  type: 'terminal.input.response';
  requestId: string;
  ok?: boolean;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type TerminalResizeRequestMsg = {
  type: 'terminal.resize.request';
  requestId: string;
  terminalId: string;
  cols: number;
  rows: number;
};

export type TerminalResizeResponseMsg = {
  type: 'terminal.resize.response';
  requestId: string;
  ok?: boolean;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type TerminalCloseRequestMsg = {
  type: 'terminal.close.request';
  requestId: string;
  terminalId: string;
};

export type TerminalCloseResponseMsg = {
  type: 'terminal.close.response';
  requestId: string;
  ok?: boolean;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type TerminalOutputEventMsg = {
  type: 'terminal.output.event';
  terminalId: string;
  data: string;
};

export type TerminalExitEventMsg = {
  type: 'terminal.exit.event';
  terminalId: string;
  exitCode?: number | null;
  signal?: string | null;
};

export type SkillsListRequestMsg = {
  type: 'skills.list.request';
  requestId: string;
  skillRoots: string[];
  path?: string | null;
  agentType?: AgentType;
  workspaceRoot?: string | null;
};

export type SkillsListResponseMsg = {
  type: 'skills.list.response';
  requestId: string;
  roots: string[];
  path?: string | null;
  skills?: AgentSkillSummary[];
  entries?: AgentSkillEntry[];
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type SkillsReadRequestMsg = {
  type: 'skills.read.request';
  requestId: string;
  skillRoots: string[];
  path: string;
  agentType?: AgentType;
  workspaceRoot?: string | null;
};

export type SkillsReadResponseMsg = {
  type: 'skills.read.response';
  requestId: string;
  path: string;
  content?: string;
  mimeType?: 'text/markdown' | 'text/plain';
  size?: number;
  modifiedAt?: number | null;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type CodexTranscriptFileEntry = {
  path: string;
  size: number;
  modifiedAt: number;
};

export type CodexTranscriptListRequestMsg = {
  type: 'codex.transcript.list.request';
  requestId: string;
  maxFiles?: number;
};

export type CodexTranscriptListResponseMsg = {
  type: 'codex.transcript.list.response';
  requestId: string;
  rootPath?: string;
  files?: CodexTranscriptFileEntry[];
  truncated?: boolean;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type CodexTranscriptReadRequestMsg = {
  type: 'codex.transcript.read.request';
  requestId: string;
  path: string;
};

export type CodexTranscriptReadResponseMsg = {
  type: 'codex.transcript.read.response';
  requestId: string;
  path: string;
  rootPath?: string;
  content?: string;
  size?: number;
  modifiedAt?: number | null;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type ClaudeTranscriptListRequestMsg = {
  type: 'claude.transcript.list.request';
  requestId: string;
  workspaceRoot: string;
  maxFiles?: number;
};

export type ClaudeTranscriptListResponseMsg = {
  type: 'claude.transcript.list.response';
  requestId: string;
  rootPath?: string;
  files?: CodexTranscriptFileEntry[];
  truncated?: boolean;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type ClaudeTranscriptReadRequestMsg = {
  type: 'claude.transcript.read.request';
  requestId: string;
  workspaceRoot: string;
  path: string;
};

export type ClaudeTranscriptReadResponseMsg = {
  type: 'claude.transcript.read.response';
  requestId: string;
  path: string;
  rootPath?: string;
  content?: string;
  size?: number;
  modifiedAt?: number | null;
  error?: string;
  errorCode?: WorkspaceErrorCode;
};

export type RunDebugSnapshotMsg = {
  type: 'run.debug.snapshot';
  runId: string;
  conversationId: string;
  sessionKey: string;
  acpSessionId: string;
  isFreshSession: boolean;
  isExact: boolean;
  effectiveSystemPromptText?: string;
  effectiveContextText?: string;
};

export type NodeToCore =
  | NodeRegisterMsg
  | NodeHeartbeatMsg
  | RunAcceptedMsg
  | RunEventMsg
  | RunEndMsg
  | NodePermissionRequestMsg
  | WorkspaceInspectResponseMsg
  | WorkspaceListResponseMsg
  | WorkspaceReadResponseMsg
  | WorkspaceWriteResponseMsg
  | WorkspaceResetResponseMsg
  | TerminalListResponseMsg
  | TerminalCreateResponseMsg
  | TerminalSnapshotResponseMsg
  | TerminalInputResponseMsg
  | TerminalResizeResponseMsg
  | TerminalCloseResponseMsg
  | TerminalOutputEventMsg
  | TerminalExitEventMsg
  | SkillsListResponseMsg
  | SkillsReadResponseMsg
  | CodexTranscriptListResponseMsg
  | CodexTranscriptReadResponseMsg
  | ClaudeTranscriptListResponseMsg
  | ClaudeTranscriptReadResponseMsg
  | RunDebugSnapshotMsg;

// Core → Node

export type NodeAckMsg = {
  type: 'node.ack';
  nodeId: string;
};

export type RunDispatchMsg = {
  type: 'run.dispatch';
  runId: string;
  conversationId: string;
  agentType: AgentType;
  model?: string;
  reasoningEffort?: string;
  workspacePath: string | null;
  skillRoots?: string[];
  envVars?: Record<string, string>;
  disabledToolKinds?: AgentPermissionKind[];
  prompt: string;
  sessionKey: string;
  hostKey: string;
  dispatchMode: RuntimeDispatchMode;
  systemPromptText?: string;
  contextText?: string;
  resumeContextText?: string;
  channelBridgeConfig?: {
    agentId: string;
    conversationId: string;
    serverUrl: string;
    authToken?: string;
  };
};

export type RunCancelMsg = {
  type: 'run.cancel';
  runId: string;
};

export type NodePermissionResponseMsg = {
  type: 'permission.response';
  requestId: string;
  decision: 'allow' | 'deny';
};

export type WorkspaceListRequestMsg = {
  type: 'workspace.list.request';
  requestId: string;
  workspaceRoot: string;
  relativePath: string;
  scaffold?: boolean;
};

export type WorkspaceReadRequestMsg = {
  type: 'workspace.read.request';
  requestId: string;
  workspaceRoot: string;
  relativePath: string;
  scaffold?: boolean;
};

export type WorkspaceWriteRequestMsg = {
  type: 'workspace.write.request';
  requestId: string;
  workspaceRoot: string;
  relativePath: string;
  content: string;
  mode: WorkspaceWriteMode;
};

export type WorkspaceInspectCoreRequestMsg = WorkspaceInspectRequestMsg;

export type TerminalListCoreRequestMsg = TerminalListRequestMsg;

export type TerminalCreateCoreRequestMsg = TerminalCreateRequestMsg;

export type TerminalSnapshotCoreRequestMsg = TerminalSnapshotRequestMsg;

export type TerminalInputCoreRequestMsg = TerminalInputRequestMsg;

export type TerminalResizeCoreRequestMsg = TerminalResizeRequestMsg;

export type TerminalCloseCoreRequestMsg = TerminalCloseRequestMsg;

export type SkillsListCoreRequestMsg = SkillsListRequestMsg;

export type SkillsReadCoreRequestMsg = SkillsReadRequestMsg;

export type HostCloseMsg = {
  type: 'host.close';
  hostKey: string;
};

export type CoreToNode =
  | NodeAckMsg
  | RunDispatchMsg
  | RunCancelMsg
  | NodePermissionResponseMsg
  | WorkspaceInspectCoreRequestMsg
  | WorkspaceListRequestMsg
  | WorkspaceReadRequestMsg
  | WorkspaceWriteRequestMsg
  | WorkspaceResetRequestMsg
  | TerminalListCoreRequestMsg
  | TerminalCreateCoreRequestMsg
  | TerminalSnapshotCoreRequestMsg
  | TerminalInputCoreRequestMsg
  | TerminalResizeCoreRequestMsg
  | TerminalCloseCoreRequestMsg
  | SkillsListCoreRequestMsg
  | SkillsReadCoreRequestMsg
  | CodexTranscriptListRequestMsg
  | CodexTranscriptReadRequestMsg
  | ClaudeTranscriptListRequestMsg
  | ClaudeTranscriptReadRequestMsg
  | HostCloseMsg;

// ─── REST API 类型 ───

export type ConversationInfo = {
  id: string;
  channelId: string;
  replyTarget?: string | null;
  title: string;
  agentType: AgentType;
  threadKind: ThreadKind;
  isPrimaryThread: boolean;
  threadRootId?: string | null;
  workspacePath: string | null;
  status: ConversationStatus;
  createdAt: number;
  updatedAt: number;
  nodeId?: string | null;
  agentId?: string | null;
  userId?: string | null;
};

export type CreateConversationRequest = {
  agentType?: AgentType;
  workspacePath?: string;
  title?: string;
  channelId?: string;
  threadKind?: ThreadKind;
  isPrimaryThread?: boolean;
  threadRootId?: string | null;
  envVars?: Record<string, string>;
  nodeId?: string;
  agentId?: string;
};

export type AgentWorkspaceListResult = {
  path: string;
  entries: AgentWorkspaceEntry[];
};

export type AgentWorkspaceFileResult = {
  path: string;
  content: string;
  mimeType: WorkspacePreviewMimeType;
  size: number;
  modifiedAt: number | null;
};

export type ResourceSpaceBackendType = 'node_path' | 'shared_mount';

export type ResourceSpaceType = 'docs' | 'experiments' | 'mixed';

export type ResourceTreeEntry = AgentWorkspaceEntry;

export type ResourceTreeResult = {
  path: string;
  entries: ResourceTreeEntry[];
};

export type ResourceFileResult = {
  path: string;
  content: string;
  mimeType: WorkspacePreviewMimeType;
  size: number;
  modifiedAt: number | null;
};

export type ResourceSpaceInfo = {
  resourceSpaceId: string;
  name: string;
  resourceType: ResourceSpaceType;
  backendType: ResourceSpaceBackendType;
  nodeId?: string | null;
  rootPath: string;
  channelId?: string | null;
  description?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type WorkbenchRootKind = 'agent_workspace' | 'project_space' | 'resource_space';

export type WorkbenchRootInfo = {
  workbenchRootId: string;
  kind: WorkbenchRootKind;
  displayName: string;
  rootPath: string;
  nodeId: string | null;
  agentId?: string;
  agentIds?: string[];
  resourceSpaceId?: string;
  resourceType?: ResourceSpaceType;
  backendType?: ResourceSpaceBackendType;
  writable: boolean;
  terminalSupported: boolean;
  terminalDisabledReason?: string | null;
  sourceLabel: string;
};

export type WorkbenchProjectKind = 'git' | 'directory';

export type WorkbenchWorkspaceInfo = {
  workspaceId: string;
  workbenchRootId: string;
  displayName: string;
  rootPath: string;
  workspaceKind: WorkbenchWorkspaceKind;
  branchName: string | null;
  remoteUrl: string | null;
  nodeId: string | null;
  agentId?: string;
  agentIds?: string[];
  writable: boolean;
  terminalSupported: boolean;
  terminalDisabledReason?: string | null;
};

export type WorkbenchProjectInfo = {
  projectId: string;
  displayName: string;
  projectKind: WorkbenchProjectKind;
  primaryRootPath: string | null;
  remoteUrl: string | null;
  workspaces: WorkbenchWorkspaceInfo[];
};

export type WorkbenchProjectsResult = {
  projects: WorkbenchProjectInfo[];
};

export type WorkbenchTreeResult = AgentWorkspaceListResult;

export type WorkbenchFileResult = AgentWorkspaceFileResult;

export type CreateWorkbenchTerminalRequest = {
  cwd?: string;
  name?: string;
  cols?: number;
  rows?: number;
};

export type WorkbenchTerminalListResult = {
  workbenchRootId: string;
  terminals: WorkbenchTerminalInfo[];
};

export type WorkbenchTerminalSnapshotResult = {
  terminal: WorkbenchTerminalInfo;
  buffer: string;
};

export type WorkbenchTerminalWsClientEvent =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

export type WorkbenchTerminalWsServerEvent =
  | { type: 'snapshot'; terminal: WorkbenchTerminalInfo; buffer: string }
  | { type: 'output'; terminalId: string; data: string }
  | { type: 'exit'; terminalId: string; exitCode?: number | null; signal?: string | null }
  | { type: 'pong' }
  | { type: 'error'; message: string };

export type CreateResourceSpaceRequest = {
  name: string;
  resourceType: ResourceSpaceType;
  backendType: ResourceSpaceBackendType;
  nodeId?: string | null;
  rootPath: string;
  channelId?: string | null;
  description?: string;
};

export type UpdateResourceSpaceRequest = {
  name?: string;
  resourceType?: ResourceSpaceType;
  backendType?: ResourceSpaceBackendType;
  nodeId?: string | null;
  rootPath?: string;
  channelId?: string | null;
  description?: string | null;
};

export type AnalyzeResourceRequest = {
  agentId: string;
  question: string;
  path: string;
  selection?: string;
};

export type AnalyzeResourceResult = {
  conversation: ConversationInfo;
  queued: boolean;
};

export type AgentSkillListResult = {
  path: string | null;
  roots: string[];
  skills: AgentSkillSummary[];
  entries: AgentSkillEntry[];
};

export type AgentSkillFileResult = {
  path: string;
  content: string;
  mimeType: 'text/markdown' | 'text/plain';
  size: number;
  modifiedAt: number | null;
};

export type AgentInfo = {
  agentId: string;
  name: string;
  agentType: AgentType;
  model?: string;
  reasoningEffort?: string;
  channelId: string;
  channelIds: string[];
  systemPrompt: string;
  description?: string;
  envVars?: Record<string, string>;
  disabledToolKinds?: AgentPermissionKind[];
  nodeId?: string | null;
  workspacePath?: string | null;
  projectPath?: string | null;
  skillRoots?: string[];
  createdAt: number;
  updatedAt: number;
};

export type CreateAgentRequest = {
  name: string;
  agentType?: AgentType;
  model?: string;
  reasoningEffort?: string;
  channelId?: string;
  systemPrompt?: string;
  description?: string;
  envVars?: Record<string, string>;
  disabledToolKinds?: AgentPermissionKind[];
  nodeId?: string;
  workspacePath?: string;
  projectPath?: string;
  skillRoots?: string[];
};

export type UpdateAgentRequest = {
  name?: string;
  systemPrompt?: string;
  description?: string;
  model?: string;
  reasoningEffort?: string;
  envVars?: Record<string, string>;
  disabledToolKinds?: AgentPermissionKind[];
  channelId?: string;
  projectPath?: string | null;
  skillRoots?: string[];
};

export type ChannelInfo = {
  channelId: string;
  name: string;
  workspacePath: string | null;
  description?: string;
  members?: Array<{
    agentId: string;
    name: string;
  }>;
  createdAt: number;
  updatedAt: number;
};

export type ChannelMemberStatus = {
  agentId: string;
  isOwner: boolean;
  isRecentParticipant: boolean;
  lastActiveAt: number | null;
};

export type CreateChannelRequest = {
  name: string;
  workspacePath?: string;
  description?: string;
  agentIds?: string[];
};

export type UpdateChannelRequest = {
  description?: string;
};

export type TaskInfo = {
  taskId: string;
  channelId: string;
  taskNumber: number;
  title: string;
  description?: string;
  status: 'todo' | 'in_progress' | 'in_review' | 'done';
  assigneeId?: string | null;
  assigneeName?: string | null;
  linkedThreadId?: string | null;
  linkedThreadShortId?: string | null;
  /** The channel_messages.message_id that IS this task's thread root */
  messageId?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type NodeInfoRest = {
  nodeId: string;
  hostname: string;
  agentTypes: string[];
  version: string;
  lastSeen: number;
  terminalBackendAvailable: boolean;
};

export type MachineInfo = {
  nodeId: string;
  name: string;           // display_name ?? hostname ?? nodeId
  hostname: string | null;
  agentTypes: string[];
  version: string | null;
  status: 'pending' | 'online' | 'offline';
  envVarKeys: string[];
  lastSeen: number | null;
  provisionedAt: number;
  createdAt: number;
};

export type CreateMachineRequest = {
  name: string;
  envVarKeys?: string[];  // e.g. ["ANTHROPIC_API_KEY"]
};
