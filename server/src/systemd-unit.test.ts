import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './paths.js';

// scripts/systemd/install.sh --print renders the systemd user unit. --print works
// without `pnpm build` (the names come from shared/src/branding.ts).

const SCRIPT = join(REPO_ROOT, 'scripts/systemd/install.sh');
const root = REPO_ROOT.replace(/\/$/, '');

describe('systemd unit', () => {
  let bin: string;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), `${BRANDING.shortName}-systemd-test-`));
  });
  afterEach(() => {
    rmSync(bin, { recursive: true, force: true });
  });

  function render(args: string[], path: string, env: Record<string, string> = {}) {
    const result = spawnSync('bash', [SCRIPT, '--print', ...args], {
      encoding: 'utf8',
      env: { HOME: bin, PATH: path, ...env },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return result.stdout;
  }

  function expectCommon(unit: string) {
    expect(unit).not.toMatch(/@[A-Z_]+@/);
    expect(unit).toContain(`Description=${BRANDING.displayName} server`);
    expect(unit).toContain(`WorkingDirectory=${root}\n`);
    expect(unit).toContain(`EnvironmentFile=-${root}/.env\n`);
    expect(unit).toContain('Restart=on-failure\n');
    expect(unit).toContain('RestartPreventExitStatus=75 78\n');
    expect(unit).toContain(`SyslogIdentifier=${BRANDING.shortName}\n`);
    expect(unit).toContain('WantedBy=default.target\n');
    // New files are for the service's user only.
    expect(unit).toContain('\nUMask=0077\n');
  }

  it('with fnm, resolves Node from .node-version at every start', () => {
    // A stand-in for `fnm exec --using=<file> node …` that runs this Node.
    const fnm = join(bin, 'fnm');
    writeFileSync(fnm, `#!/bin/sh\nshift 3\nexec "${process.execPath}" "$@"\n`);
    chmodSync(fnm, 0o755);

    const unit = render([], `${bin}:/usr/bin:/bin`, { FNM_DIR: '/opt/fnm' });
    expectCommon(unit);
    const execStart = unit.split('\n').find((line) => line.startsWith('ExecStart='));
    expect(execStart).toBe(
      `ExecStart=/bin/sh -c 'node="$$("$$0" exec --using="$$1" node -p process.execPath)" ` +
        `|| exit 78; exec "$$node" "$$2"' "${fnm}" "${root}/.node-version" ` +
        `"${root}/server/dist/index.js"`,
    );
    expect(unit).toContain('Environment="FNM_DIR=/opt/fnm"\n');
  });

  it('with --node, runs that binary', () => {
    const unit = render(['--node', process.execPath], '/usr/bin:/bin');
    expectCommon(unit);
    expect(unit).toContain(`ExecStart="${process.execPath}" "${root}/server/dist/index.js"\n`);
    expect(unit).not.toContain('FNM_DIR');
  });

  it('refuses a missing node binary', () => {
    const result = spawnSync('bash', [SCRIPT, '--print', '--node', join(bin, 'nope')], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not an executable');
  });

  it('--help prints the usage comment and no code', () => {
    const result = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: scripts/systemd/install.sh [options]');
    expect(result.stdout).toContain('--tunnel');
    expect(result.stdout).not.toContain('set -euo pipefail');
    expect(result.stdout.endsWith('\n\n')).toBe(false);
  });

  it('refuses a repo path with $, which systemd would expand', () => {
    // A copy of the script in a folder named like a variable; the check runs
    // before anything else is needed.
    const repo = join(bin, 'apps', '$fs');
    mkdirSync(join(repo, 'scripts', 'systemd'), { recursive: true });
    cpSync(SCRIPT, join(repo, 'scripts', 'systemd', 'install.sh'));
    const result = spawnSync('bash', [join(repo, 'scripts/systemd/install.sh'), '--print'], {
      encoding: 'utf8',
      env: { HOME: bin, PATH: '/usr/bin:/bin' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the repo path contains');
  });

  describe('--tunnel', () => {
    /** A stand-in for cloudflared that only answers `--version`. */
    function stubCloudflared(version: string): string {
      const path = join(bin, 'cloudflared');
      writeFileSync(path, `#!/bin/sh\necho "cloudflared version ${version} (built 2026-11-17)"\n`);
      chmodSync(path, 0o755);
      return path;
    }
    const node = ['--node', process.execPath];
    const tokenFile = `${root}/secrets/tunnel-token`;

    it('renders the cloudflared unit, reading the token from a file', () => {
      const cloudflared = stubCloudflared('2026.11.1');
      const unit = render([...node, '--tunnel'], `${bin}:/usr/bin:/bin`);
      expect(unit).not.toMatch(/@[A-Z_]+@/);
      expect(unit).toContain(`Description=${BRANDING.displayName} Cloudflare Tunnel\n`);
      expect(unit).toContain(`After=${BRANDING.shortName}.service\n`);
      expect(unit).toContain(`Wants=${BRANDING.shortName}.service\n`);
      expect(unit).toContain(
        `ExecStart="${cloudflared}" tunnel --no-autoupdate --loglevel info ` +
          `--metrics 127.0.0.1:20241 --management-diagnostics=false ` +
          `run --token-file "${tokenFile}"\n`,
      );
      expect(unit).toContain(`SyslogIdentifier=${BRANDING.shortName}-tunnel\n`);
      expect(unit).toContain('Restart=on-failure\n');
      expect(unit).toContain('NoNewPrivileges=yes\n');
      expect(unit).toContain('\nUMask=0077\n');
      expect(unit).toContain('WantedBy=default.target\n');
      // The token is never in the unit: no --token, no environment, no .env.
      expect(unit).not.toMatch(/--token(?!-file)/);
      expect(unit).not.toContain('TUNNEL_TOKEN');
      expect(unit).not.toMatch(/^Environment/m);
    });

    it('with --cloudflared, runs that binary', () => {
      const cloudflared = stubCloudflared('2025.4.0');
      const unit = render([...node, '--tunnel', '--cloudflared', cloudflared], '/usr/bin:/bin');
      expect(unit).toContain(`ExecStart="${cloudflared}" tunnel `);
    });

    it('refuses a cloudflared without --token-file (before 2025.4.0)', () => {
      stubCloudflared('2025.2.1');
      const result = spawnSync('bash', [SCRIPT, '--print', ...node, '--tunnel'], {
        encoding: 'utf8',
        env: { HOME: bin, PATH: `${bin}:/usr/bin:/bin` },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('too old');
    });

    it('uses the node on PATH to read the names, even when fnm has no matching Node', () => {
      stubCloudflared('2026.11.1');
      // fnm is installed but has no Node for .node-version: the server unit
      // can't be made, but the tunnel unit runs no Node and doesn't need it.
      const fnm = join(bin, 'fnm');
      writeFileSync(fnm, '#!/bin/sh\nexit 1\n');
      chmodSync(fnm, 0o755);
      symlinkSync(process.execPath, join(bin, 'node'));
      const path = `${bin}:/usr/bin:/bin`;

      const unit = render(['--tunnel'], path);
      expect(unit).toContain(`Description=${BRANDING.displayName} Cloudflare Tunnel\n`);

      const server = spawnSync('bash', [SCRIPT, '--print'], {
        encoding: 'utf8',
        env: { HOME: bin, PATH: path },
      });
      expect(server.status).toBe(1);
      expect(server.stderr).toContain('fnm has no Node matching');
    });

    it('refuses a cloudflared path with $', () => {
      const dir = join(bin, '$cf');
      mkdirSync(dir);
      const cloudflared = join(dir, 'cloudflared');
      writeFileSync(cloudflared, '#!/bin/sh\necho "cloudflared version 2026.11.1"\n');
      chmodSync(cloudflared, 0o755);
      const result = spawnSync(
        'bash',
        [SCRIPT, '--print', ...node, '--tunnel', '--cloudflared', cloudflared],
        { encoding: 'utf8', env: { HOME: bin, PATH: '/usr/bin:/bin' } },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('the cloudflared path contains');
    });

    it('refuses --cloudflared without --tunnel', () => {
      const result = spawnSync('bash', [SCRIPT, '--print', ...node, '--cloudflared', '/bin/true'], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--cloudflared only works with --tunnel');
    });
  });
});
