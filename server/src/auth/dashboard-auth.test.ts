import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { addDashboardAuth, USER_ROUTE } from './dashboard-auth.js';

// Every dashboard route must declare its access level. The check runs when
// routes are registered, so a route without one stops the server before it
// listens. Every real route is also checked against a test case in
// routes/access-control.test.ts.

function scope(register: (app: FastifyInstance) => void) {
  const app = Fastify();
  void app.register((dashboard, _options, done) => {
    addDashboardAuth(dashboard, { now: () => new Date() });
    register(dashboard);
    done();
  });
  return app;
}

describe('dashboard route access levels', () => {
  it('refuses to start with a route that has no access level', async () => {
    const app = scope((dashboard) => {
      dashboard.get('/forgotten', () => ({}));
    });
    await expect(app.ready()).rejects.toThrow(
      "Dashboard route GET /forgotten, HEAD /forgotten has no access level: add config: { access: 'public' | 'user' | 'admin' }",
    );
  });

  it('refuses an unknown access level', async () => {
    const app = scope((dashboard) => {
      // As a typo in plain JS would be: not one of the levels.
      dashboard.get('/typo', { config: { access: 'users' as 'user' } }, () => ({}));
    });
    await expect(app.ready()).rejects.toThrow(
      'Dashboard route GET /typo, HEAD /typo has no access level',
    );
  });

  it('starts with every route declared', async () => {
    const app = scope((dashboard) => {
      dashboard.get('/fine', USER_ROUTE, () => ({}));
    });
    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });
});
