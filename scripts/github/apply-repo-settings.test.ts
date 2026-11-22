import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// apply-repo-settings.sh in a dry run: it prints every call with its JSON body
// and sends nothing, so the settings can be checked without GitHub.

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(import.meta.dirname, 'apply-repo-settings.sh');

interface Call {
  label: string;
  method: string;
  path: string;
  body: unknown;
}

interface Rule {
  type: string;
  parameters?: Record<string, unknown> & {
    required_status_checks?: { context: string; integration_id: number }[];
  };
}

interface Ruleset {
  name: string;
  target: string;
  bypass_actors: unknown[];
  conditions: { ref_name: { include: string[] } };
  rules: Rule[];
}

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function dryRun(profile: string, branch = 'main'): Call[] {
  const result = run(`enemyrpg/${profile}`, branch, profile, '--dry-run');
  expect(result.stderr).toContain('nothing is sent');
  expect(result.status).toBe(0);
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [label = '', request = '', body = 'null'] = line.split('\t');
      const [method = '', path = ''] = request.split(' ');
      return { label, method, path, body: JSON.parse(body) as unknown };
    });
}

function ruleset(calls: Call[], name: string): Ruleset {
  const call = calls.find((c) => c.path.endsWith('/rulesets') && (c.body as Ruleset).name === name);
  expect(call, name).toBeDefined();
  return call?.body as Ruleset;
}

function requiredChecks(calls: Call[]): string[] | undefined {
  return ruleset(calls, 'default branch')
    .rules.find((rule) => rule.type === 'required_status_checks')
    ?.parameters?.required_status_checks?.map((check) => check.context);
}

/** `name:` of every job in .github/workflows/ that runs on pull requests. */
function pullRequestJobNames(): string[] {
  const dir = join(ROOT, '.github', 'workflows');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yml'))
    .flatMap((file) => {
      const workflow = parse(readFileSync(join(dir, file), 'utf8')) as {
        on: Record<string, unknown>;
        jobs: Record<string, { name?: string }>;
      };
      if (!('pull_request' in workflow.on)) return [];
      return Object.entries(workflow.jobs).map(([id, job]) => job.name ?? id);
    });
}

describe('apply-repo-settings.sh', () => {
  it('refuses unknown profiles and missing arguments', () => {
    expect(run('owner/example', 'main', 'other', '--dry-run').status).toBe(2);
    expect(run('owner/example', 'main').status).toBe(2);
    expect(run('not a repo', 'main', 'app', '--dry-run').status).toBe(2);
  });

  it.each(['app', 'plugin', 'site'])(
    '%s: squash merge only, with the PR title and no body',
    (profile) => {
      const repo = dryRun(profile).find(
        (c) => c.method === 'PATCH' && c.path === `repos/enemyrpg/${profile}`,
      );
      expect(repo?.body).toMatchObject({
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        squash_merge_commit_title: 'PR_TITLE',
        squash_merge_commit_message: 'BLANK',
        delete_branch_on_merge: true,
        allow_auto_merge: true,
        has_wiki: false,
        has_projects: false,
        has_discussions: false,
        has_issues: profile !== 'site',
      });
      // The project's website (not a constant: it's only in this script).
      expect((repo?.body as { homepage?: string }).homepage).toMatch(/^https:\/\/[a-z.]+$/);
    },
  );

  it.each(['app', 'plugin', 'site'])(
    '%s: protects the default branch, with no bypass',
    (profile) => {
      const branch = profile === 'plugin' ? 'master' : 'main';
      const rules = ruleset(dryRun(profile, branch), 'default branch');
      expect(rules.target).toBe('branch');
      expect(rules.bypass_actors).toEqual([]);
      expect(rules.conditions.ref_name.include).toEqual([`refs/heads/${branch}`]);
      const types = rules.rules.map((rule) => rule.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'deletion',
          'non_fast_forward',
          'required_linear_history',
          'pull_request',
        ]),
      );
      const pr = rules.rules.find((rule) => rule.type === 'pull_request');
      expect(pr?.parameters).toMatchObject({
        required_approving_review_count: 0,
        allowed_merge_methods: ['squash'],
      });
      const checks = rules.rules.find((rule) => rule.type === 'required_status_checks');
      if (checks) expect(checks.parameters?.strict_required_status_checks_policy).toBe(true);
    },
  );

  it.each(['app', 'plugin', 'site'])(
    '%s: release tags can be created, never moved or deleted',
    (profile) => {
      const tags = ruleset(dryRun(profile), 'release tags');
      expect(tags.target).toBe('tag');
      expect(tags.bypass_actors).toEqual([]);
      expect(tags.conditions.ref_name.include).toEqual(['refs/tags/v*', 'refs/tags/contract-v*']);
      // No "creation" rule: release-please tags v<version>, and contract-v*
      // tags are pushed by hand.
      expect(tags.rules.map((rule) => rule.type).sort()).toEqual(['deletion', 'update']);
    },
  );

  it('app: the required checks are exactly the jobs that run on every pull request', () => {
    const jobs = pullRequestJobNames().filter((name) => name !== 'Detect changes');
    expect(requiredChecks(dryRun('app'))?.sort()).toEqual(jobs.sort());
  });

  it('plugin: requires its build, the PR title and Gitleaks; site has no checks rule', () => {
    expect(requiredChecks(dryRun('plugin', 'master'))).toEqual([
      'Gradle build',
      'PR title',
      'Gitleaks',
    ]);
    expect(requiredChecks(dryRun('site'))).toBeUndefined();
  });

  it('turns on the security features, with CodeQL per language', () => {
    const app = dryRun('app');
    const paths = app.map((c) => c.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'repos/enemyrpg/app/vulnerability-alerts',
        'repos/enemyrpg/app/automated-security-fixes',
        'repos/enemyrpg/app/private-vulnerability-reporting',
      ]),
    );
    const codeql = (calls: Call[]) =>
      calls.find((c) => c.path.endsWith('/code-scanning/default-setup'))?.body;
    expect(codeql(app)).toMatchObject({
      state: 'configured',
      languages: ['javascript-typescript'],
    });
    expect(codeql(dryRun('plugin', 'master'))).toMatchObject({ languages: ['java-kotlin'] });
    expect(codeql(dryRun('site'))).toBeUndefined();
    const scanning = app.find((c) => c.label.startsWith('Secret scanning'))?.body;
    expect(scanning).toEqual({
      security_and_analysis: {
        secret_scanning: { status: 'enabled' },
        secret_scanning_push_protection: { status: 'enabled' },
      },
    });
  });

  it('keeps GITHUB_TOKEN read-only and fork workflows behind approval', () => {
    const app = dryRun('app');
    expect(app.find((c) => c.path.endsWith('/actions/permissions/workflow'))?.body).toEqual({
      default_workflow_permissions: 'read',
      can_approve_pull_request_reviews: false,
    });
    expect(
      app.find((c) => c.path.endsWith('/actions/permissions/fork-pr-contributor-approval'))?.body,
    ).toEqual({ approval_policy: 'all_external_contributors' });
  });
});
