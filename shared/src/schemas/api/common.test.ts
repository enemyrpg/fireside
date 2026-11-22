import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { schemaAsserts } from '../../test-utils.js';
import {
  accountParamsSchema,
  accountScopeParamsSchema,
  apiLootSourceSchema,
  errorResponseSchema,
  isoWeekSchema,
  localDateSchema,
  paginated,
  paginationQuerySchema,
  yearMonthSchema,
} from './common.js';

describe('account params', () => {
  const scope = schemaAsserts(accountScopeParamsSchema);
  const single = schemaAsserts(accountParamsSchema);

  it('accepts "all" and a numeric id as scope', () => {
    expect(scope.accepts({ accountId: 'all' })).toEqual({ accountId: 'all' });
    expect(scope.accepts({ accountId: '12' })).toEqual({ accountId: 12 });
  });

  it.each(['0', '-1', 'abc', '', '1.5', 'ALL', '01', '1.0', '1e0', '0x1', ' 1', '1 '])(
    'rejects scope %j',
    (accountId) => {
      scope.rejects({ accountId });
    },
  );

  it('does not accept "all" for a single account', () => {
    single.rejects({ accountId: 'all' });
    expect(single.accepts({ accountId: '3' })).toEqual({ accountId: 3 });
  });

  it('rejects unknown params', () => {
    scope.rejects({ accountId: '1', other: 'x' });
  });
});

describe('date and period keys', () => {
  it.each(['2026-11-09', '2024-02-29'])('accepts local date %s', (value) => {
    schemaAsserts(localDateSchema).accepts(value);
  });

  it.each(['2026-11-9', '2026-13-01', '2026-11-09T00:00:00.000Z', '2025-02-29'])(
    'rejects local date %s',
    (value) => {
      schemaAsserts(localDateSchema).rejects(value);
    },
  );

  it.each(['2026-W01', '2026-W45', '2026-W53', '2020-W53', '2015-W53'])(
    'accepts ISO week %s',
    (value) => {
      schemaAsserts(isoWeekSchema).accepts(value);
    },
  );

  it.each(['2026-W00', '2026-W54', '2026-W5', '2026W45', '2026-w45', '2025-W53', '2024-W53'])(
    'rejects ISO week %s',
    (value) => {
      schemaAsserts(isoWeekSchema).rejects(value);
    },
  );

  it.each(['2026-01', '2026-12'])('accepts month %s', (value) => {
    schemaAsserts(yearMonthSchema).accepts(value);
  });

  it.each(['2026-00', '2026-13', '2026-1'])('rejects month %s', (value) => {
    schemaAsserts(yearMonthSchema).rejects(value);
  });
});

describe('pagination', () => {
  const query = schemaAsserts(paginationQuerySchema);

  it('defaults limit to 50', () => {
    expect(query.accepts({})).toEqual({ limit: 50 });
  });

  it('coerces limit from a query string', () => {
    expect(query.accepts({ limit: '100', cursor: 'abc' })).toEqual({ limit: 100, cursor: 'abc' });
  });

  it.each(['0', '101', '1.5', 'many', '', '050'])('rejects limit %j', (limit) => {
    expect(query.issuePaths({ limit })).toContain('limit');
  });

  it('rejects an empty cursor', () => {
    expect(query.issuePaths({ cursor: '' })).toContain('cursor');
  });

  const page = schemaAsserts(paginated(z.strictObject({ n: z.int() })));

  it('accepts a page with and without a next cursor', () => {
    page.accepts({ items: [{ n: 1 }], nextCursor: 'next' });
    page.accepts({ items: [], nextCursor: null });
  });

  it('requires nextCursor', () => {
    expect(page.issuePaths({ items: [] })).toContain('nextCursor');
  });

  it('rejects extra keys and invalid items', () => {
    page.rejects({ items: [], nextCursor: null, total: 3 });
    page.rejects({ items: [{ n: 'x' }], nextCursor: null });
  });
});

describe('error response', () => {
  const error = schemaAsserts(errorResponseSchema);
  const valid = {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid query',
      details: [{ path: 'limit', message: 'Too big' }],
    },
  };

  it('accepts the documented format', () => {
    error.accepts(valid);
    error.accepts({ error: { code: 'NOT_FOUND', message: 'No such account', details: [] } });
  });

  it('rejects an unknown code', () => {
    error.rejects({ error: { ...valid.error, code: 'TEAPOT' } });
  });

  it('requires details', () => {
    error.rejects({ error: { code: 'NOT_FOUND', message: 'x' } });
  });

  it('rejects extra keys', () => {
    error.rejects({ ...valid, status: 400 });
    error.rejects({ error: { ...valid.error, stack: '...' } });
  });
});

describe('loot source in responses', () => {
  const source = schemaAsserts(apiLootSourceSchema);

  it('accepts PLAYER without a name', () => {
    source.accepts({ type: 'PLAYER', name: null });
  });

  it('rejects PLAYER with a name', () => {
    source.rejects({ type: 'PLAYER', name: 'Test Main' });
  });

  it.each(['NPC', 'EVENT', 'CLUE', 'OTHER'])('requires a name for %s', (type) => {
    source.accepts({ type, name: 'Something' });
    source.rejects({ type, name: null });
    source.rejects({ type, name: '' });
  });

  it('rejects npcId and unknown types', () => {
    source.rejects({ type: 'NPC', name: 'Vorkath', npcId: 8061 });
    source.rejects({ type: 'BOSS', name: 'Vorkath' });
  });
});
