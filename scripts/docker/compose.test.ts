import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BRANDING } from '../../shared/src/branding.ts';

// docker-compose.yml: the cloudflared service for Cloudflare Tunnel
// (docs/tunnel.md) and the server service it must leave unchanged.

const ROOT = join(import.meta.dirname, '..', '..');
const COMPOSE_FILE = join(ROOT, 'docker-compose.yml');
const text = readFileSync(COMPOSE_FILE, 'utf8');

interface Service {
  image?: string;
  build?: unknown;
  profiles?: string[];
  network_mode?: string;
  restart?: string;
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  logging?: unknown;
  depends_on?: Record<string, { condition?: string }>;
  command?: string[];
  environment?: Record<string, string>;
  env_file?: unknown;
  ports?: unknown;
  volumes?: unknown;
  secrets?: string[];
  healthcheck?: { test?: string[] };
}

// Aliases (the shared logging block) are resolved by the parser.
const compose = parse(text) as {
  services: Record<string, Service>;
  secrets?: Record<string, { file?: string }>;
};
/** The server's service, named after the project. */
const SERVER = BRANDING.shortName;
const PREFIX = SERVER.toUpperCase();
const fireside = compose.services[SERVER];
const cloudflared = compose.services.cloudflared;

/** The value after `flag` in the command, or `undefined`. */
function flagValue(command: string[], flag: string): string | undefined {
  const index = command.indexOf(flag);
  return index === -1 ? undefined : command[index + 1];
}

describe('docker-compose.yml: cloudflared', () => {
  it('exists, behind the profile "tunnel" only', () => {
    expect(cloudflared).toBeDefined();
    expect(cloudflared?.profiles).toEqual(['tunnel']);
  });

  it('uses host networking and publishes no ports', () => {
    expect(cloudflared?.network_mode).toBe('host');
    expect(cloudflared?.ports).toBeUndefined();
  });

  it('pins the image to a version and a digest', () => {
    expect(cloudflared?.image).toMatch(
      /^cloudflare\/cloudflared:\d{4}\.\d{1,2}\.\d+@sha256:[0-9a-f]{64}$/,
    );
  });

  it('is hardened like the server', () => {
    expect(cloudflared?.cap_drop).toEqual(['ALL']);
    expect(cloudflared?.read_only).toBe(true);
    expect(cloudflared?.security_opt).toContain('no-new-privileges:true');
    expect(cloudflared?.restart).toBe('unless-stopped');
  });

  it('runs as a non-root user', () => {
    const user = cloudflared?.user ?? '';
    expect(user).not.toBe('');
    // `${FIRESIDE_UID:-1000}:${FIRESIDE_GID:-1000}`: the default must not be root.
    const defaults = [...user.matchAll(/:-(\d+)\}/g)].map((match) => match[1]);
    expect(defaults).toEqual(['1000', '1000']);
    expect(user).not.toMatch(/^(0|root)(:|$)/);
  });

  it('starts once the server is healthy', () => {
    expect(cloudflared?.depends_on?.[SERVER]?.condition).toBe('service_healthy');
  });

  it('rotates its log like the server', () => {
    expect(cloudflared?.logging).toEqual(fireside?.logging);
    expect(fireside?.logging).toEqual({
      driver: 'json-file',
      options: { 'max-size': '10m', 'max-file': '5' },
    });
  });

  it('reads the token from a file, never from the environment or the command line', () => {
    const command = cloudflared?.command ?? [];
    expect(command.slice(0, 1)).toEqual(['tunnel']);
    expect(command).toContain('run');
    expect(flagValue(command, '--token-file')).toBe('/run/secrets/tunnel-token');
    expect(command).not.toContain('--token');
    expect(cloudflared?.secrets).toEqual(['tunnel-token']);
    expect(compose.secrets?.['tunnel-token']?.file).toBe(
      `\${${PREFIX}_TUNNEL_TOKEN_FILE:-./secrets/tunnel-token}`,
    );
    expect(cloudflared?.environment).toBeUndefined();
    expect(cloudflared?.env_file).toBeUndefined();
    expect(text).not.toContain('TUNNEL_TOKEN=');
    expect(text).not.toMatch(/TUNNEL_TOKEN:/);
  });

  it('never updates itself, logs at info, and keeps metrics on loopback', () => {
    const command = cloudflared?.command ?? [];
    expect(command).toContain('--no-autoupdate');
    expect(flagValue(command, '--loglevel')).toBe('info');
    expect(flagValue(command, '--metrics')).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(command).toContain('--management-diagnostics=false');
    // The health check asks the same metrics address.
    expect(cloudflared?.healthcheck?.test).toEqual([
      'CMD',
      'cloudflared',
      'tunnel',
      '--metrics',
      flagValue(command, '--metrics'),
      'ready',
    ]);
  });
});

describe(`docker-compose.yml: ${SERVER}`, () => {
  it('is in no profile, so it always starts', () => {
    expect(fireside?.profiles).toBeUndefined();
  });

  it('still binds to loopback with host networking, hardened', () => {
    expect(fireside?.network_mode).toBe('host');
    expect(fireside?.environment?.HOST).toBe('127.0.0.1');
    expect(fireside?.ports).toBeUndefined();
    expect(fireside?.cap_drop).toEqual(['ALL']);
    expect(fireside?.read_only).toBe(true);
    expect(fireside?.security_opt).toContain('no-new-privileges:true');
    expect(fireside?.secrets).toBeUndefined();
  });
});

describe(`docker-compose.yml: the ${SERVER} image`, () => {
  const version = (
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
  ).version;

  it("is the release from GHCR, pinned to this checkout's version", () => {
    expect(fireside?.image).toBe(`ghcr.io/enemyrpg/${SERVER}:${version}`);
    expect(fireside?.build).toBeUndefined();
  });

  it('carries the marker release-please updates the tag by', () => {
    const lines = text.split('\n').filter((line) => line.includes('x-release-please-version'));
    expect(lines).toEqual([
      `    image: ghcr.io/enemyrpg/${SERVER}:${version} # x-release-please-version`,
    ]);
  });
});

describe('docker-compose.build.yml', () => {
  const build = parse(readFileSync(join(ROOT, 'docker-compose.build.yml'), 'utf8')) as {
    services: Record<string, Service>;
  };

  it(`only adds the build and a local tag to ${SERVER}`, () => {
    expect(Object.keys(build.services)).toEqual([SERVER]);
    expect(build.services[SERVER]).toEqual({
      build: '.',
      image: `\${${PREFIX}_LOCAL_IMAGE:-${SERVER}:local}`,
    });
  });
});
