import { BRANDING } from '@fireside/shared';
import type { ReactNode } from 'react';
import { Footer } from '@/components/shell/Footer';
import { Logo } from '@/components/shell/Logo';
import { cn } from '@/lib/utils';

// The frame of the pages outside the app shell: one card on `--page`, the logo
// and name, a Space Grotesk title, and the footer with the disclaimer. Login,
// invite and reset centre the card; `/about` keeps it at the top for reading.

/** Inputs on these pages are 44 px high, on PC too. */
export const AUTH_INPUT = 'h-11 bg-page';

export function AuthFrame({
  title,
  wide = false,
  children,
}: {
  title: string;
  /** `/about`: 640 px, at the top of the page. Otherwise 400 px, centred. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="safe-area flex min-h-screen flex-col bg-page">
      <main
        className={cn('flex flex-1 flex-col items-center px-4 py-16', !wide && 'justify-center')}
      >
        <section
          className={cn(
            'flex w-full min-w-0 flex-col gap-4 rounded-[14px] border border-border bg-card p-7',
            wide ? 'max-w-[640px]' : 'max-w-[400px]',
          )}
        >
          <div className="flex items-center gap-2.5">
            <Logo className="size-[34px]" />
            <span className="font-display text-lg font-semibold">{BRANDING.displayName}</span>
          </div>
          <h1 className="m-0 font-display text-[26px] leading-tight font-semibold">{title}</h1>
          {children}
        </section>
      </main>
      <Footer />
    </div>
  );
}

/** The Jagex warning about passwords, on every page that asks for one. */
export function PasswordWarning() {
  return <p className="m-0 text-xs leading-normal text-text-2">{BRANDING.jagexPasswordWarning}</p>;
}
