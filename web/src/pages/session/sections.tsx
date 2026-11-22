import type { SessionDetailResponse, SessionLoot, SessionXp } from '@fireside/shared';
import { useState, type ReactNode } from 'react';
import { BossIcon } from '@/components/BossIcon';
import { Card } from '@/components/Card';
import { Gp } from '@/components/Gp';
import { HBarList } from '@/components/HBarList';
import { ItemIcon } from '@/components/ItemIcon';
import { SegmentedFilter } from '@/components/Segmented';
import { ShowAllButton } from '@/components/ShowAll';
import { SkillIcon } from '@/components/SkillIcon';
import { EmptyState } from '@/components/states';
import { formatCompact, formatInt, formatSkill } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useShowAll } from '@/hooks/useShowAll';
import { sourceLabel } from '@/lib/loot';
import { ROWS_SHOWN } from '@/lib/show-all';
import { lootRows, xpRows, type LootOrder } from '@/lib/session-stats';
import { BIG_DROP_GP } from '@/lib/timeline';
import { cn } from '@/lib/utils';

// The sections of Session detail (six-row rule in part 5): XP by skill (folds
// out to a compact grid), Kill count and Loot (Value | Time). In the pane on PC
// they are blocks inside one card; on the mobile screen each is its own card.

export type DetailVariant = 'pane' | 'screen';

/** A section: its own card on mobile, a plain block in the PC pane. */
export function Section({
  variant,
  label,
  title,
  action,
  className,
  children,
}: {
  variant: DetailVariant;
  /** Accessible name of the section. */
  label: string;
  title: ReactNode;
  action?: ReactNode;
  className?: string | undefined;
  children: ReactNode;
}) {
  // On the screen (mobile) the sections come right under the page's h1; in
  // the pane they are under the pane's own h2.
  const Heading = variant === 'screen' ? 'h2' : 'h3';
  const head = (
    <div className="mb-3 flex flex-wrap items-center gap-2.5">
      <Heading className="m-0 text-base font-semibold">{title}</Heading>
      {action !== undefined && (
        <div className="ml-auto flex items-center gap-2 text-xs text-text-3">{action}</div>
      )}
    </div>
  );
  if (variant === 'screen') {
    return (
      <Card aria-label={label} className={className}>
        {head}
        {children}
      </Card>
    );
  }
  return (
    <section aria-label={label} className={cn('min-w-0', className)}>
      {head}
      {children}
    </section>
  );
}

const plural = (count: number, word: string, words = `${word}s`) =>
  `${formatInt(count)} ${count === 1 ? word : words}`;

// --- XP -----------------------------------------------------------------------------------

