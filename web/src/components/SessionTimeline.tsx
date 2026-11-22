import type { AfkPeriod, SessionClogItem, SessionLoot } from '@fireside/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDuration, formatGp, formatInt } from '@/format';
import { useElementWidth } from '@/hooks/useElementWidth';
import { useFormat } from '@/hooks/useFormat';
import { sourceLabel } from '@/lib/loot';
import { activeSegments, BIG_DROP_GP, positionPercent, timelineTicks } from '@/lib/timeline';
import { cn } from '@/lib/utils';

// Session timeline: an active stripe with AFK periods, loot markers above (1M+
// highlighted), new collection log items as diamonds and clock times below. Takes plain
// data, so Session detail used it first; Home did until 12.9. Tick labels keep clear of
// the start and end labels in px, from the measured width.

export interface SessionTimelineProps {
  startedAt: string;
  /** End of the stripe: `endedAt`, or the last heartbeat while open (`sessionEndMs`). */
  endMs: number;
  /** Open session: the right-hand label says "now". */
  live?: boolean;
  afkPeriods: readonly AfkPeriod[];
  loot: readonly Pick<SessionLoot, 'id' | 'occurredAt' | 'geValue' | 'source' | 'killCount'>[];
  /**
   * New collection log items. An approximate one (found by the sync after the
   * session) sits at the end.
   */
  clogItems?: readonly Pick<SessionClogItem, 'itemId' | 'name' | 'page' | 'at' | 'approximate'>[];
  className?: string;
}

function summary(
  durationMs: number,
  afkCount: number,
  loot: SessionTimelineProps['loot'],
  clogCount: number,
) {
  const big = loot.filter((drop) => drop.geValue >= BIG_DROP_GP).length;
  const parts = [
    `Session timeline, ${formatDuration(durationMs / 1000)}`,
    `${formatInt(afkCount)} AFK ${afkCount === 1 ? 'period' : 'periods'}`,
    `${formatInt(loot.length)} ${loot.length === 1 ? 'drop' : 'drops'}${big > 0 ? ` (${formatInt(big)} worth 1M+ gp)` : ''}`,
  ];
  if (clogCount > 0) {
    parts.push(`${formatInt(clogCount)} new collection log ${clogCount === 1 ? 'item' : 'items'}`);
  }
  return parts.join(', ');
}

