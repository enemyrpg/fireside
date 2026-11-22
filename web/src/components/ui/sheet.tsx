import { DESK_QUERY } from '@/hooks/useIsDesktop';
import { cn } from '@/lib/utils';

// Dialogs are a box in the middle of the screen on PC and a sheet from the
// bottom on mobile. Shared by `ConfirmDialog` (Radix AlertDialog),
// `EditDropDialog` and `AddDropDialog` (Radix Dialog). Esc closes and focus
// goes back to the opener (`useReturnFocus`), as before.

/**
 * Classes for `DialogContent`/`AlertDialogContent`. The theme has only the
 * `desk:` breakpoint, so the shadcn `sm:` layout is replaced here. `maxWidth`
 * is the box's width on PC.
 */
export function dialogSurface(maxWidth: 420 | 480): string {
  return cn(
    'gap-4 border-border-strong bg-card overflow-y-auto',
    // PC: centred box.
    'desk:rounded-2xl desk:p-6 desk:max-h-[calc(100dvh-2rem)]',
    maxWidth === 420 ? 'desk:max-w-[420px]' : 'desk:max-w-[480px]',
    // Mobile: a sheet along the bottom, above the home indicator.
    'max-desk:top-auto max-desk:left-0 max-desk:max-w-none max-desk:translate-x-0 max-desk:translate-y-0',
    'max-desk:rounded-t-[20px] max-desk:rounded-b-none max-desk:border-x-0 max-desk:border-b-0',
    'max-desk:pr-[max(16px,var(--safe-right))] max-desk:pl-[max(16px,var(--safe-left))] max-desk:pt-2.5 max-desk:pb-[calc(24px+var(--safe-bottom))]',
    // Above the on-screen keyboard: `--keyboard-inset` and `--visual-height` follow the
    // visual viewport (lib/visual-viewport.ts), which is what shrinks on iOS Safari.
    'max-desk:bottom-[var(--keyboard-inset,0px)] max-desk:max-h-[calc(var(--visual-height,100dvh)-var(--safe-top)-1rem)]',
    'max-desk:animate-[sheet-in_200ms_ease-out]',
  );
}

/** Title of a dialog or sheet: Space Grotesk 20/600. */
export const DIALOG_TITLE = 'font-display text-xl font-semibold leading-tight';

/** The buttons: right-aligned on PC, sharing the width with 44 px targets on mobile. */
export const DIALOG_FOOTER =
  'mt-1.5 flex flex-row gap-2 desk:justify-end max-desk:[&>button]:h-11 max-desk:[&>button]:flex-1';

/** The grab handle at the top of a sheet. Decoration only. */
export function SheetHandle() {
  return (
    <span
      aria-hidden="true"
      className="mx-auto -mb-1 block h-1 w-10 rounded-sm bg-border-strong desk:hidden"
    />
  );
}

/** Marks the title of a dialog or sheet, so it can take focus on mobile (not a tab stop). */
export const SHEET_TITLE_PROPS = { 'data-sheet-title': '', tabIndex: -1 } as const;

/** Whether dialogs are sheets now (the mobile layout). */
export function isSheet(): boolean {
  return !window.matchMedia(DESK_QUERY).matches;
}

/**
 * What a dialog focuses when it opens.
 *
 * PC: `field` (the first or the asked-for field), so typing goes where it
 * should. `null` leaves it to Radix.
 *
 * Mobile (a sheet): the title, so the on-screen keyboard only opens when a
 * field is tapped and doesn't cover the sheet. The one exception is a sheet
 * opened to fill in one field ("Set party size", "Set value"): `asked`.
 */
export function openFocusTarget(
  content: HTMLElement,
  { sheet, field, asked = false }: { sheet: boolean; field: HTMLElement | null; asked?: boolean },
): HTMLElement | null {
  if (!sheet || (asked && field)) return field;
  return content.querySelector<HTMLElement>('[data-sheet-title]');
}

/**
 * `onOpenAutoFocus` for a dialog's content: focuses what `openFocusTarget`
 * says, or leaves Radix's own choice when there is nothing to focus.
 */
export function focusOnOpen(
  event: Event,
  options: { field: HTMLElement | null; asked?: boolean },
): void {
  const content = event.currentTarget;
  if (!(content instanceof HTMLElement)) return;
  const target = openFocusTarget(content, { sheet: isSheet(), ...options });
  if (!target) return;
  event.preventDefault();
  target.focus();
}
