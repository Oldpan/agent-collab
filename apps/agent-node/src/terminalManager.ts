import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { resolveWorkspacePath } from '@agent-collab/runtime-acp';
import type {
  WorkbenchTerminalInfo,
  WorkspaceErrorCode,
} from '@agent-collab/protocol';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_BUFFER_CHARS = 512_000;
const TERMINAL_BACKEND_UNAVAILABLE_MESSAGE = 'Persistent terminal backend is unavailable on this node.';
const require = createRequire(import.meta.url);

export class TerminalManagerError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type NodePtyModule = {
  spawn: (
    file: string,
    args?: string[],
    options?: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ) => PtyLike;
};

type PtyLike = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number | string | null }) => void): void;
};

type TerminalSession = {
  pty: PtyLike;
  info: WorkbenchTerminalInfo;
  buffer: string;
};

type TerminalOutputListener = (event: { terminalId: string; data: string }) => void;
type TerminalExitListener = (event: { terminalId: string; exitCode?: number | null; signal?: string | null }) => void;

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly outputListeners = new Set<TerminalOutputListener>();
  private readonly exitListeners = new Set<TerminalExitListener>();
  private backendState:
    | { available: true; module: NodePtyModule }
    | { available: false; reason: string }
    | null = null;

  isBackendAvailable(): boolean {
    return this.getBackendState().available;
  }

  getBackendUnavailableReason(): string | null {
    const backend = this.getBackendState();
    return backend.available ? null : backend.reason;
  }

  list(workspaceRoot: string): WorkbenchTerminalInfo[] {
    this.requireBackend();
    return Array.from(this.sessions.values())
      .filter((session) => session.info.workspaceRoot === workspaceRoot)
      .map((session) => ({ ...session.info }))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  create(params: {
    terminalId: string;
    workspaceRoot: string;
    cwd?: string;
    name?: string;
    cols?: number;
    rows?: number;
  }): WorkbenchTerminalInfo {
    const nodePty = this.requireBackend();
    const workspaceRoot = resolveExistingRoot(params.workspaceRoot);
    const cwd = resolveTerminalCwd(workspaceRoot, params.cwd);
    const cols = normalizeDimension(params.cols, DEFAULT_COLS);
    const rows = normalizeDimension(params.rows, DEFAULT_ROWS);
    const now = Date.now();
    const info: WorkbenchTerminalInfo = {
      terminalId: params.terminalId,
      workspaceRoot,
      cwd,
      name: params.name?.trim() || `Terminal ${this.list(workspaceRoot).length + 1}`,
      cols,
      rows,
      createdAt: now,
      lastActivityAt: now,
      exited: false,
      exitCode: null,
      signal: null,
    };

    const shell = process.env.SHELL || '/bin/bash';
    const pty = nodePty.spawn(shell, ['-i'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    const session: TerminalSession = {
      pty,
      info,
      buffer: '',
    };

    pty.onData((data) => {
      session.info.lastActivityAt = Date.now();
      session.buffer = appendBuffer(session.buffer, data);
      for (const listener of this.outputListeners) {
        listener({ terminalId: info.terminalId, data });
      }
    });

    pty.onExit((event) => {
      session.info.exited = true;
      session.info.exitCode = event.exitCode;
      session.info.signal = event.signal != null ? String(event.signal) : null;
      session.info.lastActivityAt = Date.now();
      for (const listener of this.exitListeners) {
        listener({
          terminalId: info.terminalId,
          exitCode: event.exitCode,
          signal: event.signal != null ? String(event.signal) : null,
        });
      }
    });

    this.sessions.set(info.terminalId, session);
    return { ...info };
  }

  snapshot(terminalId: string): { terminal: WorkbenchTerminalInfo; buffer: string } {
    const session = this.requireSession(terminalId);
    return {
      terminal: { ...session.info },
      buffer: session.buffer,
    };
  }

  input(terminalId: string, data: string): void {
    const session = this.requireSession(terminalId);
    if (session.info.exited) {
      throw new TerminalManagerError('io_error', 'Terminal has already exited.');
    }
    session.info.lastActivityAt = Date.now();
    session.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.requireSession(terminalId);
    const normalizedCols = normalizeDimension(cols, DEFAULT_COLS);
    const normalizedRows = normalizeDimension(rows, DEFAULT_ROWS);
    session.info.cols = normalizedCols;
    session.info.rows = normalizedRows;
    session.info.lastActivityAt = Date.now();
    session.pty.resize(normalizedCols, normalizedRows);
  }

  close(terminalId: string): void {
    const session = this.requireSession(terminalId);
    if (!session.info.exited) {
      session.pty.kill();
    }
    this.sessions.delete(terminalId);
  }

  onOutput(listener: TerminalOutputListener): () => void {
    this.outputListeners.add(listener);
    return () => {
      this.outputListeners.delete(listener);
    };
  }

  onExit(listener: TerminalExitListener): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  private requireSession(terminalId: string): TerminalSession {
    const session = this.sessions.get(terminalId);
    if (!session) {
      throw new TerminalManagerError('not_found', 'Terminal not found.');
    }
    return session;
  }

  private requireBackend(): NodePtyModule {
    const backend = this.getBackendState();
    if (!backend.available) {
      throw new TerminalManagerError('io_error', backend.reason);
    }
    return backend.module;
  }

  private getBackendState():
    | { available: true; module: NodePtyModule }
    | { available: false; reason: string } {
    if (this.backendState) return this.backendState;
    try {
      const module = require('node-pty') as NodePtyModule;
      this.backendState = { available: true, module };
    } catch (error) {
      const detail = String((error as Error)?.message ?? error);
      this.backendState = {
        available: false,
        reason: `${TERMINAL_BACKEND_UNAVAILABLE_MESSAGE} ${detail}`.trim(),
      };
    }
    return this.backendState;
  }
}

function resolveExistingRoot(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat) {
    throw new TerminalManagerError('not_found', 'Workspace root not found.');
  }
  if (!stat.isDirectory()) {
    throw new TerminalManagerError('not_directory', 'Workspace root is not a directory.');
  }
  return resolved;
}

function resolveTerminalCwd(workspaceRoot: string, cwd?: string): string {
  if (!cwd) return workspaceRoot;
  const absoluteRequested = path.isAbsolute(cwd)
    ? path.resolve(cwd)
    : path.resolve(workspaceRoot, cwd);
  try {
    return resolveWorkspacePath(workspaceRoot, absoluteRequested);
  } catch {
    throw new TerminalManagerError('path_outside_workspace', 'Terminal path escapes workspace root.');
  }
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value as number);
  if (normalized < 20) return 20;
  return normalized;
}

function appendBuffer(existing: string, next: string): string {
  const combined = `${existing}${next}`;
  if (combined.length <= MAX_BUFFER_CHARS) return combined;
  return combined.slice(combined.length - MAX_BUFFER_CHARS);
}
