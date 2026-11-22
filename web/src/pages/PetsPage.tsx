import type { CollectionLogStatusResponse, Pet } from '@fireside/shared';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAccounts, useCollectionLogStatus, usePets, useSyncCollectionLog } from '@/api/hooks';
import { Card } from '@/components/Card';
import { SegmentedFilter } from '@/components/Segmented';
import { PetCard } from '@/components/PetCard';
import { PageControls } from '@/components/shell/PageControls';
import { CardSkeleton, EmptyMessage, ErrorState } from '@/components/states';
import { StatStrip } from '@/components/StatStrip';
import { SyncNowButton } from '@/components/SyncStatus';
import { formatInt } from '@/format';
import { accountColors, accountNameById, SETTINGS_ACCOUNTS_PATH } from '@/lib/accounts';
import { CLOG_NEEDS_ACTION, clogStatusText, isClogSyncProblem } from '@/lib/clog';
import { parsePetSort, petNoun, sortPets, type PetSort } from '@/lib/pets';
import { useAccountScope } from '@/routing/useAccountScope';

// Pets: `/:acc/collections/pets?sort=new|az`. A trophy case of the pets an
// account has, newest first or by name, with the count on top. `all` shows
// every account's pets together, each card with its account. Pets come from the
// collection log ("All Pets") and from the chat message when one drops: there
// is no way to add or remove one here. For one account, a card under the grid
// says how to bring in a pet that is missing ("Sync now" is the same sync as on
// Collection log).

const SORT_OPTIONS = [
  { value: 'new', label: 'Newest' },
  { value: 'az', label: 'A–Z' },
] as const;

/** `?sort=` and the toggle in the top bar. Choosing replaces the URL entry. */
function useSort(): PetSort {
  const [searchParams] = useSearchParams();
  return parsePetSort(searchParams.get('sort'));
}

function SortToggle() {
  const [, setSearchParams] = useSearchParams();
  const sort = useSort();
  return (
    <PageControls>
      <SegmentedFilter
        block
        label="Sort"
        options={SORT_OPTIONS}
        value={sort}
        onChange={(value) => {
          setSearchParams(
            (previous) => {
              const next = new URLSearchParams(previous);
              if (value === 'new') next.delete('sort');
              else next.set('sort', value);
              return next;
            },
            { replace: true },
          );
        }}
      />
    </PageControls>
  );
}

// --- "Missing a pet?" -----------------------------------------------------------

/**
 * How to bring in a pet that is missing, for one account. With a collection
 * log source: the steps in the game and "Sync now". Without: where to turn
 * the sync on.
 */
function HelpCard({
  status,
  stale,
  name,
}: {
  status: CollectionLogStatusResponse;
  /** The status could not be read again: a running sync is not something to wait for. */
  stale: boolean;
  name: string;
}) {
  const sync = useSyncCollectionLog();
  const hasSource = status.source !== null && status.sync !== null;
  const state = status.sync?.status;
  const problem = hasSource && state !== undefined && isClogSyncProblem(state);
  return (
    <Card aria-labelledby="pets-help">
      {/* Text and button in a row on PC, stacked on mobile. */}
      <div className="flex flex-col gap-3 desk:flex-row desk:flex-wrap desk:items-center desk:justify-between desk:gap-x-6">
        <div className="flex min-w-0 flex-col gap-3 desk:flex-[1_1_420px] desk:gap-1">
          <h2 id="pets-help" className="m-0 text-sm font-semibold desk:text-[15px]">
            Missing a pet?
          </h2>
          <p className="m-0 text-xs text-text-3 desk:text-table">
            {hasSource ? (
              // The RuneProfile plugin's own steps (runeprofile.com/info/guide):
              // it can only read the collection log while it is open.
              'Pets come from your collection log. In the game, open the Collection Log and click the RuneProfile button at the top left of the window. Then press Sync now.'
            ) : (
              <>
                Pets you get while the plugin is running show up here. To bring in pets you already
                have, turn on collection log sync for this account in{' '}
                <Link to={SETTINGS_ACCOUNTS_PATH} className="underline">
                  Settings
                </Link>
                .
              </>
            )}
          </p>
        </div>
        {hasSource && (
          <SyncNowButton
            status={status}
            stale={stale}
            sync={sync}
            className="max-desk:h-11 max-desk:w-full max-desk:rounded-[10px]"
          />
        )}
      </div>
      {/* A sync that did not work, as on Collection log. The pets above stay. */}
      {problem && (
        <p
          role={CLOG_NEEDS_ACTION.has(state) ? 'alert' : 'status'}
          className="mt-3 mb-0 text-xs text-down"
        >
          {clogStatusText(state, name)}
        </p>
      )}
      {sync.isError && (
        <p role="alert" className="mt-3 mb-0 text-xs text-down">
          Couldn&apos;t start a sync. Try again in a minute.
        </p>
      )}
    </Card>
  );
}

