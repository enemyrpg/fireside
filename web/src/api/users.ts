import type {
  AcceptInviteResponse,
  AdminKeysResponse,
  CreatedInviteResponse,
  CreateUserKeyResponse,
  CreateInviteRequest,
  InviteLookupResponse,
  InvitesResponse,
  ManagedUser,
  ServerSettings,
  UpdateServerSettingsRequest,
  UpdateUserRequest,
  UsersResponse,
} from '@fireside/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ABOUT_KEY } from './about';
import { AUTH_ME_KEY } from './auth';
import { apiGet, apiSend } from './client';
import { ADMIN_KEYS_KEY, KEYS_KEY, USERS_KEY } from './hooks';

export { ADMIN_KEYS_KEY, USERS_KEY };
import { ApiError, fieldErrors, isAskedToWait, NetworkError } from './errors';

// Users, invites and password reset links. The list routes are admin only; the
// invite and reset pages use the public `auth/*` routes, with the token from
// the link's fragment in the body.

export const INVITES_KEY = ['invites'] as const;
export const SERVER_SETTINGS_KEY = ['admin', 'settings'] as const;

/** After a key changes: every list it shows up in (the admin's own keys too). */
async function invalidateKeys(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ADMIN_KEYS_KEY }),
    queryClient.invalidateQueries({ queryKey: USERS_KEY }),
    queryClient.invalidateQueries({ queryKey: KEYS_KEY }),
  ]);
}

/** `GET /users`. Admin only: call it only when `useIsAdmin()`. */
export function useUsers(enabled = true) {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: ({ signal }) => apiGet<UsersResponse>('users-response', '/users', { signal }),
    enabled,
  });
}

/** `GET /invites`: invites and reset links, newest first. Admin only. */
export function useInvites() {
  return useQuery({
    queryKey: INVITES_KEY,
    queryFn: ({ signal }) => apiGet<InvitesResponse>('invites-response', '/invites', { signal }),
  });
}

/** `PATCH /users/:id`. Deactivating also revokes the user's reset link, so invites refresh too. */
export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateUserRequest & { id: number }) =>
      apiSend<ManagedUser>('PATCH', `/users/${String(id)}`, { body, schema: 'user-response' }),
    onSuccess: async (user, request) => {
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
      await queryClient.invalidateQueries({ queryKey: INVITES_KEY });
      if (request.revokeActiveKeys === true) await invalidateKeys(queryClient);
      // The admin may have changed their own name or role.
      if (user.isSelf) await queryClient.invalidateQueries({ queryKey: AUTH_ME_KEY });
    },
  });
}

/** `GET /admin/keys`: every user's keys, oldest first. Admin only. */
export function useAdminKeys() {
  return useQuery({
    queryKey: ADMIN_KEYS_KEY,
    queryFn: ({ signal }) =>
      apiGet<AdminKeysResponse>('admin-keys-response', '/admin/keys', { signal }),
  });
}

/** `POST /users/:id/keys`: the admin makes a key for a user. The only time the key is available. */
export function useCreateUserKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiSend<CreateUserKeyResponse>('POST', `/users/${String(id)}/keys`, {
        body: { name },
        schema: 'create-user-key-response',
      }),
    onSuccess: () => invalidateKeys(queryClient),
  });
}

/** `DELETE /admin/keys/:id`: revoke any user's key. Idempotent. */
export function useAdminRevokeKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/admin/keys/${String(id)}`),
    onSuccess: () => invalidateKeys(queryClient),
  });
}

/** `GET /admin/settings`. Admin only: call it only when `useIsAdmin()`. */
export function useServerSettings(enabled = true) {
  return useQuery({
    queryKey: SERVER_SETTINGS_KEY,
    queryFn: ({ signal }) =>
      apiGet<ServerSettings>('server-settings-response', '/admin/settings', { signal }),
    enabled,
  });
}

/** `PATCH /admin/settings`. */
export function useUpdateServerSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateServerSettingsRequest) =>
      apiSend<ServerSettings>('PATCH', '/admin/settings', {
        body,
        schema: 'server-settings-response',
      }),
    onSuccess: (settings) => {
      queryClient.setQueryData(SERVER_SETTINGS_KEY, settings);
      // `/about` shows the instance text.
      void queryClient.invalidateQueries({ queryKey: ABOUT_KEY });
    },
  });
}

/** `DELETE /users/:id`: the user and all their data. */
export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/users/${String(id)}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
      await queryClient.invalidateQueries({ queryKey: INVITES_KEY });
    },
  });
}

/** `POST /users/:id/totp-reset`: an admin turns off a user's 2FA. */
export function useResetTwoFactor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('POST', `/users/${String(id)}/totp-reset`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

/** `POST /users/:id/password-reset`. The response holds the link, the only time it is available. */
export function useCreatePasswordReset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiSend<CreatedInviteResponse>('POST', `/users/${String(id)}/password-reset`, {
        schema: 'created-invite-response',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INVITES_KEY }),
  });
}

/** `POST /invites`. The response holds the link, the only time it is available. */
export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInviteRequest) =>
      apiSend<CreatedInviteResponse>('POST', '/invites', {
        body,
        schema: 'created-invite-response',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INVITES_KEY }),
  });
}

/** `DELETE /invites/:id`. Idempotent. */
export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/invites/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INVITES_KEY }),
  });
}

/** `POST /auth/invite/lookup`: what the link is for. A mutation, so it runs once per page. */
export function useInviteLookup() {
  return useMutation({
    mutationFn: (token: string) =>
      apiSend<InviteLookupResponse>('POST', '/auth/invite/lookup', {
        body: { token },
        schema: 'invite-lookup-response',
      }),
  });
}

/** `POST /auth/invite/accept`: creates the user and logs this browser in. */
export function useAcceptInvite() {
  return useMutation({
    mutationFn: (body: { token: string; username: string; password: string }) =>
      apiSend<AcceptInviteResponse>('POST', '/auth/invite/accept', {
        body,
        schema: 'accept-invite-response',
      }),
  });
}

/** `POST /auth/password-reset`: sets the password, ends every session, logs this browser in. */
export function usePasswordReset() {
  return useMutation({
    mutationFn: (body: { token: string; password: string; code?: string }) =>
      apiSend('POST', '/auth/password-reset', { body }),
  });
}

/** `POST /auth/delete-account`: the user deletes themselves and all their data. */
export function useDeleteAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (password: string) =>
      apiSend('POST', '/auth/delete-account', { body: { password } }),
    onSuccess: async () => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== AUTH_ME_KEY[0] });
      await queryClient.invalidateQueries({ queryKey: AUTH_ME_KEY });
    },
  });
}

/** The server's message for a link that can't be used. */
export const INVALID_LINK_MESSAGE = 'This invite link is no longer valid';

/** Whether `error` is the one answer for a used, expired, revoked or unknown link. */
export function isInvalidLink(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * What went wrong, in words for a form: a field's message, the server's
 * message for a conflict or a wait, or a general one.
 */
export function formErrorMessage(error: unknown, fallback: string): string | undefined {
  if (!error) return undefined;
  if (error instanceof ApiError) {
    const fields = fieldErrors(error);
    const first = Object.values(fields)[0];
    if (first !== undefined) return first;
    if (error.status === 409 || isAskedToWait(error)) return error.message;
  }
  if (error instanceof NetworkError) return "Couldn't reach the server. Try again.";
  return fallback;
}
