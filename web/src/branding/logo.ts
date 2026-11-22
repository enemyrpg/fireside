// The logo: a flame above two crossed logs, drawn for this project. Round strokes in the lucide
// style, in the theme's `--on-accent`, on a rounded square in the theme's accent colour. 24 × 24
// units, readable at 16 px.
//
// This file is the source of the drawing. `assets/logo/` (copied by the plugin
// repo), `web/public/favicon.svg` and the app icons (`web/public/icons/`,
// `web/public/apple-touch-icon.png`, see icons.ts) are generated from it, and
// tests check that they match. Change the paths here, then regenerate the SVG
// files with the strings from `logoSvg` and `logoMarkSvg`, and the PNGs with
// `pnpm icons`.

/**
 * `--accent` and `--on-accent` of the default (Ember) theme, for places without
 * theme variables: the static favicon, `assets/logo/` and the app icons.
 */
export const LOGO_DEFAULT_ACCENT = '#f0803c';
export const LOGO_DEFAULT_STROKE = '#1a1009';

export const LOGO_VIEWBOX = '0 0 24 24';
export const LOGO_CORNER_RADIUS = 5;
export const LOGO_STROKE_WIDTH = 2;

/** The flame, stroked. About half as wide as the logs, with room around it. */
export const LOGO_FLAME =
  'M12 11.75c-1.7 0-2.8-1.05-2.8-2.45 0-1.8 1.6-2.6 2.1-4.05 1.7 1 3.5 2.3 3.5 4.05 0 1.4-1.1 2.45-2.8 2.45z';
/** Two crossed logs, stroked. */
export const LOGO_LOGS = 'M6.5 18.75 17.5 13.25M6.5 13.25l11 5.5';

function mark(): string {
  return `  <path d="${LOGO_FLAME}"/>\n` + `  <path d="${LOGO_LOGS}"/>\n`;
}

function svgOpen(stroke: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOGO_VIEWBOX}" fill="none" ` +
    `stroke="${stroke}" stroke-width="${String(LOGO_STROKE_WIDTH)}" ` +
    'stroke-linecap="round" stroke-linejoin="round">\n'
  );
}

/** The full logo (square and mark) as a standalone SVG file. */
export function logoSvg(accent = LOGO_DEFAULT_ACCENT, stroke = LOGO_DEFAULT_STROKE): string {
  return (
    svgOpen(stroke) +
    `  <rect width="24" height="24" rx="${String(LOGO_CORNER_RADIUS)}" fill="${accent}" stroke="none"/>\n` +
    mark() +
    '</svg>\n'
  );
}

/**
 * Scale of the mark on the full-bleed icon. The mark with its strokes reaches
 * about 42 % of the size from the centre; scaled, about 34 %, inside the 40 %
 * safe zone of a maskable icon (tested on the rendered PNG).
 */
export const LOGO_FULL_BLEED_MARK_SCALE = 0.8;

/**
 * The logo as a full square without rounded corners, for icons the platform
 * shapes itself: the maskable app icon (Android cuts it to a circle or squircle)
 * and the apple-touch-icon (iOS rounds the corners and would fill transparent
 * corners with black).
 */
export function logoFullBleedSvg(
  accent = LOGO_DEFAULT_ACCENT,
  stroke = LOGO_DEFAULT_STROKE,
): string {
  const scale = String(LOGO_FULL_BLEED_MARK_SCALE);
  return (
    svgOpen(stroke) +
    `  <rect width="24" height="24" fill="${accent}" stroke="none"/>\n` +
    `  <g transform="translate(12 12) scale(${scale}) translate(-12 -12)">\n` +
    mark().replace(/^(?=.)/gm, '  ') +
    '  </g>\n' +
    '</svg>\n'
  );
}

/** Only the mark, in `currentColor`, for use on any background. */
export function logoMarkSvg(): string {
  return svgOpen('currentColor') + mark() + '</svg>\n';
}
