import {
  DEFAULT_INVITE_DURATION_DAYS,
  type CreatedInviteResponse,
  type InviteDuration,
  type UserRole,
} from '@fireside/shared';
import { useState, type SyntheticEvent } from 'react';
import { fieldErrors } from '@/api/errors';
import { formErrorMessage, useCreateInvite, useServerSettings } from '@/api/users';
import { FormField } from '@/components/FormField';
import { SegmentedFilter } from '@/components/Segmented';
import { Switch } from '@/components/Switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const DURATIONS = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
] as const;

type DurationValue = (typeof DURATIONS)[number]['value'];

/**
 * "Create invite": label, role, key permission and how long the link works (1,
 * 7 or 30 days, never without expiry). The label rule lives on the server; its
 * message shows under the field.
 */
export function CreateInviteForm({
  onCreated,
}: {
  onCreated: (created: CreatedInviteResponse) => void;
}) {
  const [label, setLabel] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  // Starts from the server's default (Settings → Server); on while that loads
  // or if it can't be read, so the form is never blocked.
  const defaults = useServerSettings().data;
  /** What the admin chose in this form; `undefined` until they touch the switch. */
  const [chosen, setChosen] = useState<boolean>();
  const canCreateApiKeys = chosen ?? defaults?.defaultInviteCanCreateApiKeys ?? true;
  const [days, setDays] = useState<DurationValue>(
    String(DEFAULT_INVITE_DURATION_DAYS) as DurationValue,
  );
  const create = useCreateInvite();

  const labelError = fieldErrors(create.error).label;
  const message =
    create.isError && labelError === undefined
      ? formErrorMessage(create.error, "Couldn't create the invite. Try again.")
      : undefined;

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    create.mutate(
      { label, role, canCreateApiKeys, days: Number(days) as InviteDuration },
      {
        onSuccess: (created) => {
          setLabel('');
          onCreated(created);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <FormField
        label="Label"
        optional
        help="Only you see it, e.g. who the invite is for."
        error={labelError}
      >
        {(control) => (
          <Input
            {...control}
            value={label}
            placeholder="For a friend"
            autoComplete="off"
            className="bg-page"
            onChange={(event) => {
              setLabel(event.target.value);
              if (create.isError) create.reset();
            }}
          />
        )}
      </FormField>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <FormField label="Role">
          {(control) => (
            <Select
              value={role}
              onValueChange={(value) => {
                setRole(value === 'admin' ? 'admin' : 'member');
              }}
            >
              <SelectTrigger size="sm" id={control.id} className="min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          )}
        </FormField>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-text-2">Link works for</span>
          <SegmentedFilter
            options={DURATIONS}
            value={days}
            onChange={setDays}
            label="Link works for"
          />
        </div>
      </div>
      <Switch label="Can create API keys" checked={canCreateApiKeys} onChange={setChosen} />
      {message !== undefined && (
        <p role="alert" className="m-0 text-sm text-down">
          {message}
        </p>
      )}
      <Button type="submit" disabled={create.isPending} className="desk:self-start">
        {create.isPending ? 'Creating…' : 'Create invite'}
      </Button>
    </form>
  );
}
