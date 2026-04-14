import { randomUUID } from 'node:crypto';

import type {
  WorkbenchGitAction,
  WorkbenchGitActionResult,
  WorkbenchGitDiffMode,
  WorkbenchGitDiffResult,
  WorkspaceGitActionResponseMsg,
  WorkbenchGitStatusResult,
  WorkspaceGitDiffResponseMsg,
  WorkspaceGitStatusResponseMsg,
} from '@agent-collab/protocol';
import type { NodeRegistry } from './nodeRegistry.js';

type PendingGitStatusRequest = {
  nodeId: string;
  resolve: (value: WorkbenchGitStatusResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingGitDiffRequest = {
  nodeId: string;
  resolve: (value: WorkbenchGitDiffResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingGitActionRequest = {
  nodeId: string;
  resolve: (value: WorkbenchGitActionResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class WorkbenchGitBroker {
  private readonly statusPending = new Map<string, PendingGitStatusRequest>();
  private readonly diffPending = new Map<string, PendingGitDiffRequest>();
  private readonly actionPending = new Map<string, PendingGitActionRequest>();
  private readonly nodeRegistry: NodeRegistry;
  private readonly statusTimeoutMs: number;
  private readonly diffTimeoutMs: number;
  private readonly actionTimeoutMs: number;

  constructor(params: {
    nodeRegistry: NodeRegistry;
    timeoutMs?: number;
    statusTimeoutMs?: number;
    diffTimeoutMs?: number;
    actionTimeoutMs?: number;
  }) {
    this.nodeRegistry = params.nodeRegistry;
    const fallbackTimeoutMs = params.timeoutMs;
    this.statusTimeoutMs = params.statusTimeoutMs ?? fallbackTimeoutMs ?? 5_000;
    this.diffTimeoutMs = params.diffTimeoutMs ?? fallbackTimeoutMs ?? 15_000;
    this.actionTimeoutMs = params.actionTimeoutMs ?? fallbackTimeoutMs ?? 60_000;
  }

  runGitAction(
    nodeId: string,
    workspaceRoot: string,
    action: WorkbenchGitAction,
    commitMessage?: string,
  ): Promise<WorkbenchGitActionResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.actionPending.delete(requestId);
        reject(new Error('Workspace git action request timed out.'));
      }, this.actionTimeoutMs);

      this.actionPending.set(requestId, {
        nodeId,
        resolve,
        reject,
        timer,
      });

      const sent = this.nodeRegistry.send(nodeId, {
        type: 'workspace.git_action.request',
        requestId,
        workspaceRoot,
        action,
        commitMessage,
      });

      if (!sent) {
        clearTimeout(timer);
        this.actionPending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  getGitStatus(nodeId: string, workspaceRoot: string): Promise<WorkbenchGitStatusResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.statusPending.delete(requestId);
        reject(new Error('Workspace git status request timed out.'));
      }, this.statusTimeoutMs);

      this.statusPending.set(requestId, {
        nodeId,
        resolve,
        reject,
        timer,
      });

      const sent = this.nodeRegistry.send(nodeId, {
        type: 'workspace.git_status.request',
        requestId,
        workspaceRoot,
      });

      if (!sent) {
        clearTimeout(timer);
        this.statusPending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  getGitDiff(
    nodeId: string,
    workspaceRoot: string,
    mode: WorkbenchGitDiffMode,
  ): Promise<WorkbenchGitDiffResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.diffPending.delete(requestId);
        reject(new Error('Workspace git diff request timed out.'));
      }, this.diffTimeoutMs);

      this.diffPending.set(requestId, {
        nodeId,
        resolve,
        reject,
        timer,
      });

      const sent = this.nodeRegistry.send(nodeId, {
        type: 'workspace.git_diff.request',
        requestId,
        workspaceRoot,
        mode,
      });

      if (!sent) {
        clearTimeout(timer);
        this.diffPending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  handleGitStatusResponse(msg: WorkspaceGitStatusResponseMsg): void {
    const pending = this.statusPending.get(msg.requestId);
    if (!pending) return;
    this.statusPending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error || !msg.status) {
      pending.reject(new Error(this.formatErrorMessage(msg.errorCode, msg.error, 'Workspace git status failed.')));
      return;
    }

    pending.resolve(msg.status);
  }

  handleGitDiffResponse(msg: WorkspaceGitDiffResponseMsg): void {
    const pending = this.diffPending.get(msg.requestId);
    if (!pending) return;
    this.diffPending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error || !msg.diff) {
      pending.reject(new Error(this.formatErrorMessage(msg.errorCode, msg.error, 'Workspace git diff failed.')));
      return;
    }

    pending.resolve(msg.diff);
  }

  handleGitActionResponse(msg: WorkspaceGitActionResponseMsg): void {
    const pending = this.actionPending.get(msg.requestId);
    if (!pending) return;
    this.actionPending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error || !msg.result) {
      pending.reject(new Error(this.formatErrorMessage(msg.errorCode, msg.error, 'Workspace git action failed.')));
      return;
    }

    pending.resolve(msg.result);
  }

  rejectPendingForNode(nodeId: string): void {
    for (const [requestId, pending] of this.statusPending.entries()) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(`Agent node disconnected: ${nodeId}`));
      this.statusPending.delete(requestId);
    }
    for (const [requestId, pending] of this.diffPending.entries()) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(`Agent node disconnected: ${nodeId}`));
      this.diffPending.delete(requestId);
    }
    for (const [requestId, pending] of this.actionPending.entries()) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(`Agent node disconnected: ${nodeId}`));
      this.actionPending.delete(requestId);
    }
  }

  private formatErrorMessage(errorCode: string | undefined, error: string | undefined, fallback: string): string {
    if (error) return errorCode ? `${errorCode}:${error}` : error;
    if (errorCode) return `${errorCode}:${fallback}`;
    return fallback;
  }
}
