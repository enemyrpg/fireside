import type {
  AuthMeResponse,
  ChangePasswordRequest,
  LoginResponse,
  RecoveryCodesResponse,
  TotpConfirmRequest,
  TotpSetupResponse,
  TwoFactorStatusResponse,
} from '@fireside/shared';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from './client';
import { ApiError, fieldErrors, isAskedToWait, NetworkError } from './errors';

// Login. The session is an HttpOnly cookie the browser handles; the dashboard
// only ever sees `auth/me`.

export const AUTH_ME_KEY = ['auth', 'me'] as const;

/** `GET /auth/me`: the mode and who is logged in. Refetched after a `401`. */
export function useAuthMe() {
  return useQuery({
    queryKey: AUTH_ME_KEY,
    queryFn: ({ signal }) => apiGet<AuthMeResponse>('auth-me-response', '/auth/me', { signal }),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Whether the user may use the admin-only parts: Settings → Server with
 * backups, external sources, icons and rebuild. Always in local mode (the one
 * local user is the admin); in login mode for the `admin` role. `false` while
 * `auth/me` is unknown, so nothing admin-only flashes.
 */
export function useIsAdmin(): boolean {
  const me = useAuthMe().data;
  if (!me) return false;
  return me.mode === 'local' || me.user?.role === 'admin';
}

function fetchMe(queryClient: QueryClient) {
  return queryClient.query({
    queryKey: AUTH_ME_KEY,
    queryFn: () => apiGet<AuthMeResponse>('auth-me-response', '/auth/me'),
    staleTime: 0,
  });
}

/** Another user's data must never stay on screen: drop everything but `auth/me`. */
function dropUserData(queryClient: QueryClient) {
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== AUTH_ME_KEY[0],
  });
}

/** Thrown when the login worked but the browser didn't keep the cookie (Safari on http://localhost). */
export class CookieRefusedError extends Error {
  override name = 'CookieRefusedError';
}

/** After a login: drops the old data and checks with `auth/me` that the cookie was kept. */
async function finishLogin(queryClient: QueryClient): Promise<AuthMeResponse> {
  dropUserData(queryClient);
  const me = await fetchMe(queryClient);
  if (me.mode === 'login' && me.user === null) throw new CookieRefusedError();
  return me;
}

/** What `useLogin` resolves to: logged in, or a 2FA code is needed. */
export type LoginStep = { step: 'done'; me: AuthMeResponse } | { step: 'code' };

/** `POST /auth/login`. With 2FA on, the next step is `useLoginCode`. */
export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      username,
      password,
    }: {
      username: string;
      password: string;
    }): Promise<LoginStep> => {
      const response = await apiSend<LoginResponse>('POST', '/auth/login', {
        body: { username, password },
        schema: 'login-response',
      });
      if ('twoFactorRequired' in response) return { step: 'code' };
      return { step: 'done', me: await finishLogin(queryClient) };
    },
  });
}

/** `POST /auth/login/totp`: the 2FA or recovery code after the password. */
export function useLoginCode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      await apiSend<LoginResponse>('POST', '/auth/login/totp', {
        body: { code },
        schema: 'login-response',
      });
      return finishLogin(queryClient);
    },
  });
}

/** The server's text when the 2FA step expired: the password must be entered again. */
export const LOGIN_TIMED_OUT = 'Your login timed out. Enter your password again.';

/** True when a code was refused because the 2FA step is gone (back to the password). */
export function loginTimedOut(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.message === LOGIN_TIMED_OUT;
}

/** What went wrong with a login code, in words for the form. */
export function codeErrorMessage(error: unknown): string {
  if (error instanceof CookieRefusedError) return loginErrorMessage(error);
  if (error instanceof ApiError) {
    if (loginTimedOut(error)) return LOGIN_TIMED_OUT;
    if (error.status === 401)
      return 'Wrong code. Check the time on your phone, or use a recovery code.';
    if (isAskedToWait(error)) return error.message;
  }
  if (error instanceof NetworkError) return "Couldn't reach the server. Try again.";
  return "Couldn't log in. Try again.";
}

export const TWO_FACTOR_KEY = ['auth', 'totp'] as const;

/** `GET /auth/totp`: whether 2FA is on, and recovery codes left. */
export function useTwoFactorStatus(enabled = true) {
  return useQuery({
    queryKey: TWO_FACTOR_KEY,
    queryFn: ({ signal }) =>
      apiGet<TwoFactorStatusResponse>('two-factor-status-response', '/auth/totp', { signal }),
    enabled,
  });
}

async function refreshTwoFactor(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY }),
    queryClient.invalidateQueries({ queryKey: AUTH_ME_KEY }),
  ]);
}

/** `POST /auth/totp/setup`: a new secret, pending for 10 minutes. */
export function useTotpSetup() {
  return useMutation({
    mutationFn: (password: string) =>
      apiSend<TotpSetupResponse>('POST', '/auth/totp/setup', {
        body: { password },
        schema: 'totp-setup-response',
      }),
  });
}

/** `POST /auth/totp/enable`: the first code turns 2FA on; returns the recovery codes. */
export function useTotpEnable() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      apiSend<RecoveryCodesResponse>('POST', '/auth/totp/enable', {
        body: { code },
        schema: 'recovery-codes-response',
      }),
    onSuccess: () => refreshTwoFactor(queryClient),
  });
}

/** `POST /auth/totp/disable`: password and a current code. */
export function useTotpDisable() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TotpConfirmRequest) => apiSend('POST', '/auth/totp/disable', { body }),
    onSuccess: () => refreshTwoFactor(queryClient),
  });
}

/** `POST /auth/totp/recovery-codes`: replaces every recovery code. */
export function useNewRecoveryCodes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TotpConfirmRequest) =>
      apiSend<RecoveryCodesResponse>('POST', '/auth/totp/recovery-codes', {
        body,
        schema: 'recovery-codes-response',
      }),
    onSuccess: () => refreshTwoFactor(queryClient),
  });
}

/** `POST /auth/logout` (this browser) or `/auth/logout-all` (every session). */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ everywhere = false }: { everywhere?: boolean }) => {
      await apiSend('POST', everywhere ? '/auth/logout-all' : '/auth/logout');
    },
    onSuccess: async () => {
      dropUserData(queryClient);
      await fetchMe(queryClient);
    },
  });
}

/**
 * `POST /auth/password`. In local mode (no `currentPassword`) it sets the
 * first password, which turns login on and logs this browser in.
 */
export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ChangePasswordRequest) => apiSend('POST', '/auth/password', { body }),
    onSuccess: () => fetchMe(queryClient),
  });
}

/** What went wrong at login, in words for the login form. */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof CookieRefusedError) {
    return "Your browser didn't keep the login cookie. Safari doesn't allow secure cookies on http://localhost. Use Chrome or Firefox, or HTTPS.";
  }
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Wrong username or password.';
    // The server says how long to wait.
    if (isAskedToWait(error)) return error.message;
    if (error.code === 'VALIDATION_ERROR') {
      const errors = fieldErrors(error);
      return errors.password ?? errors.username ?? 'Check the username and password.';
    }
  }
  if (error instanceof NetworkError) return "Couldn't reach the server. Try again.";
  return "Couldn't log in. Try again.";
}
