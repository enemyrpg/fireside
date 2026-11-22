// Plain constants with no Zod import, so the dashboard can use them without
// pulling Zod into the production bundle.

/** Presets for `GET /api/v1/accounts/:accountId/gains?period=`. */
export const GAINS_PERIODS = ['day', 'week', 'month', 'year'] as const;

export type GainsPeriod = (typeof GAINS_PERIODS)[number];
