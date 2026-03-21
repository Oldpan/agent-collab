export type ProcessLock = {
    path: string;
    release: () => void;
};
export declare function acquireProcessLock(lockPath: string): ProcessLock;
