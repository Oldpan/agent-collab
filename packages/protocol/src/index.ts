// ─── 服务端 → 客户端 事件 ───

export type AgentType = 'claude_acp' | 'codex_acp';
export type ConversationStatus = 'idle' | 'queued' | 'active' | 'recovering' | 'awaiting_approval' | 'failed';
export type ThreadKind = 'direct' | 'branch';
export type ChannelCollaborationMode = 'mention_only' | 'subscribed_agents';
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
    args: [],
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
    senderType: 'user' | 'agent';
    content: string;
    createdAt: string;
    seq?: number;
    /** First 8 chars of the root message ID. Present only for thread replies. */
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

export type WorkspaceReadResponseMsg = {
  type: 'workspace.read.response';
  requestId: string;
  relativePath: string;
  content?: string;
  mimeType?: 'text/markdown' | 'text/plain';
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
  | SkillsReadResponseMsg;

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
};

export type WorkspaceReadRequestMsg = {
  type: 'workspace.read.request';
  requestId: string;
  workspaceRoot: string;
  relativePath: string;
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
  mimeType: 'text/markdown' | 'text/plain';
  size: number;
  modifiedAt: number | null;
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
  collaborationMode?: ChannelCollaborationMode;
  members?: Array<{
    agentId: string;
    name: string;
  }>;
  subscribedAgents?: Array<{
    agentId: string;
    name: string;
  }>;
  createdAt: number;
  updatedAt: number;
};

export type CreateChannelRequest = {
  name: string;
  workspacePath?: string;
  description?: string;
  collaborationMode?: ChannelCollaborationMode;
  agentIds?: string[];
};

export type UpdateChannelRequest = {
  description?: string;
  collaborationMode?: ChannelCollaborationMode;
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
