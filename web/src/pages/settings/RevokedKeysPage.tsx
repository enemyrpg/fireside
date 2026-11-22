import { useAuthMe } from '@/api/auth';
import { useKeys } from '@/api/hooks';
import { useAdminKeys } from '@/api/users';
import { AdminKeyRow } from '@/components/AdminKeyRow';
import { ApiKeyRow } from '@/components/ApiKeyRow';
import { Card, CardHeader } from '@/components/Card';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { revokedKeys } from '@/lib/history';
import { ActiveCount } from './ActiveCount';
import { BackLink } from './BackLink';
import { SETTINGS_KEYS_PATH, SETTINGS_USERS_PATH } from './paths';
import { SettingsLayout } from './SettingsLayout';

// Revoked API keys: not in the main lists, but here, behind the link row
// "Revoked keys · N". Your own keys under API keys, and every user's keys under
// Users (admin only). Read only: a revoked key can't come back.

const TEXT =
  'These keys no longer work and can’t be turned back on. They are kept so you can see what was revoked, when, and by whom.';

function Retry({ onRetry }: { onRetry: () => void }) {
  return <ErrorState onRetry={onRetry} />;
}

/** Settings → API keys → Revoked keys: your own. */
export function RevokedKeysPage() {
  const keys = useKeys();
  const loginMode = useAuthMe().data?.mode === 'login';
  const revoked = keys.data ? revokedKeys(keys.data.keys) : undefined;
  let body;
  if (keys.isError) {
    body = (
      <Retry
        onRetry={() => {
          void keys.refetch();
        }}
      />
    );
  } else if (revoked === undefined) {
    body = <CardSkeleton lines={3} />;
  } else if (revoked.length === 0) {
    body = <EmptyState>No revoked keys.</EmptyState>;
  } else {
    body = (
      <ul aria-label="Revoked keys" className="m-0 flex list-none flex-col gap-2.5 p-0">
        {revoked.map((key) => (
          <ApiKeyRow key={key.id} apiKey={key} showAdmin={loginMode} onRevoke={() => undefined} />
        ))}
      </ul>
    );
  }
  return (
    <SettingsLayout section="keys">
      <BackLink to={SETTINGS_KEYS_PATH} label="API keys" />
      <Card>
        <CardHeader
          title={<ActiveCount title="Revoked keys" count={revoked?.length} unit="" />}
          className="mb-1.5"
        />
        <p className="mt-0 mb-[18px] text-text-2">{TEXT}</p>
        {body}
      </Card>
    </SettingsLayout>
  );
}

/** Settings → Users → API keys → Revoked keys: every user's (admin only). */
export function AdminRevokedKeysPage() {
  const keys = useAdminKeys();
  const revoked = keys.data ? revokedKeys(keys.data.keys) : undefined;
  let body;
  if (keys.isError) {
    body = (
      <Retry
        onRetry={() => {
          void keys.refetch();
        }}
      />
    );
  } else if (revoked === undefined) {
    body = <CardSkeleton lines={3} />;
  } else if (revoked.length === 0) {
    body = <EmptyState>No revoked keys.</EmptyState>;
  } else {
    body = (
      <ul aria-label="Revoked keys" className="m-0 flex list-none flex-col gap-2.5 p-0">
        {revoked.map((key) => (
          <AdminKeyRow key={key.id} apiKey={key} />
        ))}
      </ul>
    );
  }
  return (
    <SettingsLayout section="users">
      <BackLink to={SETTINGS_USERS_PATH} label="Users" />
      <Card>
        <CardHeader
          title={<ActiveCount title="Revoked keys" count={revoked?.length} unit="" />}
          className="mb-1.5"
        />
        <p className="mt-0 mb-[18px] text-text-2">{TEXT} Every user’s keys are listed here.</p>
        {body}
      </Card>
    </SettingsLayout>
  );
}
