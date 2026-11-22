// Username rule, shared by the CLI and invitations.

export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 32;

const ALLOWED = /^[a-z0-9_.-]+$/;

/** Thrown for a username that can't be used. The message is safe to show. */
export class InvalidUsernameError extends Error {
  override name = 'InvalidUsernameError';
}

/** Trims and lower-cases a username for lookup. Never throws. */
export function usernameKey(username: string): string {
  return username.trim().toLowerCase();
}

/** Checks a new username. Throws `InvalidUsernameError`. Returns it trimmed and lower case. */
export function normalizeUsername(username: string): string {
  const name = usernameKey(username);
  if (name.length < MIN_USERNAME_LENGTH || name.length > MAX_USERNAME_LENGTH) {
    throw new InvalidUsernameError(
      `Username must be ${String(MIN_USERNAME_LENGTH)}–${String(MAX_USERNAME_LENGTH)} characters`,
    );
  }
  if (!ALLOWED.test(name)) {
    throw new InvalidUsernameError(
      'Username may only use letters a–z, digits, dot, dash and underscore',
    );
  }
  return name;
}
