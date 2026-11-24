import { BRANDING } from '@fireside/shared';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../backup/testing.js';
import { resolveBackupFile } from './backup-file.js';

const N = BRANDING.shortName;

describe('resolveBackupFile', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function folders() {
    const { dir, remove } = tempDir();
    cleanups.push(remove);
    const cwd = join(dir, 'cwd');
    const backupDir = join(dir, 'backups');
    mkdirSync(cwd);
    mkdirSync(backupDir);
    return { cwd, backupDir };
  }

  it('takes a file in the current folder first', () => {
    const { cwd, backupDir } = folders();
    writeFileSync(join(cwd, `${N}-20261114-030000Z.db.gz`), 'x');
    writeFileSync(join(backupDir, `${N}-20261114-030000Z.db.gz`), 'x');
    expect(resolveBackupFile(`${N}-20261114-030000Z.db.gz`, cwd, backupDir)).toBe(
      join(cwd, `${N}-20261114-030000Z.db.gz`),
    );
  });

  it('looks a bare name up in BACKUP_DIR', () => {
    const { cwd, backupDir } = folders();
    writeFileSync(join(backupDir, `${N}-20261114-030000Z.db.gz`), 'x');
    expect(resolveBackupFile(`${N}-20261114-030000Z.db.gz`, cwd, backupDir)).toBe(
      join(backupDir, `${N}-20261114-030000Z.db.gz`),
    );
  });

  it('finds the compressed backup for a name typed without .gz', () => {
    const { cwd, backupDir } = folders();
    writeFileSync(join(backupDir, `${N}-20261114-030000Z.db.gz`), 'x');
    expect(resolveBackupFile(`${N}-20261114-030000Z.db`, cwd, backupDir)).toBe(
      join(backupDir, `${N}-20261114-030000Z.db.gz`),
    );
  });

  it('prefers an uncompressed backup that is there', () => {
    const { cwd, backupDir } = folders();
    writeFileSync(join(backupDir, `${N}-20261114-030000Z.db`), 'x');
    writeFileSync(join(backupDir, `${N}-20261114-030000Z.db.gz`), 'x');
    expect(resolveBackupFile(`${N}-20261114-030000Z.db`, cwd, backupDir)).toBe(
      join(backupDir, `${N}-20261114-030000Z.db`),
    );
  });

  it('leaves paths alone, so restore reports a missing file as typed', () => {
    const { cwd, backupDir } = folders();
    writeFileSync(join(backupDir, `${N}-20261114-030000Z.db.gz`), 'x');
    expect(resolveBackupFile(`sub/${N}-20261114-030000Z.db`, cwd, backupDir)).toBe(
      join(cwd, 'sub', `${N}-20261114-030000Z.db`),
    );
    expect(resolveBackupFile('missing.db', cwd, backupDir)).toBe(join(backupDir, 'missing.db'));
  });
});
