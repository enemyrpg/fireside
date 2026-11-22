import type { EventEmitter } from 'node:events';

export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

interface Closable {
  close(): Promise<unknown>;
  log: {
    info(object: object, message: string): void;
    error(object: object, message: string): void;
  };
}

/**
 * Closes `app` on SIGINT or SIGTERM, then exits. Only the first signal
 * counts: a second one (e.g. Ctrl-C, then the supervisor's SIGTERM) must not
 * close the app again or exit before the first close is done.
 */
export function closeOnSignals(
  app: Closable,
  exit: (code: number) => void = (code) => process.exit(code),
  target: Pick<EventEmitter, 'on'> = process,
): void {
  let closing = false;

  const shutdown = (signal: string) => {
    if (closing) {
      app.log.info({ signal }, 'Already shutting down');
      return;
    }
    closing = true;
    app.log.info({ signal }, 'Shutting down');
    app.close().then(
      () => {
        exit(0);
      },
      (error: unknown) => {
        app.log.error({ err: error }, 'Shutdown failed');
        exit(1);
      },
    );
  };

  for (const signal of SHUTDOWN_SIGNALS) target.on(signal, shutdown);
}
