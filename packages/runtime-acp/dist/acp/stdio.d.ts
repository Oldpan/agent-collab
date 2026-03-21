import type { JsonRpcMessage } from './jsonrpc.js';
export type StdioProcess = {
    write: (message: JsonRpcMessage) => void;
    onMessage: (cb: (message: JsonRpcMessage) => void) => void;
    onStderr: (cb: (line: string) => void) => void;
    onExit?: (cb: (info: {
        code: number | null;
        signal: NodeJS.Signals | null;
    }) => void) => void;
    kill: () => void;
};
export declare function spawnAcpAgent(command: string, args: string[], env?: NodeJS.ProcessEnv): StdioProcess;
