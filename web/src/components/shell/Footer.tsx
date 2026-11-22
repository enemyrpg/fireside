import { BRANDING } from '@fireside/shared';
import { useHealth } from '@/api/hooks';
import { cn } from '@/lib/utils';
import { SHELL_EDGE } from './edge';
import { ABOUT_PATH } from '@/pages/settings/paths';

/**
 * Footer on every page, including Settings and error pages: the Jagex Fan
 * Content Policy disclaimer, versions, the link to the instance text (`/about`)
 * and the source link.
 */
export function Footer({ className }: { className?: string }) {
  const health = useHealth().data;

  return (
    <footer
      className={cn(
        `flex flex-wrap justify-between gap-4 border-t border-border py-4 text-xs text-text-3 ${SHELL_EDGE}`,
        className,
      )}
    >
      <span>{BRANDING.jagexDisclaimer}</span>
      <span>
        {health && (
          <>
            Server {health.serverVersion} · contract {health.contractVersion} ·{' '}
          </>
        )}
        {/* A full page load: the auth gate shows `/about` before the router. */}
        <a href={ABOUT_PATH} className="underline">
          About
        </a>{' '}
        ·{' '}
        <a href={BRANDING.repositoryUrl} target="_blank" rel="noreferrer" className="underline">
          GitHub
        </a>
      </span>
    </footer>
  );
}
