import { DEFAULT_PAGE_COLOR, THEMES } from '@/theme/themes';

// `<meta name="theme-color">` colours the title bar of an installed app (and
// the browser bar on some phones). The theme-init script sets it before first
// paint (themes.ts); this keeps it in step when the theme changes.

/** Points `<meta name="theme-color">` at the current theme's `--page`. */
export function syncThemeColor(doc: Document = document): void {
  const view = doc.defaultView;
  const themed = view?.getComputedStyle(doc.documentElement).getPropertyValue('--page').trim();
  // An empty value means the theme CSS isn't loaded (yet): use the page colour
  // of the theme on <html> from the registry, as the theme-init script does,
  // so a light title bar never turns dark while the CSS loads.
  const theme = doc.documentElement.dataset.theme;
  const color =
    themed === undefined || themed === ''
      ? (THEMES.find((candidate) => candidate.id === theme)?.page ?? DEFAULT_PAGE_COLOR)
      : themed;
  let meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = doc.createElement('meta');
    meta.name = 'theme-color';
    doc.head.append(meta);
  }
  meta.content = color;
}
