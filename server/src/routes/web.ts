import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isApiPath, notFoundHandler, withoutQuery } from '../errors.js';

// Serves the built dashboard (web/dist) on the same port as the API, with a
// fallback to index.html for the dashboard's own routes (single-page app).
//
// The files hold no data, so they are not behind the local-only check: a
// visitor from another machine gets the app, and every /api/v1 dashboard
// request then answers 403, which the app explains.
//
// No routes are registered: files are served from the root not-found handler.
// So /api/* is never touched (scopes with their own not-found handler, like
// ingest, keep it), and a build made while the server runs is picked up.

const INDEX_FILE = 'index.html';

/** Hashed build files never change, so they can be cached for a year. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Whether a request that matched no route and no file should get the app's index.html. */
export function isAppRoute(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const path = withoutQuery(request.url);
  if (isApiPath(path)) return false;
  // `/assets/missing.js` is a missing file, not a page.
  const lastSegment = path.split('/').at(-1) ?? '';
  return !lastSegment.includes('.');
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The file in `root` that `urlPath` names, relative to `root`, or `undefined`
 * if it isn't a file inside `root`.
 */
async function fileFor(root: string, urlPath: string): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const absolute = resolve(root, `.${decoded}`);
  if (!absolute.startsWith(root + sep)) return undefined;
  if (!(await isFile(absolute))) return undefined;
  return absolute.slice(root.length + 1);
}

/**
 * Registers `sendFile` and the root not-found handler, which serves files from
 * `webDir`, falls back to index.html for app routes, and otherwise gives the
 * usual JSON 404. Without a build (dev, where Vite serves the app) it gives
 * the JSON 404 until one appears.
 */
export function registerWebApp(app: FastifyInstance, webDir: string): void {
  const root = resolve(webDir);
  const assetsDir = join(root, 'assets') + sep;

  void app.register(fastifyStatic, {
    root,
    // Only `reply.sendFile`; files are served by the handler below.
    serve: false,
    // The folder may not exist yet (no build).
    suppressWarning: true,
    setHeaders: (reply, filePath) => {
      void reply.header('cache-control', filePath.startsWith(assetsDir) ? IMMUTABLE : 'no-cache');
    },
  });

  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    const path = withoutQuery(request.url);
    if ((request.method === 'GET' || request.method === 'HEAD') && !isApiPath(path)) {
      const file = path.endsWith('/') ? undefined : await fileFor(root, path);
      if (file !== undefined) return reply.sendFile(file);
      if (isAppRoute(request) && (await isFile(join(root, INDEX_FILE)))) {
        return reply.sendFile(INDEX_FILE);
      }
    }
    return notFoundHandler(request, reply);
  });
}
