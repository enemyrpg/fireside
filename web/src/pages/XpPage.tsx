import { GAINS_PERIODS, SKILLS, type GainsPeriod } from '@fireside/shared';
import { ChevronDownIcon } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useGains, useXp } from '@/api/hooks';
import { DataTable, type Column } from '@/components/DataTable';
import { SegmentedFilter } from '@/components/Segmented';
import { QueryCard } from '@/components/QueryCard';
import { PageControls } from '@/components/shell/PageControls';
import { ShowAllButton } from '@/components/ShowAll';
import { SkillIcon } from '@/components/SkillIcon';
import { StatStrip, type StatStripItem } from '@/components/StatStrip';
import { EmptyState, ErrorState } from '@/components/states';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { XpLine } from '@/components/XpLine';
import { formatCompact, formatInt, formatSkill, formatXpGain } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useLocalToday } from '@/hooks/useLocalToday';
import { useShowAll } from '@/hooks/useShowAll';
import { chartFrom } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useAccountScope } from '@/routing/useAccountScope';
import {
  anyXpGained,
  buildGainsRows,
  chartSkills,
  periodOfRange,
  skillsTrained,
  splitGainsRows,
  type GainsRow,
} from './xp/gains-rows';

// XP & gains: the number row, XP over time for the chosen period beside the
// gains table on PC, and under the table a compact grid of the skills without
// XP in the period. The period and the chart's skill live in the URL
// (`?period=week&skill=SLAYER`); clicking a skill charts it.

export const DEFAULT_PERIOD: GainsPeriod = 'week';

const PERIOD_OPTIONS = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
] as const satisfies readonly { value: GainsPeriod; label: string }[];

const PERIOD_TEXT: Record<
  GainsPeriod,
  { since: string; empty: string; chart: string; untrained: string }
> = {
  // No hourly data, so the Day chart shows the last 7 days.
  day: {
    since: 'today',
    empty: 'No XP gained today yet.',
    chart: 'last 7 days',
    untrained: 'No XP today',
  },
  week: {
    since: 'since Monday',
    empty: 'No XP gained this week yet.',
    chart: 'since Monday',
    untrained: 'No XP this week',
  },
  month: {
    since: 'this month',
    empty: 'No XP gained this month yet.',
    chart: 'this month',
    untrained: 'No XP this month',
  },
  year: {
    since: 'this year',
    empty: 'No XP gained this year yet.',
    chart: 'this year',
    untrained: 'No XP this year',
  },
};

export const XP_CHART_EMPTY = 'Your XP over time shows up here after your first session.';

/** Value of the chart's skill picker for the overall series. */
const OVERALL = 'OVERALL';

/** Same rule as `upperName` in the contract, so a bad `?skill=` never reaches the API. */
const SKILL_PARAM = /^[A-Z][A-Z0-9_]*$/;

function parsePeriod(value: string | null): GainsPeriod {
  return GAINS_PERIODS.find((period) => period === value) ?? DEFAULT_PERIOD;
}

