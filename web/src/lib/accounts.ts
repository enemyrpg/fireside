import type { AccountScope, AccountSummary } from '@fireside/shared';
import { formatAccountType } from '@/format';
import { isSessionLive } from './session-stats';
import { readStorage, writeStorage } from './storage';

// Account helpers shared by the shell and pages.

/** Settings → OSRS accounts, where an account's collection log source is turned on. */
export const SETTINGS_ACCOUNTS_PATH = '/settings/accounts';

/** `localStorage` key for the last chosen account (`all` or an ID). */
export const LAST_ACCOUNT_KEY = 'lastAccount';

/** Account colours `--acc-1` … `--acc-5`; from the sixth account on, "Other" (`--afk`). */
export const ACCOUNT_COLOR_COUNT = 5;

/** Parses `:acc` from the URL: `all` or a positive whole number. `null` for anything else. */
export function parseScope(value: string | undefined): AccountScope | null {
  if (value === 'all') return 'all';
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  // Larger numbers lose precision, so they would name a different account.
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Colour of an account: by ascending account ID, never by rank or position on
 * the page, so it is the same everywhere. Returns a CSS colour (`var(--acc-2)`).
 */
export function accountColor(accountId: number, accounts: readonly { id: number }[]): string {
  return accountColors(accounts).get(accountId) ?? OTHER_COLOR;
}

/** Colour for accounts from the sixth on, and for IDs not in the list. */
const OTHER_COLOR = 'var(--afk)';

/**
 * Every account's colour (see `accountColor`) at once, for pages that colour
 * many rows: one sort instead of one per dot. IDs not in the map get `--afk`.
 */
export function accountColors(accounts: readonly { id: number }[]): ReadonlyMap<number, string> {
  const ids = accounts.map((account) => account.id).sort((a, b) => a - b);
  return new Map(
    ids.map((id, index) => [
      id,
      index < ACCOUNT_COLOR_COUNT ? `var(--acc-${String(index + 1)})` : OTHER_COLOR,
    ]),
  );
}

/** Name to show. Accounts seen before their first `session.start` have none yet. */
export function accountName(account: Pick<AccountSummary, 'displayName'>): string {
  return account.displayName ?? 'Unknown account';
}

/**
 * Name of an account by ID. An ID missing from the list (an account added
 * after the list was loaded) shows as `Account 123`.
 */
export function accountNameById(
  accountId: number,
  accounts: readonly Pick<AccountSummary, 'id' | 'displayName'>[],
): string {
  const account = accounts.find((item) => item.id === accountId);
  return account ? accountName(account) : `Account ${String(accountId)}`;
}

/**
 * What every account card shows about its account (`AccountCards`, for `all`
 * on Bank and Quests & diaries): name, colour, and the account type as text,
 * left out when unknown or a normal account.
 */
export function accountCardInfo(
  accountId: number,
  accounts: readonly Pick<AccountSummary, 'id' | 'displayName' | 'accountType'>[],
): { accountId: number; name: string; color: string; type: string | undefined } {
  const account = accounts.find((item) => item.id === accountId);
  return {
    accountId,
    name: accountNameById(accountId, accounts),
    color: accountColor(accountId, accounts),
    type:
      account?.accountType != null && account.accountType !== 'NORMAL'
        ? formatAccountType(account.accountType)
        : undefined,
  };
}

/**
 * How long after the last heartbeat (sent every 60 s) an account can still
 * count as online. Covers a killed client, whose session stays open until the
 * server's timeout closes it.
 */
export const ONLINE_WINDOW_MS = 3 * 60_000;

/**
 * Online: a heartbeat within `ONLINE_WINDOW_MS`, and the newest session still
 * live (open, or ended by a hop under 2 minutes ago; `isSessionLive`). A
 * logout shows as offline as soon as the accounts list has the ended session.
 * See "Online" in docs/design.md.
 */
export function isOnline(
  account: Pick<AccountSummary, 'lastSeenAt' | 'latestSession'>,
  now: number,
): boolean {
  return (
    now - Date.parse(account.lastSeenAt) < ONLINE_WINDOW_MS &&
    account.latestSession !== null &&
    isSessionLive(account.latestSession, now)
  );
}

/**
 * For `useAccounts({ live })`: keep polling while any account shows as online,
 * so a logout turns into offline within one poll. Read with the current clock
 * after every fetch.
 */
export function anyOnline(data: { accounts: readonly AccountSummary[] } | undefined): boolean {
  const now = Date.now();
  return (data?.accounts ?? []).some((account) => isOnline(account, now));
}

export function readLastAccount(): AccountScope | null {
  return parseScope(readStorage(LAST_ACCOUNT_KEY) ?? undefined);
}

export function storeLastAccount(scope: AccountScope): void {
  writeStorage(LAST_ACCOUNT_KEY, String(scope));
}

/** Replaces the account segment of an account path (`/1/sessions?x` -> `/all/sessions?x`). */
export function switchAccountPath(pathname: string, search: string, scope: AccountScope): string {
  const rest = pathname.split('/').slice(2).join('/');
  return `/${String(scope)}${rest ? `/${rest}` : ''}${search}`;
}

/**
 * Account scope around a session's detail page (shell, menu links, "← Sessions"):
 * `all` when that was the last choice (the user came from the combined list),
 * otherwise the session's own account, not whichever account was chosen last.
 */
export function sessionScope(sessionAccountId: number, last: AccountScope | null): AccountScope {
  return last === 'all' ? 'all' : sessionAccountId;
}
