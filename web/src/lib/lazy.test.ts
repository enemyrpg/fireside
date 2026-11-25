import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChunkLoadError, isNewVersionServed, lazyModule } from './lazy';

/** A module import that fails, as when the file is gone after a release. */
function failing(error: Error) {
  return (): Promise<{ default: ComponentType }> => Promise.reject(error);
}

function html(entry: string): string {
  return `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body><div id="root"></div></body></html>`;
}

function serve(response: Response | Error) {
  const fetchMock = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('lazyModule', () => {
  it('turns a failed import into a ChunkLoadError, keeping the cause', async () => {
    const cause = new TypeError('Failed to fetch dynamically imported module');
    const { load } = lazyModule(failing(cause));
    const error: unknown = await load().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect((error as ChunkLoadError).cause).toBe(cause);
  });

  it('imports once, however often it is asked, also after a failure', async () => {
    const importer = vi.fn(failing(new Error('gone')));
    const { load } = lazyModule(importer);
    await expect(load()).rejects.toBeInstanceOf(ChunkLoadError);
    await expect(load()).rejects.toBeInstanceOf(ChunkLoadError);
    expect(importer).toHaveBeenCalledTimes(1);
  });
});

describe('isNewVersionServed', () => {
  afterEach(() => {
    document.head.innerHTML = '';
  });

  function runningBuild(entry: string) {
    document.head.innerHTML = `<script type="module" src="${entry}"></script>`;
  }

  it('is true when the server serves another entry script', async () => {
    runningBuild('/assets/index-old.js');
    const fetchMock = serve(new Response(html('/assets/index-new.js')));
    expect(await isNewVersionServed()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/', expect.objectContaining({ cache: 'no-store' }));
  });

  it('is false when the server serves the same build', async () => {
    runningBuild('/assets/index-same.js');
    serve(new Response(html('/assets/index-same.js')));
    expect(await isNewVersionServed()).toBe(false);
  });

  it('is unknown when the server cannot be asked', async () => {
    runningBuild('/assets/index-old.js');
    serve(new TypeError('Failed to fetch'));
    expect(await isNewVersionServed()).toBeUndefined();
    serve(new Response('', { status: 502 }));
    expect(await isNewVersionServed()).toBeUndefined();
    // Not the dashboard's index.html (e.g. a JSON error).
    serve(new Response('{"error":{}}'));
    expect(await isNewVersionServed()).toBeUndefined();
  });
});
