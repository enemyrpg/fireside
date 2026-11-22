import type { ApiKey, CreateKeyResponse } from '@fireside/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AUTH_ME_KEY, useAuthMe } from '@/api/auth';
import { useKeys, useRevokeKey } from '@/api/hooks';
import { ApiKeyRow } from '@/components/ApiKeyRow';
import { Card, CardHeader } from '@/components/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CreateKeyForm } from '@/components/CreateKeyForm';
import { NewKeyReveal } from '@/components/NewKeyReveal';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { HistoryLinkRow } from '@/components/HistoryLinkRow';
import { activeKeys } from '@/lib/history';
import { ActiveCount } from './ActiveCount';
import { SETTINGS_KEYS_REVOKED_PATH } from './paths';
import { SettingsLayout } from './SettingsLayout';

/** Shown instead of "Create API key" without `can_create_api_keys`. */
export const NO_KEY_PERMISSION =
  'You can’t create API keys on this server. Ask the server’s admin for a key.';

function KeyList({ showAdmin, onRevoke }: { showAdmin: boolean; onRevoke: (key: ApiKey) => void }) {
  const keys = useKeys();
  const active = activeKeys(keys.data?.keys ?? []);
  if (keys.isError) {
    return (
      <ErrorState
        onRetry={() => {
          void keys.refetch();
        }}
      />
    );
  }
  if (!keys.data) return <CardSkeleton lines={3} />;
  const revoked = keys.data.keys.length - active.length;
  return (
    <>
      {active.length === 0 ? (
        <EmptyState>
          {revoked > 0
            ? 'No active API keys. Create one below and paste it into the plugin.'
            : 'No API keys yet. Create one below and paste it into the plugin.'}
        </EmptyState>
      ) : (
        <ul aria-label="API keys" className="m-0 flex list-none flex-col gap-2.5 p-0">
          {active.map((key) => (
            <ApiKeyRow
              key={key.id}
              apiKey={key}
              showAdmin={showAdmin}
              onRevoke={() => {
                onRevoke(key);
              }}
            />
          ))}
        </ul>
      )}
      <HistoryLinkRow
        to={SETTINGS_KEYS_REVOKED_PATH}
        label="Revoked keys"
        count={revoked}
        className="mt-0"
      />
    </>
  );
}

/**
 * Settings → API keys: list, create (shown once), revoke. Without
 * `can_create_api_keys` (login mode) the create form is replaced by an
 * explanation; the list and revoking stay.
 */
export function KeysTab() {
  const me = useAuthMe().data;
  const queryClient = useQueryClient();
  // `auth/me` is cached for the session; the admin may have changed the
  // permission since, so read it again when the tab opens.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: AUTH_ME_KEY });
  }, [queryClient]);
  const loginMode = me?.mode === 'login';
  const canCreate = me?.user?.canCreateApiKeys ?? true;
  const [created, setCreated] = useState<CreateKeyResponse>();
  // The key stays set after closing, so the title doesn't go blank while the dialog animates out.
  const [revoking, setRevoking] = useState<ApiKey>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const revoke = useRevokeKey();
  const keys = useKeys().data?.keys;
  const activeCount = keys === undefined ? undefined : activeKeys(keys).length;

  return (
    <SettingsLayout section="keys">
      <Card>
        <CardHeader
          title={<ActiveCount title="API keys" count={activeCount} />}
          className="mb-1.5"
        />
        <p className="mt-0 mb-[18px] text-text-2">
          {canCreate
            ? 'The RuneLite plugin uses a key to send data to this server. Create one per RuneLite install and paste it into the plugin settings. One key covers every account that logs in on that client.'
            : 'The RuneLite plugin uses a key to send data to this server. Paste it into the plugin settings. One key covers every account that logs in on that client.'}
        </p>
        {!canCreate && <p className="mt-0 mb-[18px] font-medium text-text">{NO_KEY_PERMISSION}</p>}
        <div className="flex flex-col gap-2.5">
          {created && <NewKeyReveal created={created} />}
          <KeyList
            showAdmin={loginMode}
            onRevoke={(key) => {
              revoke.reset();
              setRevoking(key);
              setConfirmOpen(true);
            }}
          />
        </div>
      </Card>
      {canCreate && (
        <Card>
          <CardHeader title="Create API key" />
          <CreateKeyForm onCreated={setCreated} />
        </Card>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Revoke “${revoking?.name ?? ''}”?`}
        description="RuneLite clients using this key stop sending data right away. This can't be undone."
        confirmLabel="Revoke key"
        pendingLabel="Revoking…"
        destructive
        pending={revoke.isPending}
        error={revoke.isError ? "Couldn't revoke the key. Try again." : undefined}
        onConfirm={() => {
          if (!revoking) return;
          revoke.mutate(revoking.id, {
            onSuccess: () => {
              setConfirmOpen(false);
              // The revealed key is no use once revoked.
              if (created?.apiKey.id === revoking.id) setCreated(undefined);
            },
          });
        }}
      />
    </SettingsLayout>
  );
}
