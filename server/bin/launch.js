// Shared launcher for the scripts in bin/. Development installs have tsx and
// run the TypeScript source, so commands are never stale. Production installs
// (`pnpm install --prod`, Docker) have no tsx and run the build in dist/.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Runs `src/<entry>.ts` with tsx, or `dist/<entry>.js` without it.
 * @param {string} entry Path below src/ and dist/ without extension, e.g. `cli/index`.
 */
export async function launch(entry) {
  const args = process.argv.slice(2);
  const source = fileURLToPath(new URL(`../src/${entry}.ts`, import.meta.url));
  const built = new URL(`../dist/${entry}.js`, import.meta.url);

  let tsxCli;
  try {
    tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  } catch {
    tsxCli = undefined;
  }

  if (tsxCli !== undefined && existsSync(source)) {
    const result = spawnSync(
      process.execPath,
      [tsxCli, '--conditions=@fireside/source', source, ...args],
      { stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    // Pass on a signal (e.g. Ctrl+C) so the caller sees an interrupt, not exit 1.
    if (result.signal) process.kill(process.pid, result.signal);
    process.exit(result.status ?? 1);
  } else if (existsSync(built)) {
    // The built entry reads process.argv itself.
    await import(built.href);
  } else {
    console.error('The server is not built. Run `pnpm build` first.');
    process.exit(1);
  }
}
