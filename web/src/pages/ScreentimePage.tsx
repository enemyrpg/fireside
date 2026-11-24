import type { ScreentimeResponse, ScreentimeWorldsResponse, WorldTime } from '@fireside/shared';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useScreentime, useScreentimeHeatmap, useScreentimeWorlds } from '@/api/hooks';
import type { CSSProperties } from 'react';
import { DataTable, type Column } from '@/components/DataTable';
import { Delta } from '@/components/Delta';
import { HBarList } from '@/components/HBarList';
import { HeatScale, HourHeatmap } from '@/components/HourHeatmap';
import { QueryCard } from '@/components/QueryCard';
import { SegmentedFilter } from '@/components/Segmented';
import { ShowAllButton } from '@/components/ShowAll';
import { PageControls } from '@/components/shell/PageControls';
import { StackedBars, StackedBarsLegend, type StackedBar } from '@/components/StackedBars';
import { EmptyState, ErrorState } from '@/components/states';
import { StatStrip, type StatStripItem } from '@/components/StatStrip';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  formatAxisDate,
  formatAxisDay,
  formatAxisWeekday,
  formatDuration,
  formatInt,
  formatIsoWeek,
  formatLocation,
  formatPercent,
  isoWeekStart,
  type Formatter,
} from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useShowAll } from '@/hooks/useShowAll';
import { useLocalToday } from '@/hooks/useLocalToday';
import { useParamsOfData } from '@/hooks/useParamsOfData';
import { heatFacts, heatmapWidth, type HeatFact } from '@/lib/heat';
import { lastDaysRange } from '@/lib/time';
import { useAccountScope } from '@/routing/useAccountScope';
import {
  locationRows,
  mostPlayedBucket,
  parseScreentimeRange,
  periodsPlayed,
  RANGE_SPEC,
  worldTypeRows,
  worldTypesLabel,
  type ScreentimeRange,
  type TimeRow,
} from './screentime/rows';

// Screen time: four numbers in a `StatStrip`, active/AFK bars per day (7 and 30
// days) or week (90 days) next to when you play (heatmap), then worlds next to
// world types and locations. `?range=7d|30d|90d`, default 30 days. Active/AFK
// only: account colours never appear on this page.

const RANGE_OPTIONS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
] as const satisfies readonly { value: ScreentimeRange; label: string }[];

function rangeDays(range: ScreentimeRange): string {
  return `${String(RANGE_SPEC[range].days)} days`;
}

function emptyText(range: ScreentimeRange): string {
  return `No play time in the last ${rangeDays(range)}.`;
}

type ScreentimeQuery = ReturnType<typeof useScreentime>;
type WorldsQuery = ReturnType<typeof useScreentimeWorlds>;
type HeatmapQuery = ReturnType<typeof useScreentimeHeatmap>;

// --- Big numbers ----------------------------------------------------------------

function statItems(data: ScreentimeResponse, range: ScreentimeRange): StatStripItem[] {
  const { totals, stats, previous, buckets, bucket } = data;
  const played = periodsPlayed(buckets);
  const unit = bucket === 'week' ? 'weeks' : 'days';
  return [
    {
      key: 'played',
      value: formatDuration(totals.playedSeconds),
      label: `play time · last ${rangeDays(range)}`,
      // `previous` is null without any play time before the range (e.g. a new
      // install): a change against that would look like a jump, so none is shown.
      ...(previous === null
        ? {}
        : {
            note: (
              <Delta
                current={totals.playedSeconds}
                previous={previous.playedSeconds}
                format={formatDuration}
                comparedTo={`previous ${rangeDays(range)}`}
              />
            ),
          }),
    },
    {
      key: 'average',
      value: formatDuration(stats.averagePerDaySeconds),
      label: `average per day · ${String(played)} of ${String(buckets.length)} ${unit} played`,
      shortLabel: 'avg per day',
    },
    {
      key: 'sessions',
      value: formatInt(stats.sessionCount),
      label:
        stats.sessionCount > 0
          ? `sessions · avg ${formatDuration(stats.averageSessionSeconds)} · longest ${formatDuration(stats.longestSessionSeconds)}`
          : 'sessions',
      shortLabel: 'sessions',
    },
    {
      key: 'afk',
      value: formatPercent(stats.afkShare),
      label: `AFK · ${formatDuration(totals.afkSeconds)}`,
      shortLabel: 'AFK',
    },
  ];
}

