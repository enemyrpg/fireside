import { useHealth } from '@/api/hooks';
import { Card, CardHeader } from '@/components/Card';
import { ThemeList } from '@/components/shell/ThemeList';
import { PasswordCard, UserCard } from './settings/AccountCard';
import { DeleteAccountCard } from './settings/DeleteAccountCard';
import { SettingsLayout } from './settings/SettingsLayout';
import { TwoFactorCard } from './settings/TwoFactorCard';

// Settings → Profile, the tab `/settings` opens. Order: You, Theme,
// Password, Two-factor, Time zone. The other tabs live in `./settings/`.

export function SettingsPage() {
  const timeZone = useHealth().data?.timeZone;

  return (
    <SettingsLayout section="profile">
      <UserCard />
      <Card>
        <CardHeader title="Theme" />
        <ThemeList />
      </Card>
      <PasswordCard />
      <TwoFactorCard />
      <Card>
        <CardHeader title="Time zone" />
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="text-text-2">{timeZone}</span>
          <span className="text-xs text-text-3">Set by the server (TZ)</span>
        </div>
        <p className="mt-2 mb-0 text-xs text-text-3">
          Days, weeks and all times in the dashboard use this time zone. Change it with TZ in .env.
        </p>
      </Card>
      <DeleteAccountCard />
    </SettingsLayout>
  );
}
