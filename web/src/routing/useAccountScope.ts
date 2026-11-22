import type { AccountScope } from '@fireside/shared';
import { useParams } from 'react-router';
import { parseScope } from '@/lib/accounts';

/** Account scope of the current account page. `AccountRoute` has already checked it. */
export function useAccountScope(): AccountScope {
  return parseScope(useParams().acc) ?? 'all';
}
