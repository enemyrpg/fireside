import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { LiveBadge } from '@/components/Badge';
import { Gp } from '@/components/Gp';
import { AccountDot } from '@/components/shell/AccountDot';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatCompact, formatDuration, formatInt, formatSkill } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { BIG_DROP_GP } from '@/lib/timeline';
import { cn } from '@/lib/utils';
import { mostlyAfk, worldsLabel, type SessionGroup } from '@/lib/session-groups';

// One row in the Sessions list: account dot, time, what happened (bosses with
// +N, else skills), XP and loot, and the duration. A group of world hops links
// to its first part and can be unfolded to its parts.

/** Most first (then by name), at most `max`. */
function topEntries(record: Readonly<Record<string, number>>, max: number) {
  return Object.entries(record)
    .filter(([, value]) => value > 0)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, max);
}

/** The line saying what happened: bosses with +N, else skills, else "No XP or kills". */
function Title({ group }: { group: SessionGroup }) {
  const kc = topEntries(group.kcByBoss, 2);
  const skills = topEntries(group.xpBySkill, 2);
  const afk = mostlyAfk(group) ? <span className="text-text-3"> · mostly AFK</span> : null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {group.live && <LiveBadge />}
      <span className="min-w-0 truncate">
        {kc.length > 0 ? (
          kc.map(([boss, gained], index) => (
            // On mobile only the first boss fits.
            <span key={boss} className={cn(index > 0 && '@max-[500px]/list:hidden')}>
              {index > 0 && <span className="text-text-3"> · </span>}
              {boss} <span className="text-accent-text">+{formatInt(gained)}</span>
            </span>
          ))
        ) : skills.length > 0 ? (
          <span className="text-text-2">
            {skills.map(([skill]) => formatSkill(skill)).join(', ')}
          </span>
        ) : group.live ? null : (
          <span className="text-text-3">No XP or kills</span>
        )}
        {afk}
      </span>
    </div>
  );
}

