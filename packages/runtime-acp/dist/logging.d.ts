export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export declare const log: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};
