import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// An account is (user, account hash): the same hash under two
// users is two accounts. So a query that picks rows of `events`, `accounts`
// or `account_ids` by account hash must also pick the user, or it can mix two
// users' data. This test reads the server's source and fails on a `where`
// that filters one of those tables by hash without a user filter in the same
// `where`. It is a guard against mistakes, not a proof: it only sees the
// Drizzle query builder and raw SQL written in the usual way.

const SRC = join(import.meta.dirname, '..');

const TABLES = ['events', 'accounts', 'accountIds'];
/** A filter on a table's account hash, e.g. `eq(events.accountHash, …)`. */
const HASH_FILTER = new RegExp(
  `\\b(?:eq|ne|inArray|notInArray|like)\\(\\s*(${TABLES.join('|')})\\.accountHash\\b`,
  'g',
);
/** The same in raw SQL: `account_hash = ?`, `account_hash IN (…)`. */
const RAW_HASH_FILTER = /\baccount_hash\s*(?:=|IN\b)/gi;

/** Index of the `)` that closes the `(` at `open`, or -1. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The arguments of the `.where(…)` call around `index`, or `undefined` if it is in none. */
function enclosingWhere(text: string, index: number): string | undefined {
  let from = index;
  for (;;) {
    const start = text.lastIndexOf('.where(', from);
    if (start === -1) return undefined;
    const open = start + '.where'.length;
    const close = closingParen(text, open);
    if (close > index) return text.slice(open, close + 1);
    from = start - 1;
  }
}

interface UnownedFilter {
  line: number;
  text: string;
}

/** Filters by account hash in `source` whose `where` has no user filter. */
function unownedHashFilters(source: string): UnownedFilter[] {
  const found: UnownedFilter[] = [];
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  for (const match of source.matchAll(HASH_FILTER)) {
    const where = enclosingWhere(source, match.index);
    const table = match[1] ?? '';
    // Any user filter in the same where counts: `eq(accounts.userId, …)` or a
    // join's other table, e.g. `eq(events.userId, …)` when filtering events.
    const owned =
      where !== undefined && new RegExp(`\\b(?:${TABLES.join('|')})\\.userId\\b`).test(where);
    if (!owned) found.push({ line: lineOf(match.index), text: `${table}.accountHash` });
  }
  for (const match of source.matchAll(RAW_HASH_FILTER)) {
    // The SQL statement: from the quote or backtick before to the one after.
    const before = Math.max(
      source.lastIndexOf('`', match.index),
      source.lastIndexOf("'", match.index),
    );
    const statementStart = Math.max(0, source.lastIndexOf('(', before));
    const statement = source.slice(statementStart, source.indexOf(')', match.index) + 200);
    if (!/\buser_id\b/i.test(statement)) {
      found.push({ line: lineOf(match.index), text: match[0] });
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const isCode = entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts');
    // Tests and test helpers may look up by hash on purpose.
    const isTest = entry.name.endsWith('.test.ts') || entry.name === 'testing.ts';
    return isCode && !isTest ? [path] : [];
  });
}

describe('queries by account hash', () => {
  it('always filter by user too, in every server source file', () => {
    const problems = sourceFiles(SRC).flatMap((file) =>
      unownedHashFilters(readFileSync(file, 'utf8')).map(
        ({ line, text }) =>
          `${relative(SRC, file)}:${String(line)} filters on ${text} without a user`,
      ),
    );
    expect(problems).toEqual([]);
  });

  it('scans a meaningful number of files', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(50);
  });

  describe('the checker', () => {
    it('flags a hash filter without a user filter', () => {
      const source = `
        tx.select().from(events)
          .where(and(eq(events.accountHash, hash), eq(events.type, 'kc')))
          .all();
        db.select().from(accounts).where(eq(accounts.accountHash, hash)).get();
        db.select().from(accountIds).where(inArray(accountIds.accountHash, hashes)).all();
        sqlite.prepare('SELECT id FROM accounts WHERE account_hash = ?').get(hash);
      `;
      expect(unownedHashFilters(source).map((problem) => problem.text)).toEqual([
        'events.accountHash',
        'accounts.accountHash',
        'accountIds.accountHash',
        'account_hash =',
      ]);
    });

    it('accepts a hash filter with a user filter in the same where', () => {
      const source = `
        tx.select().from(events)
          .where(
            and(
              eq(events.userId, userId),
              eq(events.accountHash, hash),
              or(isNotNull(events.processedAt), eq(events.eventId, id)),
            ),
          )
          .all();
        db.select().from(accounts).where(and(eq(accounts.userId, 1), eq(accounts.accountHash, h))).get();
        sqlite.prepare('SELECT id FROM accounts WHERE user_id = ? AND account_hash = ?').get(1, h);
      `;
      expect(unownedHashFilters(source)).toEqual([]);
    });

    it('does not count a user filter in another where', () => {
      const source = `
        db.select().from(accounts).where(eq(accounts.userId, 1)).all();
        db.select().from(accounts).where(eq(accounts.accountHash, h)).all();
      `;
      expect(unownedHashFilters(source)).toHaveLength(1);
    });

    it('ignores sorting and selecting by hash', () => {
      const source = `
        db.select({ hash: accounts.accountHash }).from(accounts)
          .orderBy(asc(accounts.userId), asc(accounts.accountHash)).all();
      `;
      expect(unownedHashFilters(source)).toEqual([]);
    });
  });
});

