// Checks for the Markdown documentation, used by check-docs.ts. No
// dependencies, so CI can run it with plain `node` and no `pnpm install`.

/** Fenced code blocks (``` or ~~~), replaced by empty lines so line numbers stay. */
function blankCodeBlocks(markdown: string): string[] {
  const lines = markdown.split('\n');
  let fence: string | undefined;
  return lines.map((line) => {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === undefined) {
      if (match?.[1] !== undefined) {
        fence = match[1];
        return '';
      }
      return line;
    }
    if (match?.[1]?.startsWith(fence)) {
      fence = undefined;
    }
    return '';
  });
}

/** Inline code spans, replaced by spaces of the same length. */
function blankCodeSpans(line: string): string {
  return line.replace(/(`+)(?:(?!\1).)+?\1/g, (span) => ' '.repeat(span.length));
}

/**
 * The anchor GitHub gives a heading: lower case, Markdown formatting and
 * punctuation removed (except `-` and `_`), spaces turned into `-`.
 */
export function githubSlug(heading: string): string {
  let text = heading.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Strip HTML tags until none are left, so no tag can be rebuilt from the pieces.
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]+>/g, '');
  } while (text !== previous);
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Every anchor in a Markdown file: headings (with `-1`, `-2` for repeats) and HTML ids. */
export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of blankCodeBlocks(markdown)) {
    const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      const slug = githubSlug(heading[1].trim());
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      anchors.add(count === 0 ? slug : `${slug}-${String(count)}`);
    }
    for (const html of line.matchAll(/<a\s[^>]*?\b(?:id|name)="([^"]+)"/g)) {
      if (html[1] !== undefined) anchors.add(html[1]);
    }
  }
  return anchors;
}

export interface Link {
  target: string;
  /** 1-based. */
  line: number;
}

/**
 * Link and image targets: inline (`[text](target)`, `![alt](target)`),
 * reference definitions (`[label]: target`) and HTML `href`/`src`. Code
 * blocks and code spans are skipped.
 */
export function linksOf(markdown: string): Link[] {
  const links: Link[] = [];
  blankCodeBlocks(markdown).forEach((raw, index) => {
    const line = blankCodeSpans(raw);
    const add = (target: string | undefined) => {
      if (target !== undefined)
        links.push({ target: target.replace(/^<(.*)>$/, '$1'), line: index + 1 });
    };
    // Every inline link or image ends in `](target)`; this also finds the
    // image inside a linked image.
    const inline =
      /\]\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
    for (const match of line.matchAll(inline)) add(match[1]);
    const definition = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
    if (definition) add(definition[1]);
    for (const match of line.matchAll(/\b(?:href|src)="([^"]*)"/g)) add(match[1]);
  });
  return links.filter((link) => link.target !== '');
}

/** `https:`, `mailto:` and other links with a scheme, and `//host` links. */
export function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

/** Names set (`NAME=`) or shown commented out (`# NAME=`) at the start of a line. */
export function envNamesInExample(example: string): Set<string> {
  const names = new Set<string>();
  for (const match of example.matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=/gm)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return names;
}

/**
 * Names in the first column of the tables in the section with the given
 * level-2 heading, e.g. `` | `PORT` | 3100 | … ``.
 */
export function envNamesInDoc(markdown: string, section: string): Set<string> {
  const names = new Set<string>();
  let inSection = false;
  for (const line of blankCodeBlocks(markdown)) {
    const heading = /^## (.*?)\s*$/.exec(line);
    if (heading) inSection = heading[1] === section;
    if (!inSection) continue;
    const row = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(line);
    if (row?.[1] !== undefined) names.add(row[1]);
  }
  return names;
}

/** What one set has that the other lacks. */
export function setDifference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((name) => !b.has(name)).sort();
}
