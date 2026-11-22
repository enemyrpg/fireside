import { UserIcon } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { SETTINGS_PATH } from '@/pages/registry';

/**
 * The profile icon: a plain link to Settings, in the top bar on PC and in the
 * page header on mobile. Marked on Settings pages.
 */
export function ProfileLink({ active }: { active: boolean }) {
  return (
    <Link
      to={SETTINGS_PATH}
      aria-label="Settings and profile"
      // Moves between the top bar and the page header (useCarryShellFocus).
      data-shell-control=""
      aria-current={active ? 'page' : undefined}
      className={cn(
        'grid size-11 flex-none place-items-center rounded-full border bg-raised no-underline desk:size-9',
        active
          ? 'border-accent text-accent-text'
          : 'border-border text-text-2 hover:border-accent hover:text-text',
      )}
    >
      <UserIcon aria-hidden="true" className="size-5 desk:size-[18px]" />
    </Link>
  );
}
