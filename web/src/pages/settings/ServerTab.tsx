import {
  INSTANCE_TEXT_PLACEHOLDERS,
  MAX_INSTANCE_TEXT_LENGTH,
  normalizeInstanceTextLayout,
  type ExternalSourceStatus,
} from '@fireside/shared';
import { Fragment, useState, type ReactNode, type SyntheticEvent } from 'react';
import { isServerDown } from '@/api/errors';
import {
  useBackupStatus,
  useExternalSources,
  useHealth,
  useIconsStatus,
  useLatestRebuild,
  useRebuild,
} from '@/api/hooks';
import { formErrorMessage, useServerSettings, useUpdateServerSettings } from '@/api/users';
import { Card, CardHeader } from '@/components/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormField } from '@/components/FormField';
import { Switch } from '@/components/Switch';
import { CardSkeleton, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatBytes, formatInt, formatRunTime } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { isImportingIcons } from '@/lib/icons';
import { ABOUT_PATH } from './paths';
import { StackedColumns } from '@/components/StackedColumns';
import { SettingsLayout } from './SettingsLayout';

function InfoRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-b border-border py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1 text-text-3">{label}</div>
      {children}
    </div>
  );
}

function Versions() {
  const health = useHealth();
  if (health.isError) {
    return (
      <ErrorState
        onRetry={() => {
          void health.refetch();
        }}
      />
    );
  }
  if (!health.data) return <CardSkeleton lines={2} />;
  return (
    <>
      <InfoRow label="Server version">
        <span className="font-mono">{health.data.serverVersion}</span>
      </InfoRow>
      <InfoRow label="Contract version">
        <span className="font-mono">{health.data.contractVersion}</span>
      </InfoRow>
    </>
  );
}

/** "1,738 items", "1 skill". */
function counted(count: number, one: string, many: string): string {
  return `${formatInt(count)} ${count === 1 ? one : many}`;
}

/**
 * How many icons the plugin has uploaded, per kind, and a note while its first
 * import runs. "Now" is when the counts were fetched: the query is refetched every
 * few seconds meanwhile, so the note goes away by itself.
 */
function IconsStatus() {
  const icons = useIconsStatus();
  if (icons.isError) {
    return (
      <ErrorState
        onRetry={() => {
          void icons.refetch();
        }}
      />
    );
  }
  if (!icons.data) return <CardSkeleton lines={1} />;
  const { items, skills, bosses, lastStoredAt } = icons.data;
  return (
    <>
      <InfoRow label="Icons">
        <span className="text-right">
          {counted(items, 'item', 'items')} · {counted(skills, 'skill', 'skills')} ·{' '}
          {counted(bosses, 'boss', 'bosses')}
        </span>
      </InfoRow>
      {isImportingIcons(lastStoredAt, icons.dataUpdatedAt) && (
        <p role="status" className="mt-2 mb-0 text-sm text-text-2">
          Importing icons from RuneLite…
        </p>
      )}
    </>
  );
}

function BackupStatus() {
  const backups = useBackupStatus();
  const format = useFormat();
  if (backups.isError) {
    return (
      <ErrorState
        onRetry={() => {
          void backups.refetch();
        }}
      />
    );
  }
  if (!backups.data) return <CardSkeleton lines={3} />;
  const { enabled, latest, count, totalSizeBytes, nextRunAt, lastError } = backups.data;
  return (
    <>
      {lastError && (
        <p role="alert" className="mt-0 mb-2 text-sm text-down">
          The last backup failed ({format.dateTime(lastError.at)}): {lastError.message}
        </p>
      )}
      <InfoRow label="Last backup">
        <span className="text-right">
          {latest
            ? `${format.dateTime(latest.createdAt)} · ${formatBytes(latest.sizeBytes)}`
            : 'None yet'}
        </span>
      </InfoRow>
      <InfoRow label="Backups kept">
        <span className="text-right">
          {formatInt(count)} ({formatBytes(totalSizeBytes)})
        </span>
      </InfoRow>
      <InfoRow label="Next backup">
        <span className="text-right">
          {enabled && nextRunAt ? (
            format.dateTime(nextRunAt)
          ) : (
            <>
              Off (<code className="font-mono">BACKUP_ENABLED</code>)
            </>
          )}
        </span>
      </InfoRow>
    </>
  );
}

/** "On", or "Off" with the `.env` variable that is missing. */
function sourceState({ enabled, active, envName }: ExternalSourceStatus): ReactNode {
  if (active) return 'On';
  return (
    <>
      Off (<code className="font-mono">{enabled ? 'USER_AGENT_CONTACT' : envName}</code>)
    </>
  );
}

