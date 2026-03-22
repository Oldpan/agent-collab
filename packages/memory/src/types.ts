export interface MemoryBackend {
  /** Load memory text. Returns '' on missing file or error. */
  load(): Promise<string>;
}
