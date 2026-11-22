import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DIALOG_FOOTER,
  DIALOG_TITLE,
  dialogSurface,
  focusOnOpen,
  isSheet,
  SHEET_TITLE_PROPS,
  SheetHandle,
} from '@/components/ui/sheet';
import { useReturnFocus } from '@/hooks/useReturnFocus';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** Shown on the confirm button while `pending`, e.g. "Revoking…". */
  pendingLabel: string;
  pending?: boolean;
  /** Red confirm button, for actions that can't be undone. */
  destructive?: boolean;
  /** Shown above the buttons when the action failed. The dialog stays open. */
  error?: string | undefined;
  /** Turns the confirm button off, e.g. until a password or name is typed. */
  confirmDisabled?: boolean;
  /** Form fields between the description and the buttons. */
  children?: ReactNode;
  onConfirm: () => void;
  /**
   * A second, milder way to go ahead, left of the confirm button, e.g. "Block
   * only" next to "Block and revoke 3 keys". Shares `pending`.
   */
  secondary?:
    { label: string; pendingLabel: string; running: boolean; onClick: () => void } | undefined;
  /**
   * Where focus goes when the dialog closes, worked out at that moment, for a
   * dialog whose opener is gone (e.g. opened from another dialog). `null` or
   * nothing to focus: back to what had focus when it opened, as usual.
   */
  focusOnClose?: (() => HTMLElement | null) | undefined;
}

/**
 * Asks before an action: revoking an API key, a rebuild, deleting a user (with
 * a field to type a name or password). The caller closes it when the action
 * succeeds.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  pending = false,
  destructive = false,
  error,
  confirmDisabled = false,
  children,
  onConfirm,
  secondary,
  focusOnClose,
}: ConfirmDialogProps) {
  // Opened from state, not an AlertDialogTrigger: go back to the opener on close.
  const returnFocus = useReturnFocus(open);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Don't close while the action runs.
        if (!pending) onOpenChange(next);
      }}
    >
      {/* A box on PC, a sheet from the bottom on mobile (`dialogSurface`). */}
      <AlertDialogContent
        className={dialogSurface(420)}
        onCloseAutoFocus={(event) => {
          const target = focusOnClose?.();
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
            return;
          }
          returnFocus(event);
        }}
        // With a field (a name, a password), start in it rather than on Cancel,
        // so typing goes where it should.
        // On mobile (a sheet) the title instead, so the keyboard doesn't open by itself.
        onOpenAutoFocus={(event) => {
          const field = (event.currentTarget as HTMLElement | null)?.querySelector('input');
          // Without a field: Radix's choice (Cancel), on PC and mobile.
          if (!field) return;
          focusOnOpen(event, { field });
        }}
        // A sheet closes when the backdrop is tapped, like the other sheets
        // (an alert dialog on PC still needs an answer).
        onOverlayClick={() => {
          if (isSheet() && !pending) onOpenChange(false);
        }}
      >
        <SheetHandle />
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle className={cn(DIALOG_TITLE, 'outline-none')} {...SHEET_TITLE_PROPS}>
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-text-2">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children !== undefined && children !== null && (
          // Enter in a field confirms, like the confirm button.
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              if (!pending && !confirmDisabled) onConfirm();
            }}
          >
            {children}
            <button type="submit" hidden tabIndex={-1} />
          </form>
        )}
        {error !== undefined && (
          <p role="alert" className="m-0 text-sm text-down">
            {error}
          </p>
        )}
        <AlertDialogFooter className={DIALOG_FOOTER}>
          <AlertDialogCancel variant="ghost" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          {secondary && (
            <Button variant="outline" disabled={pending} onClick={secondary.onClick}>
              {pending && secondary.running ? secondary.pendingLabel : secondary.label}
            </Button>
          )}
          {/* A plain button, not AlertDialogAction, so the dialog stays open while it runs. */}
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending || confirmDisabled}
            onClick={onConfirm}
          >
            {pending && !secondary?.running ? pendingLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
