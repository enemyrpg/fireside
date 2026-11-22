import { useAbout } from '@/api/about';
import { useAuthMe } from '@/api/auth';
import { AuthFrame } from '@/components/AuthFrame';
import { InstanceText } from '@/components/InstanceText';
import { CardSkeleton, ErrorState } from '@/components/states';

// `/about`: the instance text, readable without logging in, in the same frame
// as the login page but wider for reading. It shows only the text, never user
// or account data. Opened by the auth gate before the session check, so it has
// no sidebar even when logged in.

export function AboutPage() {
  const about = useAbout();
  const me = useAuthMe();
  const loggedOut = me.data?.mode === 'login' && me.data.user === null;

  return (
    <AuthFrame title="About this instance" wide>
      {about.isError ? (
        <ErrorState
          onRetry={() => {
            void about.refetch();
          }}
        />
      ) : about.data ? (
        <InstanceText text={about.data.text} />
      ) : (
        <CardSkeleton lines={6} />
      )}
      {/* A full page load: the auth gate reads the path once. */}
      <a href="/" className="font-medium">
        {loggedOut ? 'Log in' : 'Back to the dashboard'} <span aria-hidden="true">→</span>
      </a>
    </AuthFrame>
  );
}
