export type LiveRunStatus =
  | "running"
  | "awaiting_approval"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled"
  | "not_dispatched";

export type LiveToolStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type LiveRunActivityItem = {
  id: string;
  kind: "plan" | "task";
  title: string;
  detail?: string;
  createdAt: number;
};

/** A single agent run (one ACP turn), containing tool calls and optional thinking */
export type LiveRun = {
  id: string;
  runId: string;
  startedAt: number;
  endedAt?: number;
  promptText?: string;
  toolCalls: LiveToolCall[];
  activityItems: LiveRunActivityItem[];
  thinking?: string;
  outputText?: string;
  isActive: boolean;
  status: LiveRunStatus;
  stopReason?: string;
  error?: string;
};

/** A message in the live chat stream */
export type LiveMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
  thinking?: string;
  toolCalls?: LiveToolCall[];
  isStreaming: boolean;
  messageSource?: string;
  attachmentIds?: string[];
  threadRootId?: string;
  replyCount?: number;
  taskNumber?: number;
  taskStatus?: string;
  taskAssigneeName?: string | null;
};

export type PendingLocalPrompt = {
  id: string;
  text: string;
  createdAt: number;
  attachmentIds?: string[];
  sendAsTask?: boolean;
};

/** A tool call within an assistant message */
export type LiveToolCall = {
  id: string;
  name: string;
  input: unknown;
  startedAt?: number;
  endedAt?: number;
  status: LiveToolStatus;
  completed?: boolean;
  output?: string;
  error?: boolean;
};

/** Pending approval request from the server */
export type PendingApproval = {
  requestId: string;
  toolName: string;
  toolArgs: unknown;
};

/** Chat status state machine */
export type ChatStatus =
  | "idle"
  | "queued"
  | "submitted"
  | "streaming"
  | "recovering"
  | "awaiting_approval"
  | "error";
