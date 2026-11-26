import type {
  AccountDetailResponse,
  AccountScope,
  AccountsResponse,
  BackupStatusResponse,
  ExternalSourcesResponse,
  IconsStatusResponse,
  BankHistoryResponse,
  BankPrices,
  BankResponse,
  BankSummaryResponse,
  Bucket,
  CalendarResponse,
  ClogSource,
  CollectionLogResponse,
  CollectionLogStatusResponse,
  CollectionLogSyncResponse,
  CreateKeyResponse,
  DiariesResponse,
  DropsResponse,
  FeedResponse,
  FeedType,
  GainsPeriod,
  GainsResponse,
  HealthResponse,
  KcResponse,
  KeysResponse,
  LootGroupBy,
  LootResponse,
  PetsResponse,
  PotionStorageResponse,
  PriceMoversResponse,
  QuestsResponse,
  RaidDropCreateRequest,
  RaidDropResponse,
  RaidDropUpdateRequest,
  RaidSplitDefaultResponse,
  RaidSplitsResponse,
  RaidsResponse,
  RebuildResponse,
  ScreentimeHeatmapResponse,
  ScreentimeResponse,
  ScreentimeWorldsResponse,
  SessionDetailResponse,
  SessionsResponse,
  SplitMode,
  WeeklyResponse,
  XpResponse,
} from '@fireside/shared';
import {
  skipToken,
  useInfiniteQuery,
  useMutation,
  useMutationState,
  useQueries,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { apiGet, apiSend } from './client';
import { isImportingIcons } from '@/lib/icons';
import { hasLiveSession } from '@/lib/overview';
import { withSnapshot } from '@/lib/quests';
import { shouldPollSession } from '@/lib/session-stats';
import {
  KEEP_PREVIOUS,
  keepPreviousOfSameScope,
  keepPreviousOfSameScopeKind,
  LIVE_POLL_MS,
  livePolling,
} from './query-client';
import { useServerStatus } from './server-status';

// One hook per endpoint. Types come from the contract in
// shared/src/schemas/api/. Every query key holds the account scope and all
// parameters.

/** `[from, to)` in UTC. */
export interface TimeRange {
  from?: string;
  to?: string;
}

/**
 * Home polls while a session is open. `live: true` fetches again every 30 s,
 * paused in a hidden tab. Off by default.
 */
export interface LiveOption {
  live?: boolean;
}

function liveOptions(live: boolean | undefined) {
  return live ? livePolling(true) : {};
}

function accountPath(scope: AccountScope, rest = ''): string {
  return `/accounts/${String(scope)}${rest}`;
}

// --- Health -----------------------------------------------------------------

/** How often health is retried while the server is down. */
export const DOWN_POLL_MS = 5_000;

/** `GET /health`: versions and the server's time zone. Polled only while the server is down. */
export function useHealth() {
  const { down } = useServerStatus();
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => apiGet<HealthResponse>('health-response', '/health', { signal }),
    staleTime: Infinity,
    refetchInterval: down ? DOWN_POLL_MS : false,
  });
}

// --- Accounts and XP ----------------------------------------------------------

/**
 * `GET /accounts`. `live` is a flag or, as in the shell, a test of the list
 * itself (`anyOnline`), checked again after every fetch, so "Online" turns
 * into offline within one poll after a logout. Observers share the query, so
 * several of them still fetch once per interval.
 */
export function useAccounts({
  live,
  fresh = false,
}: {
  live?: boolean | ((data: AccountsResponse | undefined) => boolean);
  fresh?: boolean;
} = {}) {
  return useQuery({
    queryKey: ['accounts'],
    ...(live === undefined || live === false ? {} : livePolling<AccountsResponse>(live)),
    // `fresh` asks again on mount, for a decision that must not rest on the cache.
    ...(fresh ? { refetchOnMount: 'always' as const } : {}),
    queryFn: ({ signal }) => apiGet<AccountsResponse>('accounts-response', '/accounts', { signal }),
  });
}

export function useAccount(accountId: number) {
  return useQuery({
    queryKey: ['account', accountId],
    queryFn: ({ signal }) =>
      apiGet<AccountDetailResponse>('account-detail-response', accountPath(accountId), {
        signal,
      }),
  });
}

export interface GainsParams extends TimeRange {
  period?: GainsPeriod;
}

export function useGains(scope: AccountScope, params: GainsParams = {}, { live }: LiveOption = {}) {
  return useQuery({
    queryKey: ['gains', scope, params],
    ...liveOptions(live),
    // Has levels, which are summed for `all`.
    ...keepPreviousOfSameScopeKind(scope),
    queryFn: ({ signal }) =>
      apiGet<GainsResponse>('gains-response', accountPath(scope, '/gains'), {
        query: { ...params },
        signal,
      }),
  });
}

export interface XpParams extends TimeRange {
  /** Any skill name, also skills the dashboard doesn't know yet. */
  skill?: string;
  bucket?: Bucket;
}

