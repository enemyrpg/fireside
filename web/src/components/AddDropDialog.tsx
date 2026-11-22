import { cn } from '@/lib/utils';
import { RAIDS } from '@fireside/shared';
import { useState, type SyntheticEvent } from 'react';
import { fieldErrors } from '@/api/errors';
import { useAddRaidDrop } from '@/api/hooks';
import { DateTimeField } from '@/components/DateTimeField';
import { FormField } from '@/components/FormField';
import {
  DIALOG_FOOTER,
  DIALOG_TITLE,
  dialogSurface,
  focusOnOpen,
  SHEET_TITLE_PROPS,
  SheetHandle,
} from '@/components/ui/sheet';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFormat } from '@/hooks/useFormat';
import { useLocalToday } from '@/hooks/useLocalToday';
import { useReturnFocus } from '@/hooks/useReturnFocus';
import {
  GP_INPUT_HINT,
  NICKNAME_MAX_LENGTH,
  OWN_NOTE_HELP,
  EARLIEST_DROP_DATE,
  parseAddDropForm,
  RECIPIENT_OPTIONS,
  SAVE_FAILED,
  type AddDropForm,
  type DropFormErrors,
} from '@/lib/raid-splits';
import { localDateTimeOf } from '@/lib/time';

export const ADD_DROP_TITLE = 'Add a drop';
export const ADD_DROP_HELP =
  'For purples the plugin didn’t record, e.g. from before you installed it.';
export const GOT_BY_LABEL = 'Got by';

const FIELDS = ['raid', 'itemId', 'occurredAt', 'partySize', 'nickname', 'ownValue'];

function AddDropFormBody({
  accountId,
  timeZone,
  onClose,
}: {
  accountId: number;
  timeZone: string;
  onClose: () => void;
}) {
  // Now, in the server's time zone (never the browser's).
  const today = useLocalToday(timeZone);
  const [form, setForm] = useState<AddDropForm>(() => ({
    recipient: 'TEAMMATE',
    raid: '',
    itemId: '',
    ...localDateTimeOf(Date.now(), timeZone),
    partySize: '',
    nickname: '',
    soldFor: '',
  }));
  const [invalid, setInvalid] = useState<DropFormErrors>({});
  const add = useAddRaidDrop();

  const fromServer = fieldErrors(add.error);
  const errors: DropFormErrors = { ...fromServer, ...invalid };
  const general = add.isError && !FIELDS.some((key) => key in fromServer) ? SAVE_FAILED : undefined;
  const purples = RAIDS.find((raid) => raid.modes.some((mode) => mode.name === form.raid))?.purples;

  const set = (changes: Partial<AddDropForm>) => {
    setForm((current) => ({ ...current, ...changes }));
    setInvalid({});
    if (add.isError) add.reset();
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (add.isPending) return;
    const parsed = parseAddDropForm(form, timeZone);
    if (!parsed.ok) {
      setInvalid(parsed.errors);
      return;
    }
    add.mutate({ accountId, body: parsed.body }, { onSuccess: onClose });
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3.5">
      <div className="flex flex-col items-start gap-1.5">
        <span className="text-xs text-text-2">{GOT_BY_LABEL}</span>
        <SegmentedFilter
          label={GOT_BY_LABEL}
          options={RECIPIENT_OPTIONS}
          value={form.recipient}
          onChange={(recipient) => {
            set({ recipient });
          }}
        />
      </div>
      {/* Two columns on PC, one on mobile. */}
      <div className="grid items-start gap-3.5 desk:grid-cols-2">
        <FormField label="Raid" error={errors.raid}>
          {(control) => (
            <Select
              value={form.raid}
              onValueChange={(raid) => {
                // The purples belong to the raid, so the item is chosen again.
                set({ raid, itemId: '' });
              }}
            >
              <SelectTrigger {...control} className="w-full bg-page">
                <SelectValue placeholder="Choose a raid" />
              </SelectTrigger>
              <SelectContent>
                {RAIDS.flatMap((raid) => raid.modes).map((mode) => (
                  <SelectItem key={mode.name} value={mode.name}>
                    {mode.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        <FormField label="Item" error={errors.itemId}>
          {(control) => (
            <Select
              value={form.itemId}
              disabled={purples === undefined}
              onValueChange={(itemId) => {
                set({ itemId });
              }}
            >
              <SelectTrigger {...control} className="w-full bg-page">
                <SelectValue placeholder={purples ? 'Choose an item' : 'Choose a raid first'} />
              </SelectTrigger>
              <SelectContent>
                {purples?.map((purple) => (
                  <SelectItem key={purple.itemId} value={String(purple.itemId)}>
                    {purple.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
      </div>
      <DateTimeField
        label="Date and time"
        date={form.date}
        time={form.time}
        today={today}
        min={EARLIEST_DROP_DATE}
        timeError={errors.time}
        error={errors.occurredAt}
        onDateChange={(date) => {
          set({ date });
        }}
        onTimeChange={(time) => {
          set({ time });
        }}
      />
      <div className="grid items-start gap-3.5 desk:grid-cols-2">
        <FormField label="Party size" optional error={errors.partySize}>
          {(control) => (
            <Input
              {...control}
              // Text, not `type="number"`: a number field reports "4x" as empty.
              inputMode="numeric"
              autoComplete="off"
              value={form.partySize}
              className="bg-page"
              onChange={(event) => {
                set({ partySize: event.target.value });
              }}
            />
          )}
        </FormField>
        {/* Only a teammate's drop can have a nickname. */}
        {form.recipient === 'TEAMMATE' && (
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
      <FormField
        label="Sold for"
        optional
        help={`Leave empty to use the latest GE price in your own data. ${GP_INPUT_HINT}`}
        error={errors.ownValue}
      >
        {(control) => (
          <Input
            {...control}
            value={form.soldFor}
            inputMode="decimal"
            autoComplete="off"
            className="bg-page"
            onChange={(event) => {
              set({ soldFor: event.target.value });
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
        <Button type="button" variant="ghost" disabled={add.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={add.isPending}>
          {add.isPending ? 'Adding…' : 'Add drop'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Adds a purple the plugin didn't record: the owner's own, e.g. from before the
 * plugin was installed, or a teammate's. On one account; stored in its own
 * table, never as an event.
 */
export function AddDropDialog({
  open,
  accountId,
  onClose,
}: {
  open: boolean;
  accountId: number;
  onClose: () => void;
}) {
  const { timeZone } = useFormat();
  const returnFocus = useReturnFocus(open);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className={dialogSurface(480)}
        onCloseAutoFocus={returnFocus}
        // PC: Radix's choice (the first control). Mobile: the title.
        onOpenAutoFocus={(event) => {
          focusOnOpen(event, { field: null });
        }}
      >
        <SheetHandle />
        <DialogHeader className="text-left">
          <DialogTitle className={cn(DIALOG_TITLE, 'outline-none')} {...SHEET_TITLE_PROPS}>
            {ADD_DROP_TITLE}
          </DialogTitle>
          <DialogDescription className="text-text-2">{ADD_DROP_HELP}</DialogDescription>
        </DialogHeader>
        {open && <AddDropFormBody accountId={accountId} timeZone={timeZone} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
