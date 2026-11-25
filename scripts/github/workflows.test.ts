import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Rules for every workflow (docs/decisions/0016-release-setup.md):
// read-only by default, no pull_request_target, and every action pinned to a
// commit SHA with its version in a comment, so Dependabot can update it.

const DIR = join(import.meta.dirname, '..', '..', '.github', 'workflows');
const FILES = readdirSync(DIR).filter((file) => /\.ya?ml$/.test(file));

interface Workflow {
  on: Record<string, unknown> | string | string[];
  permissions?: unknown;
  jobs: Record<
    string,
    {
      name?: string;
      needs?: string[] | string;
      if?: string;
      permissions?: unknown;
      steps?: { uses?: string }[];
    }
  >;
}

const workflows = FILES.map((file) => {
  const text = readFileSync(join(DIR, file), 'utf8');
  return { file, text, workflow: parse(text) as Workflow };
});

function triggers(on: Workflow['on']): string[] {
  if (typeof on === 'string') return [on];
  return Array.isArray(on) ? on : Object.keys(on);
}

describe('.github/workflows', () => {
  it('has workflows', () => {
    expect(FILES).toEqual(
      expect.arrayContaining([
        'ci.yml',
        'pr.yml',
        'release-please.yml',
        'release-image.yml',
        'release-contract.yml',
      ]),
    );
  });

  it.each(workflows)('$file: top-level permissions are contents: read only', ({ workflow }) => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it.each(workflows)('$file: never runs on pull_request_target', ({ workflow, text }) => {
    expect(triggers(workflow.on)).not.toContain('pull_request_target');
    expect(text).not.toContain('pull_request_target');
  });

  it.each(workflows)(
    '$file: every action is pinned to a commit SHA with its version',
    ({ text, workflow }) => {
      const lines = text.split('\n').filter((line) => /^\s*-?\s*uses:/.test(line));
      const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
      expect(lines.length).toBe(steps.filter((step) => step.uses !== undefined).length);
      for (const line of lines) {
        expect(line).toMatch(/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      }
    },
  );

  it('only the release workflows can write, and only in their jobs', () => {
    const writers = workflows.flatMap(({ file, workflow }) =>
      Object.entries(workflow.jobs)
        .filter(([, job]) => JSON.stringify(job.permissions ?? {}).includes('write'))
        .map(([id]) => `${file}:${id}`),
    );
    expect(writers.sort()).toEqual(['release-contract.yml:release', 'release-image.yml:image']);
  });

  // A job skipped because a job it needs failed counts as passed for a
  // required check. So the required "Lint, test and build" is a summary that
  // always runs and checks every job it needs itself, and every lint, test
  // and build job must be in its `needs`.
  it('ci.yml: "Lint, test and build" summarizes every lint, test and build job', () => {
    const ci = workflows.find(({ file }) => file === 'ci.yml')?.workflow;
    expect(ci).toBeDefined();
    const jobs = ci?.jobs ?? {};
    const check = jobs.check;
    expect(check?.name).toBe('Lint, test and build');
    expect(check?.if).toContain('always()');
    const others = Object.keys(jobs).filter(
      (id) => !['check', 'docs', 'csp', 'docker'].includes(id),
    );
    expect([...(Array.isArray(check?.needs) ? check.needs : [])].sort()).toEqual(others.sort());
    expect(others).toEqual(
      expect.arrayContaining(['changes', 'lint', 'test-server', 'test-web', 'build']),
    );
  });
});
