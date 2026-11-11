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
  it('centers the lettering on its bounding box', () => {
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
    const middleOfI = (align: 'left' | 'center' | 'right') => {
      const below = layoutText(sans, 'MMMM\nI', align)!
        .shapes[0].contours.filter((c) => c.every(([, y]) => y < 0))
        .flat();
      return below.reduce((sum, [x]) => sum + x, 0) / below.length;
    };
    expect(middleOfI('left')).toBeLessThan(-lines.size[0] / 4);
    expect(Math.abs(middleOfI('center'))).toBeLessThan(0.5);
    expect(middleOfI('right')).toBeGreaterThan(lines.size[0] / 4);
  });

  it('finds accented letters in the extra font files', () => {
    // "ł" is only in the Latin Extended file; without it the missing-glyph box would be drawn.
    const withExt = layoutText(sans, 'ł', 'left')!;
    const without = layoutText([sans[0]], 'ł', 'left')!;
    expect(withExt.size[0]).not.toBeCloseTo(without.size[0], 2);
    expect(layoutText(sans, 'é', 'left')!.shapes[0].contours.length).toBeGreaterThanOrEqual(3);
  });

  it('sets Cyrillic, Greek and Vietnamese from the files that hold them', () => {
    const files = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'vietnamese'];
    const all = files.map((f) => load(`inter/files/inter-${f}-700-normal.woff`));
    for (const word of ['Привет', 'Ωμέγα', 'Việt', 'Ѣ', 'ἀ']) {
      // Every letter is found in one of the files: none is drawn as the box that stands for a missing one.
      for (const letter of word) expect(all.some((font) => font.charToGlyphIndex(letter) > 0), letter).toBe(true);
      expect(Math.abs(area(layoutText(all, word, 'left')!))).toBeGreaterThan(1);
      // Latin alone has none of them (the "V" and the "i" of the Vietnamese word apart).
      if (word !== 'Việt') for (const letter of word) expect(sans.some((font) => font.charToGlyphIndex(letter) > 0), letter).toBe(false);
    }
  });

  it('has every file the fonts are made of, each with the letters it is named for', () => {
    // Where in Unicode each kind of file has its letters: it must hold some of them.
    const ranges: Record<string, [number, number]> = { latin: [0x41, 0x5a], 'latin-ext': [0x100, 0x24f], cyrillic: [0x410, 0x44f], 'cyrillic-ext': [0x460, 0x52f], greek: [0x391, 0x3c9], 'greek-ext': [0x1f00, 0x1fff], vietnamese: [0x1ea0, 0x1ef9] };
    const holds = (font: Font, [from, to]: [number, number]): boolean => {
      for (let code = from; code <= to; code++) if (font.charToGlyphIndex(String.fromCodePoint(code)) > 0) return true;
      return false;
    };
    const fonts: [string, string, string[]][] = [
      ['inter', '700', ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'vietnamese']],
      ['roboto-slab', '700', ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'vietnamese']],
      ['jetbrains-mono', '700', ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'vietnamese']],
      ['allerta-stencil', '400', ['latin']],
      ['oswald', '700', ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'vietnamese']],
      ['nunito', '800', ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'vietnamese']],
      ['pacifico', '400', ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'vietnamese']],
    ];
    // What fonts.ts loads, file for file.
    const source = readFileSync(new URL('./fonts.ts', import.meta.url), 'utf8');
    for (const [family, weight, subsets] of fonts) {
      for (const subset of subsets) {
        const file = `${family}/files/${family}-${subset}-${weight}-normal.woff`;
        expect(source, file).toContain(`'@fontsource/${file}?url'`);
        expect(holds(load(file), ranges[subset]), file).toBe(true);
      }
    }
    expect(source.match(/\?url';/g)).toHaveLength(fonts.reduce((n, [, , subsets]) => n + subsets.length, 0));
  });

  it('sets a letter the font has not got in the font that follows it, not as an empty box', () => {
    // The stencil has no Greek: with the sans behind it, as the app loads it, the omega is the sans's.
    const behind = [...stencil, ...sans, load('inter/files/inter-greek-700-normal.woff')];
    const omega = layoutText(behind, 'Ω', 'left')!;
    const sansOmega = layoutText([load('inter/files/inter-greek-700-normal.woff')], 'Ω', 'left')!;
    expect(omega.size[0]).toBeCloseTo(sansOmega.size[0], 6);
    // Alone, the stencil has nothing to draw it with but the box that stands for a missing letter.
    const alone = layoutText(stencil, 'Ω', 'left');
    expect(alone === null || Math.abs(alone.size[0] - omega.size[0]) > 0.01).toBe(true);
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
