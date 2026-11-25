import { Card } from '@/components/Card';
import { CardSkeleton } from '@/components/states';
import { SettingsLayout, type SettingsSection } from '@/pages/settings/SettingsLayout';

/**
 * The rough shape of a page's body, while its code loads (the page header is
 * part of the shell and is already there):
 *
 * - `cards`: a grid of cards (Weekly, XP, a session …)
 * - `list`: one wide card with a long list (Sessions, Bank, Collection log …)
 * - a settings section: the settings menu itself, with cards beside it
 */
export type PageShape = 'cards' | 'list' | { settings: SettingsSection };

/**
 * Shown while a page's code loads. Like every skeleton it appears only after
 * 200 ms (`CardSkeleton`), and never as a spinner for the whole page
 * (docs/design.md, "Loading").
 */
export function PageSkeleton({ shape }: { shape: PageShape }) {
  if (shape === 'list') {
    return (
      <div data-testid="page-skeleton">
        <Card>
          <CardSkeleton lines={8} />
        </Card>
      </div>
    );
  }
  if (shape === 'cards') {
    return (
      <div data-testid="page-skeleton" className="grid gap-3.5 desk:grid-cols-2 desk:gap-5">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index}>
            <CardSkeleton lines={4} />
          </Card>
        ))}
      </div>
    );
  }
  return (
    <SettingsLayout section={shape.settings}>
      <div data-testid="page-skeleton" className="contents">
        <Card>
          <CardSkeleton lines={3} />
        </Card>
        <Card>
          <CardSkeleton lines={4} />
        </Card>
      </div>
    </SettingsLayout>
  );
}
