import type { Connect, Plugin, ViteDevServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { pwaPlugin } from '@/branding/pwa-plugin';
import { themeInitFileName, themeInitPlugin } from '@/theme/theme-init-plugin';
import { themeInitScript } from '@/theme/themes';
import { devFile } from './dev-file';

interface Answer {
  passed: boolean;
  type?: string;
  body?: string | undefined;
}

/** Runs one request through a middleware. */
function ask(handler: Connect.NextHandleFunction, method: string, url: string): Answer {
  const answer: Answer = { passed: false };
  const response = {
    setHeader: (_name: string, value: string) => {
      answer.type = value;
    },
    end: (body?: string) => {
      answer.body = body;
    },
  };
  handler({ method, url } as unknown as Connect.IncomingMessage, response as never, () => {
    answer.passed = true;
  });
  return answer;
}

/** The middleware a plugin adds to the dev server. */
function middlewareOf(plugin: Plugin): Connect.NextHandleFunction {
  const handlers: Connect.NextHandleFunction[] = [];
  const server = {
    middlewares: { use: (handler: Connect.NextHandleFunction) => handlers.push(handler) },
  };
  (plugin.configureServer as (server: ViteDevServer) => void)(server as unknown as ViteDevServer);
  expect(handlers).toHaveLength(1);
  const [handler] = handlers;
  if (!handler) throw new Error('no middleware');
  return handler;
}

describe('devFile', () => {
  const handler = devFile('/file.json', 'application/json', '{}');

  it('answers GET for exactly the path, also with a query', () => {
    expect(ask(handler, 'GET', '/file.json')).toEqual({
      passed: false,
      type: 'application/json',
      body: '{}',
    });
    expect(ask(handler, 'GET', '/file.json?v=1').body).toBe('{}');
  });

  it('answers HEAD without a body', () => {
    expect(ask(handler, 'HEAD', '/file.json')).toEqual({
      passed: false,
      type: 'application/json',
      body: undefined,
    });
  });

  it.each([
    ['POST', '/file.json'],
    ['PUT', '/file.json'],
    ['GET', '/file.json/x'],
    ['GET', '/file.jsonx'],
    ['GET', '/other/file.json'],
    ['GET', '/'],
  ])('passes %s %s on', (method, url) => {
    expect(ask(handler, method, url)).toEqual({ passed: true });
  });
});

describe('dev server files of the plugins', () => {
  it('serves the manifest only for an exact GET or HEAD', () => {
    const handler = middlewareOf(pwaPlugin());
    expect(ask(handler, 'GET', '/manifest.webmanifest').type).toBe('application/manifest+json');
    expect(ask(handler, 'POST', '/manifest.webmanifest').passed).toBe(true);
    expect(ask(handler, 'GET', '/manifest.webmanifest/x').passed).toBe(true);
  });

  it('serves the theme script only for an exact GET or HEAD', () => {
    const file = `/${themeInitFileName(themeInitScript())}`;
    const handler = middlewareOf(themeInitPlugin());
    expect(ask(handler, 'GET', file).body).toBe(themeInitScript());
    expect(ask(handler, 'HEAD', file).passed).toBe(false);
    expect(ask(handler, 'DELETE', file).passed).toBe(true);
    expect(ask(handler, 'GET', `${file}/x`).passed).toBe(true);
  });
});