function SkillGrid({ rows }: { rows: readonly SessionXp[] }) {
  return (
    <ul
      aria-label="XP by skill"
      className="m-0 grid list-none grid-cols-2 gap-2 p-0 wide:grid-cols-4"
    >
      {rows.map((row) => (
        <li
          key={row.skill}
          className="flex min-w-0 items-center gap-2 rounded-lg bg-raised px-2.5 py-2 text-sm"
        >
          <SkillIcon skill={row.skill} />
          <span className="min-w-0 flex-1 truncate">{formatSkill(row.skill)}</span>
          {row.endLevel > row.startLevel && (
            <span
              className="text-xs text-accent-text tabular-nums"
              aria-label={`Level ${String(row.startLevel)} → ${String(row.endLevel)}`}
            >
              ↑{row.endLevel}
            </span>
          )}
          <span className="font-semibold whitespace-nowrap tabular-nums">
            {formatCompact(row.xpGained)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * XP by skill: six bars, then "Show all (n)", which turns the list into a
 * compact grid (the whole width of the pane, `SessionLong`). `expanded` is
 * held by the detail, which gives the grid the full width.
 */
export function XpSection({
  detail,
  variant,
  expanded,
  onToggle,
  className,
}: {
  detail: SessionDetailResponse;
  variant: DetailVariant;
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const rows = xpRows(detail);
  const foldable = rows.length > ROWS_SHOWN;
  const action =
    rows.length === 0
      ? undefined
      : foldable && !expanded
        ? `Top ${String(ROWS_SHOWN)} of ${formatInt(rows.length)}`
        : plural(rows.length, 'skill');
  return (
    <Section
      variant={variant}
      label="XP by skill"
      title="XP by skill"
      action={action}
      className={className}
    >
      {rows.length === 0 ? (
        <EmptyState className="min-h-[80px]">No XP gained in this session.</EmptyState>
      ) : expanded ? (
        <SkillGrid rows={rows} />
      ) : (
        <HBarList
          label="XP by skill"
          limit={false}
          format={formatCompact}
          formatExact={(value) => `${formatInt(value)} XP`}
          rows={rows.slice(0, ROWS_SHOWN).map((row) => ({
            key: row.skill,
            label: formatSkill(row.skill),
            value: row.xpGained,
            icon: <SkillIcon skill={row.skill} />,
            ...(row.endLevel > row.startLevel
              ? {
                  detail: (
                    <div>
                      Level {row.startLevel} → {row.endLevel}
                    </div>
                  ),
                }
              : {}),
          }))}
        />
      )}
      <ShowAllButton
        foldable={foldable}
        expanded={expanded}
        total={rows.length}
        toggle={onToggle}
      />
    </Section>
  );
}

// --- Kill count ---------------------------------------------------------------------------

export function KcSection({
  detail,
  variant,
}: {
  detail: SessionDetailResponse;
  variant: DetailVariant;
}) {
  const rows = [...detail.kc]
    .filter((row) => row.gained > 0)
    .sort((a, b) => b.gained - a.gained || (a.boss < b.boss ? -1 : a.boss > b.boss ? 1 : 0));
  const fold = useShowAll(rows);
  return (
    <Section
      variant={variant}
      label="Kill count"
      title="Kill count"
      action={
        rows.length === 0
          ? undefined
          : fold.foldable && !fold.expanded
            ? `Top ${String(ROWS_SHOWN)} of ${formatInt(rows.length)}`
            : plural(rows.length, 'boss', 'bosses')
      }
    >
      {rows.length === 0 && (
        <EmptyState className="min-h-[80px]">No kills in this session.</EmptyState>
      )}
      {rows.length > 0 && (
        <ul aria-label="Kill count" className="m-0 flex list-none flex-col gap-1 p-0">
          {fold.rows.map((row) => (
            <li
              key={row.boss}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 py-1"
            >
              <span className="flex min-w-0 items-center gap-2">
                <BossIcon boss={row.boss} />
                <span className="truncate">{row.boss}</span>
              </span>
              <span className="text-text-2 tabular-nums">
                {formatInt(row.startKillCount)} → {formatInt(row.endKillCount)}
              </span>
              <span className="min-w-[3ch] text-right font-semibold text-accent-text tabular-nums">
                +{formatInt(row.gained)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ShowAllButton
        foldable={fold.foldable}
        expanded={fold.expanded}
        total={fold.total}
        toggle={fold.toggle}
      />
    </Section>
  );
}

// --- Loot ---------------------------------------------------------------------------------

function LootRow({ drop }: { drop: SessionLoot }) {
  const format = useFormat();
  const items = [...drop.items].sort(
    (a, b) => b.gePriceEach * b.quantity - a.gePriceEach * a.quantity,
  );
  const top = items[0];
  const rest = items.length - 1;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-2.5 first:border-t-0">
      {top ? <ItemIcon itemId={top.itemId} name={top.name} /> : <span className="size-6" />}
      <div className="min-w-0">
        <div className="truncate">
          {top ? (
            <>
              {top.name}
              {top.quantity > 1 && <> × {formatInt(top.quantity)}</>}
            </>
          ) : (
            sourceLabel(drop.source)
          )}
          {rest > 0 && <span className="text-text-3"> +{formatInt(rest)} more</span>}
        </div>
        <div className="truncate text-xs text-text-3 tabular-nums">
          {sourceLabel(drop.source)} · {format.clock(drop.occurredAt)}
        </div>
      </div>
      <Gp
        value={drop.geValue}
        className={cn(
          'font-semibold whitespace-nowrap tabular-nums',
          drop.geValue >= BIG_DROP_GP && 'text-accent-text',
        )}
      />
    </li>
  );
}

const LOOT_ORDERS = [
  { value: 'value', label: 'Value' },
  { value: 'time', label: 'Time' },
] as const;

export function LootSection({
  detail,
  variant,
}: {
  detail: SessionDetailResponse;
  variant: DetailVariant;
}) {
  const [order, setOrder] = useState<LootOrder>('value');
  const rows = lootRows(detail.loot, order);
  const fold = useShowAll(rows);
  return (
    <Section
      variant={variant}
      label="Loot"
      title="Loot"
      action={
        detail.loot.length > 0 ? (
          <SegmentedFilter label="Order" options={LOOT_ORDERS} value={order} onChange={setOrder} />
        ) : undefined
      }
    >
      {detail.loot.length === 0 ? (
        <EmptyState className="min-h-[80px]">No loot in this session.</EmptyState>
      ) : (
        <>
          <ul aria-label="Loot" className="m-0 list-none p-0">
            {fold.rows.map((drop) => (
              <LootRow key={drop.id} drop={drop} />
            ))}
          </ul>
          <ShowAllButton
            foldable={fold.foldable}
            expanded={fold.expanded}
            total={fold.total}
            toggle={fold.toggle}
          />
        </>
      )}
    </Section>
  );
}
