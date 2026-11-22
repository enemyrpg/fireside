import type { AccountSummary, SessionCloseReason, SessionDetailResponse } from '@fireside/shared';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useAccounts } from '@/api/hooks';
import { LiveBadge } from '@/components/Badge';
import { Gp } from '@/components/Gp';
import { SessionTimeline, SessionTimelineLegend } from '@/components/SessionTimeline';
import { AccountDot } from '@/components/shell/AccountDot';
import { StatStrip } from '@/components/StatStrip';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatCompact, formatDuration, formatGp, formatInt } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import type { HopChain } from '@/hooks/useHopChain';
import { accountColor, accountNameById } from '@/lib/accounts';
import { worldsLabel } from '@/lib/session-groups';
import { sessionNumbers } from '@/lib/session-stats';
import { sessionEndMs } from '@/lib/timeline';
import { ClogSection } from './ClogSection';
import { HopChainBar } from './HopChainBar';
import { KcSection, LootSection, XpSection, type DetailVariant } from './sections';

// Session detail: the selected session in the pane on PC (`variant="pane"`) and
// the screen `/sessions/:id` on mobile (`"screen"`). A line about the session,
// Older/Newer, the hop chain, four numbers (five in the pane with new
// collection log items), the timeline and the sections by the six-row
// rule.

const END_REASONS: Record<SessionCloseReason, string> = {
  logout: 'ended by logout',
  client_closed: 'client closed',
  hop: 'world hop',
  timeout: 'timed out',
};

export interface SessionDetailProps {
  detail: SessionDetailResponse;
  /** `undefined` while the hop chain is still being found. */
  chain: HopChain | undefined;
  /** Link to another session (Older/Newer, parts): `?session=` on PC, the screen on mobile. */
  hrefOf: (sessionId: string) => string;
  variant: DetailVariant;
  /** "← Sessions" on the mobile screen. */
  backHref?: string;
  /** `id` of the pane's heading, which names the pane region. */
  headingId?: string;
}

function OlderNewer({
  detail,
  hrefOf,
}: {
  detail: SessionDetailResponse;
  hrefOf: (sessionId: string) => string;
}) {
  const { neighbors } = detail;
  return (
    <nav aria-label="Other sessions" className="ml-auto flex flex-none gap-2">
      {neighbors.olderId !== null && (
        <Button asChild variant="outline" size="sm" className="max-desk:h-11">
          <Link to={hrefOf(neighbors.olderId)}>← Older</Link>
        </Button>
      )}
      {neighbors.newerId !== null && (
        <Button asChild variant="outline" size="sm" className="max-desk:h-11">
          <Link to={hrefOf(neighbors.newerId)}>Newer →</Link>
        </Button>
      )}
    </nav>
  );
}

/** "Account · World 351 · ended by logout", or Live while open. */
function AboutLine({
  detail,
  accounts,
  withWorld,
}: {
  detail: SessionDetailResponse;
  accounts: readonly AccountSummary[];
  withWorld: boolean;
}) {
  const { session } = detail;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-text-2">
      <AccountDot color={accountColor(session.accountId, accounts)} />
      <span className="min-w-0 truncate">
        {accountNameById(session.accountId, accounts)}
        {withWorld && <> · {worldsLabel([session.world])}</>}
        {session.endReason !== null && <> · {END_REASONS[session.endReason]}</>}
      </span>
      {session.endReason === null && <LiveBadge />}
    </div>
  );
}

