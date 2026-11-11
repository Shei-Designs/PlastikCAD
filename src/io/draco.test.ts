import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DracoDecode } from './draco';
import { loadDraco } from './draco';
import { importFile, needsDraco } from './import';

const file = (path: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(path, import.meta.url))));
// A box 40 x 30 x 10 mm (glTF's Y is up: 0.04 x 0.01 x 0.03 m there), red, with texture coordinates, compressed with Draco.
const box = file('../../fixtures/gltf/box-draco.glb');
let draco: DracoDecode;

beforeAll(async () => {
  draco = await loadDraco({ wasmBinary: file('../../node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.wasm') });
}, 60_000);

describe('glTF compressed with Draco', () => {
  it('is known by the extension it names', () => {
    expect(needsDraco(box)).toBe(true);
    expect(needsDraco(new TextEncoder().encode('{"asset":{"version":"2.0"},"meshes":[]}'))).toBe(false);
  });

  it('is unpacked into the mesh it holds: its size in millimeters, Z up, its color and its triangles', () => {
    const got = importFile('box.glb', box, [], { draco });
    if (got.kind !== 'model') throw new Error('expected a model');
    expect(got.parts).toHaveLength(1);
    const [part] = got.parts;
    expect(part.color).toBe('#ff0000');
    expect(part.mesh.triangles.length / 3).toBe(12);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    part.mesh.positions.forEach((v, i) => {
      min[i % 3] = Math.min(min[i % 3], v);
      max[i % 3] = Math.max(max[i % 3], v);
    });
    // To the fourteen bits the positions were packed with: a few microns on 40 mm.
    [0, -30, 0].forEach((v, i) => expect(min[i]).toBeCloseTo(v, 2));
    [40, 0, 10].forEach((v, i) => expect(max[i]).toBeCloseTo(v, 2));
    // Its texture coordinates came through, two a corner.
    expect(part.mesh.uv?.length).toBe(12 * 3 * 2);
  });

  it('is refused in words without the decoder, and when what it holds cannot be unpacked', () => {
    expect(() => importFile('box.glb', box)).toThrow('This glTF file is compressed. Export it again without mesh compression and import that.');
    // The same file with its compressed bytes overwritten.
    const broken = box.slice();
    broken.fill(7, broken.length - 120);
    expect(() => importFile('box.glb', broken, [], { draco })).toThrow('This glTF file is damaged: a compressed mesh cannot be unpacked.');
    // And the decoder is none the worse for it.
    expect(importFile('box.glb', box, [], { draco }).kind).toBe('model');
  });
});