function Summary({ screentime, range }: { screentime: ScreentimeQuery; range: ScreentimeRange }) {
  return (
    <StatStrip
      label="Screen time summary"
      items={screentime.data ? statItems(screentime.data, range) : undefined}
      error={
        !screentime.data && screentime.isError ? (
          <ErrorState onRetry={() => void screentime.refetch()} />
        ) : undefined
      }
    />
  );
}

// --- Play time per day or week -------------------------------------------------------

/** Bars from the response. Labels follow the response's own `bucket`, not the URL. */
function toBars(data: ScreentimeResponse, format: Formatter) {
  // Weekday names fit up to a week of days; longer ranges show the day of the month.
  const weekdays = data.buckets.length <= 7;
  // A week bucket can start before `from` (only days from `from` are counted),
  // so the first bar starts at the range's first day, not at Monday.
  const firstDay = format.localDateOf(data.from);
  return data.buckets.map((bucket): StackedBar => {
    let label: string;
    let title: string;
    if (data.bucket === 'week') {
      const monday = isoWeekStart(bucket.period);
      const start = monday < firstDay ? firstDay : monday;
      label = formatAxisDate(start);
      title = `${formatIsoWeek(bucket.period)} · from ${format.localDate(start)}`;
    } else {
      label = weekdays ? formatAxisWeekday(bucket.period) : formatAxisDay(bucket.period);
      title = format.localDate(bucket.period);
    }
    return {
      key: bucket.period,
      label,
      title,
      activeSeconds: bucket.activeSeconds,
      afkSeconds: bucket.afkSeconds,
    };
  });
}

const BAR_COLUMNS: readonly Column<StackedBar>[] = [
  { id: 'period', header: 'Period', cell: (bar) => bar.title },
  {
    id: 'active',
    header: 'Active',
    align: 'right',
    cell: (bar) => formatDuration(bar.activeSeconds),
  },
  { id: 'afk', header: 'AFK', align: 'right', cell: (bar) => formatDuration(bar.afkSeconds) },
  {
    id: 'total',
    header: 'Total',
    align: 'right',
    cell: (bar) => formatDuration(bar.activeSeconds + bar.afkSeconds),
  },
];

function PlaytimeCard({
  screentime,
  range,
  className,
}: {
  screentime: ScreentimeQuery;
  range: ScreentimeRange;
  className?: string;
}) {
  const format = useFormat();
  const desktop = useIsDesktop();
  const [asTable, setAsTable] = useState(false);
  const per = RANGE_SPEC[range].bucket === 'week' ? 'week' : 'day';
  // The legend and the table toggle belong to bars: hidden on empty and error,
  // kept while loading so the header doesn't jump.
  const hasBars = screentime.data ? screentime.data.totals.playedSeconds > 0 : !screentime.isError;
  const tableToggle = (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={asTable}
      className="max-desk:h-11"
      onClick={() => {
        setAsTable((value) => !value);
      }}
    >
      {asTable ? 'Show as chart' : 'Show as table'}
    </Button>
  );
  return (
    <QueryCard
      query={screentime}
      title={`Play time per ${per}`}
      action={
        hasBars && (
          <>
            <StackedBarsLegend className="mr-2" />
            {/* On mobile under the chart: the header has no room for it. */}
            {desktop && tableToggle}
          </>
        )
      }
      skeletonLines={6}
      {...(className === undefined ? {} : { className })}
    >
      {(data) => {
        if (data.totals.playedSeconds === 0) {
          return <EmptyState className="min-h-[220px]">{emptyText(range)}</EmptyState>;
        }
        const bars = toBars(data, format);
        const top = mostPlayedBucket(data.buckets);
        const topBar = top && bars.find((bar) => bar.key === top.period);
        return (
          <>
            {asTable ? (
              <DataTable
                label={`Play time per ${per}, last ${rangeDays(range)}`}
                columns={BAR_COLUMNS}
                rows={bars}
                rowKey={(bar) => bar.key}
              />
            ) : (
              <StackedBars
                bars={bars}
                dateLabels={data.bucket === 'week'}
                label={`Active and AFK play time per ${per}, last ${rangeDays(range)}`}
              />
            )}
            <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3">
              {topBar && (
                <span className="text-xs text-text-3">
                  Most on {topBar.title} ·{' '}
                  {formatDuration(topBar.activeSeconds + topBar.afkSeconds)}
                </span>
              )}
              {!desktop && tableToggle}
            </div>
          </>
        );
      }}
    </QueryCard>
  );
}

