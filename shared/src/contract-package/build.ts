// Run by `pnpm --filter shared build` after tsc: writes the contract package
// to shared/dist/.
import { join, relative } from 'node:path';
import { buildContractPackage } from './package.js';

const outDir = join(import.meta.dirname, '..');
const result = buildContractPackage(outDir);
console.log(
  `Contract package: ${relative(process.cwd(), result.zipFile)} (${String(result.entries.length)} files)`,
);
