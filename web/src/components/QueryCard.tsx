import type { CSSProperties, ReactNode } from 'react';
import { Card, CardHeader } from './Card';
import { CardSkeleton, ErrorState } from './states';

export interface QueryCardProps<T> {
  /** A query result, or several combined (e.g. the raid cards' `kc` and `raids`). */
  query: { data: T | undefined; isError: boolean; refetch: () => unknown };
  title?: ReactNode;
  action?: ReactNode;
  /** Skeleton lines while loading. */
  skeletonLines?: number;
  className?: string;
  style?: CSSProperties;
  children: (data: T) => ReactNode;
}

/**
 * A card that loads its own data: skeleton while loading, "Couldn't load this.
 * Retry" on error, content otherwise. Earlier data stays visible while a new
 * period or account loads.
 */
export function QueryCard<T>({
  query,
  title,
  action,
  skeletonLines,
  className,
  style,
  children,
}: QueryCardProps<T>) {
  let body: ReactNode;
  if (query.data !== undefined) body = children(query.data);
  else if (query.isError) body = <ErrorState onRetry={() => void query.refetch()} />;
  else body = <CardSkeleton {...(skeletonLines === undefined ? {} : { lines: skeletonLines })} />;

  return (
    <Card className={className} style={style}>
      {title !== undefined && (
        <CardHeader title={title} {...(action === undefined ? {} : { action })} />
      )}
      {body}
    </Card>
  );
}