// --- Heatmap ---------------------------------------------------------------------------

/** A number above the heatmap: "Sunday" over "day with most play time · 27 h 45 min". */
function HeatFactView({ fact }: { fact: HeatFact }) {
  return (
    <div className="flex flex-col">
      <span className="font-display text-xl font-semibold whitespace-nowrap desk:text-tile">
        {fact.value}
      </span>
      <span className="text-xs text-text-3">
        {fact.what} · {fact.duration}
      </span>
    </div>
  );
}

function HeatmapCard({
  range,
  query,
  className,
  style,
}: {
  range: ScreentimeRange;
  query: HeatmapQuery;
  className?: string;
  style?: CSSProperties;
}) {
  const format = useFormat();
  const desktop = useIsDesktop();
  return (
    <QueryCard
      query={query}
      title="When you play"
      action={
        <span className="text-xs text-text-3">
          {desktop ? `Local time (${format.timeZone})` : '2-hour blocks'}
        </span>
      }
      skeletonLines={7}
      {...(className === undefined ? {} : { className })}
      {...(style === undefined ? {} : { style })}
    >
      {(data) => {
        // Sums per weekday and per hour (PC) or two-hour block (mobile, as the
        // grid shows it), the earliest on a tie.
        const facts = heatFacts(data.cells, desktop ? 1 : 2);
        if (!facts) {
          return <EmptyState className="min-h-[200px]">{emptyText(range)}</EmptyState>;
        }
        return (
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-wrap items-end justify-between gap-x-7 gap-y-3">
              <div className="flex gap-6 desk:gap-7">
                <HeatFactView fact={facts.day} />
                <HeatFactView fact={facts.hour} />
              </div>
              <HeatScale />
            </div>
            <HourHeatmap cells={data.cells} layout={desktop ? 'hours' : 'twoHours'} />
          </div>
        );
      }}
    </QueryCard>
  );
}

// --- World types and locations --------------------------------------------------------------

/** Every row: `HBarList` shows six, then "Show all (n)" (no "Other" row). */
function timeBars(rows: readonly TimeRow[]) {
  return rows.map((row) => ({ key: row.key, label: row.label, value: row.seconds }));
}

function TypesCard({
  worlds,
  range,
  className,
}: {
  worlds: WorldsQuery;
  range: ScreentimeRange;
  className?: string;
}) {
  return (
    <QueryCard
      query={worlds}
      title="World types"
      skeletonLines={6}
      {...(className === undefined ? {} : { className })}
    >
      {(data) => {
        const total = data.worlds.reduce((sum, world) => sum + world.seconds, 0);
        if (total === 0) {
          return <EmptyState className="min-h-[200px]">{emptyText(range)}</EmptyState>;
        }
        return (
          <>
            <HBarList
              label="Play time per world type"
              rows={timeBars(worldTypeRows(data.worldTypes, total))}
              format={formatDuration}
            />
            <h2 className="mt-5 mb-2 text-base font-semibold">Locations</h2>
            <HBarList
              label="Play time per world location"
              rows={timeBars(locationRows(data.locations))}
              format={formatDuration}
            />
          </>
        );
      }}
    </QueryCard>
  );
}

