import { randomUUID } from 'node:crypto';

import type {
  WorkspaceInspectResponseMsg,
  WorkspaceInspectResult,
} from '@agent-collab/protocol';
import type { NodeRegistry } from './nodeRegistry.js';

type PendingInspectRequest = {
  nodeId: string;
  resolve: (value: WorkspaceInspectResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class WorkbenchInspectBroker {
  private readonly pending = new Map<string, PendingInspectRequest>();
  private readonly nodeRegistry: NodeRegistry;
  private readonly timeoutMs: number;

  constructor(params: { nodeRegistry: NodeRegistry; timeoutMs?: number }) {
    this.nodeRegistry = params.nodeRegistry;
    this.timeoutMs = params.timeoutMs ?? 1_500;
  }

  inspectWorkspace(nodeId: string, workspaceRoot: string): Promise<WorkspaceInspectResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Workspace inspect request timed out.'));
      }, this.timeoutMs);

      this.pending.set(requestId, {
        nodeId,
        resolve,
        reject,
        timer,
      });

      const sent = this.nodeRegistry.send(nodeId, {
        type: 'workspace.inspect.request',
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

  handleInspectResponse(msg: WorkspaceInspectResponseMsg): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending) return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error || !msg.inspect) {
      pending.reject(new Error(this.formatErrorMessage(msg.errorCode, msg.error)));
      return;
    }

    pending.resolve(msg.inspect);
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
    if (error) return error;
    if (errorCode === 'not_found') return 'Workspace root not found.';
    if (errorCode === 'not_directory') return 'Workspace root is not a directory.';
    return 'Workspace inspect failed.';
  }
}
