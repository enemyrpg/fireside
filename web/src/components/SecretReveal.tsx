import type { ReactNode } from 'react';
import { Badge } from '@/components/Badge';
import { CopyButton } from '@/components/CopyButton';

export interface SecretRevealProps {
  /** Accessible name of the section, e.g. "New API key Gaming PC". */
  label: string;
  /** Bold title, e.g. the key's name or "Invite K7Q2M4XP". */
  title: ReactNode;
  /** The secret: a full API key or a link. */
  value: string;
  /** Announced to screen readers when it appears, never the secret itself. */
  announcement: string;
  /** Under the value, e.g. "Copy it now. You won't see the full key again." */
  hint: string;
  /** Shown above the hint in body text, e.g. that the link only works on this computer. */
  warning?: string | undefined;
  /**
   * Makes the title a heading with this id that can take focus from code
   * (not a tab stop), so a page can move focus to a reveal that appears
   * away from where the action started (Users).
   */
  headingId?: string | undefined;
}

/**
 * A secret shown once with Copy, right after it was made: an API key or an
 * invite or reset link. The server never returns it again, so it lives only in
 * the page's state.
 */
export function SecretReveal({
  label,
  title,
  value,
  announcement,
  hint,
  warning,
  headingId,
}: SecretRevealProps) {
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-2.5 rounded-lg border border-accent bg-raised px-3.5 py-3"
    >
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div className="flex min-w-0 items-center gap-2">
        {headingId === undefined ? (
          <b className="truncate font-semibold">{title}</b>
        ) : (
          <h3
            id={headingId}
            tabIndex={-1}
            className="m-0 truncate text-sm font-semibold outline-none"
          >
            {title}
          </h3>
        )}
        <Badge>New</Badge>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* Selectable, so it can be copied by hand if the clipboard is refused. */}
        <code className="min-w-0 flex-1 rounded-md bg-page px-2.5 py-2 font-mono text-table break-all select-all">
          {value}
        </code>
        <CopyButton value={value} />
      </div>
      {warning !== undefined && <p className="m-0 text-xs font-medium text-text">{warning}</p>}
      <p className="m-0 text-xs text-text-2">{hint}</p>
    </section>
  );
}
