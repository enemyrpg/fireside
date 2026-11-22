// A scratch server for ad hoc checks (keyboard, landscape, anything a helper
// script needs a running dashboard for). Never reads .env, every external
// source off, its own data folder and a free port: see lib/scratch-server.ts.
//
//   pnpm build && node scripts/scratch-server.ts <data-dir> [--seed <n>]
//
// Seeds <data-dir> when it does not exist yet (the generator behind
// `pnpm seed`), starts the built server on it, prints `ready <url> pid <pid>`
// and runs until it gets SIGTERM or SIGINT, which stops the server too.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { seedScratch, startScratchServer, stopServer } from './lib/scratch-server.ts';

const [dirArgument, ...rest] = process.argv.slice(2);
if (dirArgument === undefined || dirArgument.startsWith('-')) {
  console.error('Usage: node scripts/scratch-server.ts <data-dir> [--seed <n>]');
  process.exit(2);
}
const dir = resolve(dirArgument);
const seedAt = rest.indexOf('--seed');
const seed = seedAt === -1 ? '1' : (rest[seedAt + 1] ?? '1');

if (!existsSync(dir)) {
  console.log(`seeding ${dir} (seed ${seed})`);
  seedScratch(dir, ['--seed', seed]);
}
const { base, server } = await startScratchServer(dir);
console.log(`ready ${base} pid ${String(process.pid)}`);

const stop = (): void => {
  void stopServer(server).then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.once('exit', (code) => {
  console.error(`server exited with ${String(code)}`);
  process.exit(1);
});
