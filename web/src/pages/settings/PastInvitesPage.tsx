import { useInvites } from '@/api/users';
import { Card, CardHeader } from '@/components/Card';
import { InviteRow } from '@/components/InviteRow';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { pastInvites } from '@/lib/history';
import { ActiveCount } from './ActiveCount';
import { BackLink } from './BackLink';
import { SETTINGS_USERS_PATH } from './paths';
import { SettingsLayout } from './SettingsLayout';

// Used, expired and revoked invites and password reset links, admin only:
// behind the link row under Users → Invites. Never the link itself.

export function PastInvitesPage() {
  const invites = useInvites();
  const past = invites.data ? pastInvites(invites.data.invites) : undefined;
  let body;
  if (invites.isError) {
    body = (
      <ErrorState
        onRetry={() => {
          void invites.refetch();
        }}
      />
    );
  } else if (past === undefined) {
    body = <CardSkeleton lines={3} />;
  } else if (past.length === 0) {
    body = <EmptyState>No used, expired or revoked invites.</EmptyState>;
  } else {
    body = (
      <ul
        aria-label="Used, expired and revoked invites"
        className="m-0 flex list-none flex-col gap-2.5 p-0"
      >
        {past.map((invite) => (
          <InviteRow key={invite.id} invite={invite} onRevoke={() => undefined} />
        ))}
      </ul>
    );
  }
  return (
    <SettingsLayout section="users">
      <BackLink to={SETTINGS_USERS_PATH} label="Users" />
      <Card>
        <CardHeader
          title={
            <ActiveCount title="Used, expired and revoked invites" count={past?.length} unit="" />
          }
          className="mb-1.5"
        />
        <p className="mt-0 mb-[18px] text-text-2">
          Links that can no longer be used, including password reset links. The link itself is never
          shown.
        </p>
        {body}
      </Card>
    </SettingsLayout>
  );
}
