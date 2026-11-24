import { BRANDING, DAY_MS } from '@fireside/shared';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backupFileName,
  type BackupFile,
  listBackups,
  markWrittenThisRun,
  parseBackupFileName,
  parseBackupFolderName,
  preMigrateFileName,
  preRestoreFileName,
} from './files.js';
import {
  backupsToKeep,
  filesToDelete,
  maxAgeCutoff,
  pruneBackups,
  ReferenceClock,
  retentionHorizon,
} from './retention.js';
import { tempDir } from './testing.js';

const N = BRANDING.shortName;

const at = (iso: string) => Date.parse(iso);

describe('backup file names', () => {
  it('names a backup after its UTC time, to the second', () => {
    expect(backupFileName(at('2026-11-14T03:00:09.512Z'))).toBe(`${N}-20261114-030009Z.db.gz`);
    expect(backupFileName(at('2026-11-14T03:00:09.512Z'), 2)).toBe(`${N}-20261114-030009Z-2.db.gz`);
    expect(preRestoreFileName(at('2026-11-14T03:00:09Z'))).toBe(
      `${N}-pre-restore-20261114-030009Z.db`,
    );
  });

  it.each([
    `${N}-20261114-030009Z.db.gz`,
    `${N}-20261114-030009Z-3.db.gz`,
    // Uncompressed, from before backups were compressed.
    `${N}-20261114-030009Z.db`,
    `${N}-20261114-030009Z-3.db`,
  ])('reads the time back from %s', (name) => {
    expect(parseBackupFileName(name)).toBe(at('2026-11-14T03:00:09Z'));
    expect(parseBackupFolderName(name)).toEqual({
      fileName: name,
      kind: 'backup',
      createdAtMs: at('2026-11-14T03:00:09Z'),
    });
  });

  it.each([
    `${N}-pre-restore-20261114-030009Z.db`,
    `${N}-20261340-030009Z.db`,
    `${N}-20261114-250000Z.db`,
    `${N}-20261114-030009.db`,
    `${N}-20261114-030009Z.db.tmp`,
    `${N}-20261114-030009Z.db.gz.tmp`,
    `${N}-20261114-030009Z.db.gz.x`,
    `${N}-20261114-030009Z.gz`,
    `${N}-20261114-030009Z.db.gz.gz`,
    `.${N}-backup-abc.tmp`,
    `.${N}-backup-abc.db.tmp`,
    `.${N}-backup-abc.gz.tmp`,
    `${N}.db`,
    'old-20261114-030009Z.db',
  ])('ignores %s', (name) => {
    expect(parseBackupFileName(name)).toBeUndefined();
  });
});

