import { fileURLToPath } from 'node:url';

/** Repo root (same path from src/ and dist/). Holds `.env`, and relative `DATA_DIR` paths start here. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The built dashboard (`pnpm build` in web/), served by the server on the same port. */
export const WEB_DIST_DIR = fileURLToPath(new URL('../../web/dist/', import.meta.url));
