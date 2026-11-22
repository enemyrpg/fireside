import { useState, type ReactNode } from 'react';
import { useIsAdmin } from '@/api/auth';
import { PageNotFoundError } from '@/api/errors';
import {
  hasClogData,
  hasQuestData,
  useBankSummary,
  useClogStatuses,
  usePets,
  useQuestStatuses,
} from '@/api/hooks';
import { Card } from '@/components/Card';
import { CardSkeleton } from '@/components/states';
import type { PageDef } from '@/pages/registry';

function Waiting() {
  return (
    <Card>
      <CardSkeleton />
    </Card>
  );
}

/**
 * A page that needs bank data: the full-page 404 until an account has a bank
 * snapshot (no "coming soon" pages). The answer is asked for again when
 * the page opens, so a cached "no data" from before the first snapshot never
 * turns the page away; later refetches don't hide the page.
 */
function BankGate({ children }: { children: ReactNode }) {
  const summary = useBankSummary('all', { fresh: true });
  // Can't tell: let the page show its own errors.
  if (summary.isError) return children;
  if (summary.data === undefined || !summary.isFetchedAfterMount) return <Waiting />;
  if (summary.data.updatedAt === null) throw new PageNotFoundError("This page doesn't exist.");
  return children;
}

/**
 * A page whose data is asked for once per account (the endpoints don't take
 * `all`), by the same rules as `BankGate`:
 *
 * - One account with data is enough, cached or not: the page shows at once
 *   and never waits for the other accounts.
 * - The 404 needs a fresh "no data" from every account of a fresh account
 *   list, so neither a cached answer nor a cached list turns the page away.
 * - Until then, a failed call lets the page through to show its own Retry.
 *   The page reads the same queries, so its retry puts the failed one back to
 *   loading; `failed` keeps the page there meanwhile. Once the answers are in,
 *   the two rules above decide again.
 */
function PerAccountGate({
  hasData,
  isFetchedAfterMount,
  isError,
  children,
}: {
  /** Some account has data, as far as is known now. */
  hasData: boolean;
  /** The account list and every account's answer are from after the page opened. */
  isFetchedAfterMount: boolean;
  isError: boolean;
  children: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (hasData) return children;
  if (isFetchedAfterMount) throw new PageNotFoundError("This page doesn't exist.");
  if (isError && !failed) setFailed(true);
  // Can't tell: let the page show its own errors.
  if (isError || failed) return children;
  return <Waiting />;
}

/** A page that needs quest or diary data on some account. */
function QuestsGate({ children }: { children: ReactNode }) {
  const { statuses, isFetchedAfterMount, isError } = useQuestStatuses({ fresh: true });
  return (
    <PerAccountGate
      hasData={statuses?.some(hasQuestData) ?? false}
      isFetchedAfterMount={isFetchedAfterMount}
      isError={isError}
    >
      {children}
    </PerAccountGate>
  );
}

/** A page that needs a collection log on some account. */
function ClogGate({ children }: { children: ReactNode }) {
  const { statuses, isFetchedAfterMount, isError } = useClogStatuses({ fresh: true });
  return (
    <PerAccountGate
      hasData={statuses?.some(hasClogData) ?? false}
      isFetchedAfterMount={isFetchedAfterMount}
      isError={isError}
    >
      {children}
    </PerAccountGate>
  );
}

/**
 * The Pets page: a pet or a collection log on some account. The pets are one
 * call for `all`; the 404 needs a fresh "no pets" as well as a fresh "no
 * collection log" from every account.
 */
function PetsGate({ children }: { children: ReactNode }) {
  const clog = useClogStatuses({ fresh: true });
  const pets = usePets('all', { fresh: true });
  return (
    <PerAccountGate
      hasData={
        (clog.statuses?.some(hasClogData) ?? false) ||
        (pets.data !== undefined && pets.data.pets.length > 0)
      }
      isFetchedAfterMount={
        clog.isFetchedAfterMount && pets.data !== undefined && pets.isFetchedAfterMount
      }
      isError={clog.isError || pets.isError}
    >
      {children}
    </PerAccountGate>
  );
}

/**
 * An admin-only page: the full-page 404 for a member, the same as a page that
 * doesn't exist, and none of its admin-only requests are made. `auth/me` is
 * known here: `AuthGate` waits for it.
 */
function AdminGate({ children }: { children: ReactNode }) {
  if (!useIsAdmin()) throw new PageNotFoundError("This page doesn't exist.");
  return children;
}

/**
 * Enforces `requires` and `adminOnly` of a page for its route, in one place
 * for every page that exists only once its data does or only for admins.
 * Menus use `useVisiblePages`.
 */
export function PageGate({ page, children }: { page: PageDef; children: ReactNode }) {
  if (page.adminOnly === true) return <AdminGate>{children}</AdminGate>;
  if (page.requires === 'bank') return <BankGate>{children}</BankGate>;
  if (page.requires === 'quests') return <QuestsGate>{children}</QuestsGate>;
  if (page.requires === 'clog') return <ClogGate>{children}</ClogGate>;
  if (page.requires === 'pets') return <PetsGate>{children}</PetsGate>;
  return children;
}
