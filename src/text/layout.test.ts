/// <reference types="node" />
import { readFileSync } from 'node:fs';
import * as opentype from 'opentype.js';
import type { Font } from 'opentype.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { signedArea } from '../io/outline';
import { EM, layoutText } from './layout';

// Outside a bundler the package resolves to its CommonJS build, whose exports sit on `default`.
const { parse } = ((opentype as unknown as { default?: typeof opentype }).default ?? opentype) as typeof opentype;

const load = (file: string): Font => {
  const bytes = readFileSync(new URL(`../../node_modules/@fontsource/${file}`, import.meta.url));
  return parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

let sans: Font[];
let stencil: Font[];

beforeAll(() => {
  sans = [load('inter/files/inter-latin-700-normal.woff'), load('inter/files/inter-latin-ext-700-normal.woff')];
  stencil = [load('allerta-stencil/files/allerta-stencil-latin-400-normal.woff')];
});

const area = (outline: NonNullable<ReturnType<typeof layoutText>>) =>
  outline.shapes.flatMap((s) => s.contours).reduce((sum, c) => sum + signedArea(c), 0);

describe('text layout', () => {
  it('centres the lettering on its bounding box', () => {
    const outline = layoutText(sans, 'Hxg', 'left')!;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of outline.shapes.flatMap((s) => s.contours).flat()) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    expect(minX + maxX).toBeCloseTo(0, 3);
    expect(minY + maxY).toBeCloseTo(0, 3);
    expect(maxX - minX).toBeCloseTo(outline.size[0], 3);
    expect(maxY - minY).toBeCloseTo(outline.size[1], 3);
  });

  it('sets capitals at about seven tenths of the em, right way up', () => {
    const outline = layoutText(sans, 'H', 'left')!;
    expect(outline.size[1]).toBeGreaterThan(0.65 * EM);
    expect(outline.size[1]).toBeLessThan(0.8 * EM);
    // An "L" has its foot at the bottom right: most of its area is below the middle.
    const foot = layoutText(sans, 'L', 'left')!;
    const points = foot.shapes[0].contours[0];
    const right = points.filter(([x]) => x > foot.size[0] * 0.25);
    expect(right.length).toBeGreaterThan(0);
    for (const [, y] of right) expect(y).toBeLessThan(0);
  });

  it('keeps the counters of letters open', () => {
    const o = layoutText(sans, 'O', 'left')!;
    expect(o.shapes).toHaveLength(1);
    expect(o.shapes[0].evenodd).toBe(false);
    expect(o.shapes[0].contours).toHaveLength(2);
    const [a, b] = o.shapes[0].contours.map(signedArea);
    // Outer and inner contour wind opposite ways, which is what the non-zero rule needs.
    expect(a * b).toBeLessThan(0);
    // Ring, not disc: well under the area of its bounding ellipse.
    expect(Math.abs(area(o))).toBeLessThan((Math.PI / 4) * o.size[0] * o.size[1] * 0.75);
  });

  it('flattens curves finely enough to look round', () => {
    const o = layoutText(sans, 'O', 'left')!;
    expect(o.shapes[0].contours[0].length).toBeGreaterThan(24);
  });

  it('grows with the text', () => {
    const one = layoutText(sans, 'M', 'left')!;
    const three = layoutText(sans, 'MMM', 'left')!;
    expect(three.size[0]).toBeGreaterThan(one.size[0] * 2.8);
    expect(three.size[1]).toBeCloseTo(one.size[1], 3);
  });

  it('stacks lines downwards and aligns them', () => {
    const lines = layoutText(sans, 'MMMM\nI', 'left')!;
    const single = layoutText(sans, 'MMMM', 'left')!;
    expect(lines.size[0]).toBeCloseTo(single.size[0], 3);
    expect(lines.size[1]).toBeGreaterThan(single.size[1] * 2);
    const middleOfI = (align: 'left' | 'centre' | 'right') => {
      const below = layoutText(sans, 'MMMM\nI', align)!
        .shapes[0].contours.filter((c) => c.every(([, y]) => y < 0))
        .flat();
      return below.reduce((sum, [x]) => sum + x, 0) / below.length;
    };
    expect(middleOfI('left')).toBeLessThan(-lines.size[0] / 4);
    expect(Math.abs(middleOfI('centre'))).toBeLessThan(0.5);
    expect(middleOfI('right')).toBeGreaterThan(lines.size[0] / 4);
  });

  it('finds accented letters in the extra font files', () => {
    // "ł" is only in the Latin Extended file; without it the missing-glyph box would be drawn.
    const withExt = layoutText(sans, 'ł', 'left')!;
    const without = layoutText([sans[0]], 'ł', 'left')!;
    expect(withExt.size[0]).not.toBeCloseTo(without.size[0], 2);
    expect(layoutText(sans, 'é', 'left')!.shapes[0].contours.length).toBeGreaterThanOrEqual(3);
  });

  it('gives nothing for text that draws nothing', () => {
    expect(layoutText(sans, '', 'left')).toBeNull();
    expect(layoutText(sans, '  \n ', 'left')).toBeNull();
    expect(layoutText([], 'A', 'left')).toBeNull();
  });

  it('leaves bridges in stencil letters, so their middles stay attached', () => {
    // A stencil "O" is two halves with no enclosed counter.
    const o = layoutText(stencil, 'O', 'left')!;
    const signs = o.shapes[0].contours.map((c) => Math.sign(signedArea(c)));
    expect(new Set(signs).size).toBe(1);
  });
});