// --- Worlds -----------------------------------------------------------------------------

function ActiveAfkBar({ world, max }: { world: WorldTime; max: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          role="img"
          aria-label={`Active ${formatDuration(world.activeSeconds)}, AFK ${formatDuration(world.afkSeconds)}`}
          className="flex h-2 gap-0.5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          style={{ width: `${String(Math.max(2, (world.seconds / Math.max(1, max)) * 100))}%` }}
        >
          {world.activeSeconds > 0 && (
            <div
              className="rounded-l-[3px] bg-active last:rounded-r-[3px]"
              style={{ flex: world.activeSeconds }}
            />
          )}
          {world.afkSeconds > 0 && (
            <div
              className="rounded-r-[3px] bg-afk first:rounded-l-[3px]"
              style={{ flex: world.afkSeconds }}
            />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="font-semibold">World {world.world}</div>
        <div className="tabular-nums">Active {formatDuration(world.activeSeconds)}</div>
        <div className="tabular-nums">AFK {formatDuration(world.afkSeconds)}</div>
      </TooltipContent>
    </Tooltip>
  );
}

function worldColumns(max: number): Column<WorldTime>[] {
  return [
    {
      id: 'world',
      header: 'World',
      cell: (world) => <span className="font-semibold">{world.world}</span>,
    },
    { id: 'type', header: 'Type', cell: (world) => worldTypesLabel(world.worldTypes) },
    {
      id: 'location',
      header: 'Location',
      minor: true,
      cell: (world) => formatLocation(world.location),
    },
    {
      id: 'activity',
      header: 'Activity',
      minor: true,
      className: 'text-text-2',
      // RuneLite gives an empty activity for most worlds.
      cell: (world) => (world.activity === null || world.activity === '' ? '–' : world.activity),
    },
    {
      id: 'split',
      header: 'Active / AFK',
      minor: true,
      className: 'w-[28%]',
      cell: (world) => <ActiveAfkBar world={world} max={max} />,
    },
    {
      id: 'time',
      header: 'Time',
      align: 'right',
      cell: (world) => formatDuration(world.seconds),
    },
  ];
}

/** A world as a row on mobile: number, type and place, time. */
function WorldRow({ world }: { world: WorldTime }) {
  const activity = world.activity === null || world.activity === '' ? [] : [world.activity];
  const detail = [worldTypesLabel(world.worldTypes), formatLocation(world.location), ...activity];
  return (
    <li className="grid min-h-12 grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-1.5">
      <span
        aria-hidden="true"
        className="flex size-[30px] items-center justify-center rounded-md bg-raised text-[9px] text-text-3 tabular-nums"
      >
        {world.world}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="font-medium">World {world.world}</span>
        <span className="truncate text-xs text-text-3">{detail.join(' · ')}</span>
      </span>
      <span className="font-semibold whitespace-nowrap tabular-nums">
        {formatDuration(world.seconds)}
      </span>
    </li>
  );
}

function WorldsList({ data }: { data: ScreentimeWorldsResponse }) {
  const desktop = useIsDesktop();
  const fold = useShowAll(data.worlds);
  const columns = useMemo(() => worldColumns(data.worlds[0]?.seconds ?? 0), [data.worlds]);
  return (
    <>
      {desktop ? (
        <DataTable
          label="Play time per world"
          columns={columns}
          rows={fold.rows}
          rowKey={(world) => world.world}
        />
      ) : (
        <ul aria-label="Play time per world" className="m-0 list-none p-0">
          {fold.rows.map((world) => (
            <WorldRow key={world.world} world={world} />
          ))}
        </ul>
      )}
      <ShowAllButton {...fold} />
    </>
  );
}

function WorldsCard({
  worlds,
  range,
  className,
}: {
  worlds: WorldsQuery;
  range: ScreentimeRange;
  className?: string;
}) {
  return (
    <QueryCard
      query={worlds}
      title={
        <span className="flex items-baseline gap-2.5">
          Worlds
          {worlds.data && worlds.data.worlds.length > 0 && (
            <span className="text-xs font-normal text-text-3">
              {formatInt(worlds.data.worlds.length)}{' '}
              {worlds.data.worlds.length === 1 ? 'world' : 'worlds'}
            </span>
          )}
        </span>
      }
      skeletonLines={6}
      {...(className === undefined ? {} : { className })}
    >
      {(data) =>
        data.worlds.length === 0 ? (
          <EmptyState className="min-h-[160px]">{emptyText(range)}</EmptyState>
        ) : (
          <WorldsList data={data} />
        )
      }
    </QueryCard>
  );
}

// --- Page -----------------------------------------------------------------------------

// Two cards per row on PC that wrap onto their own rows when there is no room;
// one column on mobile. 20 px between cards.
const ROW = 'flex flex-col gap-5 desk:flex-row desk:flex-wrap desk:items-stretch';
const WIDE = 'desk:min-w-0 desk:flex-[2_1_560px]';
const NARROW = 'desk:min-w-0 desk:flex-[1_1_360px]';
/** The worlds table needs about 700 px for its six columns, so that row wraps before it scrolls. */
const WORLDS = 'desk:min-w-0 desk:flex-[2_1_700px]';

/**
 * The heatmap card is never narrower than its grid of fixed 16 px cells: its
 * basis and minimum are the grid plus the card's padding (2 × 24) and border (2
 * × 1), so it wraps onto its own row first.
 */
const HEATMAP_CARD_WIDTH = heatmapWidth('hours') + 2 * 24 + 2;
const HEATMAP = 'desk:flex-[1_1_var(--heatmap-card)] desk:min-w-(--heatmap-card)';
const HEATMAP_STYLE = { '--heatmap-card': `${String(HEATMAP_CARD_WIDTH)}px` } as CSSProperties;

export function ScreentimePage() {
  const scope = useAccountScope();
  const format = useFormat();
  const [params, setParams] = useSearchParams();
  const range = parseScreentimeRange(params.get('range'));
  const { days, bucket } = RANGE_SPEC[range];

  // The range moves once per local day, so the query keys stay stable in between.
  const today = useLocalToday(format.timeZone);
  const timeRange = useMemo(
    () => lastDaysRange(days, today, format.timeZone),
    [days, today, format.timeZone],
  );
  const screentime = useScreentime(scope, { ...timeRange, bucket });
  const worlds = useScreentimeWorlds(scope, timeRange);
  const heatmap = useScreentimeHeatmap(scope, timeRange);

  // Labels follow the data on screen, which is the previous range while a new one loads.
  const shownRange = useParamsOfData(screentime, range);
  const shownWorldsRange = useParamsOfData(worlds, range);
  const shownHeatmapRange = useParamsOfData(heatmap, range);
  // Starts on the first worlds again when data for a new range or account arrives.
  const worldsKey = `${String(useParamsOfData(worlds, scope))}:${shownWorldsRange}`;

  return (
    <div className="flex flex-col gap-5 desk:gap-7">
      <PageControls>
        <SegmentedFilter
          block
          label="Period"
          options={RANGE_OPTIONS}
          value={range}
          onChange={(next) => {
            setParams((current) => {
              const nextParams = new URLSearchParams(current);
              nextParams.set('range', next);
              return nextParams;
            });
          }}
        />
      </PageControls>
      <Summary screentime={screentime} range={shownRange} />
      <div className={ROW}>
        <PlaytimeCard screentime={screentime} range={shownRange} className={WIDE} />
        <HeatmapCard
          query={heatmap}
          range={shownHeatmapRange}
          className={HEATMAP}
          style={HEATMAP_STYLE}
        />
      </div>
      <div className={ROW}>
        <WorldsCard key={worldsKey} worlds={worlds} range={shownWorldsRange} className={WORLDS} />
        <TypesCard
          key={`types:${worldsKey}`}
          worlds={worlds}
          range={shownWorldsRange}
          className={NARROW}
        />
      </div>
    </div>
  );
}