function ExternalSources() {
  const sources = useExternalSources();
  const format = useFormat();
  if (sources.isError) {
    return (
      <ErrorState
        onRetry={() => {
          void sources.refetch();
        }}
      />
    );
  }
  if (!sources.data) return <CardSkeleton lines={3} />;
  return (
    <>
      {sources.data.sources.map((source) => (
        <Fragment key={source.id}>
          {source.lastError && (
            <p role="alert" className="mt-0 mb-2 text-sm text-down">
              The last fetch from {source.name} failed ({format.dateTime(source.lastError.at)}):{' '}
              {source.lastError.message}
            </p>
          )}
          <InfoRow label={source.name}>
            <span className="text-right">{sourceState(source)}</span>
          </InfoRow>
          <InfoRow label="Last fetch">
            <span className="text-right">
              {source.lastFetchAt ? format.dateTime(source.lastFetchAt) : 'None yet'}
            </span>
          </InfoRow>
          {source.nextFetchAt && (
            <InfoRow label="Next fetch">
              <span className="text-right">{format.dateTime(source.nextFetchAt)}</span>
            </InfoRow>
          )}
        </Fragment>
      ))}
    </>
  );
}

/** Defaults for new invites: whether "Can create API keys" starts on. */
function InviteDefaults() {
  const settings = useServerSettings();
  const update = useUpdateServerSettings();
  if (settings.isError) {
    return (
      <ErrorState
        onRetry={() => {
          void settings.refetch();
        }}
      />
    );
  }
  if (!settings.data) return <CardSkeleton lines={1} />;
  const error = formErrorMessage(update.error, "Couldn't save the setting. Try again.");
  return (
    <div className="flex flex-col gap-2.5">
      <Switch
        label="Can create API keys"
        checked={settings.data.defaultInviteCanCreateApiKeys}
        disabled={update.isPending}
        onChange={(checked) => {
          update.mutate({ defaultInviteCanCreateApiKeys: checked });
        }}
      />
      {error !== undefined && (
        <p role="alert" className="m-0 text-sm text-down">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The instance text: who runs this server and what it stores, shown on `/about`,
 * linked from the login page. Plain text; a blank line starts a new paragraph.
 */
function InstanceTextSettings() {
  const settings = useServerSettings();
  const update = useUpdateServerSettings();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [confirmingReset, setConfirmingReset] = useState(false);
  if (settings.isError) {
    return (
      <ErrorState
        onRetry={() => {
          void settings.refetch();
        }}
      />
    );
  }
  if (!settings.data) return <CardSkeleton lines={4} />;
  const { instanceText, defaultInstanceText } = settings.data;
  const saved = instanceText ?? defaultInstanceText;
  const value = draft ?? saved;
  // Counted as the server stores it: trailing spaces and extra blank lines don't count.
  const count = Array.from(normalizeInstanceTextLayout(value)).length;
  const tooLong = count > MAX_INSTANCE_TEXT_LENGTH;
  const usingDefault = instanceText === null;
  const placeholdersLeft = INSTANCE_TEXT_PLACEHOLDERS.some((placeholder) =>
    value.includes(placeholder),
  );
  const error = formErrorMessage(update.error, "Couldn't save the text. Try again.");

  const save = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (update.isPending || tooLong) return;
    update.mutate(
      { instanceText: value },
      {
        onSuccess: () => {
          setDraft(undefined);
        },
      },
    );
  };

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-4">
      {usingDefault && (
        <p role="status" className="m-0 rounded-md border border-border bg-page px-3 py-2 text-sm">
          Fill in who runs this instance and how to reach you before inviting others.
        </p>
      )}
      <FormField
        label="Instance text"
        error={tooLong ? `Use at most ${formatInt(MAX_INSTANCE_TEXT_LENGTH)} characters` : error}
        help={
          <>
            Plain text, no formatting. Leave a blank line between paragraphs. {formatInt(count)} /{' '}
            {formatInt(MAX_INSTANCE_TEXT_LENGTH)} characters.
          </>
        }
      >
        {(control) => (
          <Textarea
            {...control}
            value={value}
            rows={16}
            className="bg-page"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        )}
      </FormField>
      {placeholdersLeft && (
        <p className="m-0 text-sm text-text-2">
          Replace {INSTANCE_TEXT_PLACEHOLDERS.join(' and ')} with your own name and contact.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={update.isPending || tooLong || draft === undefined || draft === saved}
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={update.isPending || (usingDefault && draft === undefined)}
          onClick={() => {
            setConfirmingReset(true);
          }}
        >
          Use the default
        </Button>
        {/* A full page load: the auth gate shows `/about` before the router. */}
        <a href={ABOUT_PATH} className="text-sm">
          View the about page
        </a>
      </div>
      <ConfirmDialog
        open={confirmingReset}
        onOpenChange={setConfirmingReset}
        title="Use the default text?"
        description="Your own text is replaced by the default, which has placeholders for who runs the instance and how to reach you."
        confirmLabel="Use the default"
        pendingLabel="Saving…"
        onConfirm={() => {
          setConfirmingReset(false);
          update.mutate(
            { instanceText: null },
            {
              onSuccess: () => {
                setDraft(undefined);
              },
            },
          );
        }}
      />
    </form>
  );
}

function RebuildResult() {
  const { status, result, error } = useLatestRebuild();
  if (status === 'error') {
    return (
      <p role="alert" className="m-0 text-sm text-down">
        {isServerDown(error)
          ? "Couldn't reach the server. Start it and try again."
          : 'The rebuild failed. Check the server log.'}
      </p>
    );
  }
  if (status !== 'success' || !result) return null;
  const events = result.processed === 1 ? 'event' : 'events';
  return (
    <div role="status" className="text-sm">
      <p className="m-0">
        Rebuilt {formatInt(result.processed)} {events} in {formatRunTime(result.durationMs)}.
      </p>
      {result.failed > 0 && (
        <p className="mt-1 mb-0 text-down">
          {formatInt(result.failed)} {result.failed === 1 ? 'event' : 'events'} failed. Their raw
          data is kept; fix the cause and run <code className="font-mono">pnpm cli reprocess</code>.
        </p>
      )}
    </div>
  );
}

/**
 * Settings → Server: versions, stored icons, the instance text, defaults for new invites, backups,
 * external sources and "Rebuild". The database file and backup folder aren't shown (in Docker they
 * would be the container's paths).
 */
export function ServerTab() {
  const [confirming, setConfirming] = useState(false);
  const rebuild = useRebuild();
  // Also pending when started before leaving and coming back to this tab.
  const running = useLatestRebuild().status === 'pending';

  return (
    <SettingsLayout section="server">
      <StackedColumns
        items={[
          {
            key: 'server',
            column: 'left',
            node: (
              <Card>
                <CardHeader title="Server" className="mb-1.5" />
                <Versions />
                <IconsStatus />
              </Card>
            ),
          },
          {
            key: 'instance-text',
            column: 'left',
            node: (
              <Card>
                <CardHeader title="Instance text" className="mb-1.5" />
                <p className="mt-0 mb-4 text-text-2">
                  Shown on the public about page, linked from the login page, also to people who
                  aren&apos;t logged in: who runs this server, how to reach you, what it stores and
                  for how long. The default describes what this server stores; adjust it if you run
                  it differently.
                </p>
                <InstanceTextSettings />
              </Card>
            ),
          },
          {
            key: 'new-invites',
            column: 'left',
            node: (
              <Card>
                <CardHeader title="New invites" className="mb-1.5" />
                <p className="mt-0 mb-4 text-text-2">
                  What the invite form under Users starts with. You can still change it per invite,
                  and per user later.
                </p>
                <InviteDefaults />
              </Card>
            ),
          },
          {
            key: 'backups',
            column: 'right',
            node: (
              <Card>
                <CardHeader title="Backups" className="mb-1.5" />
                <BackupStatus />
                <p className="mt-3 mb-0 text-sm text-text-2">
                  A backup is taken every day, and when the server starts if the newest is more than
                  a day old. Restore one with{' '}
                  <code className="font-mono">pnpm cli restore &lt;file&gt;</code> while the server
                  is stopped. Backups on the same disk don&apos;t survive a disk failure: copy them
                  somewhere else too.
                </p>
              </Card>
            ),
          },
          {
            key: 'external-sources',
            column: 'right',
            node: (
              <Card>
                <CardHeader title="External sources" className="mb-1.5" />
                <ExternalSources />
                <p className="mt-3 mb-0 text-sm text-text-2">
                  Optional and off by default. The server only calls a source that is turned on in{' '}
                  <code className="font-mono">.env</code>, and only when{' '}
                  <code className="font-mono">USER_AGENT_CONTACT</code> is set. Prices are fetched
                  at most once an hour and value the bank and the net worth; history and loot keep
                  the prices from when they happened.
                </p>
              </Card>
            ),
          },
          {
            key: 'rebuild',
            column: 'right',
            node: (
              <Card>
                <CardHeader title="Rebuild derived data" className="mb-1.5" />
                <p className="mt-0 mb-4 text-text-2">
                  Recomputes sessions, XP, loot and summaries from the raw events. With a lot of
                  data it can take a minute or more, and the dashboard and the plugin wait until it
                  is done. Nothing is lost: the plugin sends again afterwards.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    disabled={running}
                    onClick={() => {
                      setConfirming(true);
                    }}
                  >
                    {running ? 'Rebuilding…' : 'Rebuild'}
                  </Button>
                  <RebuildResult />
                </div>
              </Card>
            ),
          },
        ]}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Rebuild derived data?"
        description="Every derived table is cleared and rebuilt from the raw events. The dashboard and the plugin wait until it is done."
        confirmLabel="Rebuild"
        pendingLabel="Rebuilding…"
        onConfirm={() => {
          // The button on the page shows progress; the dialog's job is done.
          setConfirming(false);
          rebuild.mutate();
        }}
      />
    </SettingsLayout>
  );
}
