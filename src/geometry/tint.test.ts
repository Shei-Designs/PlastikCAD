import { describe, expect, it } from 'vitest';
import { cloneNode, makeGroup, makeShape } from '../model/ops';
import type { Vec3 } from '../model/types';
import { FILL_UV } from './uv';
import { cornerColors, tintKey, underPicture } from './tint';
import { NO_SOURCE } from './mesh';
import type { Faces } from './mesh';

const bounds = { min: [-10, -10, 0] as Vec3, max: [10, 10, 20] as Vec3 };
const red = { ...makeShape('box'), id: 'r', color: '#ff0000' };
const blue = { ...makeShape('sphere'), id: 'b', color: '#0000ff' };
const group = makeGroup([red, blue], bounds, 'G');
// Four faces: two from the box, one from the sphere, one of unknown origin.
const faces: Faces = { source: new Uint16Array([0, 0, 1, NO_SOURCE]), sources: [[0], [1]] };
const RED = [1, 0, 0];
const BLUE = [0, 0, 1];

const rgb = (colors: Float32Array, corner: number) => Array.from(colors.slice(corner * 3, corner * 3 + 3));

describe('corner colors of a mixed group', () => {
  it('gives every corner of a face the linear color of the part that made it', () => {
    const colors = cornerColors(group, faces, 4);
    expect(colors.length).toBe(4 * 9);
    for (let c = 0; c < 6; c++) expect(rgb(colors, c)).toEqual(RED);
    for (let c = 6; c < 9; c++) expect(rgb(colors, c)).toEqual(BLUE);
    // A face from nowhere takes the group's own color (that of its first solid).
    expect(rgb(colors, 9)).toEqual(RED);
  });

  it('follows cut triangles back to their faces, and leaves those under a picture white', () => {
    // The sphere's face was cut in two; the second piece lies under a picture.
    const origin = new Uint32Array([0, 1, 2, 2, 3]);
    const uv = new Float32Array(5 * 6).fill(FILL_UV[0]);
    uv.set([0.2, 0.6, 0.8, 0.6, 0.5, 0.9], 3 * 6);
    const colors = cornerColors(group, faces, 5, { origin, covered: (t) => underPicture(uv, t) });
    expect(rgb(colors, 6)).toEqual(BLUE);
    expect(rgb(colors, 9)).toEqual([1, 1, 1]);
    expect(rgb(colors, 12)).toEqual(RED);
  });

  it('changes its key when a part changes color, and not otherwise', () => {
    const key = tintKey(group, faces);
    expect(tintKey({ ...group, children: [red, { ...blue, color: '#00ff00' }] }, faces)).not.toBe(key);
    expect(tintKey({ ...group, pos: [5, 5, 5] }, faces)).toBe(key);
  });

  it('colors a copy of the group, whose parts have ids of their own, from the same faces', () => {
    const copy = cloneNode(group);
    expect(copy.children[0].id).not.toBe('r');
    expect(Array.from(cornerColors(copy, faces, 4))).toEqual(Array.from(cornerColors(group, faces, 4)));
    expect(tintKey(copy, faces)).toBe(tintKey(group, faces));
  });
});