function parseSkill(value: string | null): string | undefined {
  return value !== null && value !== OVERALL && SKILL_PARAM.test(value) ? value : undefined;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// --- Number row ----------------------------------------------------------------

/** A number with its exact value on hover or focus. */
function Exact({ value, exact }: { value: string; exact: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-default rounded-sm">
          {value}
        </span>
      </TooltipTrigger>
      <TooltipContent>{exact}</TooltipContent>
    </Tooltip>
  );
}

/**
 * XP, levels and skills trained (`StatStrip`). The labels follow the data on
 * screen (its own `from`/`to`), so they never name a period still loading.
 */
function XpStrip({ gains }: { gains: ReturnType<typeof useGains> }) {
  const { data } = gains;
  let items: StatStripItem[] | undefined;
  if (data) {
    const trained = formatInt(skillsTrained(data));
    const of = formatInt(SKILLS.length);
    items = [
      {
        key: 'xp',
        value: (
          <Exact
            value={formatCompact(data.total.xpGained)}
            exact={`${formatInt(data.total.xpGained)} XP`}
          />
        ),
        label: `XP gained ${PERIOD_TEXT[periodOfRange(data)].since}`,
      },
      { key: 'levels', value: formatInt(data.total.levelsGained), label: 'levels gained' },
      {
        key: 'skills',
        // PC: "8" over "of 24 skills trained"; mobile: "8 of 24" over "skills trained".
        value: (
          <>
            {trained}
            <span className="desk:hidden"> of {of}</span>
          </>
        ),
        label: `of ${of} skills trained`,
        shortLabel: 'skills trained',
      },
    ];
  }
  return (
    <StatStrip
      label="XP summary"
      items={items}
      skeletonCount={3}
      error={
        data === undefined &&
        gains.isError && <ErrorState className="min-h-0" onRetry={() => void gains.refetch()} />
      }
      // Mobile (`MobileProgressXp`): the two small numbers share a row in halves.
      className="max-desk:grid-cols-2"
    />
  );
}

// --- XP over time ----------------------------------------------------------------

function XpChartCard({
  period,
  skill,
  onSkillChange,
  skills,
  single,
}: {
  period: GainsPeriod;
  skill: string | undefined;
  onSkillChange: (skill: string | undefined) => void;
  skills: readonly string[];
  single: boolean;
}) {
  const scope = useAccountScope();
  const format = useFormat();
  // The start moves once per local day, so the query key stays stable in between.
  const today = useLocalToday(format.timeZone);
  const from = useMemo(
    () => chartFrom(period, today, format.timeZone),
    [period, today, format.timeZone],
  );
  const xp = useXp(scope, { bucket: 'day', from, ...(skill ? { skill } : {}) });
  // While a new period loads, the previous line stays; its period is unknown, so no subtitle.
  const chartText = xp.isPlaceholderData ? undefined : PERIOD_TEXT[period].chart;

  const options = skill && !skills.includes(skill) ? [...skills, skill] : skills;

  return (
    <QueryCard
      query={xp}
      skeletonLines={6}
      title={
        <span className="flex items-baseline gap-2.5">
          XP over time
          {chartText && (
            <span className="text-xs font-normal text-text-3">{capitalise(chartText)}</span>
          )}
        </span>
      }
      action={
        <Select
          value={skill ?? OVERALL}
          onValueChange={(value) => {
            onSkillChange(parseSkill(value));
          }}
        >
          <SelectTrigger size="sm" aria-label="Skill" className="min-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={OVERALL}>Overall</SelectItem>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {formatSkill(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {(data) =>
        data.points.length === 0 ? (
          <EmptyState className="min-h-[240px]">
            {/* "First session" only fits Overall: a skill can be empty for a played account. */}
            {data.skill ? `No ${formatSkill(data.skill)} XP to show yet.` : XP_CHART_EMPTY}
          </EmptyState>
        ) : (
          <XpLine
            points={data.points}
            // Named after the data on screen: the previous skill while a new one loads.
            label={`XP over time for ${data.skill ? formatSkill(data.skill) : 'Overall'}${chartText ? `, ${chartText}` : ''}`}
            showLevel={single}
            levelLabel={data.skill ? 'Level' : 'Total level'}
          />
        )
      }
    </QueryCard>
  );
}

// --- Gains table -------------------------------------------------------------------

function skillName(row: GainsRow): string {
  return row.skill === null ? 'Overall' : formatSkill(row.skill);
}

/** Level, with "↑2" after it when the skill gained levels (like Session detail). */
function LevelCell({ row }: { row: GainsRow }) {
  return (
    <>
      {formatInt(row.level)}
      {row.skill !== null && row.levelsGained > 0 && (
        <span
          className="ml-1.5 text-xs font-medium text-accent-text"
          title={`${formatInt(row.levelsGained)} ${row.levelsGained === 1 ? 'level' : 'levels'} gained`}
        >
          ↑{formatInt(row.levelsGained)}
        </span>
      )}
    </>
  );
}

function gainsColumns(
  single: boolean,
  maxGain: number,
  chartSkill: string | undefined,
  onSelect: (row: GainsRow) => void,
): Column<GainsRow>[] {
  const columns: (Column<GainsRow> | false)[] = [
    {
      id: 'skill',
      header: 'Skill',
      cell: (row) => (
        // The row is clickable with the mouse; this button is for keyboard and screen readers.
        <button
          type="button"
          aria-pressed={row.skill === (chartSkill ?? null)}
          title={`Show ${skillName(row)} in the chart`}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(row);
          }}
          className="-mx-1 flex cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-left font-[inherit] text-inherit focus-visible:outline-2 focus-visible:outline-accent"
        >
          {/* Overall is the total level: its icon has the skill key OVERALL. */}
          <SkillIcon skill={row.skill ?? 'OVERALL'} />
          {skillName(row)}
        </button>
      ),
    },
    single && {
      id: 'level',
      header: 'Level',
      align: 'right',
      cell: (row) => <LevelCell row={row} />,
    },
    {
      id: 'total',
      header: 'Total XP',
      align: 'right',
      cell: (row) => formatInt(row.totalXp),
    },
    {
      id: 'bar',
      header: <span className="sr-only">Share of XP gained</span>,
      className: 'w-[172px]',
      cell: (row) =>
        row.skill !== null && row.xpGained > 0 ? (
          <div className="w-[140px]">
            <div
              aria-hidden="true"
              className="h-2 rounded-r bg-active"
              style={{ width: `${String(Math.max(1, (row.xpGained / maxGain) * 100))}%` }}
            />
          </div>
        ) : null,
    },
    {
      id: 'gained',
      header: 'Gained',
      align: 'right',
      cell: (row) => formatXpGain(row.xpGained),
    },
  ];
  return columns.filter((column) => column !== false);
}

