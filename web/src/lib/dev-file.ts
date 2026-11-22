import type { Connect } from 'vite';

// Serves a file made by a Vite plugin from the dev server, like the production
// server would: only GET and HEAD for exactly that path (a query string is
// fine). Every other method or path goes on to the next handler, so
// `/manifest.webmanifest/x` or a POST isn't answered with the file. Read by
// vite.config.ts, so it must not touch browser globals.

export function devFile(
  path: string,
  contentType: string,
  body: string,
): Connect.NextHandleFunction {
  return (request, response, next) => {
    const url = request.url ?? '';
    const pathname = url.split('?', 1)[0];
    if (pathname !== path || (request.method !== 'GET' && request.method !== 'HEAD')) {
      next();
      return;
    }
    response.setHeader('content-type', contentType);
    response.end(request.method === 'HEAD' ? undefined : body);
  };
}
