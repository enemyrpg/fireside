import { useSyncExternalStore } from 'react';
import { isForbidden, isServerDown, isUnauthorized } from './errors';

// App-wide state derived from API errors:
// - `down`: the server can't be reached. Shows a banner until a request succeeds.
// - `forbidden`: the server refused a dashboard request (403, not on localhost).
//   Replaces the whole app with an explanation.
// - `unauthorized`: counts `401`s (login mode, no or expired session). The
//   auth gate refetches `auth/me` when it changes and shows the login page.

export interface ServerStatus {
  down: boolean;
  forbidden: boolean;
  unauthorized: number;
}

let status: ServerStatus = { down: false, forbidden: false, unauthorized: 0 };
const listeners = new Set<() => void>();

function update(next: Partial<ServerStatus>): void {
  const merged = { ...status, ...next };
  if (
    merged.down === status.down &&
    merged.forbidden === status.forbidden &&
    merged.unauthorized === status.unauthorized
  ) {
    return;
  }
  status = merged;
  listeners.forEach((listener) => {
    listener();
  });
}

export function getServerStatus(): ServerStatus {
  return status;
}

/** Records what an error says about the server. */
export function reportError(error: unknown): void {
  if (isServerDown(error)) update({ down: true });
  else if (isForbidden(error)) update({ forbidden: true });
  else if (isUnauthorized(error)) update({ unauthorized: status.unauthorized + 1 });
}

/** A request got an answer, so the server is up. */
export function reportSuccess(): void {
  update({ down: false });
}

/** Back to the initial state. For tests. */
export function resetServerStatus(): void {
  update({ down: false, forbidden: false, unauthorized: 0 });
}

export function subscribeServerStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useServerStatus(): ServerStatus {
  return useSyncExternalStore(subscribeServerStatus, getServerStatus);
}
