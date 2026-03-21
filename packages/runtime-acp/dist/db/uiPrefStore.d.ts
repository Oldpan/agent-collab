import type { Db } from './db.js';
import type { UiMode } from '../gateway/types.js';
export declare function getUiMode(db: Db, bindingKey: string): UiMode | null;
export declare function setUiMode(db: Db, bindingKey: string, mode: UiMode): void;
