import { randomUUID } from 'node:crypto';

import type {
  CodexTranscriptFileEntry,
  CodexTranscriptListResponseMsg,
  CodexTranscriptReadResponseMsg,
} from '@agent-collab/protocol';
import type { NodeRegistry } from './nodeRegistry.js';

type CodexTranscriptListResult = {
  rootPath: string;
  files: CodexTranscriptFileEntry[];
  truncated: boolean;
};

type CodexTranscriptReadResult = {
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
    resolve: (value: CodexTranscriptListResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
  | {
    nodeId: string;
    kind: 'read';
    resolve: (value: CodexTranscriptReadResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };

export class CodexTranscriptBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly nodeRegistry: NodeRegistry;
  private readonly timeoutMs: number;

  constructor(params: { nodeRegistry: NodeRegistry; timeoutMs?: number }) {
    this.nodeRegistry = params.nodeRegistry;
    this.timeoutMs = params.timeoutMs ?? 15_000;
  }

  listFiles(nodeId: string, maxFiles = 1000): Promise<CodexTranscriptListResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Codex transcript request timed out.'));
      }, this.timeoutMs);

      this.pending.set(requestId, { nodeId, kind: 'list', resolve, reject, timer });

      const sent = this.nodeRegistry.send(nodeId, {
        type: 'codex.transcript.list.request',
        requestId,
        maxFiles,
      });

      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  readFile(nodeId: string, transcriptPath: string): Promise<CodexTranscriptReadResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Codex transcript request timed out.'));
      }, this.timeoutMs);

      this.pending.set(requestId, { nodeId, kind: 'read', resolve, reject, timer });

      const sent = this.nodeRegistry.send(nodeId, {
        type: 'codex.transcript.read.request',
        requestId,
        path: transcriptPath,
      });

      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  handleListResponse(msg: CodexTranscriptListResponseMsg): void {
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

  handleReadResponse(msg: CodexTranscriptReadResponseMsg): void {
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
  if (errorCode) return `${errorCode}:${error ?? 'codex transcript request failed'}`;
  return error ?? 'codex transcript request failed';
}
