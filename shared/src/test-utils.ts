import { expect } from 'vitest';
import type { z } from 'zod';

/** Assertion helpers for one schema, used by the schema tests. */
export function schemaAsserts(schema: z.ZodType) {
  return {
    /** Parses `input` and fails with the issues if it's rejected. */
    accepts(input: unknown): unknown {
      const result = schema.safeParse(input);
      expect(result.error?.issues).toBeUndefined();
      return result.data;
    },
    rejects(input: unknown): void {
      expect(schema.safeParse(input).success).toBe(false);
    },
    /** Returns the issue paths of a failed parse, joined with dots. */
    issuePaths(input: unknown): string[] {
      const result = schema.safeParse(input);
      expect(result.success).toBe(false);
      return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
    },
  };
}

/** Copy of `object` without `key`. */
export function without<T extends object>(object: T, key: keyof T): Partial<T> {
  return Object.fromEntries(Object.entries(object).filter(([k]) => k !== key)) as Partial<T>;
}
