import { CONTRACT_VERSION, type HealthResponse } from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { SERVER_VERSION } from '../version.js';

export interface HealthRoutesOptions {
  /** IANA time zone (`TZ`), reported so the dashboard can show times in it. */
  timeZone: string;
}

/** `GET /health`. No auth: it tells nothing about accounts, keys or data. */
export const healthRoutes: FastifyPluginCallback<HealthRoutesOptions> = (
  app,
  { timeZone },
  done,
) => {
  app.get('/health', (): HealthResponse => ({
    status: 'ok',
    serverVersion: SERVER_VERSION,
    contractVersion: CONTRACT_VERSION,
    timeZone,
  }));
  done();
};
