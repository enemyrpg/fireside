import { useEffect } from 'react';
import { Navigate, Outlet, useParams } from 'react-router';
import { toast } from 'sonner';
import { useAccounts } from '@/api/hooks';
import { Card } from '@/components/Card';
import { CardSkeleton } from '@/components/states';
import { parseScope, readLastAccount, storeLastAccount } from '@/lib/accounts';

export const UNKNOWN_ACCOUNT_MESSAGE = "That account doesn't exist";

/**
 * `/:acc`: checks that the account exists (or is `all`) and remembers it.
 * Unknown accounts give a toast and a redirect to `/all`.
 */
export function AccountRoute() {
  const { acc } = useParams();
  const scope = parseScope(acc);
  const accounts = useAccounts();
  const list = accounts.data?.accounts;

  const invalid =
    scope === null ||
    (scope !== 'all' && list !== undefined && !list.some((account) => account.id === scope));
  const valid = scope === 'all' || (scope !== null && !invalid && list !== undefined);

  useEffect(() => {
    // The id stops a second toast when the effect runs twice (StrictMode).
    if (invalid) toast(UNKNOWN_ACCOUNT_MESSAGE, { id: 'unknown-account' });
  }, [invalid]);

  useEffect(() => {
    if (valid) storeLastAccount(scope);
  }, [valid, scope]);

  if (invalid) return <Navigate to="/all" replace />;
  // Wait for the account list before showing an account; on error, let the page show its own errors.
  if (!valid && !accounts.isError) {
    return (
      <Card>
        <CardSkeleton />
      </Card>
    );
  }
  return <Outlet />;
}

/** `/`: the last chosen account if it still exists, otherwise `/all`. */
export function RootRedirect() {
  const last = readLastAccount();
  const accounts = useAccounts();
  if (last === null || last === 'all') return <Navigate to="/all" replace />;
  if (accounts.data === undefined) {
    if (accounts.isError) return <Navigate to="/all" replace />;
    return null;
  }
  const exists = accounts.data.accounts.some((account) => account.id === last);
  return <Navigate to={exists ? `/${String(last)}` : '/all'} replace />;
}
