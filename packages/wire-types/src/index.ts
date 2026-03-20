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

// ─── REST API 类型 ───

export type AgentType = 'claude_acp' | 'codex_acp';

export type ConversationInfo = {
  id: string;
  title: string;
  agentType: AgentType;
  workspacePath: string | null;
  status: 'idle' | 'busy' | 'error';
  createdAt: number;
  updatedAt: number;
};

export type CreateConversationRequest = {
  agentType?: AgentType;
  workspacePath?: string;
  title?: string;
  envVars?: Record<string, string>;
};
