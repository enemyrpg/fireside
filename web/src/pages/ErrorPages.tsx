import { Link, useRouteError } from 'react-router';
import { useAuthMe } from '@/api/auth';
import { isForbidden, isNotFound, PageNotFoundError } from '@/api/errors';
import { Button } from '@/components/ui/button';
import { FullPageMessage } from '@/components/shell/FullPageMessage';

// Full-page messages. Never show raw errors.

const backLink = (
  <Button asChild variant="outline">
    <Link to="/">Go to Home</Link>
  </Button>
);

/**
 * `403 FORBIDDEN`: the dashboard was opened from another machine or through a
 * proxy, or a member reached something only an admin may use (the dashboard
 * hides those, so this is rare).
 */
export function ForbiddenPage() {
  const me = useAuthMe().data;
  if (me?.mode === 'login' && me.user !== null && me.user.role !== 'admin') {
    return (
      <FullPageMessage title="Admins only" action={backLink}>
        Only an admin can see this.
      </FullPageMessage>
    );
  }
  return (
    <FullPageMessage title="Only on this PC">
      The dashboard only works on this PC (localhost) for now.
    </FullPageMessage>
  );
}

/** Unknown page, or a session or account that doesn't exist. */
export function NotFoundPage({ message = "This page doesn't exist." }: { message?: string }) {
  return (
    <FullPageMessage title="Not found" action={backLink}>
      {message}
    </FullPageMessage>
  );
}

/** Router error element: anything a page throws while rendering. */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isForbidden(error)) return <ForbiddenPage />;
  if (error instanceof PageNotFoundError) return <NotFoundPage message={error.message} />;
  if (isNotFound(error)) return <NotFoundPage />;
  if (import.meta.env.DEV) console.error(error);
  return (
    <FullPageMessage
      title="Something went wrong"
      action={
        <Button
          variant="outline"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </Button>
      }
    >
      This page couldn&apos;t be shown.
    </FullPageMessage>
  );
}
