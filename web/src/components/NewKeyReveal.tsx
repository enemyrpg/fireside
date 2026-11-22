import type { CreateKeyResponse } from '@fireside/shared';
import { SecretReveal } from '@/components/SecretReveal';

/** The full key, right after it was created. */
export function NewKeyReveal({ created }: { created: CreateKeyResponse }) {
  return (
    <SecretReveal
      label={`New API key ${created.apiKey.name}`}
      title={created.apiKey.name}
      value={created.key}
      announcement="API key created. Copy it now."
      hint="Copy it now. You won't see the full key again."
    />
  );
}
