import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { closeOnSignals } from './shutdown.js';

/** Fake app whose `close` resolves or rejects when the test says so. */
function fakeApp() {
  let finish: (error?: Error) => void = () => undefined;
  const close = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        finish = (error) => {
          if (error) reject(error);
          else resolve();
        };
      }),
  );
  const log = { info: vi.fn(), error: vi.fn() };
  return {
    app: { close, log },
    finish: (error?: Error) => {
      finish(error);
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('closeOnSignals', () => {
  it('closes once and exits 0 when signals arrive twice during shutdown', async () => {
    const { app, finish } = fakeApp();
    const exit = vi.fn();
    const target = new EventEmitter();
    closeOnSignals(app, exit, target);

    target.emit('SIGINT', 'SIGINT');
    target.emit('SIGTERM', 'SIGTERM');
    await flush();
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    finish();
    await flush();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when closing fails', async () => {
    const { app, finish } = fakeApp();
    const exit = vi.fn();
    const target = new EventEmitter();
    closeOnSignals(app, exit, target);

    target.emit('SIGTERM', 'SIGTERM');
    finish(new Error('close failed'));
    await flush();
    expect(exit).toHaveBeenCalledWith(1);
    expect(app.log.error).toHaveBeenCalled();
  });
});
