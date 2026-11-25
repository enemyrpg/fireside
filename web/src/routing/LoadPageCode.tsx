import { useEffect } from 'react';

/**
 * Starts loading a lazy page's code when its route opens, so a page behind
 * `PageGate` gets its code and its gate's data at the same time, not one
 * after the other. A failed load is shown when the page renders.
 */
export function LoadPageCode({ load }: { load: () => Promise<unknown> }) {
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);
  return null;
}
