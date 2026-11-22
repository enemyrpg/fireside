import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// The image check (check-image.sh) runs these checks on the image's file list.

const SCRIPT = join(import.meta.dirname, 'check-files.sh');
const WEB_PUBLIC = join(import.meta.dirname, '..', '..', 'web', 'public');
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|apng|jxl|heic)$/i;

function check(files: string[]): { status: number | null; output: string } {
  const result = spawnSync('bash', [SCRIPT], { input: `${files.join('\n')}\n`, encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

const ICONS = [
  'app/web/dist/favicon.svg',
  'app/web/dist/apple-touch-icon.png',
  'app/web/dist/icons/icon-192.png',
  'app/web/dist/icons/icon-512.png',
  'app/web/dist/icons/icon-maskable-512.png',
];
const BASE = ['app/', 'app/web/dist/index.html', 'app/server/dist/index.js'];

describe('check-files.sh', () => {
  it('accepts the favicon and the app icons', () => {
    const result = check([...BASE, ...ICONS.map((file) => `./${file}`)]);
    expect(result.output).toContain('OK');
    expect(result.status).toBe(0);
  });

  it('allows images inside node_modules', () => {
    expect(check([...BASE, 'app/node_modules/pkg/logo.png']).status).toBe(0);
  });

  it.each([
    'app/web/dist/icons/other.png',
    'app/web/dist/icons/icon-1024.png',
    'app/web/dist/logo.png',
    'app/web/dist/assets/item.webp',
    'app/web/dist/favicon.ico',
    'app/server/x.jpg',
    'app/web/dist/icons/ICON-192.PNG',
    'app/web/dist/sub/apple-touch-icon.png',
  ])('rejects any other image: %s', (file) => {
    const result = check([...BASE, ...ICONS, file]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(file);
  });

  it.each(['app/.env', 'app/server/.env.local', 'app/data/app.db', 'data/x', 'app/x.db-wal'])(
    'still rejects %s',
    (file) => {
      expect(check([...BASE, file]).status).toBe(1);
    },
  );

  it('allows exactly the images in web/public, so a new image needs a decision here', () => {
    const allowed = spawnSync('bash', [SCRIPT, '--allowed-images'], { encoding: 'utf8' });
    const inPublic = readdirSync(WEB_PUBLIC, { recursive: true })
      .map(String)
      .filter((file) => IMAGE.test(file))
      .map((file) => `app/web/dist/${relative(WEB_PUBLIC, join(WEB_PUBLIC, file))}`);
    expect(allowed.stdout.trim().split('\n').sort()).toEqual(inPublic.sort());
    expect(allowed.stdout.trim().split('\n').sort()).toEqual([...ICONS].sort());
  });
});
