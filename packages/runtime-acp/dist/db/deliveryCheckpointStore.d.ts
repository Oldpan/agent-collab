import type { Db } from './db.js';
export type DeliveryCheckpointRow = {
    bindingKey: string;
    runId: string;
    lastSeq: number;
    messageId: string | null;
    text: string;
    createdAt: number;
    updatedAt: number;
};
export declare function getDeliveryCheckpoint(db: Db, params: {
    bindingKey: string;
    runId: string;
}): DeliveryCheckpointRow | null;
export declare function upsertDeliveryCheckpoint(db: Db, params: {
    bindingKey: string;
    runId: string;
    lastSeq: number;
    messageId: string | null;
    text: string;
}): void;
