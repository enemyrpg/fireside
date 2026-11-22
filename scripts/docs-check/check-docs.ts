// Checks the Markdown documentation (the "Docs" job in CI):
//
//   node scripts/docs-check/check-docs.ts
//
// 1. Every relative link and image in a tracked Markdown file points to a
//    file or folder that exists, and a `#anchor` into a Markdown file matches
//    one of its headings. External links are not fetched.
// 2. The `.env` reference in docs/self-hosting.md ("Configuration") lists
//    exactly the variables in .env.example. config.test.ts checks that
//    .env.example has every variable the server reads, so the code, the
//    example and the docs can't drift apart.
//
// Uses only Node's standard library, so it runs without `pnpm install`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  anchorsOf,
  envNamesInDoc,
  envNamesInExample,
  isExternal,
  linksOf,
  setDifference,
} from './docs-check.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

const ENV_DOC = 'docs/self-hosting.md';
const ENV_SECTION = 'Configuration';
const ENV_EXAMPLE = '.env.example';

const errors: string[] = [];
const anchorCache = new Map<string, Set<string>>();

function anchorsIn(path: string): Set<string> {
  let anchors = anchorCache.get(path);
  if (!anchors) {
    anchors = anchorsOf(readFileSync(path, 'utf8'));
    anchorCache.set(path, anchors);
  }
  return anchors;
}

const files = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file !== '');

let checked = 0;
for (const file of files) {
  const path = join(ROOT, file);
  for (const { target, line } of linksOf(readFileSync(path, 'utf8'))) {
    if (isExternal(target)) continue;
    checked += 1;
    const hash = target.indexOf('#');
    const pathPart = hash === -1 ? target : target.slice(0, hash);
    const anchor = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathPart.split('?')[0] ?? '');
    } catch {
      errors.push(`${file}:${String(line)}: can't decode link ${target}`);
      continue;
    }
    // Like GitHub: a leading `/` is the repository root.
    const resolved =
      decoded === ''
        ? path
        : decoded.startsWith('/')
          ? join(ROOT, decoded)
          : resolve(dirname(path), decoded);
    if (relative(ROOT, resolved).startsWith('..')) {
      errors.push(`${file}:${String(line)}: link leaves the repository: ${target}`);
      continue;
    }
    if (!existsSync(resolved)) {
      errors.push(`${file}:${String(line)}: no such file: ${target}`);
      continue;
    }
    if (anchor !== undefined && anchor !== '' && resolved.endsWith('.md')) {
      if (!anchorsIn(resolved).has(anchor)) {
        errors.push(
          `${file}:${String(line)}: no heading for #${anchor} in ${relative(ROOT, resolved)}`,
        );
      }
    }
  }
}

const inExample = envNamesInExample(readFileSync(join(ROOT, ENV_EXAMPLE), 'utf8'));
const inDoc = envNamesInDoc(readFileSync(join(ROOT, ENV_DOC), 'utf8'), ENV_SECTION);
for (const name of setDifference(inExample, inDoc)) {
  errors.push(`${ENV_DOC}: ${name} is in ${ENV_EXAMPLE} but not in "${ENV_SECTION}"`);
}
for (const name of setDifference(inDoc, inExample)) {
  errors.push(`${ENV_DOC}: ${name} is in "${ENV_SECTION}" but not in ${ENV_EXAMPLE}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  console.error(`\n${String(errors.length)} problem(s) in the documentation.`);
  process.exit(1);
}
console.log(
  `OK: ${String(checked)} relative links in ${String(files.length)} Markdown files, ` +
    `${String(inExample.size)} variables documented.`,
);
