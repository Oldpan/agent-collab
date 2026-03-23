import { randomUUID } from 'node:crypto';

import type {
  AgentWorkspaceFileResult,
  AgentWorkspaceListResult,
  WorkspaceListResponseMsg,
  WorkspaceReadResponseMsg,
  WorkspaceResetResponseMsg,
} from '@agent-collab/protocol';
import type { NodeRegistry } from './nodeRegistry.js';

type PendingRequest =
  | {
    nodeId: string;
    resolve: (value: AgentWorkspaceListResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    kind: 'list';
  }
  | {
    nodeId: string;
    resolve: (value: AgentWorkspaceFileResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    kind: 'read';
  }
  | {
    nodeId: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    kind: 'reset';
  };

export class AgentWorkspaceBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly nodeRegistry: NodeRegistry;
  private readonly timeoutMs: number;

  constructor(params: { nodeRegistry: NodeRegistry; timeoutMs?: number }) {
    this.nodeRegistry = params.nodeRegistry;
    this.timeoutMs = params.timeoutMs ?? 5_000;
  }

  listDirectory(
    nodeId: string,
    workspaceRoot: string,
    relativePath: string,
  ): Promise<AgentWorkspaceListResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Workspace request timed out.'));
      }, this.timeoutMs);

      this.pending.set(requestId, {
        kind: 'list',
        nodeId,
        resolve,
        reject,
        timer,
      });

      const sent = this.nodeRegistry.send(nodeId, {
        type: 'workspace.list.request',
        requestId,
        workspaceRoot,
        relativePath,
      });

      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  readFile(
    nodeId: string,
    workspaceRoot: string,
    relativePath: string,
  ): Promise<AgentWorkspaceFileResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Workspace request timed out.'));
      }, this.timeoutMs);

      this.pending.set(requestId, {
        kind: 'read',
        nodeId,
        resolve,
        reject,
        timer,
      });

      const sent = this.nodeRegistry.send(nodeId, {
        type: 'workspace.read.request',
        requestId,
        workspaceRoot,
        relativePath,
      });

      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  resetWorkspace(
    nodeId: string,
    workspaceRoot: string,
  ): Promise<void> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Workspace reset timed out.'));
      }, this.timeoutMs);

      this.pending.set(requestId, {
        kind: 'reset',
        nodeId,
        resolve,
        reject,
        timer,
      });

      const sent = this.nodeRegistry.send(nodeId, {
        type: 'workspace.reset.request',
        requestId,
        workspaceRoot,
      });

      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  handleWorkspaceListResponse(msg: WorkspaceListResponseMsg): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending || pending.kind !== 'list') return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error || !msg.entries) {
      pending.reject(new Error(this.formatErrorMessage(msg.errorCode, msg.error)));
      return;
    }

    pending.resolve({
      path: msg.relativePath,
      entries: msg.entries,
    });
  }

  handleWorkspaceReadResponse(msg: WorkspaceReadResponseMsg): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending || pending.kind !== 'read') return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error || msg.content === undefined || !msg.mimeType || msg.size === undefined) {
      pending.reject(new Error(this.formatErrorMessage(msg.errorCode, msg.error)));
      return;
    }

    pending.resolve({
      path: msg.relativePath,
      content: msg.content,
      mimeType: msg.mimeType,
      size: msg.size,
      modifiedAt: msg.modifiedAt ?? null,
    });
  }

  handleWorkspaceResetResponse(msg: WorkspaceResetResponseMsg): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending || pending.kind !== 'reset') return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error || !msg.ok) {
      pending.reject(new Error(this.formatErrorMessage(msg.errorCode, msg.error)));
      return;
    }

    pending.resolve();
  }

  rejectPendingForNode(nodeId: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(`Agent node disconnected: ${nodeId}`));
      this.pending.delete(requestId);
    }
  }

  private formatErrorMessage(errorCode?: string, error?: string): string {
    if (errorCode) {
      return `${errorCode}:${error ?? 'workspace request failed'}`;
    }
    return error ?? 'workspace request failed';
  }
}
