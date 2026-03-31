import path from 'node:path';

export type WorkspaceLockLease = {
  key: string;
  release: () => void;
};

type WorkspaceLockState = {
  locked: boolean;
  waiters: Array<() => void>;
};

export class WorkspaceLockManager {
  private readonly locks = new Map<string, WorkspaceLockState>();

  normalizeKey(workspaceRoot: string): string {
    return path.resolve(workspaceRoot);
  }

  async acquire(
    workspaceRoot: string,
    hooks?: {
      onWaitStart?: () => void;
      onAcquired?: (params: { waited: boolean }) => void;
    },
  ): Promise<WorkspaceLockLease> {
    const key = this.normalizeKey(workspaceRoot);
    const state = this.getState(key);

    let waited = false;
    if (state.locked || state.waiters.length > 0) {
      waited = true;
      hooks?.onWaitStart?.();
      await new Promise<void>((resolve) => {
        state.waiters.push(resolve);
      });
    }

    state.locked = true;
    hooks?.onAcquired?.({ waited });

    let released = false;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        this.release(key);
      },
    };
  }

  async runExclusive<T>(
    workspaceRoot: string,
    action: () => Promise<T> | T,
    hooks?: {
      onWaitStart?: () => void;
      onAcquired?: (params: { waited: boolean }) => void;
    },
  ): Promise<T> {
    const lease = await this.acquire(workspaceRoot, hooks);
    try {
      return await action();
    } finally {
      lease.release();
    }
  }

  private getState(key: string): WorkspaceLockState {
    let state = this.locks.get(key);
    if (!state) {
      state = { locked: false, waiters: [] };
      this.locks.set(key, state);
    }
    return state;
  }

  private release(key: string): void {
    const state = this.locks.get(key);
    if (!state) return;

    const next = state.waiters.shift();
    if (next) {
      queueMicrotask(next);
      return;
    }

    state.locked = false;
    this.locks.delete(key);
  }
}