// The read layer only ever gets the account IDs a route resolved for the
// logged-in user (routes/account-scope.ts). So below `routes/`:
// - no `AccountScope` and no `'all'`: "every account" can't be expressed;
// - a query on `accounts` filters on the user or on given account IDs;
// - a lookup of a session by its ID also filters on the account IDs, so
//   another user's session is not found.
// Like the check above, a guard against mistakes, not a proof.

const READ_DIR = join(SRC, 'read');

/** Statements in `source` that read `accounts` without a user or ID filter. */
function unownedAccountQueries(source: string): UnownedFilter[] {
  const found: UnownedFilter[] = [];
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  for (const match of source.matchAll(/\.from\(accounts\)/g)) {
    const end = source.indexOf(';', match.index);
    const statement = source.slice(match.index, end === -1 ? undefined : end);
    const whereAt = statement.indexOf('.where(');
    const where = whereAt === -1 ? undefined : enclosingWhere(statement, whereAt + 7);
    if (where === undefined || !/\baccounts\.(?:userId|id)\b/.test(where)) {
      found.push({ line: lineOf(match.index), text: '.from(accounts)' });
    }
  }
  return found;
}

/** `where`s that look up `sessions.id` without filtering `sessions.accountId`. */
function unownedSessionLookups(source: string): UnownedFilter[] {
  const found: UnownedFilter[] = [];
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  for (const match of source.matchAll(/\beq\(\s*sessions\.id\s*,/g)) {
    const where = enclosingWhere(source, match.index);
    // Outside a where it is a join condition, not a lookup.
    if (where !== undefined && !/\bsessions\.accountId\b/.test(where)) {
      found.push({ line: lineOf(match.index), text: 'eq(sessions.id, …)' });
    }
  }
  return found;
}

/** `AccountScope` or `'all'` in read code. */
function scopeMentions(source: string): UnownedFilter[] {
  const found: UnownedFilter[] = [];
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  for (const match of source.matchAll(/\bAccountScope\b|'all'/g)) {
    found.push({ line: lineOf(match.index), text: match[0] });
  }
  return found;
}

describe('the read layer', () => {
  const files = () => sourceFiles(READ_DIR);

  it.each([
    ['takes owned account IDs, never a scope or all', scopeMentions],
    ['reads accounts only by user or account ID', unownedAccountQueries],
    ['finds a session by ID only among the given accounts', unownedSessionLookups],
  ])('%s', (_name, check) => {
    const problems = files().flatMap((file) =>
      check(readFileSync(file, 'utf8')).map(
        ({ line, text }) => `${relative(SRC, file)}:${String(line)}: ${text}`,
      ),
    );
    expect(problems).toEqual([]);
  });

  it('scans every read module', () => {
    expect(files().length).toBeGreaterThan(15);
  });

  describe('the checkers', () => {
    it('flag a scope, an unfiltered accounts query and a bare session lookup', () => {
      const source = `
        export function pets(db: Queryable, scope: AccountScope) {
          return scope === 'all' ? all(db) : one(db, scope);
        }
        db.select().from(accounts).all();
        db.select().from(accounts).where(eq(accounts.accountHash, h)).all();
        db.select().from(sessions).where(eq(sessions.id, id)).get();
      `;
      expect(scopeMentions(source).map((p) => p.text)).toEqual(['AccountScope', "'all'"]);
      expect(unownedAccountQueries(source)).toHaveLength(2);
      expect(unownedSessionLookups(source)).toHaveLength(1);
    });

    it('accept owned filters and join conditions', () => {
      const source = `
        db.select().from(accounts).where(eq(accounts.userId, userId)).all();
        db.select().from(accounts).where(inArray(accounts.id, ids)).all();
        db.select()
          .from(sessions)
          .leftJoin(summaries, eq(summaries.sessionId, sessions.id))
          .where(and(eq(sessions.id, id), inArray(sessions.accountId, ids)))
          .get();
        db.select().from(beats).innerJoin(sessions, eq(sessions.id, beats.sessionId)).all();
      `;
      expect(unownedAccountQueries(source)).toEqual([]);
      expect(unownedSessionLookups(source)).toEqual([]);
    });
  });
});
