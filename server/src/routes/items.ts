import {
  bossIconParamsSchema,
  itemIconParamsSchema,
  skillIconParamsSchema,
} from '@fireside/shared';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { PRIVATE_REVALIDATE } from '../security-headers.js';
import { getBossIcon, getIcon, getSkillIcon, type StoredIcon } from '../icons/store.js';
import { parseRequest } from './parse.js';

// `GET /items/:itemId/icon`, `GET /skills/:skill/icon` and
// `GET /bosses/:boss/icon`. Registered in the dashboard scope (local only). An
// item ID is the exact ID from the data; the server never maps IDs.

/** True if `If-None-Match` lists `etag` (weak or strong) or `*`. */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === etag || tag === '*');
}

/**
 * Sends a stored icon, or 404. The same for every kind of icon: `ETag` is the
 * SHA-256 and a matching `If-None-Match` gives 304. A found icon is
 * `private, no-cache`, the one exception to `no-store` under `/api`
 * (`PRIVATE_REVALIDATE` in security-headers.ts): the browser keeps it and
 * checks it each time, and no shared cache stores it. A missing icon is
 * `no-store`, so a newly uploaded one shows up at once.
 */
function sendIcon(request: FastifyRequest, reply: FastifyReply, icon: StoredIcon | undefined) {
  if (!icon) throw new ApiError(404, 'NOT_FOUND', 'Icon not found');
  const etag = `"${icon.sha256}"`;
  reply.header('ETag', etag).header('Cache-Control', PRIVATE_REVALIDATE);
  if (matchesEtag(request.headers['if-none-match'], etag)) {
    return reply.code(304).send();
  }
  return reply.type('image/png').send(icon.png);
}

export const itemRoutes: FastifyPluginCallback = (app, _options, done) => {
  // On every response from these routes, errors included: the body is never
  // sniffed as anything else and can't load or run anything.
  const routeOptions = {
    // Icons are shared by the instance: any logged-in user may read them.
    config: { access: 'user' as const },
    onRequest: (_request: FastifyRequest, reply: FastifyReply, next: () => void) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'");
      next();
    },
  };

  app.get('/items/:itemId/icon', routeOptions, (request, reply) => {
    const { itemId } = parseRequest(itemIconParamsSchema, request.params, 'params');
    return sendIcon(request, reply, getIcon(app.db, itemId));
  });

  // Skill and boss/raid icons. A skill is its name in the data (`ATTACK`). A
  // boss is any name the data uses: it is normalized, and a raid mode without
  // an icon of its own gets its raid's.
  app.get('/skills/:skill/icon', routeOptions, (request, reply) => {
    const { skill } = parseRequest(skillIconParamsSchema, request.params, 'params');
    return sendIcon(request, reply, getSkillIcon(app.db, skill));
  });

  app.get('/bosses/:boss/icon', routeOptions, (request, reply) => {
    const { boss } = parseRequest(bossIconParamsSchema, request.params, 'params');
    return sendIcon(request, reply, getBossIcon(app.db, boss));
  });
  done();
};
