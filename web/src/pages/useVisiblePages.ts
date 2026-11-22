import { useIsAdmin } from '@/api/auth';
import { useHasBankData, useHasClogData, useHasPetsPage, useHasQuestData } from '@/api/hooks';
import { PAGES, type PageDef, type PageRequirement } from './registry';

/**
 * Whether a page exists right now: `true`, `false`, or `undefined` while a
 * page that needs data doesn't know yet. Admin-only pages don't exist for
 * members.
 */
export function usePageExists(): (page: PageDef) => boolean | undefined {
  const has: Record<PageRequirement, boolean | undefined> = {
    bank: useHasBankData(),
    quests: useHasQuestData(),
    clog: useHasClogData(),
    pets: useHasPetsPage(),
  };
  const isAdmin = useIsAdmin();
  return (page) => {
    if (page.adminOnly === true && !isAdmin) return false;
    return page.requires === undefined ? true : has[page.requires];
  };
}

/**
 * The pages that exist right now, for menus (no "coming soon" pages). A
 * page that needs data is left out until the data is there, also while that is
 * still unknown, so a menu item never flashes and goes. Admin-only pages are
 * left out for members. Every menu uses this list; the route itself is guarded
 * by `PageGate`.
 */
export function useVisiblePages(): readonly PageDef[] {
  const exists = usePageExists();
  return PAGES.filter((page) => exists(page) === true);
}
