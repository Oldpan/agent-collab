import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestConfig } from './helpers.js';

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  sent: string[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

vi.mock('ws', () => ({
  default: MockWebSocket,
}));

describe('CoreConnection', () => {
  afterEach(() => {
    MockWebSocket.instances = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('core 断开后应自动按 backoff 重连', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const { CoreConnection } = await import('../connection.js');

    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    const connection = new CoreConnection(
      createTestConfig(),
      () => {},
      { onConnected, onDisconnected },
    );

    const connectPromise = connection.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    const first = MockWebSocket.instances[0]!;
    first.readyState = MockWebSocket.OPEN;
    first.emit('open');
    await connectPromise;

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(first.sent.some((payload) => payload.includes('"type":"node.register"'))).toBe(true);

    first.emit('close');
    expect(onDisconnected).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9);
    expect(MockWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});
