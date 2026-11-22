import { API_SCHEMAS, type ApiSchemaName } from '@fireside/shared';
import { ContractError } from './errors';

// Loaded only in development and tests (see client.ts), so the Zod schemas
// stay out of the production bundle.

export function validateResponse(name: ApiSchemaName, data: unknown): unknown {
  const result = API_SCHEMAS[name].safeParse(data);
  if (!result.success) {
    console.error(`Response does not match ${name}`, result.error.issues);
    throw new ContractError(`Response does not match ${name}`);
  }
  return data;
}
