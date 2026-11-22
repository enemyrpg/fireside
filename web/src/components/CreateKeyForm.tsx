import type { CreateKeyResponse } from '@fireside/shared';
import { useId, useState, type SyntheticEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AUTH_ME_KEY } from '@/api/auth';
import { ApiError, fieldErrors } from '@/api/errors';
import { useCreateKey } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * "Create API key" with a name field. The name rule lives on the server (shared
 * with the CLI); its message shows under the field.
 */
export function CreateKeyForm({ onCreated }: { onCreated: (created: CreateKeyResponse) => void }) {
  const [name, setName] = useState('');
  const create = useCreateKey();
  const queryClient = useQueryClient();
  const inputId = useId();
  const errorId = useId();
  const helpId = `${inputId}-help`;

  const errors = fieldErrors(create.error);
  // A message on the name, a message for the whole request (the limit of
  // active keys), or a general one.
  const requestMessage =
    create.error instanceof ApiError && create.error.status === 409
      ? create.error.message
      : undefined;
  const message = create.isError
    ? (errors.name ?? errors[''] ?? requestMessage ?? "Couldn't create the key. Try again.")
    : undefined;

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    create.mutate(name, {
      onSuccess: (created) => {
        setName('');
        onCreated(created);
      },
      onError: (error) => {
        // The admin took the permission away while the page was open: `auth/me`
        // now says so, and the Keys tab swaps this form for the explanation.
        if (error instanceof ApiError && error.status === 403) {
          void queryClient.invalidateQueries({ queryKey: AUTH_ME_KEY });
        }
      },
    });
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2.5">
      <Label htmlFor={inputId} className="text-xs font-normal text-text-2">
        Name
      </Label>
      <Input
        id={inputId}
        value={name}
        placeholder="Gaming PC"
        autoComplete="off"
        className="bg-page"
        aria-invalid={message !== undefined}
        aria-describedby={message !== undefined ? `${errorId} ${helpId}` : helpId}
        onChange={(event) => {
          setName(event.target.value);
          if (create.isError) create.reset();
        }}
      />
      {message !== undefined && (
        <p id={errorId} className="m-0 text-xs text-down">
          {message}
        </p>
      )}
      <p id={helpId} className="m-0 text-xs text-text-3">
        So you can tell your keys apart, e.g. the computer the plugin runs on.
      </p>
      <Button type="submit" disabled={create.isPending} className="desk:self-start">
        {create.isPending ? 'Creating…' : 'Create key'}
      </Button>
    </form>
  );
}
