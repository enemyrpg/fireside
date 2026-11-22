import QRCode from 'qrcode';
import { useMemo } from 'react';

/**
 * A QR code drawn as one SVG path: no canvas, no `data:` URI and no `style`
 * attribute, so it passes the CSP. Always dark on white with a quiet zone,
 * whatever the theme, because that is what phone cameras read best.
 */
export function QrCode({
  value,
  label,
  size = 192,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const { path, width } = useMemo(() => {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const quiet = 4;
    let d = '';
    for (let row = 0; row < modules.size; row++) {
      for (let column = 0; column < modules.size; column++) {
        if (modules.get(row, column)) {
          d += `M${String(column + quiet)} ${String(row + quiet)}h1v1h-1z`;
        }
      }
    }
    return { path: d, width: modules.size + quiet * 2 };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${String(width)} ${String(width)}`}
      shapeRendering="crispEdges"
      className="rounded-md"
    >
      <rect width={width} height={width} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