/** Active and AFK as two bars, with the times in a tooltip (mobile). */
function ActivityBar({ active, afk }: { active: number; afk: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          role="img"
          aria-label={`Active ${formatDuration(active)}, AFK ${formatDuration(afk)}`}
          className="relative z-10 flex h-1.5 min-w-0 gap-0.5 overflow-hidden rounded-[3px]"
        >
          {active > 0 && <div className="bg-active" style={{ flex: active }} />}
          {afk > 0 && <div className="bg-afk" style={{ flex: afk }} />}
          {active + afk === 0 && <div className="flex-1 bg-raised" />}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="tabular-nums">Active {formatDuration(active)}</div>
        <div className="tabular-nums">AFK {formatDuration(afk)}</div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * New collection log items in the row: an 8 px
 * diamond in `--info` and "1 new log" in `--info-text`. Screen readers hear
 * "collection log".
 */
export function NewClogBadge({ count }: { count: number }) {
  return (
    <span
      data-testid="new-clog-badge"
      className="inline-flex items-center gap-1.5 self-center font-medium text-info-text"
    >
      <i aria-hidden="true" className="size-2 shrink-0 rotate-45 bg-info" />
      <span>
        {formatInt(count)} new <span className="sr-only">collection </span>
        {count === 1 ? 'log' : 'logs'}
      </span>
    </span>
  );
}

/** XP, loot and (mobile) drops, then the world(s). */
function Numbers({ group }: { group: SessionGroup }) {
  const parts = [];
  if (group.xpGained) parts.push(<span key="xp">{formatCompact(group.xpGained)} XP</span>);
  if (group.lootGeValue) {
    parts.push(
      <Gp
        key="gp"
        value={group.lootGeValue}
        className={cn('relative z-10', group.lootGeValue >= BIG_DROP_GP && 'text-accent-text')}
      />,
    );
  }
  if (group.newCollectionLogCount > 0) {
    parts.push(<NewClogBadge key="clog" count={group.newCollectionLogCount} />);
  }
  if (group.lootCount) {
    parts.push(
      <span key="drops" className="@min-[500px]/list:hidden">
        {formatInt(group.lootCount)} {group.lootCount === 1 ? 'drop' : 'drops'}
      </span>,
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-text-2 tabular-nums">
      {parts}
      <span className="truncate text-xs text-text-3">{worldsLabel(group.worlds)}</span>
    </div>
  );
}

export interface SessionRowProps {
  group: SessionGroup;
  /** Account name and colour for the dot. */
  account: { name: string; color: string };
  /** Link to a session: the list with it selected on PC, its screen on mobile. */
  hrefOf: (sessionId: string) => string;
  /** The session selected on PC, if any. The row is selected when it holds it. */
  selectedId?: string | undefined;
}

export function SessionRow({ group, account, hrefOf, selectedId }: SessionRowProps) {
  const format = useFormat();
  const [open, setOpen] = useState(false);
  const hops = group.parts.length > 1;
  const end = group.endedAt === null ? 'now' : format.clock(group.endedAt);
  const partsId = `session-parts-${group.key}`;
  const first = group.parts[0] ?? group.newest;
  const selected = selectedId !== undefined && group.parts.some((part) => part.id === selectedId);

  return (
    <li className="mb-2 list-none">
      <div
        className={cn(
          'relative isolate grid grid-cols-[10px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3 hover:border-accent has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-accent @min-[500px]/list:grid-cols-[10px_100px_minmax(0,1fr)_auto_24px] @min-[500px]/list:gap-x-3.5',
          selected ? 'border-accent bg-accent-wash' : 'border-border',
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={-1} className="relative z-10 flex pt-1.5">
              <AccountDot color={account.color} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{account.name}</TooltipContent>
        </Tooltip>
        {/* The link covers the whole row; the buttons and tooltips sit above it (z-10). `isolate` keeps those z-indexes inside the row, below the sticky top bar. A hop group opens its first part. */}
        <Link
          to={hrefOf(first.id)}
          aria-current={selected ? 'true' : undefined}
          className="pt-0.5 font-mono text-sm whitespace-nowrap text-text-2 tabular-nums outline-none after:absolute after:inset-0 after:rounded-xl hover:no-underline"
          aria-label={`${account.name}, ${format.date(group.startedAt)} ${format.clock(group.startedAt)}–${end}`}
        >
          {format.clock(group.startedAt)}–{end}
        </Link>
        <div
          className={cn(
            'col-start-2 row-start-2 flex min-w-0 flex-col gap-1.5 @min-[500px]/list:col-span-1 @min-[500px]/list:col-start-3 @min-[500px]/list:row-start-1',
            // Narrow: a hop row leaves the last column to its button, at the end of the numbers.
            hops ? 'col-span-1' : 'col-span-2',
          )}
        >
          <Title group={group} />
          <div className="@min-[500px]/list:hidden">
            <ActivityBar active={group.activeSeconds} afk={group.afkSeconds} />
          </div>
          <Numbers group={group} />
        </div>
        <div className="text-right font-semibold whitespace-nowrap tabular-nums @min-[500px]/list:pt-0.5">
          {formatDuration(group.durationSeconds)}
        </div>
        {hops ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={partsId}
            aria-label={`${open ? 'Hide' : 'Show'} ${String(group.parts.length)} parts (world hops)`}
            onClick={() => {
              setOpen((value) => !value);
            }}
            className="relative z-10 col-start-3 row-start-2 grid size-6 place-items-center self-end justify-self-end rounded-md text-text-2 hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent @min-[500px]/list:col-start-5 @min-[500px]/list:row-start-1 @min-[500px]/list:self-start"
          >
            {open ? (
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            ) : (
              <ChevronRightIcon aria-hidden="true" className="size-4" />
            )}
          </button>
        ) : (
          <span className="hidden @min-[500px]/list:block" />
        )}
      </div>
      {hops && open && (
        <ul
          id={partsId}
          aria-label="Parts"
          className="m-0 mt-1 mb-2.5 ml-6 list-none p-0 @min-[500px]/list:ml-10"
        >
          {group.parts.map((part) => (
            <li key={part.id} className="border-b border-border last:border-b-0">
              <Link
                to={hrefOf(part.id)}
                aria-current={part.id === selectedId ? 'true' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-sm px-1 py-2 text-text hover:bg-hover hover:no-underline',
                  part.id === selectedId && 'text-accent-text',
                )}
              >
                <span className="w-[110px] flex-none text-xs text-text-3 tabular-nums">
                  {format.clock(part.startedAt)}–
                  {part.endedAt === null ? 'now' : format.clock(part.endedAt)}
                </span>
                <span className="min-w-0 flex-1 truncate">{worldsLabel([part.world])}</span>
                <span className="text-text-2 tabular-nums">
                  {formatDuration(part.durationSeconds)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
