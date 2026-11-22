import { describe, expect, it } from 'vitest';
import { continuesHop, HOP_MERGE_MS } from './sessions.js';

describe('continuesHop', () => {
  const hop = { accountId: 1, endReason: 'hop', endedAt: '2026-11-08T20:00:00.000Z' };
  const at = (ms: number) => new Date(Date.parse(hop.endedAt) + ms).toISOString();

  it('joins the same account’s next session under 2 minutes after a hop', () => {
    expect(HOP_MERGE_MS).toBe(120_000);
    expect(continuesHop(hop, { accountId: 1, startedAt: at(HOP_MERGE_MS - 1) })).toBe(true);
    expect(continuesHop(hop, { accountId: 1, startedAt: at(HOP_MERGE_MS) })).toBe(false);
  });

  it('needs a hop and the same account', () => {
    expect(continuesHop({ ...hop, endReason: 'logout' }, { accountId: 1, startedAt: at(1) })).toBe(
      false,
    );
    expect(continuesHop({ ...hop, endedAt: null }, { accountId: 1, startedAt: at(1) })).toBe(false);
    expect(continuesHop(hop, { accountId: 2, startedAt: at(1) })).toBe(false);
  });
});
