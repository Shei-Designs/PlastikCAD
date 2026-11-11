import type { Polygon } from '../model/types';
import { traceArcs } from './arcs';
import { encodeText, escapeXml, fmt } from './format';
import { bounds } from './outline';

const MARGIN = 1; // mm
const STROKE = 0.05; // mm, hairline for laser cutters

/**
 * SVG in millimeters (1 user unit = 1 mm). Y is negated because SVG's Y axis points down. Round things
 * go out round (see arcs.ts): arcs as arcs, and a circle as two half circles, in the one path, so that a
 * hole stays a hole in whatever it is inside.
 */
export function writeSvg(outline: Polygon[], name: string): Uint8Array {
  const contours = outline.filter((c) => c.length >= 2);
  const b = contours.length ? bounds(contours) : { min: [0, 0], max: [0, 0] };
  const x = b.min[0] - MARGIN;
  const y = -b.max[1] - MARGIN;
  const w = b.max[0] - b.min[0] + 2 * MARGIN;
  const h = b.max[1] - b.min[1] + 2 * MARGIN;

  const at = ([px, py]: [number, number]): string => `${fmt(px, 4)} ${fmt(-py, 4)}`;
  const d = contours
    .map((c) => {
      const traced = traceArcs(c);
      if ('circle' in traced) {
        const { center, radius } = traced.circle;
        const r = fmt(radius, 4);
        return `M${at([center[0] + radius, center[1]])} A${r} ${r} 0 1 0 ${at([center[0] - radius, center[1]])} A${r} ${r} 0 1 0 ${at([center[0] + radius, center[1]])} Z`;
      }
      // SVG's sweep flag is 1 for an arc whose angle grows in the page's own coordinates. Negating Y turns an
      // arc that goes counterclockwise here into one whose angle shrinks there: flag 0.
      const sides = traced.sides.map((s) => (s.arc ? `A${fmt(s.arc.radius, 4)} ${fmt(s.arc.radius, 4)} 0 0 ${s.arc.sweep > 0 ? 0 : 1} ${at(s.to)}` : `L${at(s.to)}`));
      // The last side leads back to the start, which Z says by itself when that side is straight.
      const last = traced.sides[traced.sides.length - 1];
      if (last && !last.arc) sides.pop();
      return [`M${at(traced.start)}`, ...sides].join(' ') + ' Z';
    })
    .join(' ');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${fmt(w, 4)}mm" height="${fmt(h, 4)}mm" viewBox="${fmt(x, 4)} ${fmt(y, 4)} ${fmt(w, 4)} ${fmt(h, 4)}">
  <title>${escapeXml(name)}</title>
  <path d="${d}" fill="none" fill-rule="evenodd" stroke="#000000" stroke-width="${STROKE}" stroke-linejoin="round"/>
</svg>
`;
  return encodeText(svg);
}
