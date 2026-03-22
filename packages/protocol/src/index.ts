// ─── 服务端 → 客户端 事件 ───

export type ConversationStatusEvent = {
  type: 'conversation.status';
  status: 'idle' | 'busy' | 'error';
  conversationId: string;
};

export type TurnBeginEvent = {
  type: 'turn.begin';
  turnId: string;
};

export type TurnEndEvent = {
  type: 'turn.end';
  turnId: string;
  stopReason?: string;
};

export type ContentDeltaEvent = {
  type: 'content.delta';
  text: string;
};

export type ThinkingDeltaEvent = {
  type: 'thinking.delta';
  text: string;
};

export type ToolCallEvent = {
  type: 'tool.call';
  toolCallId: string;
  name: string;
  input: unknown;
};

export type ToolResultEvent = {
  type: 'tool.result';
  toolCallId: string;
  output: string;
  error?: boolean;
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

// 历史回放：用户消息
export type HistoryUserMessageEvent = {
  type: 'history.user_message';
  text: string;
};

export type ServerEvent =
  | ConversationStatusEvent
  | TurnBeginEvent
  | TurnEndEvent
  | ContentDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalRequestEvent
  | ErrorEvent
  | HistoryCompleteEvent
  | HistoryUserMessageEvent;

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

export type NodePermissionRequestMsg = {
  type: 'permission.request';
  runId: string;
  conversationId: string;
  requestId: string;
  toolName: string;
  toolArgs: unknown;
  toolKind?: string | null;
};

export type NodeToCore =
  | NodeRegisterMsg
  | NodeHeartbeatMsg
  | RunEventMsg
  | RunEndMsg
  | NodePermissionRequestMsg;

// Core → Node

export type NodeAckMsg = {
  type: 'node.ack';
  nodeId: string;
};

export type RunDispatchMsg = {
  type: 'run.dispatch';
  runId: string;
  conversationId: string;
  agentType: string;
  workspacePath: string | null;
  envVars?: Record<string, string>;
  prompt: string;
  sessionKey: string;
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

export type CoreToNode = NodeAckMsg | RunDispatchMsg | RunCancelMsg | NodePermissionResponseMsg;

// ─── REST API 类型 ───

export type AgentType = 'claude_acp' | 'codex_acp';

export type ConversationInfo = {
  id: string;
  channelId: string;
  title: string;
  agentType: AgentType;
  workspacePath: string | null;
  status: 'idle' | 'busy' | 'error';
  createdAt: number;
  updatedAt: number;
  nodeId?: string | null;
};

export type CreateConversationRequest = {
  agentType?: AgentType;
  workspacePath?: string;
  title?: string;
  channelId?: string;
  envVars?: Record<string, string>;
  nodeId?: string;
};

export type ChannelInfo = {
  channelId: string;
  name: string;
  workspacePath: string | null;
  createdAt: number;
  updatedAt: number;
};

export type CreateChannelRequest = {
  name: string;
  workspacePath?: string;
};

export type NodeInfoRest = {
  nodeId: string;
  hostname: string;
  agentTypes: string[];
  version: string;
  lastSeen: number;
};
