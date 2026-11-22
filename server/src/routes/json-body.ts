import type { FastifyInstance } from 'fastify';

/**
 * Makes the routes in `app` (an encapsulated scope) take JSON bodies only.
 *
 * A cross-site form can't send JSON without a preflight. The Origin check
 * already refuses those; this is a second guard (`text/plain` gives `415`).
 *
 * An empty JSON body means no body, so a client that sends
 * `Content-Type: application/json` on every request can still DELETE.
 * Anything else goes to Fastify's own parser (with its poisoning checks).
 */
export function jsonBodiesOnly(app: FastifyInstance): void {
  app.removeContentTypeParser('text/plain');

  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    // `parseAs: 'string'` always gives a string; the type also allows a Buffer.
    const text = body.toString();
    if (text === '') {
      done(null, undefined);
      return;
    }
    // Fastify's parser is synchronous and reports through `done`.
    void parseJson(request, text, done);
  });
}