describe('retention', () => {
  const OSLO = 'Europe/Oslo';
  const keep = (daily: number, weekly: number, monthly: number) => ({ daily, weekly, monthly });

  /** One backup per day at 04:00 Oslo time (03:00 UTC in winter), `days` days back from 2026-11-14. */
  function dailyBackups(days: number) {
    return Array.from({ length: days }, (_, i) => {
      const ms = at('2026-11-14T03:00:00Z') - i * 86_400_000;
      return { fileName: backupFileName(ms), createdAtMs: ms };
    });
  }

  const names = (set: Set<string>) => [...set].sort();

  it('keeps the newest backup of each of the last 7 days, 4 weeks and 6 months', () => {
    const kept = backupsToKeep(dailyBackups(400), keep(7, 4, 6), OSLO);
    expect(names(kept)).toEqual(
      [
        // Daily: 8–14 November.
        '20261114',
        '20261113',
        '20261112',
        '20261111',
        '20261110',
        '20261109',
        '20261108',
        // Weekly (Sundays end ISO weeks): W46 is the 14th (kept), W45 the 8th (kept),
        // W44 1 November, W43 25 October.
        '20261101',
        '20261025',
        // Monthly: last day of each month (November is the 14th): Oct 31, Sep 30, Aug 31, Jul 31, Jun 30.
        '20261031',
        '20260930',
        '20260831',
        '20260731',
        '20260630',
      ]
        .map((day) => `${N}-${day}-030000Z.db.gz`)
        .sort(),
    );
  });

  it('keeps the newest per day when there are several', () => {
    const backups = [
      { fileName: `${N}-20261114-030000Z.db`, createdAtMs: at('2026-11-14T03:00:00Z') },
      { fileName: `${N}-20261114-150000Z.db`, createdAtMs: at('2026-11-14T15:00:00Z') },
      { fileName: `${N}-20261113-030000Z.db`, createdAtMs: at('2026-11-13T03:00:00Z') },
    ];
    expect(names(backupsToKeep(backups, keep(2, 0, 0), OSLO))).toEqual([
      `${N}-20261113-030000Z.db`,
      `${N}-20261114-150000Z.db`,
    ]);
  });

  it('groups by local day in TZ, not by UTC day', () => {
    // 23:30 UTC on the 13th is 00:30 on the 14th in Oslo: same local day as the 14th 03:00.
    const backups = [
      { fileName: `${N}-20261113-233000Z.db`, createdAtMs: at('2026-11-13T23:30:00Z') },
      { fileName: `${N}-20261114-030000Z.db`, createdAtMs: at('2026-11-14T03:00:00Z') },
    ];
    expect(names(backupsToKeep(backups, keep(7, 0, 0), OSLO))).toEqual([
      `${N}-20261114-030000Z.db`,
    ]);
    expect(backupsToKeep(backups, keep(7, 0, 0), 'UTC').size).toBe(2);
  });

  it('handles the DST change (25-hour day in Oslo)', () => {
    // 25 October 2026: clocks go back. 22:30 UTC on the 25th is 23:30 local, still the 25th.
    const backups = [
      { fileName: `${N}-20261024-230000Z.db`, createdAtMs: at('2026-10-24T23:00:00Z') },
      { fileName: `${N}-20261025-223000Z.db`, createdAtMs: at('2026-10-25T22:30:00Z') },
    ];
    expect(names(backupsToKeep(backups, keep(7, 0, 0), OSLO))).toEqual([
      `${N}-20261025-223000Z.db`,
    ]);
  });

  it('counts only days that have a backup', () => {
    const backups = [
      { fileName: `${N}-20261114-030000Z.db`, createdAtMs: at('2026-11-14T03:00:00Z') },
      { fileName: `${N}-20261001-030000Z.db`, createdAtMs: at('2026-10-01T03:00:00Z') },
    ];
    expect(backupsToKeep(backups, keep(2, 0, 0), OSLO).size).toBe(2);
  });

  it('always keeps the newest backup, even with every level at 0', () => {
    expect(names(backupsToKeep(dailyBackups(10), keep(0, 0, 0), OSLO))).toEqual([
      `${N}-20261114-030000Z.db.gz`,
    ]);
    expect(backupsToKeep([], keep(7, 4, 6), OSLO).size).toBe(0);
  });

  it('does not depend on input order', () => {
    const backups = dailyBackups(60);
    expect(backupsToKeep([...backups].reverse(), keep(7, 4, 6), OSLO)).toEqual(
      backupsToKeep(backups, keep(7, 4, 6), OSLO),
    );
  });
});

