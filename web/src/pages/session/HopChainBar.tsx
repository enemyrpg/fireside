import type { Session } from '@fireside/shared';
import { Link } from 'react-router';
import { formatDuration, formatInt } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import type { HopChain } from '@/hooks/useHopChain';
import { worldsLabel } from '@/lib/session-groups';
import { cn } from '@/lib/utils';

// The hop chain on Session detail: shown when the session is one part of
// several joined by quick world hops. "Part 2 of 3" and one link per part
// (time, world, duration), the current part marked.

export function HopChainBar({
  chain,
  currentId,
  hrefOf,
}: {
  chain: HopChain;
  currentId: string;
  hrefOf: (sessionId: string) => string;
}) {
  const format = useFormat();
  if (chain.parts.length < 2) return null;
  const index = chain.parts.findIndex((part) => part.id === currentId);
  const total = `${formatInt(chain.parts.length)}${chain.capped ? '+' : ''}`;
  const time = (part: Session) =>
    `${format.clock(part.startedAt)}–${part.endedAt === null ? 'now' : format.clock(part.endedAt)}`;

  return (
    <nav
      aria-label="World hops"
      className="flex flex-col gap-2 rounded-xl border border-border bg-raised px-3 py-2.5 desk:flex-row desk:items-center desk:gap-3"
    >
      <span className="flex-none text-sm font-semibold">
        Part {formatInt(index + 1)} of {total}
        <span className="font-normal text-text-3"> · world hops</span>
      </span>
      <ol className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0">
        {chain.parts.map((part) => {
          const current = part.id === currentId;
          return (
            <li key={part.id}>
              <Link
                to={hrefOf(part.id)}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs whitespace-nowrap tabular-nums hover:no-underline max-desk:min-h-11',
                  current
                    ? 'border-accent bg-accent-wash text-accent-text'
                    : 'border-border text-text hover:border-accent',
                )}
              >
                <span className="font-mono">{time(part)}</span>
                <span className="text-text-3">·</span>
                <span>{worldsLabel([part.world])}</span>
                <span className="text-text-3">·</span>
                <span>{formatDuration(part.durationSeconds)}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
