import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { log } from '../logging.js';
import type { JsonRpcMessage } from './jsonrpc.js';

type StdioExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
};

export type StdioProcess = {
  write: (message: JsonRpcMessage) => void;
  onMessage: (cb: (message: JsonRpcMessage) => void) => void;
  onStderr: (cb: (line: string) => void) => void;
  onExit?: (
    cb: (info: StdioExitInfo) => void,
  ) => void;
  kill: () => void;
};

const ACP_AGENT_COMMAND_FALLBACKS: Record<string, { command: string; args: string[] }> = {
  'claude-code-acp': {
    command: 'npx',
    args: ['-y', '@zed-industries/claude-code-acp@latest'],
  },
  'codex-acp': {
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp@latest'],
  },
};

export function spawnAcpAgent(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): StdioProcess {
  const childEnv = {
    ...process.env,
    // Unset vars that would prevent Claude Code from starting inside an existing Claude session
    CLAUDECODE: undefined,
    CLAUDE_CODE_ENTRYPOINT: undefined,
    ...env,
  };
  const spawnPlan = resolveSpawnPlan(command, args, childEnv);

  if (spawnPlan.fallbackFrom) {
    log.warn('ACP agent command not found on PATH; falling back to npx package execution', {
      requestedCommand: spawnPlan.fallbackFrom,
      fallbackCommand: spawnPlan.command,
      cwd,
    });
  }

  const child = spawn(spawnPlan.command, spawnPlan.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
    env: childEnv,
  });

  const stdoutRl = child.stdout ? readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  }) : null;
  const stderrRl = child.stderr ? readline.createInterface({
    input: child.stderr,
    crlfDelay: Infinity,
  }) : null;

  const messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  const stderrHandlers: Array<(line: string) => void> = [];
  const exitHandlers: Array<(info: StdioExitInfo) => void> = [];
  let exitInfo: StdioExitInfo | null = null;

  stdoutRl?.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as JsonRpcMessage;
      messageHandlers.forEach((h) => h(msg));
    } catch (error) {
      log.error('ACP stdout non-JSON line (fatal):', line);
      log.error(error);
      child.kill('SIGKILL');
    }
  });

  stderrRl?.on('line', (line) => {
    stderrHandlers.forEach((h) => h(line));
  });

  const handleExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: string,
  ): void => {
    if (!exitInfo) {
      exitInfo = { code, signal, ...(error ? { error } : {}) };
    }

    log.warn('ACP agent exited', exitInfo);
    exitHandlers.forEach((h) => h(exitInfo as StdioExitInfo));
  };

  child.on('error', (error) => {
    log.error('ACP agent process error', error);
    handleExit(null, null, error instanceof Error ? error.message : String(error));
  });

  child.on('exit', (code, signal) => {
    handleExit(code, signal);
  });

  function write(message: JsonRpcMessage): void {
    if (exitInfo) {
      const errorSuffix = exitInfo.error ? `, error=${exitInfo.error}` : '';
      throw new Error(
        `ACP process is not running (code=${String(exitInfo.code)}, signal=${String(exitInfo.signal)}${errorSuffix})`,
      );
    }

    const payload = JSON.stringify(message);
    if (payload.includes('\n')) {
      // JSON itself must be newline-delimited; embedded newlines here are a bug.
      throw new Error('ACP message serialization produced newline');
    }
    child.stdin.write(payload + '\n');
  }

  return {
    write,
    onMessage: (cb) => {
      messageHandlers.push(cb);
    },
    onStderr: (cb) => {
      stderrHandlers.push(cb);
    },
    onExit: (cb) => {
      exitHandlers.push(cb);
      if (exitInfo) cb(exitInfo);
    },
    kill: () => {
      child.kill('SIGTERM');
    },
  };
}

function resolveSpawnPlan(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; fallbackFrom?: string } {
  if (hasPathSeparator(command) || isCommandOnPath(command, env)) {
    return { command, args };
  }

  const fallback = ACP_AGENT_COMMAND_FALLBACKS[command];
  if (!fallback) return { command, args };

  return {
    command: fallback.command,
    args: [...fallback.args, ...args],
    fallbackFrom: command,
  };
}

function isCommandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const rawPath = env.PATH ?? process.env.PATH ?? '';
  if (!rawPath) return false;

  const candidates = rawPath
    .split(path.delimiter)
    .map((entry) => entry || '.')
    .filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .filter(Boolean)
    : [''];

  for (const dir of candidates) {
    for (const extension of extensions) {
      const fileName = process.platform === 'win32' && hasKnownExtension(command)
        ? command
        : `${command}${extension}`;
      const candidate = path.join(dir, fileName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // keep probing PATH entries
      }
    }
  }

  return false;
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

function hasKnownExtension(command: string): boolean {
  const ext = path.extname(command);
  return ext.length > 0;
}
