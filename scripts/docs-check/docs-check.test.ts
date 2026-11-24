import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  anchorsOf,
  envNamesInDoc,
  envNamesInExample,
  githubSlug,
  isExternal,
  linksOf,
  setDifference,
} from './docs-check.ts';

describe('githubSlug', () => {
  it.each([
    ['Local mode and login mode', 'local-mode-and-login-mode'],
    ['The key, `secret.key`', 'the-key-secretkey'],
    ['1. Before you start', '1-before-you-start'],
    ['Docker and `pnpm dev` at the same time', 'docker-and-pnpm-dev-at-the-same-time'],
    [
      'Let the plugin through: Browser Integrity Check off',
      'let-the-plugin-through-browser-integrity-check-off',
    ],
    ['Keep BACKUP_DIR', 'keep-backup_dir'],
    ['A [link](x.md) in a heading', 'a-link-in-a-heading'],
    ['Café Zoë', 'café-zoë'],
    ['A <code>tag</code> heading', 'a-tag-heading'],
    ['Nested <a<b>>tags', 'nested-tags'],
  ])('%s → %s', (heading, slug) => {
    expect(githubSlug(heading)).toBe(slug);
  });
});

describe('anchorsOf', () => {
  it('finds headings, numbers repeats and skips code blocks', () => {
    const anchors = anchorsOf(
      [
        '# Title',
        '## Docker',
        '### Docker',
        '```sh',
        '# not a heading',
        '```',
        '## Closing hashes ##',
        '<a id="custom"></a>',
      ].join('\n'),
    );
    expect([...anchors].sort()).toEqual(
      ['closing-hashes', 'custom', 'docker', 'docker-1', 'title'].sort(),
    );
  });
});

describe('linksOf', () => {
  it('finds inline links, images, linked images, definitions and HTML', () => {
    const markdown = [
      'See [the guide](docs/guide.md#start) and ![a shot](img/a.png "Title").',
      '[![badge](img/b.svg)](https://example.com)',
      '[ref]: ./other.md',
      '<img src="img/c.png" alt="x"> <a href="d.md">d</a>',
      'An [angle](<with space.md>) link and a [paren](file_(1).md).',
    ].join('\n');
    expect(linksOf(markdown)).toEqual([
      { target: 'docs/guide.md#start', line: 1 },
      { target: 'img/a.png', line: 1 },
      { target: 'img/b.svg', line: 2 },
      { target: 'https://example.com', line: 2 },
      { target: './other.md', line: 3 },
      { target: 'img/c.png', line: 4 },
      { target: 'd.md', line: 4 },
      { target: 'with space.md', line: 5 },
      { target: 'file_(1).md', line: 5 },
    ]);
  });

  it('ignores code blocks and code spans', () => {
    const markdown = ['`[a](nope.md)`', '```', '[b](nope.md)', '```', '~~~', '[c](nope.md)', '~~~'];
    expect(linksOf(markdown.join('\n'))).toEqual([]);
  });

  it('keeps line numbers after a code block', () => {
    expect(linksOf(['```', 'x', '```', '[a](a.md)'].join('\n'))).toEqual([
      { target: 'a.md', line: 4 },
    ]);
  });
});

describe('isExternal', () => {
  it.each([
    ['https://example.com', true],
    ['mailto:someone@example.com', true],
    ['//cdn.example.com/x', true],
    ['docs/tunnel.md', false],
    ['#anchor', false],
    ['../LICENSE', false],
  ])('%s → %s', (target, external) => {
    expect(isExternal(target)).toBe(external);
  });
});

describe('the .env reference', () => {
  const example = [
    '# Comment about HOST.',
    'HOST=127.0.0.1',
    '# PUBLIC_URL=https://dashboard.example.com',
    '#   DATA_DIR=./data-dev',
    '# KEY_LIKE text in a comment',
  ].join('\n');
  const doc = [
    '## Configuration',
    '| Variable | Default |',
    '| --- | --- |',
    '| `HOST` | `127.0.0.1` |',
    '| `MAX_USERS` | unset |',
    '## Elsewhere',
    '| `PUBLIC_URL` | unset |',
  ].join('\n');

  it('reads set and commented-out names from .env.example', () => {
    expect([...envNamesInExample(example)].sort()).toEqual(['HOST', 'PUBLIC_URL']);
  });

  it('reads the first column of the tables in the section only', () => {
    expect([...envNamesInDoc(doc, 'Configuration')].sort()).toEqual(['HOST', 'MAX_USERS']);
  });

  it('reports what each side lacks', () => {
    const inExample = envNamesInExample(example);
    const inDoc = envNamesInDoc(doc, 'Configuration');
    expect(setDifference(inExample, inDoc)).toEqual(['PUBLIC_URL']);
    expect(setDifference(inDoc, inExample)).toEqual(['MAX_USERS']);
  });
});

describe('check-docs.ts on this repository', () => {
  it('passes', () => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'check-docs.ts')], {
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
