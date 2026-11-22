import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

// A folder for the seed datasets the `*-seed.test.ts` files share
// (src/seed/testing.ts). It lives for one test run: it is emptied before
// each rerun in watch mode, so a dataset never outlives the code that built
// it, and removed at the end.
export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'seed-fixtures-'));
  project.provide('seedFixtureDir', dir);
  project.onTestsRerun(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
  });
  return () => {
    rmSync(dir, { recursive: true, force: true });
  };
}
