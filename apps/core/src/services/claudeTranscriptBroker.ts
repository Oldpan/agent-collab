import { randomUUID } from 'node:crypto';

import type {
  CodexTranscriptFileEntry,
  ClaudeTranscriptListResponseMsg,
  ClaudeTranscriptReadResponseMsg,
} from '@agent-collab/protocol';
import type { NodeRegistry } from './nodeRegistry.js';

type ClaudeTranscriptListResult = {
  rootPath: string;
  files: CodexTranscriptFileEntry[];
  truncated: boolean;
};

type ClaudeTranscriptReadResult = {
  rootPath: string;
  path: string;
  content: string;
  size: number;
  modifiedAt: number | null;
};

type PendingRequest =
  | {
    nodeId: string;
    kind: 'list';
    resolve: (value: ClaudeTranscriptListResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
  | {
    nodeId: string;
    kind: 'read';
    resolve: (value: ClaudeTranscriptReadResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };

export class ClaudeTranscriptBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly nodeRegistry: NodeRegistry;
  private readonly timeoutMs: number;

  constructor(params: { nodeRegistry: NodeRegistry; timeoutMs?: number }) {
    this.nodeRegistry = params.nodeRegistry;
    this.timeoutMs = params.timeoutMs ?? 15_000;
  }

  listFiles(nodeId: string, workspaceRoot: string, maxFiles = 1000): Promise<ClaudeTranscriptListResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Claude transcript request timed out.'));
      }, this.timeoutMs);

      this.pending.set(requestId, { nodeId, kind: 'list', resolve, reject, timer });

      const sent = this.nodeRegistry.send(nodeId, {
        type: 'claude.transcript.list.request',
        requestId,
        workspaceRoot,
        maxFiles,
      });

      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  readFile(nodeId: string, workspaceRoot: string, transcriptPath: string): Promise<ClaudeTranscriptReadResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Claude transcript request timed out.'));
      }, this.timeoutMs);

      this.pending.set(requestId, { nodeId, kind: 'read', resolve, reject, timer });

      const sent = this.nodeRegistry.send(nodeId, {
        type: 'claude.transcript.read.request',
        requestId,
        workspaceRoot,
        path: transcriptPath,
      });

      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  handleListResponse(msg: ClaudeTranscriptListResponseMsg): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending || pending.kind !== 'list') return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error || !msg.rootPath || !msg.files) {
      pending.reject(new Error(formatErrorMessage(msg.errorCode, msg.error)));
      return;
    }

    pending.resolve({
      rootPath: msg.rootPath,
      files: msg.files,
      truncated: Boolean(msg.truncated),
    });
  }

  handleReadResponse(msg: ClaudeTranscriptReadResponseMsg): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending || pending.kind !== 'read') return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error || !msg.rootPath || msg.content === undefined || msg.size === undefined) {
      pending.reject(new Error(formatErrorMessage(msg.errorCode, msg.error)));
      return;
    }

    pending.resolve({
      rootPath: msg.rootPath,
      path: msg.path,
      content: msg.content,
      size: msg.size,
      modifiedAt: msg.modifiedAt ?? null,
    });
  }

  rejectPendingForNode(nodeId: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(`Agent node disconnected: ${nodeId}`));
      this.pending.delete(requestId);
    }
  }
}

function formatErrorMessage(errorCode?: string, error?: string): string {
  if (errorCode) return `${errorCode}:${error ?? 'claude transcript request failed'}`;
  return error ?? 'claude transcript request failed';
}
