import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { MeshData } from '../geometry/mesh';
import type { ImportedPart } from './import';
import { asOne, closed } from './oneObject';

/** A box from the origin to (x, y, z); `open` leaves its top off. */
function box(x: number, y: number, z: number, at = 0, open = false): MeshData {
  const positions = new Float32Array([0, 0, 0, x, 0, 0, x, y, 0, 0, y, 0, 0, 0, z, x, 0, z, x, y, z, 0, y, z].map((v, i) => (i % 3 === 0 ? v + at : v)));
  const sides = [
    [0, 3, 2, 1],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
    ...(open ? [] : [[4, 5, 6, 7]]),
  ];
  return { positions, triangles: new Uint32Array(sides.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])) };
}

/** The colors of a picture the reader wrote, each once. */
function colorsOf(png: Uint8Array): string[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const [width, height] = [view.getUint32(16), view.getUint32(20)];
  const rows = unzlibSync(png.subarray(41, 41 + view.getUint32(33)));
  const seen = new Set<string>();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) seen.add(`#${[0, 1, 2].map((k) => rows[y * (width * 3 + 1) + 1 + x * 3 + k].toString(16).padStart(2, '0')).join('')}`);
  return [...seen].sort();
}

describe('a mesh that is the skin of a solid', () => {
  it('is told from one with a side missing', () => {
    expect(closed(box(1, 1, 1))).toBe(true);
    expect(closed(box(1, 1, 1, 0, true))).toBe(false);
  });
});

describe('the parts of a file as one object', () => {
  const part = (name: string, mesh: MeshData, color?: string): ImportedPart => ({ name, mesh, ...(color ? { color } : {}) });

  it('are one mesh that wears their colors, when one of them is no closed solid', () => {
    const shell = part('body (rubber)', box(10, 10, 10, 0, true), '#ff0000');
    const lid = part('body (logo)', box(10, 10, 2, 20), '#0000ff');
    const one = asOne([shell, lid])!;
    expect(one.name).toBe('body (rubber)');
    expect(one.mesh.triangles.length / 3).toBe(10 + 12);
    expect(one.mesh.positions.length / 3).toBe(16);
    // A picture of the two colors, and every triangle on the color of the part it came from.
    expect(colorsOf(one.image!.bytes)).toEqual(['#0000ff', '#ff0000']);
    const uv = one.mesh.uv!;
    expect(uv.length).toBe(22 * 6);
    const places = new Set<string>();
    for (let t = 0; t < 22; t++) places.add(`${t < 10 ? 'shell' : 'lid'} ${uv[t * 6]},${uv[t * 6 + 1]}`);
    expect(places.size).toBe(2);
    // The object's own color, where a picture does not go, is the mean by triangles: ten red, twelve blue.
    expect(one.color).toBe('#74008b');
  });

  it('are one mesh of one color and no picture when they are of one color, or of none', () => {
    const same = asOne([part('a', box(1, 1, 1, 0, true), '#336699'), part('b', box(1, 1, 1, 5), '#336699')])!;
    expect(same.color).toBe('#336699');
    expect(same.image).toBeUndefined();
    expect(same.mesh.uv).toBeUndefined();
    const none = asOne([part('a', box(1, 1, 1, 0, true)), part('b', box(1, 1, 1, 5))])!;
    expect(none.color).toBeUndefined();
    expect(none.image).toBeUndefined();
  });

  it('gives a part that names no color a plain one beside parts that do', () => {
    const one = asOne([part('a', box(1, 1, 1, 0, true), '#ff0000'), part('b', box(1, 1, 1, 5))])!;
    expect(colorsOf(one.image!.bytes)).toEqual(['#808080', '#ff0000']);
  });

  it('are left as they are when they can be a group, when there is one, and when one wears a picture', () => {
    expect(asOne([part('a', box(1, 1, 1)), part('b', box(1, 1, 1, 5))])).toBeNull();
    expect(asOne([part('a', box(1, 1, 1, 0, true))])).toBeNull();
    const pictured: ImportedPart = { ...part('b', box(1, 1, 1, 5)), image: { name: 'b.png', mime: 'image/png', bytes: new Uint8Array(1) } };
    expect(asOne([part('a', box(1, 1, 1, 0, true)), pictured])).toBeNull();
  });

  it('joins corners the parts share and drops a triangle with no area', () => {
    const sliver: MeshData = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0]), triangles: new Uint32Array([0, 1, 2]) };
    const one = asOne([part('a', box(1, 1, 1, 0, true), '#ff0000'), part('b', sliver, '#00ff00')])!;
    expect(one.mesh.triangles.length / 3).toBe(10);
    expect(one.image).toBeUndefined();
    expect(one.color).toBe('#ff0000');
  });
});