// --- The trophy case --------------------------------------------------------------

function Trophies({ pets, withAccount }: { pets: readonly Pet[]; withAccount: boolean }) {
  const sort = useSort();
  const accounts = useAccounts().data?.accounts;
  const sorted = useMemo(() => sortPets(pets, sort), [pets, sort]);
  const colors = useMemo(() => accountColors(accounts ?? []), [accounts]);
  return (
    <>
      <StatStrip
        label="Pets summary"
        items={[{ key: 'pets', value: formatInt(pets.length), label: petNoun(pets.length) }]}
      />
      {sorted.length === 0 ? (
        <Card>
          <EmptyMessage>Pets you unlock show up here.</EmptyMessage>
        </Card>
      ) : (
        <ul
          aria-label="Pets"
          className="m-0 grid list-none grid-cols-2 gap-3 p-0 desk:grid-cols-[repeat(auto-fill,minmax(min(210px,100%),1fr))] desk:gap-4"
        >
          {sorted.map((pet) => (
            <PetCard
              key={`${String(pet.accountId)}:${String(pet.itemId)}`}
              pet={pet}
              account={
                withAccount
                  ? {
                      name: accountNameById(pet.accountId, accounts ?? []),
                      color: colors.get(pet.accountId) ?? 'var(--text-3)',
                    }
                  : undefined
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}

function Loading() {
  return (
    <>
      <StatStrip items={undefined} label="Pets summary" skeletonCount={1} />
      <Card>
        <CardSkeleton lines={4} />
      </Card>
    </>
  );
}

function AccountView({ accountId }: { accountId: number }) {
  const status = useCollectionLogStatus(accountId);
  // Asked for once the status is known (or can't be), so one call has the right key.
  const pets = usePets(accountId, {
    status: status.data,
    enabled: status.data !== undefined || status.isError,
  });
  const accounts = useAccounts().data?.accounts ?? [];

  if (pets.data === undefined) {
    return pets.isError ? (
      <Card>
        <ErrorState onRetry={() => void pets.refetch()} />
      </Card>
    ) : (
      <Loading />
    );
  }
  return (
    <>
      <Trophies pets={pets.data.pets} withAccount={false} />
      {/* Without the status there is nothing true to say about syncing. */}
      {status.data !== undefined && (
        <HelpCard
          status={status.data}
          stale={status.isError}
          name={accountNameById(accountId, accounts)}
        />
      )}
    </>
  );
}

function AllAccountsView() {
  const pets = usePets('all');
  if (pets.data === undefined) {
    return pets.isError ? (
      <Card>
        <ErrorState onRetry={() => void pets.refetch()} />
      </Card>
    ) : (
      <Loading />
    );
  }
  return <Trophies pets={pets.data.pets} withAccount />;
}

// --- Page ---------------------------------------------------------------------

export function PetsPage() {
  const scope = useAccountScope();
  return (
    <div className="flex w-full flex-col gap-4 desk:gap-5">
      <SortToggle />
      {scope === 'all' ? <AllAccountsView /> : <AccountView key={scope} accountId={scope} />}
    </div>
  );
}
