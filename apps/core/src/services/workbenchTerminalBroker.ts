import { randomUUID } from 'node:crypto';

import type {
  TerminalCloseResponseMsg,
  TerminalCreateResponseMsg,
  TerminalExitEventMsg,
  TerminalInputResponseMsg,
  TerminalListResponseMsg,
  TerminalOutputEventMsg,
  TerminalResizeResponseMsg,
  TerminalSnapshotResponseMsg,
  WorkbenchTerminalInfo,
  WorkbenchTerminalSnapshotResult,
  WorkbenchTerminalWsServerEvent,
} from '@agent-collab/protocol';
import type { WebSocket } from 'ws';
import type { NodeRegistry } from './nodeRegistry.js';

type PendingRequest =
  | {
    nodeId: string;
    kind: 'list';
    resolve: (value: WorkbenchTerminalInfo[]) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
  | {
    nodeId: string;
    kind: 'create';
    resolve: (value: WorkbenchTerminalInfo) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
  | {
    nodeId: string;
    kind: 'snapshot';
    resolve: (value: WorkbenchTerminalSnapshotResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
  | {
    nodeId: string;
    kind: 'input' | 'resize';
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
  | {
    nodeId: string;
    kind: 'close';
    terminalId: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };

type TerminalRoute = {
  nodeId: string;
  workspaceRoot: string;
};

export class WorkbenchTerminalBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly nodeRegistry: NodeRegistry;
  private readonly timeoutMs: number;
  private readonly routesByTerminalId = new Map<string, TerminalRoute>();
  private readonly socketsByTerminalId = new Map<string, Set<WebSocket>>();

  constructor(params: { nodeRegistry: NodeRegistry; timeoutMs?: number }) {
    this.nodeRegistry = params.nodeRegistry;
    this.timeoutMs = params.timeoutMs ?? 10_000;
  }

  listTerminals(nodeId: string, workspaceRoot: string): Promise<WorkbenchTerminalInfo[]> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Terminal list request timed out.'));
      }, this.timeoutMs);

      this.pending.set(requestId, { nodeId, kind: 'list', resolve, reject, timer });
      const sent = this.nodeRegistry.send(nodeId, {
        type: 'terminal.list.request',
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

  createTerminal(
    nodeId: string,
    params: {
      workspaceRoot: string;
      cwd?: string;
      name?: string;
      cols?: number;
      rows?: number;
    },
  ): Promise<WorkbenchTerminalInfo> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Terminal create request timed out.'));
      }, this.timeoutMs);

      this.pending.set(requestId, { nodeId, kind: 'create', resolve, reject, timer });
      const sent = this.nodeRegistry.send(nodeId, {
        type: 'terminal.create.request',
        requestId,
        workspaceRoot: params.workspaceRoot,
        cwd: params.cwd,
        name: params.name,
        cols: params.cols,
        rows: params.rows,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  snapshotTerminal(nodeId: string, terminalId: string): Promise<WorkbenchTerminalSnapshotResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Terminal snapshot request timed out.'));
      }, this.timeoutMs);

      this.pending.set(requestId, { nodeId, kind: 'snapshot', resolve, reject, timer });
      const sent = this.nodeRegistry.send(nodeId, {
        type: 'terminal.snapshot.request',
        requestId,
        terminalId,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  sendInput(nodeId: string, terminalId: string, data: string): Promise<void> {
    return this.sendNoContentRequest(nodeId, 'input', {
      type: 'terminal.input.request',
      requestId: randomUUID(),
      terminalId,
      data,
    });
  }

  resizeTerminal(nodeId: string, terminalId: string, cols: number, rows: number): Promise<void> {
    return this.sendNoContentRequest(nodeId, 'resize', {
      type: 'terminal.resize.request',
      requestId: randomUUID(),
      terminalId,
      cols,
      rows,
    });
  }

  closeTerminal(nodeId: string, terminalId: string): Promise<void> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Terminal close request timed out.'));
      }, this.timeoutMs);

      this.pending.set(requestId, { nodeId, kind: 'close', terminalId, resolve, reject, timer });
      const sent = this.nodeRegistry.send(nodeId, {
        type: 'terminal.close.request',
        requestId,
        terminalId,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  getTerminalRoute(terminalId: string): TerminalRoute | null {
    return this.routesByTerminalId.get(terminalId) ?? null;
  }

  subscribe(terminalId: string, socket: WebSocket): void {
    let sockets = this.socketsByTerminalId.get(terminalId);
    if (!sockets) {
      sockets = new Set();
      this.socketsByTerminalId.set(terminalId, sockets);
    }
    sockets.add(socket);
  }

  unsubscribe(terminalId: string, socket: WebSocket): void {
    const sockets = this.socketsByTerminalId.get(terminalId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.socketsByTerminalId.delete(terminalId);
    }
  }

  handleListResponse(msg: TerminalListResponseMsg): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending || pending.kind !== 'list') return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error || !msg.terminals) {
      pending.reject(new Error(formatTerminalError(msg.errorCode, msg.error)));
      return;
    }

    for (const terminal of msg.terminals) {
      this.trackTerminal(terminal, pending.nodeId);
    }
    pending.resolve(msg.terminals);
  }

  handleCreateResponse(msg: TerminalCreateResponseMsg): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending || pending.kind !== 'create') return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error || !msg.terminal) {
      pending.reject(new Error(formatTerminalError(msg.errorCode, msg.error)));
      return;
    }

    this.trackTerminal(msg.terminal, pending.nodeId);
    pending.resolve(msg.terminal);
  }

  handleSnapshotResponse(msg: TerminalSnapshotResponseMsg): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending || pending.kind !== 'snapshot') return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error || !msg.terminal || msg.buffer === undefined) {
      pending.reject(new Error(formatTerminalError(msg.errorCode, msg.error)));
      return;
    }

    this.trackTerminal(msg.terminal, pending.nodeId);
    pending.resolve({
      terminal: msg.terminal,
      buffer: msg.buffer,
    });
  }

  handleInputResponse(msg: TerminalInputResponseMsg): void {
    this.handleAckResponse(msg.requestId, msg.errorCode, msg.error, 'input');
  }

  handleResizeResponse(msg: TerminalResizeResponseMsg): void {
    this.handleAckResponse(msg.requestId, msg.errorCode, msg.error, 'resize');
  }

  handleCloseResponse(msg: TerminalCloseResponseMsg): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending || pending.kind !== 'close') return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(new Error(formatTerminalError(msg.errorCode, msg.error)));
      return;
    }

    this.disposeTerminal(pending.terminalId, 'Terminal closed.');
    pending.resolve();
  }

  handleOutputEvent(msg: TerminalOutputEventMsg): void {
    this.broadcast(msg.terminalId, {
      type: 'output',
      terminalId: msg.terminalId,
      data: msg.data,
    });
  }

  handleExitEvent(msg: TerminalExitEventMsg): void {
    this.broadcast(msg.terminalId, {
      type: 'exit',
      terminalId: msg.terminalId,
      exitCode: msg.exitCode,
      signal: msg.signal,
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

  handleNodeDisconnect(nodeId: string): void {
    this.rejectPendingForNode(nodeId);

    for (const [terminalId, route] of this.routesByTerminalId.entries()) {
      if (route.nodeId !== nodeId) continue;
      this.disposeTerminal(terminalId, `Agent node disconnected: ${nodeId}`);
    }
  }

  private sendNoContentRequest(
    nodeId: string,
    kind: 'input' | 'resize',
    msg:
      | { type: 'terminal.input.request'; requestId: string; terminalId: string; data: string }
      | { type: 'terminal.resize.request'; requestId: string; terminalId: string; cols: number; rows: number },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.requestId);
        reject(new Error(`Terminal ${kind} request timed out.`));
      }, this.timeoutMs);

      this.pending.set(msg.requestId, { nodeId, kind, resolve, reject, timer });
      const sent = this.nodeRegistry.send(nodeId, msg);
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(msg.requestId);
        reject(new Error('Agent node is offline.'));
      }
    });
  }

  private handleAckResponse(
    requestId: string,
    errorCode: string | undefined,
    error: string | undefined,
    kind: 'input' | 'resize',
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.kind !== kind) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);

    if (error) {
      pending.reject(new Error(formatTerminalError(errorCode, error)));
      return;
    }

    pending.resolve();
  }

  private trackTerminal(terminal: WorkbenchTerminalInfo, nodeId: string): void {
    this.routesByTerminalId.set(terminal.terminalId, {
      nodeId,
      workspaceRoot: terminal.workspaceRoot,
    });
  }

  private disposeTerminal(terminalId: string, reason: string): void {
    this.broadcast(terminalId, {
      type: 'error',
      message: reason,
    });
    this.routesByTerminalId.delete(terminalId);
    const sockets = this.socketsByTerminalId.get(terminalId);
    if (!sockets) return;
    this.socketsByTerminalId.delete(terminalId);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        socket.close();
      }
    }
  }

  private broadcast(terminalId: string, event: WorkbenchTerminalWsServerEvent): void {
    const sockets = this.socketsByTerminalId.get(terminalId);
    if (!sockets) return;
    const payload = JSON.stringify(event);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }
}

function formatTerminalError(errorCode?: string, error?: string): string {
  if (errorCode) return `${errorCode}:${error ?? 'terminal request failed'}`;
  return error ?? 'terminal request failed';
}
