import { useEffect, useState } from 'react';
import { Link, useRouteError } from 'react-router';
import { useAuthMe } from '@/api/auth';
import { isForbidden, isNotFound, PageNotFoundError } from '@/api/errors';
import { Button } from '@/components/ui/button';
import { FullPageMessage } from '@/components/shell/FullPageMessage';
import { ChunkLoadError, isNewVersionServed } from '@/lib/lazy';
import { reloadPage } from '@/lib/reload';

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

const reloadButton = (
  <Button variant="outline" onClick={reloadPage}>
    Reload
  </Button>
);

/**
 * A page's code couldn't be loaded. Almost always a tab older than the last
 * release: the files it asks for were replaced. Never reloads by itself, so a
 * file that keeps failing can't loop; the user reloads when ready
 * (docs/design.md, "Loading").
 */
export function ChunkErrorPage() {
  // `undefined` while asking the server which build it serves.
  const [newVersion, setNewVersion] = useState<boolean>();
  useEffect(() => {
    let current = true;
    void isNewVersionServed().then((answer) => {
      if (current) setNewVersion(answer ?? false);
    });
    return () => {
      current = false;
    };
  }, []);

  if (newVersion === undefined) return null;
  if (newVersion) {
    return (
      <FullPageMessage title="A new version is available" action={reloadButton}>
        Reload to get it.
      </FullPageMessage>
    );
  }
  return (
    <FullPageMessage title="Couldn't load this page" action={reloadButton}>
      Check the connection to the server, then reload.
    </FullPageMessage>
  );
}

/** Router error element: anything a page throws while rendering. */
export function RouteErrorPage() {
  const error = useRouteError();
  if (error instanceof ChunkLoadError) return <ChunkErrorPage />;
  if (isForbidden(error)) return <ForbiddenPage />;
  if (error instanceof PageNotFoundError) return <NotFoundPage message={error.message} />;
  if (isNotFound(error)) return <NotFoundPage />;
  if (import.meta.env.DEV) console.error(error);
  return (
    <FullPageMessage title="Something went wrong" action={reloadButton}>
      This page couldn&apos;t be shown.
    </FullPageMessage>
  );
}
