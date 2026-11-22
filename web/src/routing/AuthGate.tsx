import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import { AUTH_ME_KEY, useAuthMe } from '@/api/auth';
import { useServerStatus } from '@/api/server-status';
import { AboutPage } from '@/pages/AboutPage';
import { InvitePage } from '@/pages/InvitePage';
import { LoginPage } from '@/pages/LoginPage';
import { ABOUT_PATH, INVITE_PATH, RESET_PASSWORD_PATH } from '@/pages/settings/paths';

const withoutTrailingSlash = (pathname: string) => pathname.replace(/\/+$/, '');

/** The invite and reset pages work without a login, so they come before the check. */
function isLinkPage(pathname: string): boolean {
  const path = withoutTrailingSlash(pathname);
  return path === INVITE_PATH || path === RESET_PASSWORD_PATH;
}

/**
 * Shows the invite or reset page for a link, and `/about`, whoever is logged in. Shows the login
 * page in login mode when nobody is logged in, the app otherwise. A `401` from any request (expired
 * session, logged out elsewhere) checks `auth/me` again, which brings the login page back. If
 * `auth/me` fails (server down, not on localhost), the app shows its usual banner or 403 page.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  if (isLinkPage(window.location.pathname)) return <InvitePage />;
  // The instance text is public, logged in or not, in both modes.
  if (withoutTrailingSlash(window.location.pathname) === ABOUT_PATH) return <AboutPage />;
  return <SessionGate>{children}</SessionGate>;
}

function SessionGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const me = useAuthMe();
  const { unauthorized } = useServerStatus();
  const seen = useRef(unauthorized);

  useEffect(() => {
    if (unauthorized === seen.current) return;
    seen.current = unauthorized;
    void queryClient.invalidateQueries({ queryKey: AUTH_ME_KEY });
  }, [unauthorized, queryClient]);

  if (me.isPending) return null;
  if (me.data?.mode === 'login' && me.data.user === null) return <LoginPage />;
  return children;
}
