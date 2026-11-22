import { cn } from '@/lib/utils';
import type { RaidDrop, SplitMode } from '@fireside/shared';
import { useRef, useState, type RefObject, type SyntheticEvent } from 'react';
import { fieldErrors } from '@/api/errors';
import { useUpdateRaidDrop } from '@/api/hooks';
import { FormField } from '@/components/FormField';
import { SegmentedFilter } from '@/components/Segmented';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  DIALOG_FOOTER,
  DIALOG_TITLE,
  dialogSurface,
  focusOnOpen,
  SHEET_TITLE_PROPS,
  SheetHandle,
} from '@/components/ui/sheet';
import { formatInt } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useReturnFocus } from '@/hooks/useReturnFocus';
import {
  ACCOUNT_DEFAULT,
  dropChanges,
  dropForm,
  modeLabel,
  NICKNAME_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  OWN_NOTE_HELP,
  parseDropForm,
  SAVE_FAILED,
  soldForHelp,
  type DropForm,
  type DropFormErrors,
} from '@/lib/raid-splits';

/** The drop to edit, and the field to start in ("Set value", "Set party size"). */
export interface EditDropTarget {
  drop: RaidDrop;
  focus?: 'soldFor' | 'partySize';
}

function EditDropForm({
  target,
  defaultMode,
  initialFocus,
  onClose,
  onDelete,
}: {
  target: EditDropTarget;
  defaultMode: SplitMode;
  initialFocus: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onDelete: ((drop: RaidDrop) => void) | undefined;
}) {
  const { drop, focus = 'soldFor' } = target;
  const [form, setForm] = useState<DropForm>(() => dropForm(drop));
  const [invalid, setInvalid] = useState<DropFormErrors>({});
  const update = useUpdateRaidDrop();

  const fromServer = fieldErrors(update.error);
  const errors: DropFormErrors = { ...fromServer, ...invalid };
  // A failure that isn't about one of the fields.
  const general =
    update.isError &&
    !['ownValue', 'partySize', 'nickname', 'note'].some((key) => key in fromServer)
      ? SAVE_FAILED
      : undefined;

  const set = (changes: Partial<DropForm>) => {
    setForm((current) => ({ ...current, ...changes }));
    setInvalid({});
    if (update.isError) update.reset();
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (update.isPending) return;
    const parsed = parseDropForm(form);
    if (!parsed.ok) {
      setInvalid(parsed.errors);
      return;
    }
    const changes = dropChanges(drop, parsed.choices);
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    // On the drop's own account, so it also works under "All accounts".
    update.mutate(
      { accountId: drop.accountId, dropId: drop.dropId, changes },
      { onSuccess: onClose },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3.5">
      <FormField label="Sold for" optional help={soldForHelp(drop)} error={errors.ownValue}>
        {(control) => (
          <Input
            {...control}
            ref={focus === 'soldFor' ? initialFocus : undefined}
            value={form.soldFor}
            inputMode="decimal"
            autoComplete="off"
            placeholder={drop.geValue === null ? '' : formatInt(drop.geValue)}
            className="bg-page"
            onChange={(event) => {
              set({ soldFor: event.target.value });
            }}
          />
        )}
      </FormField>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-text-2">Mode</span>
        <SegmentedFilter
          block
          label="Mode"
          options={[
            {
              value: ACCOUNT_DEFAULT,
              label: `Account default (${modeLabel(defaultMode)})`,
              // Three equal columns on a phone: the long label doesn't fit.
              shortLabel: `Default (${modeLabel(defaultMode)})`,
            },
            { value: 'SPLIT', label: 'Split' },
            { value: 'FFA', label: 'FFA' },
          ]}
          value={form.mode}
          onChange={(mode) => {
            set({ mode });
          }}
        />
      </div>
      {/* Side by side on PC, one column on mobile. */}
      <div className="grid items-start gap-3.5 desk:grid-cols-2">
        <FormField
          label="Party size"
          help={
            drop.teamSize === null
              ? undefined
              : `Leave empty to use the size from the plugin (${String(drop.teamSize)}).`
          }
          error={errors.partySize}
        >
          {(control) => (
            <Input
              {...control}
              ref={focus === 'partySize' ? initialFocus : undefined}
              // Text, not `type="number"`: a number field reports "4x" as empty,
              // which would read as clearing the size.
              inputMode="numeric"
              autoComplete="off"
              value={form.partySize}
              // Empty means the plugin's size.
              placeholder={drop.teamSize === null ? 'Unknown' : String(drop.teamSize)}
              className="bg-page"
              onChange={(event) => {
                set({ partySize: event.target.value });
              }}
            />
          )}
        </FormField>
        {drop.recipient === 'TEAMMATE' && (
          <FormField label="Nickname" optional help={OWN_NOTE_HELP} error={errors.nickname}>
            {(control) => (
              <Input
                {...control}
                value={form.nickname}
                maxLength={NICKNAME_MAX_LENGTH}
                autoComplete="off"
                placeholder="Teammate"
                className="bg-page"
                onChange={(event) => {
                  set({ nickname: event.target.value });
                }}
              />
            )}
          </FormField>
        )}
      </div>
      <FormField label="Note" optional help={OWN_NOTE_HELP} error={errors.note}>
        {(control) => (
          <Input
            {...control}
            value={form.note}
            maxLength={NOTE_MAX_LENGTH}
            autoComplete="off"
            className="bg-page"
            onChange={(event) => {
              set({ note: event.target.value });
            }}
          />
        )}
      </FormField>
      {general !== undefined && (
        <p role="alert" className="m-0 text-sm text-down">
          {general}
        </p>
      )}
      <DialogFooter className={DIALOG_FOOTER}>
        {/* Mobile: the rows have no bin, so a drop added by hand is deleted from here. */}
        {drop.manual && onDelete && (
          <Button
            type="button"
            variant="ghost"
            className="text-down hover:text-down desk:mr-auto"
            disabled={update.isPending}
            onClick={() => {
              onDelete(drop);
            }}
          >
            Delete drop
          </Button>
        )}
        <Button type="button" variant="ghost" disabled={update.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The owner's choices for one purple: what it sold for, Split or FFA, the party
 * size, a nickname for a teammate's drop and a note. They are stored on the
 * server in their own tables, never in raw events.
 */
export function EditDropDialog({
  target,
  defaultMode,
  onClose,
  onDelete,
}: {
  /** Open while set. */
  target: EditDropTarget | undefined;
  /** The default of the drop's own account. */
  defaultMode: SplitMode;
  onClose: () => void;
  /**
   * "Delete drop" for a drop added by hand (mobile, where the rows have no
   * bin). The page closes this dialog and asks in `ConfirmDialog`, which then
   * decides where focus goes, so this dialog doesn't return it to the row.
   */
  onDelete?: ((drop: RaidDrop) => void) | undefined;
}) {
  const open = target !== undefined;
  const format = useFormat();
  const returnFocus = useReturnFocus(open);
  const deleting = useRef(false);
  const initialFocus = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className={dialogSurface(480)}
        // PC: the field. Mobile: the title, unless the sheet was opened for one
        // field ("Set party size", "Set value"), so the keyboard doesn't cover it.
        onOpenAutoFocus={(event) => {
          focusOnOpen(event, { field: initialFocus.current, asked: target?.focus !== undefined });
        }}
        onCloseAutoFocus={(event) => {
          if (deleting.current) {
            // The confirmation is open and has focus; leave it there.
            deleting.current = false;
            event.preventDefault();
            return;
          }
          returnFocus(event);
        }}
      >
        {target && (
          <>
            <SheetHandle />
            <DialogHeader className="text-left">
              <DialogTitle className={cn(DIALOG_TITLE, 'outline-none')} {...SHEET_TITLE_PROPS}>
                Edit drop
              </DialogTitle>
              <DialogDescription className="text-text-2">
                {target.drop.name} · {target.drop.raid} · {format.date(target.drop.occurredAt)}
              </DialogDescription>
            </DialogHeader>
            <EditDropForm
              key={target.drop.dropId}
              target={target}
              defaultMode={defaultMode}
              initialFocus={initialFocus}
              onClose={onClose}
              onDelete={
                onDelete &&
                ((drop) => {
                  deleting.current = true;
                  onDelete(drop);
                })
              }
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