describe('max age', () => {
  const OSLO = 'Europe/Oslo';
  const DEFAULT_KEEP = { daily: 7, weekly: 4, monthly: 6 };
  const NOW = at('2026-11-14T10:00:00Z');
  const none = new Set<string>();
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  const file = (fileName: string) => {
    const parsed = parseBackupFolderName(fileName);
    if (!parsed) throw new Error(`not a backup folder name: ${fileName}`);
    return parsed;
  };

  it('knows the backup, pre-migrate and pre-restore names, and nothing else', () => {
    expect(parseBackupFolderName(`${N}-20261114-030009Z.db`)?.kind).toBe('backup');
    expect(parseBackupFolderName(`${N}-pre-migrate-20261114-030009Z-2.db`)?.kind).toBe(
      'pre-migrate',
    );
    expect(parseBackupFolderName(`${N}-pre-restore-20261114-030009Z.db`)?.kind).toBe('pre-restore');
    expect(parseBackupFolderName(`${N}-pre-restore-20261114-030009Z.db-wal`)?.kind).toBe(
      'pre-restore',
    );
    for (const name of [
      `${N}.db`,
      `${N}-pre-restore-20261114-030009Z.db-shm`,
      `${N}-pre-migrate-20261340-030009Z.db`,
      `.${N}-backup-abc.tmp`,
      `.${N}-backup-abc.gz.tmp`,
      'notes.txt',
      `my-${N}-20261114-030009Z.db`,
    ]) {
      expect(parseBackupFolderName(name)).toBeUndefined();
    }
  });

  it('reaches as far back as the longest level that is on', () => {
    expect(retentionHorizon(DEFAULT_KEEP)).toEqual({ count: 6, unit: 'month' });
    expect(retentionHorizon({ daily: 7, weekly: 4, monthly: 0 })).toEqual({
      count: 4,
      unit: 'week',
    });
    expect(retentionHorizon({ daily: 60, weekly: 4, monthly: 1 })).toEqual({
      count: 60,
      unit: 'day',
    });
    expect(retentionHorizon({ daily: 0, weekly: 0, monthly: 0 })).toBeNull();
  });

  it('counts months in local time, and the 31st goes to the end of a shorter month', () => {
    // 11:00 in Oslo (winter time) minus 6 months: 11:00 in Oslo (summer time).
    expect(maxAgeCutoff(at('2026-11-14T10:00:00Z'), DEFAULT_KEEP, OSLO)).toBe(
      at('2026-05-14T09:00:00Z'),
    );
    // 31 August 12:00 in Oslo (summer time) minus 6 months: 28 February 12:00 (winter time).
    expect(maxAgeCutoff(at('2026-08-31T10:00:00Z'), DEFAULT_KEEP, OSLO)).toBe(
      at('2026-02-28T11:00:00Z'),
    );
  });

  it('deletes pre-migrate and pre-restore copies older than the max age', () => {
    const files = [
      file(backupFileName(at('2026-11-14T03:00:00Z'))),
      file(preMigrateFileName(at('2026-05-01T03:00:00Z'))),
      file(preRestoreFileName(at('2026-04-01T03:00:00Z'))),
      file(`${preRestoreFileName(at('2026-04-01T03:00:00Z'))}-wal`),
      file(preMigrateFileName(at('2026-10-01T03:00:00Z'))),
      file(preRestoreFileName(at('2026-06-01T03:00:00Z'))),
    ];
    expect(
      filesToDelete(files, DEFAULT_KEEP, OSLO, { referenceMs: NOW, protect: none }).sort(),
    ).toEqual(
      [
        preMigrateFileName(at('2026-05-01T03:00:00Z')),
        preRestoreFileName(at('2026-04-01T03:00:00Z')),
        `${preRestoreFileName(at('2026-04-01T03:00:00Z'))}-wal`,
      ].sort(),
    );
  });

  it('deletes a monthly backup older than the max age after a gap', () => {
    // GFS alone keeps one per month that has a backup, so a year-old one survives a gap.
    const files = [
      file(backupFileName(at('2026-11-14T03:00:00Z'))),
      file(backupFileName(at('2026-10-14T03:00:00Z'))),
      file(backupFileName(at('2025-11-14T03:00:00Z'))),
    ];
    expect(filesToDelete(files, DEFAULT_KEEP, OSLO, { referenceMs: NOW, protect: none })).toEqual([
      backupFileName(at('2025-11-14T03:00:00Z')),
    ]);
  });

  it('keeps the newest backup even when it is older than the max age', () => {
    const newest = backupFileName(at('2025-01-14T03:00:00Z'));
    const files = [
      file(newest),
      file(backupFileName(at('2024-12-14T03:00:00Z'))),
      file(preMigrateFileName(at('2025-02-01T03:00:00Z'))),
    ];
    expect(
      filesToDelete(files, DEFAULT_KEEP, OSLO, { referenceMs: NOW, protect: none }).sort(),
    ).toEqual(
      [
        backupFileName(at('2024-12-14T03:00:00Z')),
        preMigrateFileName(at('2025-02-01T03:00:00Z')),
      ].sort(),
    );
  });

  it('never deletes a copy this process took, whatever the time in its name', () => {
    const { dir, remove } = tempDir();
    cleanup = remove;
    // A copy taken before a migration while the clock was a year behind.
    const copy = preMigrateFileName(at('2025-11-14T03:00:00Z'));
    writeFileSync(join(dir, copy), 'copy');
    markWrittenThisRun(copy);
    const older = preMigrateFileName(at('2025-10-14T03:00:00Z'));
    writeFileSync(join(dir, older), 'copy');
    writeFileSync(join(dir, backupFileName(at('2026-11-14T03:00:00Z'))), 'b');

    expect(pruneBackups(dir, DEFAULT_KEEP, OSLO, { nowMs: NOW })).toEqual([older]);
    expect(readdirSync(dir)).toContain(copy);
  });

  it('never deletes anything else in the backup folder', () => {
    const { dir, remove } = tempDir();
    cleanup = remove;
    const others = [
      'notes.txt',
      `${N}.db`,
      `${N}-pre-restore-20200101-030000Z.db-shm`,
      `old-${N}-20200101-030000Z.db`,
      `.${N}-backup-abc.tmp`,
    ];
    for (const name of others) writeFileSync(join(dir, name), 'x');
    mkdirSync(join(dir, preMigrateFileName(at('2020-01-01T03:00:00Z'))));
    writeFileSync(join(dir, backupFileName(at('2020-01-01T03:00:00Z'))), 'b');
    writeFileSync(join(dir, backupFileName(at('2020-01-02T03:00:00Z'))), 'b');

    // A clock that has run long enough for the reference to be the wall clock.
    const clock = new ReferenceClock(() => 10 * 365 * DAY_MS);
    expect(pruneBackups(dir, DEFAULT_KEEP, OSLO, { nowMs: NOW, protect: none, clock })).toEqual([
      backupFileName(at('2020-01-01T03:00:00Z')),
    ]);
    expect(readdirSync(dir).sort()).toEqual(
      [
        ...others,
        preMigrateFileName(at('2020-01-01T03:00:00Z')),
        backupFileName(at('2020-01-02T03:00:00Z')),
      ].sort(),
    );
  });

  it('with every level at 0 keeps only the newest backup', () => {
    const files = [
      file(backupFileName(at('2026-11-14T03:00:00Z'))),
      file(backupFileName(at('2026-11-13T03:00:00Z'))),
      file(preMigrateFileName(at('2026-11-14T02:00:00Z'))),
    ];
    expect(
      filesToDelete(files, { daily: 0, weekly: 0, monthly: 0 }, OSLO, {
        referenceMs: NOW,
        protect: none,
      }).sort(),
    ).toEqual(
      [
        backupFileName(at('2026-11-13T03:00:00Z')),
        preMigrateFileName(at('2026-11-14T02:00:00Z')),
      ].sort(),
    );
  });

  it('counts and deletes compressed and uncompressed backups the same way', () => {
    const { dir, remove } = tempDir();
    cleanup = remove;
    // 400 daily backups: the newest 100 `.db.gz`, the older ones from before compression (`.db`).
    const all = Array.from({ length: 400 }, (_, i) => {
      const ms = at('2026-11-14T03:00:00Z') - i * DAY_MS;
      const gz = backupFileName(ms);
      return i < 100 ? gz : gz.slice(0, -'.gz'.length);
    });
    for (const name of all) writeFileSync(join(dir, name), 'b');
    expect(listBackups(dir)).toHaveLength(400);

    // The same rules as for 400 backups of one kind.
    const asIfAllGz = all.map((name) => (name.endsWith('.gz') ? name : `${name}.gz`));
    const keptIfAllGz = backupsToKeep(
      asIfAllGz.map((fileName) => file(fileName)),
      DEFAULT_KEEP,
      OSLO,
    );
    const clock = new ReferenceClock(() => 10 * 365 * DAY_MS);
    pruneBackups(dir, DEFAULT_KEEP, OSLO, { nowMs: NOW, protect: none, clock });
    const left = readdirSync(dir).sort();
    expect(left.map((name) => (name.endsWith('.gz') ? name : `${name}.gz`)).sort()).toEqual(
      [...keptIfAllGz].sort(),
    );
    // Both kinds survive where the rules keep them: the newest months are
    // compressed, the oldest kept monthly ones are from before compression.
    expect(left.some((name) => name.endsWith('.db'))).toBe(true);
    expect(left.some((name) => name.endsWith('.db.gz'))).toBe(true);
    expect(listBackups(dir).map((backup) => backup.sizeBytes)).toEqual(left.map(() => 1));
  });

  it('keeps the compressed backup when it was also unpacked in place (gunzip -k)', () => {
    const gz = backupFileName(at('2026-11-14T03:00:00Z'));
    const unpacked = gz.slice(0, -'.gz'.length);
    for (const order of [
      [unpacked, gz],
      [gz, unpacked],
    ]) {
      const files = order.map((name) => file(name));
      expect(backupsToKeep(files, DEFAULT_KEEP, OSLO)).toEqual(new Set([gz]));
      expect(filesToDelete(files, DEFAULT_KEEP, OSLO, { referenceMs: NOW, protect: none })).toEqual(
        [unpacked],
      );
    }
  });

  it('keeps the newest backup whichever kind it is', () => {
    const plain = backupFileName(at('2026-11-14T03:00:00Z')).slice(0, -'.gz'.length);
    const gz = backupFileName(at('2026-11-13T03:00:00Z'));
    const files = [file(plain), file(gz)];
    expect(
      filesToDelete(files, { daily: 0, weekly: 0, monthly: 0 }, OSLO, {
        referenceMs: NOW,
        protect: none,
      }),
    ).toEqual([gz]);
  });

  it('leaves the usual daily, weekly and monthly backups alone', () => {
    const files = Array.from({ length: 400 }, (_, i) =>
      file(backupFileName(at('2026-11-14T03:00:00Z') - i * 86_400_000)),
    );
    const kept = backupsToKeep(files, DEFAULT_KEEP, OSLO);
    const deleted = new Set(
      filesToDelete(files, DEFAULT_KEEP, OSLO, { referenceMs: NOW, protect: none }),
    );
    expect(
      files
        .filter((f) => !deleted.has(f.fileName))
        .map((f) => f.fileName)
        .sort(),
    ).toEqual([...kept].sort());
  });
});

