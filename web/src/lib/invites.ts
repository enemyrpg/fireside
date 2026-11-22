import type { Invite } from '@fireside/shared';

// Words for invites and reset links.

/** Shown next to a new link when `PUBLIC_URL` isn't set. */
export const LOCAL_ONLY_WARNING =
  'This link only works on this computer. Set PUBLIC_URL to share it.';

/** What the link is for, as a title. */
export function inviteTitle(invite: Invite): string {
  if (invite.type === 'password_reset') return `Password reset for ${invite.targetUser.username}`;
  return invite.label ?? `Invite ${invite.id}`;
}

/** Where an invite or reset page goes once the user is logged in. An object, so tests can stub it. */
export const linkNavigation = {
  /** Starts the app fresh, without any state from before the login. */
  enterApp(): void {
    window.location.assign('/');
  },
};
