import type { Polygon } from '../model/types';
import { encodeText, escapeXml, fmt } from './format';
import { bounds } from './outline';

const MARGIN = 1; // mm
const STROKE = 0.05; // mm, hairline for laser cutters

/** SVG in millimetres (1 user unit = 1 mm). Y is negated because SVG's Y axis points down. */
export function writeSvg(outline: Polygon[], name: string): Uint8Array {
  const contours = outline.filter((c) => c.length >= 2);
  const b = contours.length ? bounds(contours) : { min: [0, 0], max: [0, 0] };
  const x = b.min[0] - MARGIN;
  const y = -b.max[1] - MARGIN;
  const w = b.max[0] - b.min[0] + 2 * MARGIN;
  const h = b.max[1] - b.min[1] + 2 * MARGIN;

  const d = contours
    .map((c) => c.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${fmt(px, 4)} ${fmt(-py, 4)}`).join(' ') + ' Z')
    .join(' ');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${fmt(w, 4)}mm" height="${fmt(h, 4)}mm" viewBox="${fmt(x, 4)} ${fmt(y, 4)} ${fmt(w, 4)} ${fmt(h, 4)}">
  <title>${escapeXml(name)}</title>
  <path d="${d}" fill="none" fill-rule="evenodd" stroke="#000000" stroke-width="${STROKE}" stroke-linejoin="round"/>
</svg>
`;
  return encodeText(svg);
}