describe('reference time for the max age', () => {
  const OSLO = 'Europe/Oslo';
  const DEFAULT_KEEP = { daily: 7, weekly: 4, monthly: 6 };
  const none = new Set<string>();

  /** Daily backups at 03:00 UTC, the newest at `newest`, `days` of them. */
  function daily(newest: string, days: number): BackupFile[] {
    return Array.from({ length: days }, (_, i) => {
      const createdAtMs = at(newest) - i * DAY_MS;
      return { fileName: backupFileName(createdAtMs), kind: 'backup', createdAtMs };
    });
  }
  const copy = (iso: string): BackupFile => ({
    fileName: preMigrateFileName(at(iso)),
    kind: 'pre-migrate',
    createdAtMs: at(iso),
  });
  const deleted = (files: BackupFile[], referenceMs: number) =>
    filesToDelete(files, DEFAULT_KEEP, OSLO, { referenceMs, protect: none }).sort();

  it('is the wall clock when there were no files before this process', () => {
    const clock = new ReferenceClock(() => 0);
    expect(clock.referenceMs('d', [], at('2026-11-14T10:00:00Z'), none)).toBe(
      at('2026-11-14T10:00:00Z'),
    );
  });

  it('only counts files that were there before this process', () => {
    const clock = new ReferenceClock(() => 0);
    const mine = backupFileName(at('2028-11-14T03:00:00Z'));
    const files = [
      ...daily('2026-11-14T03:00:00Z', 3),
      { fileName: mine, kind: 'backup' as const, createdAtMs: at('2028-11-14T03:00:00Z') },
    ];
    expect(clock.referenceMs('d', files, at('2028-11-14T10:00:00Z'), new Set([mine]))).toBe(
      at('2026-11-15T03:00:00Z'),
    );
  });

  it('deletes nothing extra when the clock jumps two years ahead, and warns once', () => {
    const files = [...daily('2026-11-14T03:00:00Z', 400), copy('2026-07-01T03:00:00Z')];
    const right = new ReferenceClock(() => 60_000).referenceMs(
      'd',
      files,
      at('2026-11-14T10:00:00Z'),
      none,
    );
    const warnings: [number, number][] = [];
    const jumped = new ReferenceClock(() => 60_000);
    const onAhead = (wall: number, reference: number) => warnings.push([wall, reference]);
    const wrong = jumped.referenceMs('d', files, at('2028-11-14T10:00:00Z'), none, onAhead);
    expect(deleted(files, wrong)).toEqual(deleted(files, right));
    expect(deleted(files, wrong)).not.toContain(copy('2026-07-01T03:00:00Z').fileName);
    // Also after the backup taken with the wrong clock: the base stays.
    const later = jumped.referenceMs(
      'd',
      [...files, ...daily('2028-11-14T04:00:00Z', 1)],
      at('2028-11-14T10:00:00Z'),
      none,
      onAhead,
    );
    expect(later).toBe(wrong);
    expect(warnings).toEqual([[at('2028-11-14T10:00:00Z'), at('2026-11-15T03:01:00Z')]]);
  });

  it('does not count a three-month stop, and prunes on schedule once running', () => {
    // Stopped after the backup of 14 August, started again on 14 November.
    const files = [...daily('2026-08-14T03:00:00Z', 300), copy('2026-03-01T03:00:00Z')];
    let elapsed = 0;
    const clock = new ReferenceClock(() => elapsed);
    const start = at('2026-11-14T10:00:00Z');
    const atStart = clock.referenceMs('d', files, start, none);
    expect(atStart).toBe(at('2026-08-15T03:00:00Z'));
    // By the wall clock the copy is past 6 months; by running time it isn't yet.
    expect(deleted(files, atStart)).not.toContain(copy('2026-03-01T03:00:00Z').fileName);

    elapsed = 30 * DAY_MS;
    const after = clock.referenceMs('d', files, start + elapsed, none);
    expect(after).toBe(at('2026-09-14T03:00:00Z'));
    expect(deleted(files, after)).toContain(copy('2026-03-01T03:00:00Z').fileName);
  });

  it('is the wall clock in normal daily operation', () => {
    // The newest backup is from 04:00 local the day before; the server
    // starts at midnight and runs for two months.
    const files = daily('2026-11-13T03:00:00Z', 200);
    let elapsed = 0;
    const clock = new ReferenceClock(() => elapsed);
    const start = at('2026-11-14T00:00:00Z');
    for (let day = 0; day <= 60; day++) {
      elapsed = day * DAY_MS;
      expect(clock.referenceMs('d', files, start + elapsed, none)).toBe(start + elapsed);
    }
  });
});

