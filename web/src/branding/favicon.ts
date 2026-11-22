import { LOGO_DEFAULT_ACCENT, LOGO_DEFAULT_STROKE, logoSvg } from './logo';

// The favicon is the logo in the current theme's `--accent` and `--on-accent`.
// index.html links the static `favicon.svg` (default theme); this swaps it for
// the chosen theme.

export function faviconHref(accent: string, stroke: string = LOGO_DEFAULT_STROKE): string {
  return `data:image/svg+xml,${encodeURIComponent(logoSvg(accent, stroke))}`;
}

/** Points `<link rel="icon">` at the logo in the current `--accent` and `--on-accent`. */
export function syncFavicon(doc: Document = document): void {
  const style = doc.defaultView?.getComputedStyle(doc.documentElement);
  const read = (name: string) => style?.getPropertyValue(name).trim() ?? '';
  // An empty value means the theme CSS isn't loaded (yet).
  const accent = read('--accent') || LOGO_DEFAULT_ACCENT;
  const stroke = read('--on-accent') || LOGO_DEFAULT_STROKE;
  let link = doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = doc.createElement('link');
    link.rel = 'icon';
    doc.head.append(link);
  }
  link.type = 'image/svg+xml';
  link.href = faviconHref(accent, stroke);
}
