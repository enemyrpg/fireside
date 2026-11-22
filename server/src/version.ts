import { readFileSync } from 'node:fs';

// Read at runtime so it works from both src/ (dev, tests) and dist/ (build).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version?: unknown;
};

if (typeof pkg.version !== 'string') {
  throw new Error('server/package.json has no version');
}

/** Version of the server package. */
export const SERVER_VERSION: string = pkg.version;
