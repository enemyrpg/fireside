import { formatInt } from '@/format';

/**
 * A card title with its count after it, "API keys 2 active". No count while loading.
 */
export function ActiveCount({
  title,
  count,
  unit = 'active',
}: {
  title: string;
  count: number | undefined;
  unit?: string;
}) {
  return (
    <>
      {title}
      {count !== undefined && ' '}
      {count !== undefined && (
        <span className="text-xs font-normal text-text-3">
          {formatInt(count)}
          {unit === '' ? '' : ` ${unit}`}
        </span>
      )}
    </>
  );
}
