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

export const THREAD_SHORT_ID_LENGTH = 16;

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
  | 'image/svg+xml';

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
  | WorkspaceListResponseMsg
  | WorkspaceReadResponseMsg
  | WorkspaceWriteResponseMsg
  | WorkspaceResetResponseMsg
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
  | WorkspaceListRequestMsg
  | WorkspaceReadRequestMsg
  | WorkspaceWriteRequestMsg
  | WorkspaceResetRequestMsg
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
