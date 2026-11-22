import { formatDelta, type DeltaInput } from '@/format';

/** Neutral ▲/▼ change against an earlier period. Never green or red. */
export function Delta(props: DeltaInput) {
  return <span className="text-xs text-text-2 tabular-nums">{formatDelta(props)}</span>;
}
