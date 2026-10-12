import { describe, expect, it } from 'vitest';
import { multiply, rotation, scaling, translation } from '../model/math';
import { linearColor, readGlb, writeGlb } from './glb';

// One triangle in the XY plane facing +Z, at z = 5 mm.
const positions = new Float32Array([0, 0, 5, 10, 0, 5, 0, 10, 5]);
const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
// A tiny PNG signature stands in for a picture.
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const floats = (bin: Uint8Array, view: { byteOffset: number; byteLength: number }) => Array.from(new Float32Array(bin.buffer, bin.byteOffset + view.byteOffset, view.byteLength / 4), (v) => Math.round(v * 1e6) / 1e6 || 0);

describe('glb', () => {
  it('writes a valid container with one node, mesh and material per object, Y up and in meters', () => {
    const bytes = writeGlb([{ name: 'Tri', positions, normals, matrix: translation([0, 0, 0]), color: '#ffffff' }], 'Design');
    expect(bytes.length % 4).toBe(0);
    const { json, bin } = readGlb(bytes);
    expect(json.asset).toMatchObject({ version: '2.0' });
    expect(json.nodes).toHaveLength(1);
    expect(json.meshes).toHaveLength(1);
    expect(json.materials).toHaveLength(1);
    expect(json.textures).toBeUndefined();
    const views = json.bufferViews as { byteOffset: number; byteLength: number }[];
    const accessors = json.accessors as { bufferView: number; count: number; type: string; min?: number[]; max?: number[] }[];
    const pos = accessors[0];
    expect(pos.count).toBe(3);
    expect(pos.type).toBe('VEC3');
    // (10, 0, 5) mm becomes (0.01, 0.005, 0) m: Z up turned into Y up.
    expect(floats(bin, views[pos.bufferView])).toEqual([0, 0.005, 0, 0.01, 0.005, 0, 0, 0.005, -0.01]);
    expect(pos.max!.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.01, 0.005, 0]);
    const normal = accessors[1];
    expect(floats(bin, views[normal.bufferView]).slice(0, 3)).toEqual([0, 1, 0]);
    expect((json.materials as { pbrMetallicRoughness: { baseColorFactor: number[] } }[])[0].pbrMetallicRoughness.baseColorFactor).toEqual([1, 1, 1, 1]);
  });

  it('places the corners by the matrix and turns the normals with them', () => {
    // Turned 90° about Z and doubled: the triangle's +X edge becomes +Y, 20 mm long.
    const matrix = multiply(rotation([0, 0, 90]), scaling([2, 2, 2]));
    const { json, bin } = readGlb(writeGlb([{ name: 'T', positions, normals, matrix, color: '#000000' }], 'D'));
    const views = json.bufferViews as { byteOffset: number; byteLength: number }[];
    const p = floats(bin, views[0]);
    // The second corner (10, 0, 5) goes to (0, 20, 10) mm, which in glTF's frame is (0, 0.01, -0.02).
    expect(p[3]).toBeCloseTo(0, 9);
    expect(p[4]).toBeCloseTo(0.01, 9);
    expect(p[5]).toBeCloseTo(-0.02, 9);
    expect(floats(bin, views[1]).slice(0, 3)).toEqual([0, 1, 0]);
  });

  it('turns mirrored objects back outwards', () => {
    const matrix = scaling([-1, 1, 1]);
    const { json, bin } = readGlb(writeGlb([{ name: 'M', positions, normals, matrix, color: '#000000', skin: { uv: new Float32Array([0, 0, 1, 0, 0, 1]), image: png, mime: 'image/png', repeat: false } }], 'D'));
    const views = json.bufferViews as { byteOffset: number; byteLength: number }[];
    const p = floats(bin, views[0]);
    // Corners come out as 0, 2, 1 so the triangle still faces +Z (+Y in glTF) after the mirror.
    expect(p.slice(0, 3)).toEqual([0, 0.005, 0]);
    expect(p.slice(3, 6)).toEqual([0, 0.005, -0.01]);
    expect(p.slice(6, 9)).toEqual([-0.01, 0.005, 0]);
    // Their texture coordinates travel with them, with v turned over for glTF.
    const uv = floats(bin, views[2]);
    expect(uv).toEqual([0, 1, 0, 0, 1, 1]);
  });

  it('embeds the picture and points the material at it', () => {
    const { json, bin } = readGlb(writeGlb([{ name: 'P', positions, normals, matrix: translation([0, 0, 0]), color: '#ff0000', skin: { uv: new Float32Array(6), image: png, mime: 'image/png', repeat: true } }], 'D'));
    expect(json.images).toEqual([{ bufferView: 3, mimeType: 'image/png', name: 'P' }]);
    expect(json.samplers).toEqual([{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }]);
    const views = json.bufferViews as { byteOffset: number; byteLength: number }[];
    expect(Array.from(bin.subarray(views[3].byteOffset, views[3].byteOffset + views[3].byteLength))).toEqual(Array.from(png));
    expect(views[3].byteOffset % 4).toBe(0);
    const material = (json.materials as { pbrMetallicRoughness: { baseColorFactor: number[]; baseColorTexture: { index: number } } }[])[0];
    expect(material.pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0 });
    expect(material.pbrMetallicRoughness.baseColorFactor).toEqual([1, 1, 1, 1]);
    expect((json.meshes as { primitives: { attributes: Record<string, number> }[] }[])[0].primitives[0].attributes.TEXCOORD_0).toBe(2);
  });

  it('converts colors to linear', () => {
    expect(linearColor('#ffffff')).toEqual([1, 1, 1]);
    expect(linearColor('#000000')).toEqual([0, 0, 0]);
    expect(linearColor('#808080')[0]).toBeCloseTo(0.2158, 3);
  });
});