/** Mobile (`MobileProgressXp`): one row per skill, the whole row charts it. */
function GainsList({
  rows,
  single,
  chartSkill,
  onSelect,
  label,
}: {
  rows: readonly GainsRow[];
  single: boolean;
  chartSkill: string | undefined;
  onSelect: (row: GainsRow) => void;
  label: string;
}) {
  const [overall, ...skills] = rows;
  // Six skills, then "Show all (n)"; Overall always stays on top.
  const fold = useShowAll(skills);
  const shown = overall ? [overall, ...fold.rows] : fold.rows;
  return (
    <>
      <ul aria-label={label} className="m-0 list-none p-0">
        {shown.map((row) => {
          const level = single
            ? `${row.skill === null ? 'Total level' : 'Level'} ${formatInt(row.level)}`
            : undefined;
          return (
            <li key={row.skill ?? 'OVERALL'} className="border-t border-hover">
              <button
                type="button"
                aria-pressed={row.skill === (chartSkill ?? null)}
                onClick={() => {
                  onSelect(row);
                }}
                className={cn(
                  '-mx-2 grid min-h-12 w-[calc(100%+16px)] cursor-pointer grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-inherit',
                  row.skill === (chartSkill ?? null) && 'bg-accent-wash',
                )}
              >
                <SkillIcon skill={row.skill ?? 'OVERALL'} />
                <span className="flex min-w-0 flex-col">
                  <span
                    className={cn('truncate', row.skill === null ? 'font-semibold' : 'font-medium')}
                  >
                    {skillName(row)}
                  </span>
                  {level !== undefined && (
                    <span className="text-xs text-text-3">
                      {level}
                      {/* Levels gained in the period, like "↑1" in the Level column on PC. */}
                      {row.skill !== null && row.levelsGained > 0 && (
                        <span className="ml-1.5 font-medium text-accent-text">
                          <span aria-hidden="true">↑</span>
                          {formatInt(row.levelsGained)}
                          <span className="sr-only">
                            {` (${formatInt(row.levelsGained)} ${row.levelsGained === 1 ? 'level' : 'levels'} gained)`}
                          </span>
                        </span>
                      )}
                    </span>
                  )}
                </span>
                <span className="font-semibold tabular-nums">{formatXpGain(row.xpGained)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <ShowAllButton {...fold} />
    </>
  );
}

/** The skills without XP in the period: a compact grid of buttons that chart the skill. */
function UntrainedGrid({
  rows,
  single,
  chartSkill,
  onSelect,
  label,
}: {
  rows: readonly GainsRow[];
  single: boolean;
  chartSkill: string | undefined;
  onSelect: (row: GainsRow) => void;
  label: string;
}) {
  return (
    <ul
      aria-label={label}
      className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-1.5 p-0"
    >
      {rows.map((row) => (
        <li key={row.skill ?? 'OVERALL'} className="min-w-0">
          <button
            type="button"
            aria-pressed={row.skill === (chartSkill ?? null)}
            title={`Show ${skillName(row)} in the chart`}
            onClick={() => {
              onSelect(row);
            }}
            className={cn(
              'grid h-[34px] w-full cursor-pointer grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border-0 px-2.5 text-left text-[12.5px] text-text-3 hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent max-desk:h-11',
              row.skill === (chartSkill ?? null) ? 'bg-accent-wash' : 'bg-raised',
            )}
          >
            <SkillIcon skill={row.skill ?? 'OVERALL'} />
            <span className="truncate">{skillName(row)}</span>
            {single && <span className="tabular-nums">{formatInt(row.level)}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The grid's heading: an uppercase heading on PC, a row that folds the grid
 * out on mobile (`MobileProgressXp`).
 */
function Untrained({
  title,
  desktop,
  children,
}: {
  title: string;
  desktop: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (desktop) {
    return (
      <div className="mt-[22px] flex flex-col gap-3.5">
        <h3 className="m-0 text-xs font-medium tracking-[0.05em] text-text-3 uppercase">{title}</h3>
        {children}
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex h-11 w-full cursor-pointer items-center justify-between rounded-[10px] border border-border bg-raised px-4 text-left text-sm text-text-2"
      >
        {title}
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            'size-4 text-text-3 transition-transform motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && children}
    </div>
  );
}

function GainsCard({
  gains,
  single,
  chartSkill,
  onSelectSkill,
}: {
  gains: ReturnType<typeof useGains>;
  single: boolean;
  /** The skill in the chart; `undefined` = Overall. */
  chartSkill: string | undefined;
  onSelectSkill: (skill: string | undefined) => void;
}) {
  const format = useFormat();
  const desktop = useIsDesktop();
  // Labels follow the data on screen, which is the previous period while a new one loads.
  const shown = gains.data && periodOfRange(gains.data);
  const text = PERIOD_TEXT[shown ?? DEFAULT_PERIOD];
  const range = gains.data
    ? shown === 'day'
      ? format.date(gains.data.from)
      : `${format.date(gains.data.from)} – today`
    : undefined;

  return (
    <QueryCard
      query={gains}
      skeletonLines={8}
      title={
        <span className="flex flex-wrap items-baseline gap-x-2.5">
          Gains
          <span className="text-xs font-normal text-text-3">
            {desktop ? (
              <>{range && `${range} · `}click a skill to chart it</>
            ) : (
              'tap a skill to chart it'
            )}
          </span>
        </span>
      }
    >
      {(data) => {
        if (!anyXpGained(data)) {
          return <EmptyState>{text.empty}</EmptyState>;
        }
        const { trained, untrained } = splitGainsRows(buildGainsRows(data));
        const maxGain = Math.max(1, ...trained.slice(1).map((row) => row.xpGained));
        const select = (row: GainsRow) => {
          onSelectSkill(row.skill ?? undefined);
        };
        const label = `XP gained ${text.since} per skill`;
        const untrainedTitle = `${text.untrained} · ${formatInt(untrained.length)} ${untrained.length === 1 ? 'skill' : 'skills'}`;
        return (
          <>
            {desktop ? (
              <DataTable
                label={label}
                columns={gainsColumns(single, maxGain, chartSkill, select)}
                onRowClick={select}
                rows={trained}
                rowKey={(row) => row.skill ?? OVERALL}
                rowClassName={(row) =>
                  cn(
                    // Overall stands out.
                    row.skill === null && 'bg-raised font-semibold',
                    // The skill shown in the chart, like a chosen menu item.
                    row.skill === (chartSkill ?? null) && 'bg-accent-wash',
                  )
                }
              />
            ) : (
              // Remounts (back to six) for a new period.
              <GainsList
                key={`${data.from}:${data.to}`}
                label={label}
                rows={trained}
                single={single}
                chartSkill={chartSkill}
                onSelect={select}
              />
            )}
            {untrained.length > 0 && (
              <Untrained title={untrainedTitle} desktop={desktop}>
                <UntrainedGrid
                  label={untrainedTitle}
                  rows={untrained}
                  single={single}
                  chartSkill={chartSkill}
                  onSelect={select}
                />
              </Untrained>
            )}
          </>
        );
      }}
    </QueryCard>
  );
}

// --- Page ----------------------------------------------------------------------------

export function XpPage() {
  const scope = useAccountScope();
  const [params, setParams] = useSearchParams();
  const period = parsePeriod(params.get('period'));
  const skill = parseSkill(params.get('skill'));
  const single = scope !== 'all';
  const gains = useGains(scope, { period });

  const chartRef = useRef<HTMLDivElement>(null);

  const update = (key: string, value: string | undefined, replace: boolean) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === undefined) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <PageControls>
        <SegmentedFilter
          block
          label="Period"
          options={PERIOD_OPTIONS}
          value={period}
          onChange={(next) => {
            update('period', next, false);
          }}
        />
      </PageControls>
      <XpStrip gains={gains} />
      {/* Side by side on PC (`ProgressXp`), wrapping under each other when there isn't room. */}
      <div className="flex flex-wrap items-start gap-5">
        <div ref={chartRef} className="min-w-0 flex-[1_1_440px] scroll-mt-24">
          <XpChartCard
            period={period}
            skill={skill}
            onSkillChange={(next) => {
              update('skill', next, true);
            }}
            skills={chartSkills(gains.data)}
            single={single}
          />
        </div>
        <div className="min-w-0 flex-[1.5_1_560px]">
          <GainsCard
            gains={gains}
            single={single}
            chartSkill={skill}
            onSelectSkill={(next) => {
              update('skill', next, true);
              // The chart is above the table; bring it into view if it's off screen.
              const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
              chartRef.current?.scrollIntoView({
                block: 'nearest',
                behavior: reduced ? 'auto' : 'smooth',
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}
