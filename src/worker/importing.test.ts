import { describe, expect, it } from 'vitest';
import { readFile } from './importing';

const bytes = (s: string) => new TextEncoder().encode(s);

/** Two open-topped boxes side by side, each in a material of its own, as a modelling program writes a part in two materials. */
function twoShells(): { obj: Uint8Array; mtl: Uint8Array } {
  const lines = ['mtllib shells.mtl'];
  const side = (at: number, material: string, first: number): void => {
    for (const [x, y, z] of [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]]) lines.push(`v ${x + at} ${y} ${z}`);
    lines.push(`usemtl ${material}`);
    for (const f of [[1, 4, 3, 2], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]]) lines.push(`f ${f.map((i) => i + first).join(' ')}`);
  };
  side(0, 'red', 0);
  side(20, 'blue', 8);
  return { obj: bytes(lines.join('\n')), mtl: bytes('newmtl red\nKd 1 0 0\nnewmtl blue\nKd 0 0 1\n') };
}

describe('a file read into what the design keeps', () => {
  it('gives parts that are open shells as one object wearing their colors', async () => {
    const { obj, mtl } = twoShells();
    const result = await readFile(1, 'shells.obj', obj, [{ name: 'shells.mtl', bytes: mtl }], 1);
    if (result.kind !== 'model') throw new Error('expected a model');
    expect(result.parts).toHaveLength(1);
    const [part] = result.parts;
    // Both shells, where the file has them: 30 mm long over the two.
    expect(part.size.map((v) => Math.round(v))).toEqual([30, 10, 10]);
    expect(part.image?.mime).toBe('image/png');
    expect(part.asset.uv).toBeDefined();
  });
});
