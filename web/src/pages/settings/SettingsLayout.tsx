import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useIsAdmin } from '@/api/auth';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { SETTINGS_ACCOUNTS_PATH } from '@/lib/accounts';
import { cn } from '@/lib/utils';
import { SETTINGS_KEYS_PATH, SETTINGS_SERVER_PATH, SETTINGS_USERS_PATH } from './paths';

// The frame of every Settings screen: a menu on the left on PC and a dropdown above the cards
// on mobile, in place of the old tabs (`PageTabs`). Each item is its own route.
// A screen below a tab (revoked keys, past invites) keeps its tab marked.

export type SettingsSection = 'profile' | 'keys' | 'accounts' | 'users' | 'server';

interface MenuItem {
  section: SettingsSection;
  to: string;
  label: string;
}

const ITEMS: readonly MenuItem[] = [
  { section: 'profile', to: '/settings', label: 'Profile' },
  { section: 'keys', to: SETTINGS_KEYS_PATH, label: 'API keys' },
  { section: 'accounts', to: SETTINGS_ACCOUNTS_PATH, label: 'OSRS accounts' },
];

/** Only for admins: every card on them reads an admin-only endpoint. */
const ADMIN_ITEMS: readonly MenuItem[] = [
  { section: 'users', to: SETTINGS_USERS_PATH, label: 'Users' },
  { section: 'server', to: SETTINGS_SERVER_PATH, label: 'Server' },
];

/** Width of the content column per screen (Profile 720, Server no limit). */
const CONTENT_WIDTH: Record<SettingsSection, string> = {
  profile: 'desk:max-w-[720px]',
  keys: 'desk:max-w-[760px]',
  accounts: 'desk:max-w-[760px]',
  users: 'desk:max-w-[760px]',
  server: '',
};

function SideMenu({ items, current }: { items: readonly MenuItem[]; current: SettingsSection }) {
  const isAdmin = useIsAdmin();
  return (
    <div className="flex flex-[0_1_200px] flex-col">
      <nav aria-label="Settings" className="flex flex-col gap-0.5">
        {items.map((item) => (
          <Link
            key={item.section}
            to={item.to}
            aria-current={item.section === current ? 'page' : undefined}
            className={cn(
              'rounded-lg px-3 py-2.5 text-text-2 no-underline hover:bg-hover hover:text-text',
              item.section === current && 'bg-accent-wash font-semibold text-accent-text',
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {isAdmin && (
        <p className="m-0 px-3 pt-3.5 text-xs text-text-3">Users and Server are for admins only.</p>
      )}
    </div>
  );
}

function MenuDropdown({
  items,
  current,
}: {
  items: readonly MenuItem[];
  current: SettingsSection;
}) {
  const label = items.find((item) => item.section === current)?.label ?? 'Settings';
  return (
    <nav aria-label="Settings">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Settings section: ${label}`}
            className="flex h-11 w-full items-center justify-between rounded-[10px] border border-border bg-card px-3.5 text-text"
          >
            <span>{label}</span>
            <ChevronDownIcon aria-hidden="true" className="size-4 text-text-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) rounded-xl border-border-strong bg-raised p-1.5"
        >
          {items.map((item) => (
            <DropdownMenuItem key={item.section} asChild className="min-h-11 rounded-lg px-3">
              <Link
                to={item.to}
                aria-current={item.section === current ? 'page' : undefined}
                className={cn(
                  'text-text no-underline',
                  item.section === current && 'font-semibold text-accent-text',
                )}
              >
                {item.label}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}

export function SettingsLayout({
  section,
  children,
}: {
  /** The menu item to mark: the screen's own tab, or the tab it belongs to. */
  section: SettingsSection;
  children: ReactNode;
}) {
  const isAdmin = useIsAdmin();
  const isDesktop = useIsDesktop();
  const items = isAdmin ? [...ITEMS, ...ADMIN_ITEMS] : ITEMS;
  return (
    <div className="flex flex-col gap-4 desk:flex-row desk:flex-wrap desk:items-start desk:gap-5">
      {isDesktop ? (
        <SideMenu items={items} current={section} />
      ) : (
        <MenuDropdown items={items} current={section} />
      )}
      <div
        className={cn(
          'flex min-w-0 flex-col gap-4 desk:flex-[1_1_520px] desk:gap-5',
          CONTENT_WIDTH[section],
        )}
      >
        {children}
      </div>
    </div>
  );
}
