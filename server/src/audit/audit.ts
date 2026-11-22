import type { Queryable } from '../db/index.js';
import { auditLog } from '../db/schema.js';

// `audit_log`. Never pass secrets: no
// passwords, tokens, keys or invite links, and no username someone typed at a
// failed login (it may be a password). Targets are IDs only (`user:<id>`,
// `invite:<id>`, `key:<id>`, `setting:<key>`), never names: a key's name is
// free text the owner typed.

export type AuditAction =
  | 'auth.login'
  | 'auth.logout_all'
  | 'auth.password_change'
  | 'auth.totp_enable'
  | 'auth.totp_disable'
  | 'auth.recovery_codes_regenerate'
  | 'auth.recovery_code_use'
  | 'user.create'
  | 'user.rename'
  | 'user.set_password'
  | 'user.clear_password'
  | 'user.disable'
  | 'user.enable'
  | 'user.promote'
  | 'user.demote'
  | 'user.keys_allow'
  | 'user.keys_deny'
  | 'user.delete'
  | 'user.delete_self'
  | 'user.totp_reset'
  | 'invite.create'
  | 'invite.use'
  | 'invite.revoke'
  | 'password_reset.create'
  | 'password_reset.use'
  | 'password_reset.revoke'
  | 'key.create'
  | 'key.revoke'
  | 'settings.update';

export interface AuditEntry {
  /** `null` for the CLI on the server itself. */
  actorUserId: number | null;
  action: AuditAction;
  target?: string | null;
  now?: Date;
}

/** `user:<id>`, the target for user actions. */
export const userTarget = (userId: number) => `user:${String(userId)}`;

/** `invite:<id>`, the target for invite and reset link actions. */
export const inviteTarget = (inviteId: string) => `invite:${inviteId}`;

/** `key:<id>`, the target for API key actions. The key's owner is in `api_keys`. */
export const keyTarget = (keyId: number) => `key:${String(keyId)}`;

export function audit(db: Queryable, entry: AuditEntry): void {
  db.insert(auditLog)
    .values({
      at: (entry.now ?? new Date()).toISOString(),
      actorUserId: entry.actorUserId,
      action: entry.action,
      target: entry.target ?? null,
    })
    .run();
}
