import { BRANDING } from '@fireside/shared';
import type { ReactNode } from 'react';
import { Footer } from './Footer';
import { Logo } from './Logo';

export interface FullPageMessageProps {
  title: string;
  children?: ReactNode;
  /** Link or button back. */
  action?: ReactNode;
}

/**
 * Full-page message for 403, 404 and unexpected errors. Keeps the footer with
 * the disclaimer.
 */
export function FullPageMessage({ title, children, action }: FullPageMessageProps) {
  return (
    <div className="safe-area flex min-h-screen flex-col">
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
        <div className="flex items-center gap-2.5 font-semibold">
          <Logo />
          {BRANDING.displayName}
        </div>
        <h1 className="m-0 font-display text-2xl font-semibold">{title}</h1>
        {children !== undefined && <div className="max-w-[480px] text-text-2">{children}</div>}
        {action}
      </main>
      <Footer />
    </div>
  );
}
