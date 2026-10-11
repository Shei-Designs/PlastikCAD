// Turns words into outlines: glyphs from a font, set in lines, flattened to
// polygons. Pure geometry; loading the fonts is `fonts.ts`' business.
import type { Font, Glyph } from 'opentype.js';
import type { OutlineShape, Polygon, TextAlign, Vec2 } from '../model/types';

/** Size of the em square the text is laid out at, in mm. Text nodes scale from there. */
export const EM = 10;
/** How far a flattened curve may stray from the true one, in mm at that size. */
const TOLERANCE = 0.01;
const MAX_SEGMENTS = 24;

export interface TextOutline {
  /** Centered on the bounding box of the lettering; Y up. */
  shapes: OutlineShape[];
  /** Width and height of that box. */
  size: Vec2;
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Number of straight pieces for a curve whose control polygon bends by `bend` (a second difference). */
const pieces = (bend: number) => Math.max(1, Math.min(MAX_SEGMENTS, Math.ceil(Math.sqrt(bend / TOLERANCE))));

/** Contours of one glyph with its origin at (x, y); Y up. */
function glyphContours(glyph: Glyph, x: number, y: number, out: Polygon[]): void {
  let contour: Polygon = [];
  let px = 0;
  let py = 0;
  const close = () => {
    // Fonts repeat the first point at the end of a contour, and stack points on curve joins.
    const clean: Polygon = [];
    for (const p of contour) {
      const last = clean[clean.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) clean.push(p);
    }
    if (clean.length > 1 && clean[0][0] === clean[clean.length - 1][0] && clean[0][1] === clean[clean.length - 1][1]) clean.pop();
    if (clean.length >= 3) out.push(clean);
    contour = [];
  };
  const add = (ax: number, ay: number) => {
    contour.push([round(ax), round(ay)]);
    px = ax;
    py = ay;
  };
  // The path comes in canvas coordinates (Y down), hence the minus signs.
  for (const c of glyph.getPath(x, -y, EM).commands) {
    switch (c.type) {
      case 'M':
        close();
        add(c.x, -c.y);
        break;
      case 'L':
        add(c.x, -c.y);
        break;
      case 'Q': {
        const [x1, y1, x2, y2] = [c.x1, -c.y1, c.x, -c.y];
        const n = pieces(Math.hypot(px - 2 * x1 + x2, py - 2 * y1 + y2) / 4);
        const [x0, y0] = [px, py];
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          add(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
        }
        break;
      }
      case 'C': {
        const [x1, y1, x2, y2, x3, y3] = [c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y];
        const bend = Math.max(Math.hypot(px - 2 * x1 + x2, py - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3));
        const n = pieces(bend * 0.75);
        const [x0, y0] = [px, py];
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          add(
            u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
          );
        }
        break;
      }
      case 'Z':
        close();
        break;
    }
  }
  close();
}

/**
 * Outlines of `text` set in the given fonts: the first is the main font, the
 * others are consulted for characters it lacks (fonts are shipped in pieces
 * per script). Null if nothing would be drawn (no text, or only spaces).
 */
export function layoutText(fonts: Font[], text: string, align: TextAlign): TextOutline | null {
  const main = fonts[0];
  if (!main) return null;
  const lineHeight = ((main.ascender - main.descender) / main.unitsPerEm) * EM;
  const lines: { contours: Polygon[]; width: number }[] = [];

  text.split('\n').forEach((line, row) => {
    const contours: Polygon[] = [];
    let x = 0;
    let previous = null as { font: Font; glyph: Glyph } | null;
    for (const char of line) {
      // An unknown character shows as the main font's "missing" box rather than vanishing.
      const font = fonts.find((f) => f.charToGlyphIndex(char) > 0) ?? main;
      const glyph = font.charToGlyph(char);
      const scale = EM / font.unitsPerEm;
      if (previous?.font === font) x += font.getKerningValue(previous.glyph, glyph) * scale;
      glyphContours(glyph, x, -row * lineHeight, contours);
      x += (glyph.advanceWidth ?? 0) * scale;
      previous = { font, glyph };
    }
    lines.push({ contours, width: x });
  });

  const widest = Math.max(...lines.map((l) => l.width));
  const all: Polygon[] = [];
  for (const line of lines) {
    const shift = align === 'left' ? 0 : (widest - line.width) * (align === 'right' ? 1 : 0.5);
    for (const contour of line.contours) all.push(shift === 0 ? contour : contour.map(([x, y]): Vec2 => [round(x + shift), y]));
  }
  if (all.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of all) {
    for (const [x, y] of contour) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // One shape for everything: with the non-zero rule the counters of letters stay open, while
  // overlapping parts (accents, letters that touch) simply merge.
  const contours = all.map((contour) => contour.map(([x, y]): Vec2 => [round(x - cx), round(y - cy)]));
  return { shapes: [{ contours, evenodd: false }], size: [round(maxX - minX), round(maxY - minY)] };
}