describe('every level at 0', () => {
  const OSLO = 'Europe/Oslo';
  const ZERO = { daily: 0, weekly: 0, monthly: 0 };
  const NOW = at('2026-11-14T10:00:00Z');
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('keeps the pre-migrate copy from this run, also after a newer backup', () => {
    const { dir, remove } = tempDir();
    cleanup = remove;
    const older = backupFileName(at('2026-11-13T03:00:00Z'));
    const mine = preMigrateFileName(at('2026-11-14T09:00:00Z'));
    const newer = backupFileName(at('2026-11-14T09:05:00Z'));
    for (const name of [older, mine, newer]) writeFileSync(join(dir, name), 'x');
    markWrittenThisRun(mine);
    const clock = new ReferenceClock(() => 0);
    expect(pruneBackups(dir, ZERO, OSLO, { nowMs: NOW, clock })).toEqual([older]);
    expect(readdirSync(dir).sort()).toEqual([mine, newer].sort());
  });

  it('removes a pre-migrate copy only once a newer regular backup exists', () => {
    const copy = parseBackupFolderName(preMigrateFileName(at('2026-11-14T09:00:00Z')));
    const before = parseBackupFolderName(backupFileName(at('2026-11-13T03:00:00Z')));
    const after = parseBackupFolderName(backupFileName(at('2026-11-14T09:05:00Z')));
    if (!copy || !before || !after) throw new Error('names');
    const options = { referenceMs: NOW, protect: new Set<string>() };
    expect(filesToDelete([copy, before], ZERO, OSLO, options)).toEqual([]);
    expect(filesToDelete([copy, before, after], ZERO, OSLO, options).sort()).toEqual(
      [copy.fileName, before.fileName].sort(),
    );
  });
});
