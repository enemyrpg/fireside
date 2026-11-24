import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * The backup file `restore` was given, as typed: relative to `cwd` (the folder
 * `pnpm cli` was run from). A bare name that isn't there is looked up in
 * `backupDir`, so in Docker the file name is enough. A bare `….db` name that
 * isn't there either finds the compressed `….db.gz`, so names from before
 * backups were compressed still work.
 */
export function resolveBackupFile(file: string, cwd: string, backupDir: string): string {
  const fromCwd = resolve(cwd, file);
  if (existsSync(fromCwd) || isAbsolute(file) || file.includes('/')) return fromCwd;
  const inBackupDir = join(backupDir, file);
  if (!existsSync(inBackupDir) && file.endsWith('.db') && existsSync(`${inBackupDir}.gz`)) {
    return `${inBackupDir}.gz`;
  }
  return inBackupDir;
}