export function useXp(scope: AccountScope, params: XpParams = {}) {
  return useQuery({
    queryKey: ['xp', scope, params],
    // Has levels, which are summed for `all`.
    ...keepPreviousOfSameScopeKind(scope),
    queryFn: ({ signal }) =>
      apiGet<XpResponse>('xp-response', accountPath(scope, '/xp'), {
        query: { ...params },
        signal,
      }),
  });
}

// --- Loot and KC --------------------------------------------------------------

export interface LootParams extends TimeRange {
  groupBy?: LootGroupBy;
}

export function useLoot(scope: AccountScope, params: LootParams = {}) {
  return useQuery({
    queryKey: ['loot', scope, params],
    // Sums over all accounts must not stand in for one account.
    ...keepPreviousOfSameScopeKind(scope),
    queryFn: ({ signal }) =>
      apiGet<LootResponse>('loot-response', accountPath(scope, '/loot'), {
        query: { ...params },
        signal,
      }),
  });
}

export interface DropsParams extends TimeRange {
  minValue?: number;
  limit?: number;
}

/** Valuable drops, newest first, one page per `fetchNextPage`. */
export function useDrops(scope: AccountScope, params: DropsParams = {}, { live }: LiveOption = {}) {
  return useInfiniteQuery({
    queryKey: ['drops', scope, params],
    ...liveOptions(live),
    // Rows from every account (named only for `all`) must not show under one account.
    ...keepPreviousOfSameScopeKind(scope),
    queryFn: ({ signal, pageParam }) =>
      apiGet<DropsResponse>('drops-response', accountPath(scope, '/loot/drops'), {
        query: { ...params, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useKc(scope: AccountScope) {
  return useQuery({
    queryKey: ['kc', scope],
    // KC is summed for `all`, with a split per account shown only there.
    ...keepPreviousOfSameScopeKind(scope),
    queryFn: ({ signal }) =>
      apiGet<KcResponse>('kc-response', accountPath(scope, '/kc'), { signal }),
  });
}

export interface RaidsParams {
  limit?: number;
}

/**
 * Raids (loot value per raid) and special loot, one page of special loot per
 * `fetchNextPage`. Every page repeats `raids`; read it from the first page.
 */
export function useRaids(scope: AccountScope, params: RaidsParams = {}) {
  return useInfiniteQuery({
    queryKey: ['raids', scope, params],
    // Rows from every account (named only for `all`) must not show under one account.
    ...keepPreviousOfSameScopeKind(scope),
    queryFn: ({ signal, pageParam }) =>
      apiGet<RaidsResponse>('raids-response', accountPath(scope, '/raids'), {
        query: { ...params, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.specialLoot.nextCursor ?? undefined,
  });
}

// --- Raid loot split tracker ---------------------------------------

const RAID_SPLITS_KEY = 'raid-splits';

/**
 * Your share of purples: totals, per raid, per month and the drops with the
 * owner's choices, one page of drops per `fetchNextPage`. Every page repeats
 * the sums, months and defaults; read them from the first page.
 */
export function useRaidSplits(scope: AccountScope, params: RaidsParams = {}) {
  return useInfiniteQuery({
    queryKey: [RAID_SPLITS_KEY, scope, params],
    // Rows from every account (named only for `all`) must not show under one account.
    ...keepPreviousOfSameScopeKind(scope),
    queryFn: ({ signal, pageParam }) =>
      apiGet<RaidSplitsResponse>('raid-splits-response', accountPath(scope, '/raids/splits'), {
        query: { ...params, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.drops.nextCursor ?? undefined,
  });
}

/**
 * The split tracker's changes. Every share, sum and month comes from the
 * server, so each change fetches the tracker again (for every scope) and is
 * pending until that is done.
 */
function useRaidSplitChange<Variables, Result>(
  mutationFn: (variables: Variables) => Promise<Result>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [RAID_SPLITS_KEY] }),
  });
}

function dropPath(accountId: number, dropId: string): string {
  return accountPath(accountId, `/raids/drops/${encodeURIComponent(dropId)}`);
}

/** `PUT …/raids/split-default`: Split or FFA for one account (never `all`). */
export function useSetSplitDefault() {
  return useRaidSplitChange(({ accountId, mode }: { accountId: number; mode: SplitMode }) =>
    apiSend<RaidSplitDefaultResponse>('PUT', accountPath(accountId, '/raids/split-default'), {
      body: { mode },
      schema: 'raid-split-default-response',
    }),
  );
}

/** `PATCH …/raids/drops/:dropId`, on the drop's own account (also under `all`). */
export function useUpdateRaidDrop() {
  return useRaidSplitChange(
    ({
      accountId,
      dropId,
      changes,
    }: {
      accountId: number;
      dropId: string;
      changes: RaidDropUpdateRequest;
    }) =>
      apiSend<RaidDropResponse>('PATCH', dropPath(accountId, dropId), {
        body: changes,
        schema: 'raid-drop-response',
      }),
  );
}

/** `POST …/raids/drops`: a purple the plugin didn't record, your own or a teammate's. */
export function useAddRaidDrop() {
  return useRaidSplitChange(
    ({ accountId, body }: { accountId: number; body: RaidDropCreateRequest }) =>
      apiSend<RaidDropResponse>('POST', accountPath(accountId, '/raids/drops'), {
        body,
        schema: 'raid-drop-response',
      }),
  );
}

/** `DELETE …/raids/drops/:dropId`. Only for a drop added by hand. */
export function useDeleteRaidDrop() {
  return useRaidSplitChange(({ accountId, dropId }: { accountId: number; dropId: string }) =>
    apiSend('DELETE', dropPath(accountId, dropId)),
  );
}

// --- Sessions and calendar ------------------------------------------------------

export interface SessionsParams extends TimeRange {
  limit?: number;
}

/**
 * Sessions, newest first, one page per `fetchNextPage`. With `pollWhileOpen`
 * (Home, Sessions), fetched again every 30 s while the list has a live
 * session (`isSessionLive`): open, or ended by a hop under 2 minutes ago, so a
 * poll that lands between the two parts of a hop keeps polling.
 */
export function useSessions(
  scope: AccountScope,
  params: SessionsParams = {},
  { pollWhileOpen = false }: { pollWhileOpen?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: ['sessions', scope, params],
    ...(pollWhileOpen
      ? livePolling<InfiniteData<SessionsResponse>>((data) =>
          hasLiveSession((data?.pages ?? []).flatMap((page) => page.items)),
        )
      : {}),
    // No previous data: the only change is the account, and another account's
    // rows (clickable, with its colours) must not show under this one.
    queryFn: ({ signal, pageParam }) =>
      apiGet<SessionsResponse>('sessions-response', accountPath(scope, '/sessions'), {
        query: { ...params, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/**
 * One session in detail. While it is open it is fetched again every 30 s,
 * paused while the tab is hidden, and for up to 2 minutes after a world hop
 * until the next part shows up (`shouldPollSession`).
 */
export function useSession(sessionId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    ...sessionQuery(sessionId),
    enabled,
    ...livePolling<SessionDetailResponse>((data) => shouldPollSession(data)),
  });
}

/**
 * Key and fetch of one session in detail, shared by `useSession` and the hop
 * chain walk (`useHopChain`), so a part the walk fetched opens at once.
 */
export function sessionQuery(sessionId: string) {
  return {
    queryKey: ['session', sessionId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      apiGet<SessionDetailResponse>(
        'session-detail-response',
        `/sessions/${encodeURIComponent(sessionId)}`,
        { signal },
      ),
  };
}

/**
 * Account of a session already in the cache (from `useSession`), without
 * fetching. The shell uses it on Session detail, which has no account in the URL.
 */
export function useCachedSessionAccount(sessionId: string | undefined): number | undefined {
  return useQuery<SessionDetailResponse, Error, number>({
    queryKey: ['session', sessionId ?? ''],
    queryFn: skipToken,
    select: (data) => data.session.accountId,
  }).data;
}

// --- Feed ("Latest" on Home) -------------------------------------------------------

export interface FeedParams {
  /** Entry types, in any order. Default: every type. */
  types?: readonly FeedType[];
  /** Lowest GE value of a drop. Default on the server: 1M. */
  minValue?: number;
  limit?: number;
}

/**
 * What happened lately, newest first, one page per `fetchNextPage`. Home shows
 * six rows and normally has one page; it asks for the next only when a page
 * gives fewer rows than that. With `live` (while a session is open) the loaded
 * pages are fetched again every 30 s, each with the cursor of the fresh page
 * before it.
 */
export function useFeed(scope: AccountScope, params: FeedParams = {}, { live }: LiveOption = {}) {
  const { types, ...rest } = params;
  const query = { ...rest, ...(types === undefined ? {} : { types: types.join(',') }) };
  return useInfiniteQuery({
    queryKey: ['feed', scope, query],
    ...liveOptions(live),
    // No previous data: another account's or filter's rows must not show under this one.
    queryFn: ({ signal, pageParam }) =>
      apiGet<FeedResponse>('feed-response', accountPath(scope, '/feed'), {
        query: { ...query, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export type CalendarParams = { year?: number } | Required<TimeRange>;

export function useCalendar(
  scope: AccountScope,
  params: CalendarParams = {},
  { live }: LiveOption = {},
) {
  return useQuery({
    queryKey: ['calendar', scope, params],
    ...liveOptions(live),
    ...KEEP_PREVIOUS,
    queryFn: ({ signal }) =>
      apiGet<CalendarResponse>('calendar-response', accountPath(scope, '/calendar'), {
        query: { ...params },
        signal,
      }),
  });
}

// --- Screen time ----------------------------------------------------------------

export interface ScreentimeParams extends TimeRange {
  bucket?: Bucket;
}

/** `enabled: false` waits (Weekly asks only for weeks with play time). */
export function useScreentime(
  scope: AccountScope,
  params: ScreentimeParams = {},
  { enabled = true, live }: LiveOption & { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ['screentime', scope, params],
    enabled,
    ...liveOptions(live),
    ...KEEP_PREVIOUS,
    queryFn: ({ signal }) =>
      apiGet<ScreentimeResponse>('screentime-response', accountPath(scope, '/screentime'), {
        query: { ...params },
        signal,
      }),
  });
}

export function useScreentimeWorlds(scope: AccountScope, params: TimeRange = {}) {
  return useQuery({
    queryKey: ['screentime-worlds', scope, params],
    ...KEEP_PREVIOUS,
    queryFn: ({ signal }) =>
      apiGet<ScreentimeWorldsResponse>(
        'screentime-worlds-response',
        accountPath(scope, '/screentime/worlds'),
        { query: { ...params }, signal },
      ),
  });
}

export function useScreentimeHeatmap(scope: AccountScope, params: TimeRange = {}) {
  return useQuery({
    queryKey: ['screentime-heatmap', scope, params],
    ...KEEP_PREVIOUS,
    queryFn: ({ signal }) =>
      apiGet<ScreentimeHeatmapResponse>(
        'screentime-heatmap-response',
        accountPath(scope, '/screentime/heatmap'),
        { query: { ...params }, signal },
      ),
  });
}

// --- Weekly summary ---------------------------------------------------------------

/**
 * Without `week`: the current week. Sums for `all` and drops named by account
 * must not stand in for one account, so only data of the same kind is kept.
 */
export function useWeekly(scope: AccountScope, week?: string, { live }: LiveOption = {}) {
  return useQuery({
    queryKey: ['weekly', scope, { week }],
    ...liveOptions(live),
    ...keepPreviousOfSameScopeKind(scope),
    queryFn: ({ signal }) =>
      apiGet<WeeklyResponse>('weekly-response', accountPath(scope, '/weekly'), {
        query: { week },
        signal,
      }),
  });
}

// --- Bank ---------------------------------------------------------------

// The bank changes only when it is closed in the game, so the Bank page never
// polls. Home passes `live` like its other cards.

/** `GET …/bank`: the latest bank per account, in container order. */
export function useBank(scope: AccountScope) {
  return useQuery({
    queryKey: ['bank', scope],
    // One account's tabs and items must not show under another account or `all`.
    queryFn: ({ signal }) =>
      apiGet<BankResponse>('bank-response', accountPath(scope, '/bank'), { signal }),
  });
}

/** `GET …/potion-storage`: the latest potion storage per account. */
export function usePotionStorage(scope: AccountScope) {
  return useQuery({
    queryKey: ['potion-storage', scope],
    queryFn: ({ signal }) =>
      apiGet<PotionStorageResponse>(
        'potion-storage-response',
        accountPath(scope, '/potion-storage'),
        { signal },
      ),
  });
}

/**
 * `GET …/bank/summary`: the net worth in GE. `updatedAt` is `null` until an
 * account in scope has a snapshot. For `all` it also tells whether the Bank
 * page and its menu item exist yet (`useHasBankData`, `PageGate`).
 */
export function useBankSummary(
  scope: AccountScope,
  { live, fresh = false }: LiveOption & { fresh?: boolean } = {},
) {
  return useQuery({
    queryKey: ['bank-summary', scope],
    ...liveOptions(live),
    // No previous data: one account's net worth must never show under another.
    // `fresh` asks again on mount, for a decision that must not rest on the cache.
    ...(fresh ? { refetchOnMount: 'always' as const } : {}),
    queryFn: ({ signal }) =>
      apiGet<BankSummaryResponse>('bank-summary-response', accountPath(scope, '/bank/summary'), {
        signal,
      }),
  });
}

/**
 * How price changes moved the value of what is held now. Asked for only when
 * `enabled`: the bank answer says whether the server has current prices at all.
 * Never polled, like the rest of the Bank page.
 */
export function usePriceMovers(scope: AccountScope, { enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: ['price-movers', scope],
    enabled,
    queryFn: ({ signal }) =>
      apiGet<PriceMoversResponse>(
        'price-movers-response',
        accountPath(scope, '/bank/price-movers'),
        { signal },
      ),
  });
}

/** Current prices older than this start a fetch on the server when they are read. */
export const STALE_PRICES_MS = 60 * 60 * 1000;
/** How long after a stale answer the bank-price queries are asked again. */
export const STALE_PRICES_REFETCH_MS = 5_000;
/** Every query valued at the latest prices: refetched together, so they agree. */
const BANK_PRICE_QUERIES = ['bank', 'bank-summary', 'price-movers', 'potion-storage'] as const;

/**
 * A read of current prices over an hour old makes the server fetch new ones
 * in the background while it answers with the old ones (see
 * docs/decisions/0019-prices-fetched-on-demand.md). The bank queries never
 * poll, so a few seconds after such an answer this asks all four bank-price
 * queries of `scope` again, once: they then show the same, new prices. At
 * most once per scope and price fetch while the component stays mounted (a
 * page visit), so it never loops: if the prices are still old afterwards (the
 * fetch failed or is slow), they are left as they are. Never with snapshot
 * prices (prices off, or no fetch yet).
 */
export function useRefreshStalePrices(scope: AccountScope, prices: BankPrices | undefined) {
  const queryClient = useQueryClient();
  const asked = useRef(new Set<string>());
  const fetchedAt = prices?.source === 'CURRENT' ? prices.fetchedAt : null;
  useEffect(() => {
    if (fetchedAt === null) return;
    const age = Date.now() - Date.parse(fetchedAt);
    if (!(age >= STALE_PRICES_MS)) return;
    const key = `${String(scope)} ${fetchedAt}`;
    if (asked.current.has(key)) return;
    const timer = setTimeout(() => {
      asked.current.add(key);
      for (const name of BANK_PRICE_QUERIES) {
        // Cached ones that are not on screen too, so none keeps the old prices.
        void queryClient.invalidateQueries({ queryKey: [name, scope], refetchType: 'all' });
      }
    }, STALE_PRICES_REFETCH_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [queryClient, scope, fetchedAt]);
}

/** `GET …/bank/history`: net worth per local day. Without a range: a rolling year. */
export function useBankHistory(
  scope: AccountScope,
  params: TimeRange = {},
  { live, enabled = true }: LiveOption & { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ['bank-history', scope, params],
    enabled,
    ...liveOptions(live),
    // Kept while a new period loads, but never from another account.
    ...keepPreviousOfSameScope(scope),
    queryFn: ({ signal }) =>
      apiGet<BankHistoryResponse>('bank-history-response', accountPath(scope, '/bank/history'), {
        query: { ...params },
        signal,
      }),
  });
}

/**
 * Whether any account has bank data: `true`/`false`, or `undefined` while it
 * is not known yet. The Bank page, its menu item and the net-worth card exist
 * only when it is `true` (no "coming soon" pages).
 */
export function useHasBankData(): boolean | undefined {
  const summary = useBankSummary('all');
  if (summary.data === undefined) return undefined;
  return summary.data.updatedAt !== null;
}

// --- Quests and diaries ----------------------------------------------------

// Quest and diary status belongs to one account: the endpoints don't take
// `all` (states can't be summed), so "All accounts" and the question whether
// the page exists ask once per account. Nothing polls: the plugin sends a
// snapshot after login and when something changes.

/**
 * A failed call is asked again every 30 s while something shows it. The menu
 * waits for every account's answer and has no Retry button of its own, so
 * without this one failed call would keep the menu item away until a reload.
 */
const retryWhileFailed = {
  refetchInterval: (query: { state: { status: string } }) =>
    query.state.status === 'error' ? LIVE_POLL_MS : false,
  refetchIntervalInBackground: false,
} as const;

/** `fresh` asks again on mount, for a decision that must not rest on the cache. */
function freshOption(fresh: boolean) {
  return fresh ? { refetchOnMount: 'always' as const } : {};
}

// --- One call per account ---------------------------------------------------------

/** What `usePerAccount` needs to know about a call. */
interface PerAccountResult<T> {
  data: T | undefined;
  isError: boolean;
  isFetchedAfterMount: boolean;
  refetch: () => unknown;
}

/** The options of one account's call: what `useQuery` takes, e.g. from `questsQuery`. */
interface PerAccountQuery<T> {
  queryKey: readonly unknown[];
  queryFn: (context: { signal: AbortSignal }) => Promise<T>;
  refetchInterval?: (query: { state: { status: string; data: T | undefined } }) => number | false;
  refetchIntervalInBackground?: boolean;
}

/**
 * The account list and the IDs to ask, for endpoints that don't take `all`.
 * `ids` is `undefined` until the list is known. `fresh` asks for the list
 * again on mount: an account added since it was cached must be asked as well.
 */
function useAccountIds(fresh: boolean) {
  const accounts = useAccounts({ fresh });
  return { accounts, ids: accounts.data?.accounts.map((account) => account.id) };
}

/** One call per account, in the order of `ids`. `fresh` asks again on mount. */
function usePerAccountQueries<T>(
  ids: readonly number[] | undefined,
  query: (accountId: number) => PerAccountQuery<T>,
  fresh: boolean,
): PerAccountResult<T>[] {
  return useQueries({
    queries: (ids ?? []).map((id) => ({ ...query(id), ...freshOption(fresh) })),
  });
}

/**
 * How far the calls of a per-account fan-out have come: the account list and
 * every call of every account (`queries`, all of them in one list).
 */
function perAccountState(
  accounts: Pick<PerAccountResult<unknown>, 'isError' | 'isFetchedAfterMount' | 'refetch'>,
  known: boolean,
  queries: readonly PerAccountResult<unknown>[],
) {
  return {
    /** Every account has every answer. */
    isComplete: known && queries.every((query) => query.data !== undefined),
    /** Every call has answered or failed: nothing is still loading for the first time. */
    isSettled: known && queries.every((query) => query.data !== undefined || query.isError),
    /**
     * As `isComplete`, and the account list and every answer are from after
     * the hook was mounted. Only meaningful with `fresh`.
     */
    isFetchedAfterMount:
      known &&
      accounts.isFetchedAfterMount &&
      queries.every((query) => query.data !== undefined && query.isFetchedAfterMount),
    isError: accounts.isError || queries.some((query) => query.isError),
    /** Asks again for what failed. */
    refetch: () => {
      if (accounts.isError) void accounts.refetch();
      for (const query of queries) if (query.isError) void query.refetch();
    },
  };
}

// No previous data: one account's quests must never show under another.
function questsQuery(accountId: number) {
  return {
    queryKey: ['quests', accountId] as const,
    ...retryWhileFailed,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      apiGet<QuestsResponse>('quests-response', accountPath(accountId, '/quests'), { signal }),
  };
}

function diariesQuery(accountId: number) {
  return {
    queryKey: ['diaries', accountId] as const,
    ...retryWhileFailed,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      apiGet<DiariesResponse>('diaries-response', accountPath(accountId, '/diaries'), { signal }),
  };
}

/** `GET …/quests`: quests and miniquests of the account's latest snapshot. */
export function useQuests(accountId: number) {
  return useQuery(questsQuery(accountId));
}

/** `GET …/diaries`: diary tiers per region of the account's latest snapshot. */
export function useDiaries(accountId: number) {
  return useQuery(diariesQuery(accountId));
}

// --- Collection log -----------------------------------------

/** How often the status is read again while a sync is running. */
export const CLOG_SYNC_POLL_MS = 2_000;

const collectionLogStatusKey = (accountId: number) => ['collection-log-status', accountId] as const;

// Small enough to poll: every two seconds while a sync runs, so its result
// shows up by itself. A failed call is asked again like the quest calls, since
// the menu depends on it: every 30 s, also when the last answer said a sync
// was running (the server may be down, and that sync is then not something to
// wait for). The fast poll is back with the first answer.
function collectionLogStatusQuery(accountId: number) {
  return {
    queryKey: collectionLogStatusKey(accountId),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      apiGet<CollectionLogStatusResponse>(
        'collection-log-status-response',
        accountPath(accountId, '/collection-log/status'),
        { signal },
      ),
    refetchInterval: (query: {
      state: { status: string; data: CollectionLogStatusResponse | undefined };
    }) =>
      query.state.status === 'error'
        ? LIVE_POLL_MS
        : query.state.data?.sync?.status === 'SYNCING'
          ? CLOG_SYNC_POLL_MS
          : false,
    refetchIntervalInBackground: false,
  };
}

/**
 * `GET …/collection-log/status`: the account's source, how the latest sync
 * went and the slot counts, without the collection log itself.
 */
export function useCollectionLogStatus(accountId: number) {
  return useQuery(collectionLogStatusQuery(accountId));
}

/**
 * `GET …/collection-log`: the account's whole collection log. Never polled
 * (it is about 150 KB): it is read when `status` says there is one, and again
 * when a sync has worked since, which is when its items or dates can have
 * changed. While that loads, the same account's previous log stays.
 */
export function useCollectionLog(
  accountId: number,
  status: CollectionLogStatusResponse | undefined,
) {
  return useQuery({
    queryKey: [
      'collection-log',
      accountId,
      status?.updatedAt ?? null,
      status?.sync?.lastSuccessAt ?? null,
    ] as const,
    queryFn: ({ signal }) =>
      apiGet<CollectionLogResponse>(
        'collection-log-response',
        accountPath(accountId, '/collection-log'),
        { signal },
      ),
    enabled: hasClogData(status),
    ...keepPreviousOfSameScope(accountId),
  });
}

/** Puts the new source and sync state into the cached status, then reads it again. */
function useCollectionLogChange<V extends { accountId: number }>(
  mutationFn: (variables: V) => Promise<CollectionLogSyncResponse>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (state, { accountId }) => {
      queryClient.setQueryData<CollectionLogStatusResponse>(
        collectionLogStatusKey(accountId),
        (current) => (current ? { ...current, source: state.source, sync: state.sync } : current),
      );
      return queryClient.invalidateQueries({ queryKey: collectionLogStatusKey(accountId) });
    },
  });
}

/** `PUT …/collection-log/source`: the owner's opt-in per account. `null` turns it off. */
export function useSetCollectionLogSource() {
  return useCollectionLogChange(
    ({ accountId, source }: { accountId: number; source: ClogSource | null }) =>
      apiSend<CollectionLogSyncResponse>('PUT', accountPath(accountId, '/collection-log/source'), {
        body: { source },
        schema: 'collection-log-sync-response',
      }),
  );
}

/** `POST …/collection-log/sync`: "Sync now". The result shows up in `useCollectionLogStatus`. */
export function useSyncCollectionLog() {
  return useCollectionLogChange(({ accountId }: { accountId: number }) =>
    apiSend<CollectionLogSyncResponse>('POST', accountPath(accountId, '/collection-log/sync'), {
      schema: 'collection-log-sync-response',
    }),
  );
}

/** Whether an account has a stored collection log. */
export function hasClogData(status: CollectionLogStatusResponse | undefined): boolean {
  return status !== undefined && status.updatedAt !== null;
}

/**
 * The collection log status of every account: one small call per account (the
 * endpoint does not take `all`), the same queries Settings and the page use.
 * `statuses` is `undefined` until the account list is known. `fresh` asks for
 * everything again on mount, the account list too.
 */
export function useClogStatuses({ fresh = false }: { fresh?: boolean } = {}) {
  const { accounts, ids } = useAccountIds(fresh);
  const queries = usePerAccountQueries(ids, collectionLogStatusQuery, fresh);
  const statuses: (CollectionLogStatusResponse | undefined)[] | undefined = ids?.map(
    (_id, index) => queries[index]?.data,
  );
  return { statuses, ...perAccountState(accounts, statuses !== undefined, queries) };
}

/**
 * Whether any account has a collection log: `true` as soon as one has,
 * `false` when every account answered without one, `undefined` while that is
 * not known. The Collection log page and its menu item exist only when it is
 * `true`.
 */
export function useHasClogData(): boolean | undefined {
  const { statuses, isComplete } = useClogStatuses();
  if (statuses?.some(hasClogData)) return true;
  return isComplete ? false : undefined;
}

/** One account's answers. Either may still be loading. */
export interface AccountQuestStatus {
  accountId: number;
  quests: QuestsResponse | undefined;
  diaries: DiariesResponse | undefined;
}

/** Whether an account has a quest or a diary snapshot. */
export function hasQuestData(status: AccountQuestStatus): boolean {
  return withSnapshot(status.quests) !== undefined || withSnapshot(status.diaries) !== undefined;
}

/**
 * Quests and diaries of every account: one call of each per account, the same
 * queries the page of one account uses. `statuses` is `undefined` until the
 * account list is known. `fresh` asks for everything again on mount, the
 * account list too: an account added since it was cached must be asked as well.
 */
export function useQuestStatuses({ fresh = false }: { fresh?: boolean } = {}) {
  const { accounts, ids } = useAccountIds(fresh);
  const quests = usePerAccountQueries(ids, questsQuery, fresh);
  const diaries = usePerAccountQueries(ids, diariesQuery, fresh);
  const statuses: AccountQuestStatus[] | undefined = ids?.map((accountId, index) => ({
    accountId,
    quests: quests[index]?.data,
    diaries: diaries[index]?.data,
  }));
  return {
    statuses,
    ...perAccountState(accounts, statuses !== undefined, [...quests, ...diaries]),
  };
}

/**
 * Whether any account has quest or diary data: `true` as soon as one answer
 * has a snapshot, `false` when every account answered without one, and
 * `undefined` while that is not known. The Quests & diaries page and its menu
 * item exist only when it is `true`.
 */
export function useHasQuestData(): boolean | undefined {
  const { statuses, isComplete } = useQuestStatuses();
  if (statuses?.some(hasQuestData)) return true;
  return isComplete ? false : undefined;
}

// --- Pets ----------------------------------------------------------------

/**
 * `GET …/pets`: the pets of an account, or of every account for `all`,
 * newest first. Read only: pets come from the collection log and from chat.
 * `status` is the account's collection log status: the pets are read again
 * when a sync has worked since, which is when it can have brought new ones.
 * Meanwhile the same scope's previous pets stay. A failed call is asked again
 * like the quest calls, since the menu depends on it.
 */
export function usePets(
  scope: AccountScope,
  {
    status,
    fresh = false,
    enabled = true,
  }: {
    status?: CollectionLogStatusResponse | undefined;
    fresh?: boolean;
    /** `false` while the status is still on its way, so the pets are asked for once. */
    enabled?: boolean;
  } = {},
) {
  return useQuery({
    queryKey: [
      'pets',
      scope,
      status?.updatedAt ?? null,
      status?.sync?.lastSuccessAt ?? null,
    ] as const,
    enabled,
    ...retryWhileFailed,
    ...freshOption(fresh),
    ...keepPreviousOfSameScope(scope),
    queryFn: ({ signal }) =>
      apiGet<PetsResponse>('pets-response', accountPath(scope, '/pets'), { signal }),
  });
}

/**
 * Whether the Pets page exists: `true` as soon as an account has a pet or a
 * collection log (then the help text about syncing has a use), `false` when
 * no account has either, `undefined` while that is not known.
 */
export function useHasPetsPage(): boolean | undefined {
  const pets = usePets('all');
  const clog = useHasClogData();
  if (clog === true || (pets.data !== undefined && pets.data.pets.length > 0)) return true;
  return clog === false && pets.data !== undefined ? false : undefined;
}

// --- Settings: API keys and rebuild ---------------------------------------------

export const KEYS_KEY = ['keys'] as const;
/** Settings → Users (admin): the user list (with active key counts) and every user's keys. */
export const USERS_KEY = ['users'] as const;
export const ADMIN_KEYS_KEY = ['admin', 'keys'] as const;

/** After the user's own keys change: the admin's lists show them too. */
async function invalidateOwnKeys(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: KEYS_KEY }),
    queryClient.invalidateQueries({ queryKey: USERS_KEY }),
    queryClient.invalidateQueries({ queryKey: ADMIN_KEYS_KEY }),
  ]);
}

/** `GET /keys`: all API keys, oldest first. Never the full key or its hash. */
export function useKeys() {
  return useQuery({
    queryKey: KEYS_KEY,
    queryFn: ({ signal }) => apiGet<KeysResponse>('keys-response', '/keys', { signal }),
  });
}

/** `POST /keys`. The response holds the full key, the only time it is available. */
export function useCreateKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiSend<CreateKeyResponse>('POST', '/keys', {
        body: { name },
        schema: 'create-key-response',
      }),
    onSuccess: () => invalidateOwnKeys(queryClient),
  });
}

/** `DELETE /keys/:id`. Idempotent: an already revoked key also succeeds. */
export function useRevokeKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/keys/${String(id)}`),
    onSuccess: () => invalidateOwnKeys(queryClient),
  });
}

const REBUILD_KEY = ['rebuild'] as const;

/**
 * `GET /admin/backups`: the newest backup, how many are kept, the next run and
 * the last error. Refetched every minute while the tab is open, so a backup
 * that runs meanwhile shows up.
 */
export function useBackupStatus() {
  return useQuery({
    queryKey: ['admin', 'backups'],
    queryFn: ({ signal }) =>
      apiGet<BackupStatusResponse>('backup-status-response', '/admin/backups', { signal }),
    refetchInterval: 60_000,
  });
}

/**
 * `GET /admin/external-sources`: each optional external source, whether it is
 * on, its last fetch and its last error. Refetched every minute, like backups.
 * Admin only: pass `enabled: false` for members.
 */
export function useExternalSources({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['admin', 'external-sources'],
    enabled,
    queryFn: ({ signal }) =>
      apiGet<ExternalSourcesResponse>('external-sources-response', '/admin/external-sources', {
        signal,
      }),
    refetchInterval: 60_000,
  });
}

/**
 * `GET /admin/icons`: how many icons are stored, per kind. Refetched every 5
 * seconds while the plugin is importing (the newest icon is under two minutes
 * old), otherwise every minute like the rest.
 */
export function useIconsStatus() {
  return useQuery({
    queryKey: ['admin', 'icons'],
    queryFn: ({ signal }) =>
      apiGet<IconsStatusResponse>('icons-status-response', '/admin/icons', { signal }),
    refetchInterval: (query) =>
      isImportingIcons(query.state.data?.lastStoredAt ?? null, Date.now()) ? 5_000 : 60_000,
  });
}

/**
 * `POST /admin/rebuild`. Every derived table is rebuilt, so all queries are
 * fetched again afterwards (account IDs stay the same).
 */
export function useRebuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: REBUILD_KEY,
    // `useLatestRebuild` reads the result later; don't let it be collected after 5 min.
    gcTime: Infinity,
    mutationFn: () =>
      apiSend<RebuildResponse>('POST', '/admin/rebuild', { schema: 'rebuild-response' }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

export interface RebuildState {
  status: 'idle' | 'pending' | 'success' | 'error';
  result?: RebuildResponse;
  /** Set when `status` is `error`. */
  error?: unknown;
}

/**
 * The latest rebuild in this tab. Read from the mutation cache, so it survives
 * leaving the Server tab while a rebuild runs (it can take a minute or more).
 */
export function useLatestRebuild(): RebuildState {
  const states = useMutationState({
    filters: { mutationKey: REBUILD_KEY },
    select: (mutation): RebuildState => {
      const { status, data, error } = mutation.state;
      return {
        status,
        ...(data !== undefined ? { result: data as RebuildResponse } : {}),
        ...(error !== null ? { error } : {}),
      };
    },
  });
  return states.at(-1) ?? { status: 'idle' };
}