/** A number with its exact value or rate in a tooltip. */
function WithTip({ value, tip }: { value: ReactNode; tip: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{value}</span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

function Numbers({
  detail,
  dateLine,
  variant,
}: {
  detail: SessionDetailResponse;
  dateLine: string;
  variant: DetailVariant;
}) {
  const { session } = detail;
  const numbers = sessionNumbers(detail);
  const plural = (count: number, word: string, words = `${word}s`) =>
    `${formatInt(count)} ${count === 1 ? word : words}`;
  return (
    <StatStrip
      label="Session summary"
      size="pane"
      items={[
        {
          key: 'played',
          value: (
            <WithTip
              value={formatDuration(session.durationSeconds)}
              tip={`${formatDuration(session.activeSeconds)} active · ${formatDuration(session.afkSeconds)} AFK`}
            />
          ),
          label: 'played',
          shortLabel: dateLine,
        },
        {
          key: 'xp',
          value: (
            <WithTip
              value={formatCompact(numbers.xpTotal)}
              tip={
                <>
                  <div className="tabular-nums">{formatInt(numbers.xpTotal)} XP</div>
                  {numbers.xpPerHour !== null && (
                    <div className="tabular-nums">
                      {formatCompact(Math.round(numbers.xpPerHour))} XP/h active
                    </div>
                  )}
                </>
              }
            />
          ),
          label: `XP · ${plural(numbers.skillCount, 'skill')}`,
        },
        {
          key: 'loot',
          value: <Gp value={numbers.lootGeValue} />,
          label: `loot · ${plural(numbers.dropCount, 'drop')}`,
          shortLabel: 'loot',
          ...(numbers.gpPerHour === null || numbers.lootGeValue === 0
            ? {}
            : { note: `${formatGp(Math.round(numbers.gpPerHour))}/h` }),
        },
        {
          key: 'kills',
          value: formatInt(numbers.kills),
          label: `kills · ${plural(numbers.bosses.length, 'boss', 'bosses')}`,
          shortLabel: 'kills',
        },
        // The fifth number, in `--info-text`; only in the pane, since the
        // mobile layout has room for three small numbers.
        ...(variant === 'pane' && numbers.newCollectionLog > 0
          ? [
              {
                key: 'clog',
                value: (
                  <span className="text-info-text">{formatInt(numbers.newCollectionLog)}</span>
                ),
                label:
                  numbers.newCollectionLog === 1 ? 'new collection log' : 'new collection logs',
              },
            ]
          : []),
      ]}
    />
  );
}

function Timeline({ detail }: { detail: SessionDetailResponse }) {
  const { session } = detail;
  return (
    <div className="flex flex-col gap-2">
      <SessionTimeline
        startedAt={session.startedAt}
        endMs={sessionEndMs(session)}
        live={session.endedAt === null}
        afkPeriods={detail.afkPeriods}
        loot={detail.loot}
        clogItems={detail.collectionLog.items}
      />
      <SessionTimelineLegend clog={detail.collectionLog.items.length > 0} />
    </div>
  );
}

export function SessionDetail({
  detail,
  chain,
  hrefOf,
  variant,
  backHref,
  headingId,
}: SessionDetailProps) {
  const format = useFormat();
  const accounts = useAccounts().data?.accounts ?? [];
  // Held here: the grid of all skills takes the whole width of the pane.
  const [xpExpanded, setXpExpanded] = useState(false);
  const { session } = detail;
  const end = session.endedAt === null ? 'now' : format.clock(session.endedAt);
  const when = `${format.date(session.startedAt)} · ${format.clock(session.startedAt)}–${end}`;
  const pane = variant === 'pane';

  const xp = (
    <XpSection
      detail={detail}
      variant={variant}
      expanded={xpExpanded}
      onToggle={() => {
        setXpExpanded((value) => !value);
      }}
    />
  );
  const kc = <KcSection detail={detail} variant={variant} />;
  const loot = <LootSection detail={detail} variant={variant} />;
  // Before Loot at the top of the right column in the pane; the first card on mobile.
  const clog = <ClogSection detail={detail} variant={variant} />;

  const chainBar = chain && <HopChainBar chain={chain} currentId={session.id} hrefOf={hrefOf} />;

  if (pane) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2
              id={headingId}
              className="m-0 font-display text-[22px] font-semibold tracking-[-0.01em] tabular-nums"
            >
              {when}
            </h2>
            <AboutLine detail={detail} accounts={accounts} withWorld />
          </div>
          <OlderNewer detail={detail} hrefOf={hrefOf} />
        </div>
        {chainBar}
        <Numbers detail={detail} dateLine={when} variant={variant} />
        <Timeline detail={detail} />
        {/* DOM order is the reading order: XP, Kill count, Collection log, Loot. */}
        {xpExpanded ? (
          <div className="flex flex-col gap-7">
            {xp}
            <div className="grid items-start gap-7 wide:grid-cols-2">
              {kc}
              <div className="flex min-w-0 flex-col gap-[22px]">
                {clog}
                {loot}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid items-start gap-7 wide:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-7">
              {xp}
              {kc}
            </div>
            {/* 22 px between Collection log and Loot. */}
            <div className="flex min-w-0 flex-col gap-[22px]">
              {clog}
              {loot}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        {backHref !== undefined && (
          <Button asChild variant="outline" size="sm" className="max-desk:h-11">
            <Link to={backHref}>← Sessions</Link>
          </Button>
        )}
        <OlderNewer detail={detail} hrefOf={hrefOf} />
      </div>
      <AboutLine detail={detail} accounts={accounts} withWorld={false} />
      {chainBar}
      <Numbers
        detail={detail}
        dateLine={`${when} · ${worldsLabel([session.world])}`}
        variant={variant}
      />
      <Timeline detail={detail} />
      {/* Mobile: the first card (`MobileSession`), so it comes first for screen readers too. */}
      {clog}
      {xp}
      {kc}
      {loot}
    </div>
  );
}
