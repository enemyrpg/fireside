import { offsetAt, type Session } from '@fireside/shared';

// Positions and clock ticks for `SessionTimeline`.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Drops worth this much or more get a highlighted marker. */
export const BIG_DROP_GP = 1_000_000;

/**
 * End of a session on the timeline: `endedAt`, or for an open session the
 * last heartbeat (`startedAt` + `durationSeconds`, as the server counts it).
 */
export function sessionEndMs(session: Pick<Session, 'startedAt' | 'endedAt' | 'durationSeconds'>) {
  return session.endedAt === null
    ? Date.parse(session.startedAt) + session.durationSeconds * 1000
    : Date.parse(session.endedAt);
}

/**
 * The active stretches of a session: the time between `startMs` and `endMs`
 * not covered by an AFK period. AFK periods may be unsorted, overlap or reach
 * outside the session; they are clipped. Empty stretches are left out.
 */
export function activeSegments(
  startMs: number,
  endMs: number,
  afkPeriods: readonly { startedAt: string; endedAt: string }[],
): { fromMs: number; toMs: number }[] {
  const afk = afkPeriods
    .map((period) => ({
      from: Math.max(startMs, Date.parse(period.startedAt)),
      to: Math.min(endMs, Date.parse(period.endedAt)),
    }))
    .filter((period) => period.to > period.from)
    .sort((a, b) => a.from - b.from);
  const segments: { fromMs: number; toMs: number }[] = [];
  let cursor = startMs;
  for (const period of afk) {
    if (period.from > cursor) segments.push({ fromMs: cursor, toMs: period.from });
    cursor = Math.max(cursor, period.to);
  }
  if (endMs > cursor) segments.push({ fromMs: cursor, toMs: endMs });
  return segments;
}

/** Where `ms` sits between `startMs` and `endMs`, in percent, clamped to 0–100. */
export function positionPercent(ms: number, startMs: number, endMs: number): number {
  const span = Math.max(1, endMs - startMs);
  return Math.min(100, Math.max(0, ((ms - startMs) / span) * 100));
}

/** Tick step for a span: 2 h over 8 h, 1 h over 3 h, 30 min over 1.2 h, else 15 min. */
export function tickStepMs(spanMs: number): number {
  if (spanMs > 8 * HOUR_MS) return 2 * HOUR_MS;
  if (spanMs > 3 * HOUR_MS) return HOUR_MS;
  if (spanMs > 1.2 * HOUR_MS) return 30 * MINUTE_MS;
  return 15 * MINUTE_MS;
}

/**
 * Width of a clock label ("20:30", 11 px tabular figures, about 31 px) and the
 * least room between two labels.
 */
const LABEL_WIDTH_PX = 32;
const LABEL_GAP_PX = 8;

/**
 * How far a tick's centre must be from either end of the timeline for its
 * label to clear the start and end labels: the end label's width, the gap,
 * and half the tick's own label. Measured in px, not percent, since a few
 * percent of a phone-wide timeline is only a few pixels.
 */
export const TICK_EDGE_CLEARANCE_PX = LABEL_WIDTH_PX + LABEL_GAP_PX + LABEL_WIDTH_PX / 2;

/**
 * Clock ticks between `startMs` and `endMs` on whole steps of local time in
 * `timeZone` (18:00, 18:30 …, also in zones with a half-hour offset), for a
 * timeline `widthPx` wide. A tick whose label would come closer than
 * `TICK_EDGE_CLEARANCE_PX` to either end is left out; the ends have their own
 * labels. Without a width (not measured yet) there are no ticks, so labels
 * never overlap for a moment.
 */
export function timelineTicks(
  startMs: number,
  endMs: number,
  timeZone: string,
  widthPx: number | null,
): { ms: number; percent: number }[] {
  if (widthPx === null || widthPx <= 0) return [];
  const step = tickStepMs(endMs - startMs);
  const ticks: { ms: number; percent: number }[] = [];
  const offset = (ms: number) => offsetAt(ms, timeZone);
  const localStart = startMs + offset(startMs);
  for (let local = Math.ceil(localStart / step) * step; ; local += step) {
    // Local time back to UTC, with the offset at that moment (DST may change mid-session).
    const ms = local - offset(local - offset(startMs));
    if (ms > endMs) break;
    const percent = positionPercent(ms, startMs, endMs);
    const px = (percent / 100) * widthPx;
    if (px >= TICK_EDGE_CLEARANCE_PX && widthPx - px >= TICK_EDGE_CLEARANCE_PX) {
      ticks.push({ ms, percent });
    }
  }
  return ticks;
}
