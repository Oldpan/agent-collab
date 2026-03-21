export type JsonRpcVersion = '2.0';
export type JsonRpcId = number | string;
export type JsonRpcError = {
    code: number;
    message: string;
    data?: unknown;
};
export type JsonRpcRequest = {
    jsonrpc: JsonRpcVersion;
    id: JsonRpcId;
    method: string;
    params?: unknown;
};
export type JsonRpcNotification = {
    jsonrpc: JsonRpcVersion;
    method: string;
    params?: unknown;
};
export type JsonRpcResponse = {
    jsonrpc: JsonRpcVersion;
    id: JsonRpcId;
    result: unknown;
} | {
    jsonrpc: JsonRpcVersion;
    id: JsonRpcId;
    error: JsonRpcError;
};
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
export declare function isRequest(message: any): message is JsonRpcRequest;
export declare function isNotification(message: any): message is JsonRpcNotification;
export declare function isResponse(message: any): message is JsonRpcResponse;
