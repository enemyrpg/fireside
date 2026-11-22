import { z } from 'zod';
import { ApiError } from '../errors.js';

/**
 * Parses a request part (`params`, `query` or `body`) with a strict schema. Errors
 * become `400 VALIDATION_ERROR` with paths like `query.limit`
 * or `body.name`.
 */
export function parseRequest<S extends z.ZodType>(
  schema: S,
  value: unknown,
  part: 'params' | 'query' | 'body',
): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new ApiError(
    400,
    'VALIDATION_ERROR',
    'Invalid request',
    result.error.issues.map((issue) => ({
      path: [part, ...issue.path.map(String)].join('.'),
      message: issue.message,
    })),
  );
}

/** Query schema for endpoints without query parameters: unknown ones are still rejected. */
export const noQuerySchema = z.strictObject({});
