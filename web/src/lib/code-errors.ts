import { loginTimedOut } from '@/api/auth';
import { ApiError, fieldErrors } from '@/api/errors';

// When a two-factor code field is cleared: only when the server refused the
// code itself. After a 429, a 503 or a network error the digits stay, so the
// user can press the button again; the code field's own guard keeps it from
// sending them by itself.

/** The login step's code was wrong (`401`), not timed out and not a wait or network error. */
export function loginCodeRejected(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && !loginTimedOut(error);
}

/** A form's `code` field was refused (`400` with a message on `body.code`). */
export function codeFieldRejected(error: unknown): boolean {
  return fieldErrors(error).code !== undefined;
}