export function SessionTimeline({
  startedAt,
  endMs,
  live = false,
  afkPeriods,
  loot,
  clogItems = [],
  className,
}: SessionTimelineProps) {
  const format = useFormat();
  const { attach, width } = useElementWidth();
  const startMs = Date.parse(startedAt);
  const at = (ms: number) => positionPercent(ms, startMs, endMs);
  const ticks = timelineTicks(startMs, endMs, format.timeZone, width);

  return (
    // The marks are a picture; the loot list and tooltips have the details.
    <div
      ref={attach}
      role="img"
      aria-label={summary(endMs - startMs, afkPeriods.length, loot, clogItems.length)}
      className={cn('min-w-0', className)}
    >
      <div className="relative mb-1 h-[22px]">
        {loot.map((drop) => {
          const big = drop.geValue >= BIG_DROP_GP;
          return (
            <Tooltip key={drop.id}>
              <TooltipTrigger asChild>
                <div
                  data-testid={big ? 'drop-marker-big' : 'drop-marker'}
                  className={cn(
                    'absolute bottom-0 -translate-x-1/2',
                    big ? 'h-5 w-[3px] bg-accent-text' : 'h-2.5 w-0.5 bg-text-3',
                  )}
                  style={{ left: `${String(at(Date.parse(drop.occurredAt)))}%` }}
                />
              </TooltipTrigger>
              <TooltipContent>
                <div className="font-semibold">
                  {sourceLabel(drop.source)}
                  {drop.killCount !== null && (
                    <span className="font-normal text-text-2">
                      {' '}
                      · KC {formatInt(drop.killCount)}
                    </span>
                  )}
                </div>
                <div className="tabular-nums">
                  {format.clock(drop.occurredAt)} · {formatGp(drop.geValue)}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
        {clogItems.map((item) => (
          <Tooltip key={`clog-${String(item.itemId)}`}>
            <TooltipTrigger asChild>
              <div
                data-testid={item.approximate ? 'clog-marker-approximate' : 'clog-marker'}
                className={cn(
                  // A 10 px diamond (9 px on mobile) at the top of the lane.
                  'absolute top-0 size-[9px] -translate-x-1/2 rotate-45 desk:size-2.5',
                  item.approximate ? 'border-[1.5px] border-info bg-card' : 'bg-info',
                )}
                style={{ left: `${String(at(Date.parse(item.at)))}%` }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <div className="font-semibold">{item.name}</div>
              <div className="text-text-2">New collection log · {item.page}</div>
              <div className="tabular-nums">
                {item.approximate
                  ? `Found by the sync after the session, ${format.clock(item.at)}`
                  : format.clock(item.at)}
              </div>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="relative h-7 overflow-hidden rounded-md bg-active">
        {/* The stripe is active underneath; these give the active stretches a tooltip too. */}
        {activeSegments(startMs, endMs, afkPeriods).map((segment) => (
          <Tooltip key={`active-${String(segment.fromMs)}`}>
            <TooltipTrigger asChild>
              <div
                data-testid="active-period"
                className="absolute inset-y-0"
                style={{
                  left: `${String(at(segment.fromMs))}%`,
                  width: `${String(at(segment.toMs) - at(segment.fromMs))}%`,
                }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <div className="font-semibold">Active</div>
              <div className="tabular-nums">
                {format.clock(segment.fromMs)}–
                {live && segment.toMs === endMs ? 'now' : format.clock(segment.toMs)} ·{' '}
                {formatDuration((segment.toMs - segment.fromMs) / 1000)}
              </div>
            </TooltipContent>
          </Tooltip>
        ))}
        {afkPeriods.map((period) => {
          const from = Date.parse(period.startedAt);
          const to = Date.parse(period.endedAt);
          return (
            <Tooltip key={period.startedAt}>
              <TooltipTrigger asChild>
                <div
                  data-testid="afk-period"
                  className="absolute inset-y-0 border-x-2 border-card bg-afk"
                  style={{ left: `${String(at(from))}%`, width: `${String(at(to) - at(from))}%` }}
                />
              </TooltipTrigger>
              <TooltipContent>
                <div className="font-semibold">AFK</div>
                <div className="tabular-nums">
                  {format.clock(from)}–{format.clock(to)} · {formatDuration((to - from) / 1000)}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="relative h-[18px] text-axis text-text-3 tabular-nums">
        <span className="absolute top-1 left-0">{format.clock(startMs)}</span>
        {ticks.map((tick) => (
          <span
            key={tick.ms}
            className="absolute top-1 -translate-x-1/2"
            style={{ left: `${String(tick.percent)}%` }}
          >
            {format.clock(tick.ms)}
          </span>
        ))}
        <span className="absolute top-1 right-0">{live ? 'now' : format.clock(endMs)}</span>
      </div>
    </div>
  );
}

/**
 * Legend for the timeline, for the card header. "New collection log" only when
 * the session has some.
 */
export function SessionTimelineLegend({
  className,
  clog = false,
}: {
  className?: string;
  clog?: boolean;
}) {
  const item = 'inline-flex items-center gap-1.5';
  return (
    <div className={cn('flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-text-2', className)}>
      <span className={item}>
        <i aria-hidden="true" className="size-2.5 rounded-[3px] bg-active" />
        Active
      </span>
      <span className={item}>
        <i aria-hidden="true" className="size-2.5 rounded-[3px] bg-afk" />
        AFK
      </span>
      <span className={item}>
        <i aria-hidden="true" className="h-2.5 w-0.5 bg-text-3" />
        Drop
      </span>
      <span className={item}>
        <i aria-hidden="true" className="h-2.5 w-[3px] bg-accent-text" />
        Drop ≥ 1M
      </span>
      {clog && (
        <span className="inline-flex items-center gap-[7px]">
          <i aria-hidden="true" className="size-2 rotate-45 bg-info" />
          New collection log
        </span>
      )}
    </div>
  );
}
