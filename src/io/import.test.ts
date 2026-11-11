import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { MeshData, MeshWithUV } from '../geometry/mesh';
import type { Polygon } from '../model/types';
import { exportMesh, exportOutline } from './export';
import { writeGlb } from './glb';
import { write3mf } from './threemf';
import { scaling, translation } from '../model/math';
import { centerMesh, centerOutline, checkedMesh, checkedOutline, fileKind, guarded, IMPORT_EXTENSIONS, importFile } from './import';
import type { Companion, ImportedModel } from './import';
import type { OutlineShape } from '../model/types';
import { signedArea } from './outline';
import { ByteReader } from './scan';

const bytes = (s: string) => new TextEncoder().encode(s);

/** The one mesh a single-part model file holds. */
function mesh(name: string, data: Uint8Array | string): MeshWithUV {
  const result = importFile(name, typeof data === 'string' ? bytes(data) : data);
  if (result.kind !== 'model') throw new Error('expected a model');
  if (result.parts.length !== 1) throw new Error(`expected one part, got ${result.parts.length}`);
  return result.parts[0].mesh;
}

/** A model file with all its parts. */
function modelOf(name: string, data: Uint8Array | string, companions: Companion[] = []): ImportedModel {
  const result = importFile(name, typeof data === 'string' ? bytes(data) : data, companions);
  if (result.kind !== 'model') throw new Error('expected a model');
  return result;
}

/** All the shapes of a drawing, whatever their colors. */
function outlineOf(data: Uint8Array | string): { shapes: OutlineShape[] } {
  const result = importFile('drawing.svg', typeof data === 'string' ? bytes(data) : data);
  if (result.kind !== 'outline') throw new Error('expected an outline');
  return { shapes: result.parts.flatMap((p) => p.shapes) };
}

/** Volume enclosed by a closed mesh; positive when its triangles face outwards. */
function volume({ positions: p, triangles: t }: MeshData): number {
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

function meshBounds({ positions: p }: MeshData): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    min[i % 3] = Math.min(min[i % 3], p[i]);
    max[i % 3] = Math.max(max[i % 3], p[i]);
  }
  return { min, max };
}

/** Every edge of a closed, consistently wound mesh is used once in each direction. */
function isClosed({ triangles: t }: MeshData): boolean {
  const edges = new Map<string, number>();
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const key = `${t[i + k]}>${t[i + ((k + 1) % 3)]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of edges) {
    const [a, b] = key.split('>');
    if (count !== 1 || edges.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

// A tetrahedron with outward-facing triangles.
const tetra: MeshData = {
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
  triangles: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
};

/** The 12 outward-facing facets of a cube from 0 to `size`, nine coordinates each. */
function cubeFacets(size = 10): number[][] {
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? size : 0, i & 2 ? size : 0, i & 4 ? size : 0]);
  // Each face counter-clockwise seen from outside.
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  return quads.flatMap(([a, b, c, d]) => [
    [...corners[a], ...corners[b], ...corners[c]],
    [...corners[a], ...corners[c], ...corners[d]],
  ]);
}

function binaryStl(facets: number[][], header = 'binary', declared = facets.length): Uint8Array {
  const out = new Uint8Array(84 + facets.length * 50);
  out.set(bytes(header).subarray(0, 80));
  const view = new DataView(out.buffer);
  view.setUint32(80, declared, true);
  facets.forEach((facet, i) => facet.forEach((v, k) => view.setFloat32(84 + i * 50 + 12 + k * 4, v, true)));
  return out;
}

function asciiStl(facets: number[][], number = (v: number) => v.toExponential(6)): string {
  const lines = ['solid cube'];
  for (const f of facets) {
    lines.push('  facet normal 0 0 0', '    outer loop');
    for (let k = 0; k < 9; k += 3) lines.push(`      vertex ${number(f[k])} ${number(f[k + 1])} ${number(f[k + 2])}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push('endsolid cube', '');
  return lines.join('\n');
}

describe('importFile', () => {
  it('dispatches on the extension, whatever its case', () => {
    expect(IMPORT_EXTENSIONS).toEqual(['stl', 'obj', '3mf', 'glb', 'gltf', 'dae', 'svg', 'dxf']);
    expect(importFile('Part.STL', binaryStl(cubeFacets())).kind).toBe('model');
    expect(importFile('C:\\models\\my.part.Obj', bytes('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')).kind).toBe('model');
    expect(importFile('a.SVG', bytes('<svg><rect width="1" height="1"/></svg>')).kind).toBe('outline');
  });

  it('names the formats it can read when given another', () => {
    expect(() => importFile('part.step', new Uint8Array(4))).toThrow(/\.step files can't be imported.*STL, OBJ, 3MF, GLB, GLTF, DAE, SVG/);
    expect(() => importFile('README', new Uint8Array(4))).toThrow(/can't be imported/);
  });

  it('names the companions an OBJ wants that did not come along', () => {
    const obj = bytes('mtllib colors.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl red\nf 1 2 3\n');
    const alone = importFile('part.obj', obj);
    expect(alone.kind === 'model' && alone.missing).toEqual(['colors.mtl']);
    const mtl = { name: 'colors.mtl', bytes: bytes('newmtl red\nKd 1 0 0\nmap_Kd textures/skin.png\n') };
    const withLib = importFile('part.obj', obj, [mtl]);
    expect(withLib.kind === 'model' && withLib.missing).toEqual(['skin.png']);
    expect(withLib.kind === 'model' && withLib.used).toEqual(['colors.mtl']);
    expect(withLib.kind === 'model' && withLib.parts[0].color).toBe('#ff0000');
  });

  it('reads a file without an extension by what its bytes say (a document picked on Android)', () => {
    // A download picked through the Android picker: no name to go by, only the bytes.
    expect(importFile('msf:123', binaryStl(cubeFacets())).kind).toBe('model');
    expect(importFile('msf:123', bytes('solid a\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid a\n')).kind).toBe('model');
    const obj = importFile('msf:124', bytes('# made elsewhere\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'));
    expect(obj.kind).toBe('model');
    expect(obj.kind === 'model' && obj.parts[0].name).toBe('msf:124');
    expect(importFile('msf:125', bytes('<?xml version="1.0"?>\n<svg><rect width="1" height="1"/></svg>')).kind).toBe('outline');
    expect(fileKind('msf:126', bytes('  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n'))).toBe('dxf');
    expect(fileKind('msf:127', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe('png');
    expect(fileKind('msf:128', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('jpg');
    // A known extension wins over the bytes; an unknown one with unreadable bytes is still refused.
    expect(fileKind('part.stl', bytes('v 0 0 0\n'))).toBe('stl');
    expect(() => importFile('part.step', bytes('ISO-10303-21;'))).toThrow(/\.step files can't be imported/);
  });
});

describe('STL import', () => {
  it('reads binary files and welds the corners of a cube', () => {
    const m = mesh('cube.stl', binaryStl(cubeFacets()));
    expect(m.positions).toBeInstanceOf(Float32Array);
    expect(m.triangles).toBeInstanceOf(Uint32Array);
    expect(m.positions.length).toBe(8 * 3);
    expect(m.triangles.length).toBe(12 * 3);
    expect(volume(m)).toBeCloseTo(1000, 6);
    expect(isClosed(m)).toBe(true);
  });

  it('reads ASCII files', () => {
    const m = mesh('cube.stl', asciiStl(cubeFacets()));
    expect(m.positions.length).toBe(8 * 3);
    expect(m.triangles.length).toBe(12 * 3);
    expect(volume(m)).toBeCloseTo(1000, 6);
    expect(isClosed(m)).toBe(true);
  });

  it('reads ASCII files with a BOM, CRLF line ends, capitals and long decimals', () => {
    const text = asciiStl(cubeFacets(0.1), (v) => v.toFixed(20)).toUpperCase().replace(/\n/g, '\r\n');
    const m = mesh('cube.stl', new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(text)]));
    expect(m.positions.length).toBe(8 * 3);
    expect(m.triangles.length).toBe(12 * 3);
    // 0.1 has no short binary form: the slow path of the number reader must round it like the engine does.
    expect(Math.max(...m.positions)).toBe(Math.fround(0.1));
  });

  it('takes a binary file for binary even when its header starts with "solid"', () => {
    const m = mesh('cube.stl', binaryStl(cubeFacets(), 'solid facet made by a careless exporter'));
    expect(m.positions.length).toBe(8 * 3);
    expect(m.triangles.length).toBe(12 * 3);
  });

  it('accepts a binary file with trailing bytes', () => {
    const padded = new Uint8Array(84 + 12 * 50 + 7);
    padded.set(binaryStl(cubeFacets()));
    expect(mesh('cube.stl', padded).triangles.length).toBe(12 * 3);
  });

  it('drops degenerate triangles and the vertices only they used', () => {
    const facets = [...cubeFacets(), [0, 0, 0, 0, 0, 0, 50, 50, 50], [1, 2, 3, 1, 2, 3, 1, 2, 3]];
    const m = mesh('cube.stl', binaryStl(facets));
    expect(m.triangles.length).toBe(12 * 3);
    expect(m.positions.length).toBe(8 * 3);
    expect(meshBounds(m).max).toEqual([10, 10, 10]);
  });

  it('welds -0 with 0 and drops triangles with coordinates that are not finite', () => {
    const facets = cubeFacets().map((f) => f.map((v, i) => (v === 0 && i % 2 ? -0 : v)));
    facets.push([0, 0, 0, 1, 0, 0, 0, NaN, 0], [0, 0, 0, Infinity, 0, 0, 0, 1, 0]);
    const m = mesh('cube.stl', binaryStl(facets));
    expect(m.positions.length).toBe(8 * 3);
    expect(m.triangles.length).toBe(12 * 3);
  });

  it('keeps going after a damaged ASCII facet', () => {
    const text = asciiStl(cubeFacets(), String).replace('vertex 10 10 0', 'vertex 10 oops 0');
    const m = mesh('cube.stl', text);
    expect(m.triangles.length).toBe(11 * 3);
    expect(m.positions.length).toBe(8 * 3);
  });

  it('round-trips through the STL writer', () => {
    const m = mesh('tetra.stl', exportMesh('stl', tetra, 'tetra'));
    expect(m.positions.length).toBe(4 * 3);
    expect(m.triangles.length).toBe(4 * 3);
    expect(volume(m)).toBeCloseTo(volume(tetra), 6);
    expect(isClosed(m)).toBe(true);
    expect(meshBounds(m)).toEqual({ min: [0, 0, 0], max: [10, 10, 10] });
  });

  it('welds a large mesh', () => {
    // A sheet of n x n squares: enough vertices to grow every buffer and rehash the table several times.
    const n = 150;
    const facets: number[][] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const z = (x: number, y: number) => Math.sin(x * 0.1) * Math.cos(y * 0.1);
        const p = (x: number, y: number) => [x, y, z(x, y)];
        facets.push([...p(i, j), ...p(i + 1, j), ...p(i + 1, j + 1)], [...p(i, j), ...p(i + 1, j + 1), ...p(i, j + 1)]);
      }
    }
    const m = mesh('sheet.stl', binaryStl(facets));
    expect(m.triangles.length).toBe(n * n * 2 * 3);
    expect(m.positions.length).toBe((n + 1) * (n + 1) * 3);
    expect(m.triangles.reduce((a, b) => Math.max(a, b))).toBe((n + 1) * (n + 1) - 1);
    // Every triangle still spans the same three places.
    for (const i of [0, 1234, n * n * 2 - 1]) {
      const corners = [0, 1, 2].flatMap((k) => [...m.positions.subarray(m.triangles[i * 3 + k] * 3, m.triangles[i * 3 + k] * 3 + 3)]);
      expect(corners).toEqual(facets[i].map(Math.fround));
    }
  });

  it('explains what is wrong with empty, truncated and foreign files', () => {
    expect(() => mesh('a.stl', new Uint8Array(0))).toThrow('This STL file is empty.');
    const cube = binaryStl(cubeFacets());
    expect(() => mesh('a.stl', cube.subarray(0, 84 + 5 * 50 + 20))).toThrow(
      'This STL file is incomplete: it should hold 12 triangles but ends after 5.',
    );
    expect(() => mesh('a.stl', cube.subarray(0, 40))).toThrow('This is not an STL file, or it is incomplete.');
    expect(() => mesh('a.stl', binaryStl([], 'binary'))).toThrow('This STL file has no triangles.');
    expect(() => mesh('a.stl', 'solid nothing\nendsolid nothing\n')).toThrow(/not an STL file/);
    expect(() => mesh('a.stl', asciiStl([]) + 'facet\n')).toThrow('This STL file has no triangles.');
  });
});

describe('OBJ import', () => {
  const cubeVertices = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `v ${i & 1 ? 10 : 0} ${i & 2 ? 10 : 0} ${i & 4 ? 10 : 0}`);

  it('reads vertices and faces in every index form, triangulating polygons', () => {
    const text = [
      '# a cube, each face written differently',
      'mtllib cube.mtl',
      'o cube',
      ...cubeVertices,
      'vt 0 0',
      'vt 1 0',
      'vn 0 0 1',
      'vp 0.5 0.5',
      'g faces',
      'usemtl red',
      's off',
      'f 1 3 4 2',
      'f 5/1 6/2 8/1 7/2',
      'f 1/1/1 2/2/1 6/1/1 5/2/1',
      'f 3//1 7//1 8//1 4//1',
      'f -8 -4 -2 -6',
      'f 2 4 8',
      'f 2/1 8/1/1 6//1',
      'l 1 2',
      '',
    ].join('\n');
    const m = mesh('cube.obj', text);
    expect(m.positions.length).toBe(8 * 3);
    expect(m.triangles.length).toBe(12 * 3);
    expect(volume(m)).toBeCloseTo(1000, 6);
    expect(isClosed(m)).toBe(true);
    // The first quad became a fan around its first corner.
    expect([...m.triangles.subarray(0, 6)]).toEqual([0, 2, 3, 0, 3, 1]);
  });

  it('copes with CRLF, tabs, continued lines, vertex colors and scientific notation', () => {
    const text = 'v\t0 0 0 1.0\r\nv 1e1 0 0 0.5 0.5 0.5\r\nv 0 1.0E+1 0\r\nv 0 0 -.5e1\r\nf 1 3 \\\r\n 2\r\nf 1 2 4\r\nf 2 3 4\r\nf 1 4 3';
    const m = mesh('tetra.obj', text);
    expect([...m.positions]).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, -5]);
    expect([...m.triangles]).toEqual([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]);
  });

  it('welds repeated positions and drops what no face uses', () => {
    // Two triangles sharing an edge, every corner written out again, plus a stray vertex far away.
    const text = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 99 99 99\nf 1 2 3\nf 4 5 6\n';
    const m = mesh('quad.obj', text);
    expect(m.positions.length).toBe(4 * 3);
    expect([...m.triangles]).toEqual([0, 1, 2, 1, 3, 2]);
    expect(meshBounds(m).max).toEqual([1, 1, 0]);
  });

  it('skips faces that point at vertices which do not exist', () => {
    const m = mesh('a.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 2 9\nf 0 1 2\nf -9 1 2\nf 1 2\n');
    expect([...m.triangles]).toEqual([0, 1, 2]);
  });

  it('allows a face to come before its vertices', () => {
    const m = mesh('a.obj', 'f 1 2 3\nv 0 0 0\nv 1 0 0\nv 0 1 0\n');
    expect([...m.triangles]).toEqual([0, 1, 2]);
  });

  it('splits the file by material, with the color, picture and texture coordinates each brings', () => {
    const obj = ['mtllib stuff.mtl', 'v 0 0 0', 'v 10 0 0', 'v 0 10 0', 'v 0 0 10', 'vt 0 0', 'vt 1 0', 'vt 0 1', 'usemtl Red', 'f 1/1 2/2 3/3', 'usemtl Skin', 'f 1/1 2/2 4/3', 'f 2/2 3/3 4/1', 'usemtl Red', 'f 1/1 4/2 3/3', ''].join('\n');
    const mtl = ['newmtl Red', 'Kd 1 0 0', 'newmtl Skin', 'Kd 0.5 0.5 0.5', 'map_Kd -s 1 1 1 textures/skin.PNG', ''].join('\n');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const got = modelOf('thing.obj', obj, [
      { name: 'STUFF.mtl', bytes: bytes(mtl) },
      { name: 'skin.png', bytes: png },
      { name: 'other.png', bytes: png },
    ]);
    expect(got.parts.map((p) => [p.name, p.color, p.mesh.triangles.length / 3])).toEqual([
      ['Red', '#ff0000', 2],
      ['Skin', '#808080', 2],
    ]);
    expect(got.parts[1].image).toEqual({ name: 'skin.png', mime: 'image/png', bytes: png });
    expect(got.parts[0].image).toBeUndefined();
    expect([...got.parts[0].mesh.uv!]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(got.used.sort()).toEqual(['STUFF.mtl', 'skin.png']);
  });

  it('keeps a file with no material library whole, and without texture coordinates where it has none', () => {
    const got = modelOf('a.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl x\nf 1 2 3\nusemtl y\nf 1 3 2\n');
    expect(got.parts.map((p) => p.name)).toEqual(['x', 'y']);
    expect(got.parts.every((p) => p.color === undefined && p.mesh.uv === undefined)).toBe(true);
    expect(got.used).toEqual([]);
    expect(mesh('b.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1// 2// 3//\n').uv).toBeUndefined();
  });

  it('round-trips through the OBJ writer', () => {
    const m = mesh('tetra.obj', exportMesh('obj', tetra, 'tetra'));
    expect([...m.positions]).toEqual([...tetra.positions]);
    expect([...m.triangles]).toEqual([...tetra.triangles]);
  });

  it('explains what is wrong with files that hold no mesh', () => {
    expect(() => mesh('a.obj', new Uint8Array(0))).toThrow('This OBJ file is empty.');
    expect(() => mesh('a.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\n')).toThrow('This OBJ file has no faces.');
    expect(() => mesh('a.obj', 'v 0 0 0\nf 1 1 1\n')).toThrow('This OBJ file has no usable faces.');
  });

  it('skips a byte order mark', () => {
    const text = 'v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n';
    const plain = mesh('a.obj', text);
    const marked = mesh('a.obj', new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(text)]));
    expect(Array.from(marked.positions)).toEqual(Array.from(plain.positions));
    expect(Array.from(marked.triangles)).toEqual(Array.from(plain.triangles));
  });

  it('reads numbers written with hundreds of thousands of digits', () => {
    const third = '0.' + '3'.repeat(300_000);
    expect(new ByteReader(bytes(third)).number()).toBeCloseTo(1 / 3, 15);
    const m = mesh('a.obj', `v ${third} 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n`);
    expect(m.positions[0]).toBeCloseTo(1 / 3, 6);
  });

  it('cuts a face that is not convex into triangles that stay inside it', () => {
    // An L of area 3, its face listed from the corner next to the notch: a fan from there would spill over the notch.
    const m = mesh('l.obj', 'v 0 0 0\nv 2 0 0\nv 2 1 0\nv 1 1 0\nv 1 2 0\nv 0 2 0\nf 3 4 5 6 1 2\n');
    expect(m.triangles.length).toBe(4 * 3);
    const areas = flatAreas(m);
    expect(areas.every((a) => a > 0)).toBe(true);
    expect(areas.reduce((sum, a) => sum + a, 0)).toBeCloseTo(3, 6);
    // The same face seen from below keeps facing down, and one tilted out of every axis plane is cut as well.
    expect(flatAreas(mesh('l.obj', 'v 0 0 0\nv 2 0 0\nv 2 1 0\nv 1 1 0\nv 1 2 0\nv 0 2 0\nf 2 1 6 5 4 3\n')).every((a) => a < 0)).toBe(true);
    const tilted = mesh('l.obj', 'v 0 0 0\nv 2 0 2\nv 2 1 2\nv 1 1 1\nv 1 2 1\nv 0 2 0\nf 3 4 5 6 1 2\n');
    expect(flatAreas(tilted).every((a) => a > 0)).toBe(true);
    expect(flatAreas(tilted).reduce((sum, a) => sum + a, 0)).toBeCloseTo(3, 6);
    // A dart, whose only diagonal inside it is not the one from its first corner.
    const dart = flatAreas(mesh('d.obj', 'v 0 0 0\nv 1 1 0\nv 2 0 0\nv 1 3 0\nf 1 2 3 4\n'));
    expect(dart.every((a) => a > 0)).toBe(true);
    expect(dart.reduce((sum, a) => sum + a, 0)).toBeCloseTo(2, 6);
  });

  it('finds a material library and a picture whose names have spaces in them', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const obj = 'mtllib my model.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nusemtl red\nf 1/1 2/1 3/1\n';
    const got = modelOf('a.obj', obj, [
      { name: 'my model.mtl', bytes: bytes('newmtl red\nKd 1 0 0\nmap_Kd -s 1 1 1 my tex.png\n') },
      { name: 'my tex.png', bytes: png },
    ]);
    expect(got.parts[0].color).toBe('#ff0000');
    expect(got.parts[0].image?.name).toBe('my tex.png');
    expect(got.used.sort()).toEqual(['my model.mtl', 'my tex.png']);
    expect(got.missing).toEqual([]);
    // Several libraries on one line are still told apart, and a missing one is named whole.
    const two = modelOf('a.obj', 'mtllib a.mtl b.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl red\nf 1 2 3\n', [{ name: 'b.mtl', bytes: bytes('newmtl red\nKd 0 0 1\n') }]);
    expect(two.parts[0].color).toBe('#0000ff');
    expect(two.missing).toEqual(['a.mtl']);
    expect(modelOf('a.obj', obj).missing).toEqual(['my model.mtl']);
  });

  /** The signed area of each triangle of a mesh as seen from +Z. */
  function flatAreas({ positions: p, triangles: t }: MeshData): number[] {
    const out: number[] = [];
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
      out.push(((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1])) / 2);
    }
    return out;
  }
});

describe('a file that trips a reader up', () => {
  it('is reported as damaged, in words fit to show', () => {
    expect(() => guarded('OBJ', () => [].reduce((a) => a))).toThrow('This OBJ file is damaged or not supported.');
    expect(() => guarded('STL', () => new Float32Array(-1))).toThrow('This STL file is damaged or not supported.');
    // What a reader says itself is passed on as it is.
    expect(() => guarded('OBJ', () => { throw new Error('This OBJ file has no faces.'); })).toThrow('This OBJ file has no faces.');
    expect(guarded('OBJ', () => 7)).toBe(7);
  });
});

describe('coordinates that are not numbers', () => {
  it('are refused on the way in', () => {
    const good = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), triangles: new Uint32Array([0, 1, 2]) };
    expect(checkedMesh(good)).toBe(good);
    const bad = { positions: new Float32Array([0, 0, 0, NaN, 0, 0, 0, 1, 0]), triangles: new Uint32Array([0, 1, 2]) };
    expect(() => checkedMesh(bad)).toThrow(/not numbers/);
    const far = { positions: new Float32Array([0, 0, 0, Infinity, 0, 0, 0, 1, 0]), triangles: new Uint32Array([0, 1, 2]) };
    expect(() => checkedMesh(far)).toThrow(/not numbers/);
    expect(() => checkedOutline([{ contours: [[[0, 0], [1, NaN], [1, 1]]], evenodd: false }])).toThrow(/not numbers/);
  });

  it('are refused as corners of triangles, and made zero as texture coordinates', () => {
    const stray = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), triangles: new Uint32Array([0, 1, 3]) };
    expect(() => checkedMesh(stray)).toThrow(/damaged/);
    // A texture coordinate with a number missing.
    const m = mesh('a.obj', 'v 0 0 0\nv 10 0 0\nv 0 10 0\nvt 0.5\nvt 1 0\nf 1/1 2/2 3/2\n');
    expect([...m.uv!]).toEqual([0.5, 0, 1, 0, 1, 0]);
    // A glTF whose texture coordinates run out before its corners do.
    const floats = (values: number[]) => `data:application/octet-stream;base64,${btoa(String.fromCharCode(...new Uint8Array(new Float32Array(values).buffer)))}`;
    const gltf = {
      asset: { version: '2.0' },
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: 2, type: 'VEC2' }],
      bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 1, byteLength: 16 }],
      buffers: [{ byteLength: 36, uri: floats([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]) }, { byteLength: 16, uri: floats([0.25, 0.25, 0.75, 0.25]) }],
    };
    const g = mesh('a.gltf', JSON.stringify(gltf));
    expect(g.uv!.length).toBe(6);
    expect(Array.from(g.uv!).every(Number.isFinite)).toBe(true);
  });

  it('never reach the mesh a file reader returns', () => {
    // A vertex that is not finite takes its triangles with it; what is left is sound.
    const m = mesh('a.obj', 'v 0 0 0\nv 1e999 0 0\nv 0 10 0\nv 10 0 0\nf 1 2 3\nf 1 4 3\n');
    expect(m.triangles.length).toBe(3);
    expect(Array.from(m.positions).every(Number.isFinite)).toBe(true);
    expect(() => mesh('a.obj', 'v 0 0 0\nv 1e999 0 0\nv 0 10 0\nf 1 2 3\n')).toThrow('This OBJ file has no usable faces.');
  });
});

describe('3MF import', () => {
  const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  const TETRA = `<mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0" />
          <vertex z="0" y='1' x="0"/><vertex x="0" y="0" z="1e0"></vertex>
        </vertices>
        <triangles>
          <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3" pid="5" p1="0"/>
          <triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/>
        </triangles>
      </mesh>`;

  const model = (attrs: string, resources: string, build: string) => `<?xml version="1.0" encoding="UTF-8"?>
<model ${attrs} xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <!-- <object id="99"><mesh><vertices><vertex x="500" y="500" z="500"/></vertices></mesh></object> -->
  <metadata name="Title">test</metadata>
  <resources>${resources}</resources>
  <build>${build}</build>
</model>`;

  const pack = (files: Record<string, string>) =>
    zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));

  it('round-trips through the 3MF writer', () => {
    const m = mesh('tetra.3mf', write3mf([{ name: 'tetra', parts: [{ color: '#8fa3bf', mesh: tetra }] }], 'tetra'));
    expect([...m.positions]).toEqual([...tetra.positions]);
    expect([...m.triangles]).toEqual([...tetra.triangles]);
    // An object of several colored parts comes back as those parts, each in its color.
    const two = modelOf('two.3mf', write3mf([{ name: 'two', parts: [{ color: '#ff0000', mesh: tetra }, { color: '#00ff00', mesh: tetra }] }], 'two'));
    expect(two.parts.map((p) => [p.name, p.color, p.mesh.triangles.length])).toEqual([
      ['two', '#ff0000', tetra.triangles.length],
      ['two', '#00ff00', tetra.triangles.length],
    ]);
  });

  it('reads colors from base materials and color groups, splitting an object whose triangles differ', () => {
    const resources = `
      <basematerials id="1"><base name="Red" displaycolor="#FF0000"/><base name="Green" displaycolor="#00ff00ff"/></basematerials>
      <m:colorgroup id="2"><m:color color="#0000FF"/></m:colorgroup>
      <object id="10" type="model" name="Plain" pid="1" pindex="1">${TETRA}</object>
      <object id="11" type="model" name="Mixed" pid="1" pindex="0"><mesh>
        <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices>
        <triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3" p1="1"/><triangle v1="1" v2="2" v3="3" pid="2" p1="0"/><triangle v1="0" v2="3" v3="2"/></triangles>
      </mesh></object>
      <object id="12" type="model"><components><component objectid="10" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components></object>`;
    const file = pack({ '_rels/.rels': RELS, '3D/3dmodel.model': model('unit="millimeter"', resources, '<item objectid="11"/><item objectid="12"/>') });
    const got = importFile('colors.3mf', file);
    if (got.kind !== 'model') throw new Error('expected a model');
    expect(got.parts.map((p) => [p.name, p.color, p.mesh.triangles.length / 3])).toEqual([
      ['Mixed', '#ff0000', 2],
      ['Mixed', '#00ff00', 1],
      ['Mixed', '#0000ff', 1],
      ['colors', '#00ff00', 4],
    ]);
    // The component's transform moved the plain tetra along.
    expect(meshBounds(got.parts[3].mesh).min[0]).toBe(5);
  });

  it('converts the unit of the model to millimeters', () => {
    const file = (unit: string) =>
      pack({
        '_rels/.rels': RELS,
        '3D/3dmodel.model': model(unit, `<object id="1" type="model">${TETRA}</object>`, '<item objectid="1"/>'),
      });
    expect(meshBounds(mesh('a.3mf', file('unit="inch"'))).max).toEqual([25.4, 25.4, 25.4].map(Math.fround));
    expect(meshBounds(mesh('a.3mf', file('unit="micron"'))).max).toEqual([0.001, 0.001, 0.001].map(Math.fround));
    expect(meshBounds(mesh('a.3mf', file('unit="centimeter"'))).max).toEqual([10, 10, 10]);
    expect(meshBounds(mesh('a.3mf', file('unit="foot"'))).max).toEqual([304.8, 304.8, 304.8].map(Math.fround));
    expect(meshBounds(mesh('a.3mf', file('unit="meter"'))).max).toEqual([1000, 1000, 1000]);
    expect(meshBounds(mesh('a.3mf', file('unit="millimeter"'))).max).toEqual([1, 1, 1]);
    expect(meshBounds(mesh('a.3mf', file(''))).max).toEqual([1, 1, 1]);
    const inch = mesh('a.3mf', file('unit="inch"'));
    expect(inch.positions.length).toBe(4 * 3);
    expect(volume(inch)).toBeCloseTo(25.4 ** 3 / 6, 2);
  });

  it('places every build item, through components and transforms', () => {
    const resources = `
      <object id="1" type="model">${TETRA}</object>
      <object id="2" type="model">
        <components>
          <component objectid="1"/>
          <component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 5"/>
        </components>
      </object>`;
    // Item one is the tetrahedron doubled in size and moved to x = 10; item two is the pair, turned a quarter about Z.
    const build = `
      <item objectid="1" transform="2 0 0 0 2 0 0 0 2 10 0 0"/>
      <item objectid="2" transform="0 1 0 -1 0 0 0 0 1 0 0 0"/>`;
    // Each build item is a part of its own; a pair of components stays one part.
    const got = importFile('a.3mf', pack({ '_rels/.rels': RELS, '3D/3dmodel.model': model('unit="millimeter"', resources, build) }));
    if (got.kind !== 'model') throw new Error('expected a model');
    expect(got.parts.map((p) => p.mesh.triangles.length / 3)).toEqual([4, 8]);
    expect(got.parts.map((p) => p.mesh.positions.length / 3)).toEqual([4, 8]);
    expect(meshBounds(got.parts[0].mesh)).toEqual({ min: [10, 0, 0], max: [12, 2, 2] });
    expect(meshBounds(got.parts[1].mesh)).toEqual({ min: [-1, 0, 0], max: [0, 1, 6] });
    expect(volume(got.parts[0].mesh)).toBeCloseTo(8 / 6, 5);
    expect(volume(got.parts[1].mesh)).toBeCloseTo(1 / 6 + 1 / 6, 5);
  });

  it('turns the triangles of a mirrored item the right way out', () => {
    const resources = `<object id="1">${TETRA}</object>`;
    const build = '<item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/>';
    const m = mesh('a.3mf', pack({ '3D/3dmodel.model': model('', resources, build) }));
    expect(meshBounds(m).min).toEqual([-1, 0, 0]);
    expect(volume(m)).toBeCloseTo(1 / 6, 6);
  });

  it('follows components into other model parts (production extension)', () => {
    const root = model(
      'unit="millimeter"',
      '<object id="7"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 3 0 0"/></components></object>',
      '<item objectid="7" printable="1"/>',
    );
    const part = model('unit="millimeter"', `<object id="1">${TETRA}</object>`, '');
    const m = mesh('a.3mf', pack({ '_rels/.rels': RELS, '3D/3dmodel.model': root, '3D/Objects/object_1.model': part }));
    expect(m.triangles.length).toBe(4 * 3);
    expect(meshBounds(m)).toEqual({ min: [3, 0, 0], max: [4, 1, 1] });
  });

  it('finds the model without relationships, and the objects without a build section', () => {
    const m = mesh('a.3mf', pack({ '3D/Model.model': model('', `<object id="1">${TETRA}</object>`, '') }));
    expect(m.triangles.length).toBe(4 * 3);
  });

  it('skips triangles that point at vertices which do not exist', () => {
    const broken = TETRA.replace('<triangle v1="1" v2="2" v3="3"/>', '<triangle v1="1" v2="2" v3="30"/><triangle v1="1" v2="2"/>');
    const m = mesh('a.3mf', pack({ '3D/3dmodel.model': model('', `<object id="1">${broken}</object>`, '<item objectid="1"/>') }));
    expect(m.triangles.length).toBe(3 * 3);
  });

  it('reads a model whose elements are written under a namespace prefix', () => {
    const prefixed = model('unit="millimeter"', `<basematerials id="1"><base name="Red" displaycolor="#FF0000"/></basematerials><object id="1" pid="1" pindex="0">${TETRA}</object><object id="2"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components></object>`, '<item objectid="2"/>')
      .replace(/<(\/?)(model|resources|basematerials|base|object|mesh|vertices|vertex|triangles|triangle|components|component|build|item|metadata)\b/g, '<$1c:$2')
      .replace('xmlns=', 'xmlns:c=');
    expect(prefixed).toContain('<c:vertex x="0"');
    const got = modelOf('a.3mf', pack({ '_rels/.rels': RELS, '3D/3dmodel.model': prefixed }));
    expect(got.parts.map((p) => [p.color, p.mesh.triangles.length / 3])).toEqual([['#ff0000', 4]]);
    expect(meshBounds(got.parts[0].mesh)).toEqual({ min: [5, 0, 0], max: [6, 1, 1] });
  });

  it('takes the unit of another model part from that part', () => {
    // The root is in millimeters; the part it places 3 mm along X is drawn in inches.
    const root = model('unit="millimeter"', '<object id="7"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 3 0 0"/></components></object>', '<item objectid="7"/>');
    const part = model('unit="inch"', `<object id="1">${TETRA}</object>`, '');
    const m = mesh('a.3mf', pack({ '_rels/.rels': RELS, '3D/3dmodel.model': root, '3D/Objects/object_1.model': part }));
    expect(meshBounds(m)).toEqual({ min: [3, 0, 0], max: [28.4, 25.4, 25.4].map(Math.fround) });
  });

  it('explains what is wrong with files that hold no mesh', () => {
    expect(() => mesh('a.3mf', new Uint8Array(0))).toThrow('This 3MF file is empty.');
    expect(() => mesh('a.3mf', bytes('this is not a zip archive at all'))).toThrow(
      'This 3MF file is damaged, or is not a 3MF file.',
    );
    expect(() => mesh('a.3mf', pack({ 'readme.txt': 'hello' }))).toThrow('This 3MF file has no 3D model in it.');
    expect(() => mesh('a.3mf', pack({ '3D/3dmodel.model': model('', '', '') }))).toThrow('This 3MF file has no meshes.');
  });

  it('takes a unit it does not know, even one named like an object method, as millimeters', () => {
    const file = (unit: string) => pack({ '3D/3dmodel.model': model(unit, `<object id="1">${TETRA}</object>`, '<item objectid="1"/>') });
    expect(meshBounds(mesh('a.3mf', file('unit="toString"'))).max).toEqual([1, 1, 1]);
    expect(meshBounds(mesh('a.3mf', file('unit="constructor"'))).max).toEqual([1, 1, 1]);
    expect(meshBounds(mesh('a.3mf', file('unit="furlong"'))).max).toEqual([1, 1, 1]);
  });

  it(
    'gives up on a small file whose components multiply into a model that would never fit',
    () => {
      // Object 1 is a tetrahedron; each object above it holds ten copies of the one below.
      const fanOut = (id: number) => Array.from({ length: 10 }, () => `<component objectid="${id - 1}"/>`).join('');
      let resources = `<object id="1">${TETRA}</object>`;
      for (let id = 2; id <= 13; id++) resources += `<object id="${id}"><components>${fanOut(id)}</components></object>`;
      const bomb = pack({ '3D/3dmodel.model': model('', resources, '<item objectid="13"/>') });
      expect(bomb.length).toBeLessThan(4096);
      expect(() => mesh('a.3mf', bomb)).toThrow(/too many/);
    },
    10_000,
  );

  it('refuses an archive whose model parts unpack to more than it will hold', () => {
    // The central directory says the part is enormous; it is never inflated.
    const archive = pack({ '3D/3dmodel.model': model('', `<object id="1">${TETRA}</object>`, '<item objectid="1"/>') });
    // Patch the uncompressed size fields (local header at 22, central directory at 24 past its signature).
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const central = findSignature(archive, 0x02014b50);
    view.setUint32(central + 24, 0xffffff00, true);
    expect(() => mesh('a.3mf', archive)).toThrow('This 3MF file is too large to open.');
  });

  function findSignature(bytes: Uint8Array, signature: number): number {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i + 4 <= bytes.length; i++) if (view.getUint32(i, true) === signature) return i;
    throw new Error('signature not found');
  }
});

describe('glTF import', () => {
  // One triangle in the XY plane facing +Z at z = 5 mm, as the writer's tests use.
  const positions = new Float32Array([0, 0, 5, 10, 0, 5, 0, 10, 5]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it('round-trips through the GLB writer: millimeters, Z up, colors, pictures and texture coordinates', () => {
    const objects = [
      { name: 'Tri', positions, normals, matrix: translation([0, 0, 0]), color: '#d8605a' },
      { name: 'Sheet', positions, normals, matrix: translation([20, 0, 0]), color: '#ffffff', skin: { uv: new Float32Array([0, 0, 1, 0, 0, 1]), image: png, mime: 'image/png' as const, repeat: false } },
    ];
    const got = modelOf('scene.glb', writeGlb(objects, 'scene'));
    expect(got.parts.map((p) => [p.name, p.color])).toEqual([
      ['Tri', '#d8605a'],
      ['Sheet', undefined],
    ]);
    expect([...got.parts[0].mesh.positions]).toEqual([0, 0, 5, 10, 0, 5, 0, 10, 5]);
    expect([...got.parts[0].mesh.triangles]).toEqual([0, 1, 2]);
    expect(got.parts[0].mesh.uv).toBeUndefined();
    expect(meshBounds(got.parts[1].mesh).min[0]).toBeCloseTo(20, 4);
    expect([...got.parts[1].mesh.uv!]).toEqual([0, 0, 1, 0, 0, 1]);
    expect(got.parts[1].image).toEqual({ name: 'Sheet', mime: 'image/png', bytes: png });
  });

  it('places meshes by their nodes, turns a mirrored one the right way out, and names the parts of a mesh', () => {
    const mirrored = modelOf('m.glb', writeGlb([{ name: 'M', positions, normals, matrix: scaling([-1, 1, 1]), color: '#000000' }], 'D'));
    expect(volumeSign(mirrored.parts[0].mesh)).toBeGreaterThan(0);
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Root', translation: [0, 0, 0], scale: [2, 2, 2], children: [1] }, { name: 'Leaf', mesh: 0, translation: [0, 0.001, 0], rotation: [0, 0, 0, 1] }],
      meshes: [{ name: 'Mesh', primitives: [{ attributes: { POSITION: 0 }, material: 0 }, { attributes: { POSITION: 0 }, material: 1, mode: 4 }] }],
      materials: [{ name: 'Lin', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }, { pbrMetallicRoughness: { baseColorFactor: [0.2158605, 0.2158605, 0.2158605, 1] } }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...new Uint8Array(new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0, -0.01]).buffer)))}` }],
    };
    const got = modelOf('t.gltf', JSON.stringify(gltf));
    expect(got.parts.map((p) => [p.name, p.color])).toEqual([
      ['Leaf (Lin)', '#ff0000'],
      ['Leaf (2)', '#808080'],
    ]);
    // The leaf sits 1 mm up in glTF's Y, scaled twice by its parent: 2 mm up in Z here; its corner at -0.01 along glTF's Z lands at +20 in Y.
    expect(meshBounds(got.parts[0].mesh)).toEqual({ min: [0, 0, 2], max: [20, 20, 2] });
  });

  it('rejects what it cannot read', () => {
    expect(() => modelOf('x.glb', new Uint8Array(0))).toThrow('empty');
    expect(() => modelOf('x.gltf', '{"asset":{"version":"2.0"},"buffers":[{"byteLength":4,"uri":"data.bin"}],"meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}],"accessors":[{"bufferView":0,"componentType":5126,"count":1,"type":"VEC3"}],"bufferViews":[{"buffer":0,"byteLength":12}]}')).toThrow(/separate files/);
    expect(() => modelOf('x.gltf', 'nope')).toThrow(/JSON/);
    expect(() => modelOf('x.gltf', '{"asset":{"version":"2.0"},"extensionsRequired":["KHR_draco_mesh_compression"],"meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}]}')).toThrow(/compressed/);
    expect(() => modelOf('x.gltf', '{"asset":{"version":"2.0"}}')).toThrow(/no meshes/);
  });

  it('says what is wrong with a damaged file, rather than falling over it', () => {
    const file = (rest: object) => JSON.stringify({ asset: { version: '2.0' }, ...rest });
    const triangle = `data:application/octet-stream;base64,${btoa(String.fromCharCode(...new Uint8Array(new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]).buffer)))}`;
    const withAccessor = (accessor: object) => file({ meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [accessor], bufferViews: [{ buffer: 0, byteLength: 36 }], buffers: [{ byteLength: 36, uri: triangle }] });
    // The file reads when nothing is wrong with it.
    expect(mesh('x.gltf', withAccessor({ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' })).triangles.length).toBe(3);
    expect(() => modelOf('x.gltf', file({ nodes: [{ mesh: 0 }], meshes: [{}] }))).toThrow(/damaged/);
    expect(() => modelOf('x.gltf', file({ nodes: [{ mesh: 0 }], meshes: [{ primitives: [{}] }] }))).toThrow(/damaged/);
    expect(() => modelOf('x.gltf', file({ nodes: 7, meshes: 'none' }))).toThrow(/damaged/);
    expect(() => modelOf('x.gltf', file({ nodes: [{ mesh: 0, scale: { length: 3 } }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] }))).toThrow(/damaged/);
    expect(() => modelOf('x.gltf', file({ buffers: [{ byteLength: 3, uri: 'data:application/octet-stream;base64,@@@@' }] }))).toThrow(/damaged/);
    // More corners than could be there, with or without the bytes to read them from.
    expect(() => modelOf('x.gltf', withAccessor({ bufferView: 0, componentType: 5126, count: 4e9, type: 'VEC3' }))).toThrow(/damaged/);
    expect(() => modelOf('x.gltf', withAccessor({ componentType: 5126, count: 4e9, type: 'VEC3' }))).toThrow(/damaged/);
    expect(() => modelOf('x.gltf', withAccessor({ bufferView: 0, componentType: 5126, count: 3, type: 'toString' }))).toThrow(/damaged/);
    // Corners kept as a few changes to a list of zeros are not read as zeros.
    expect(() => modelOf('x.gltf', withAccessor({ componentType: 5126, count: 3, type: 'VEC3', sparse: { count: 1, indices: { bufferView: 0, componentType: 5123 }, values: { bufferView: 0 } } }))).toThrow(/sparse/);
    expect(() => modelOf('x.gltf', 'null')).toThrow(/not a glTF/);
  });

  /** Sign of the volume a closed mesh (or here, the orientation of one triangle against +Z) encloses. */
  function volumeSign(m: MeshData): number {
    const { positions: p, triangles: t } = m;
    const [a, b, c] = [t[0] * 3, t[1] * 3, t[2] * 3];
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    return ux * vy - uy * vx;
  }
});

describe('DXF import', () => {
  /** A drawing: header variables, blocks and entities given as (code, value) pairs, one per line. */
  const dxf = (entities: string, { header = '', blocks = '', layers = '' } = {}) =>
    [
      '0\nSECTION\n2\nHEADER',
      header,
      '0\nENDSEC',
      '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER',
      layers,
      '0\nENDTAB\n0\nENDSEC',
      '0\nSECTION\n2\nBLOCKS',
      blocks,
      '0\nENDSEC',
      '0\nSECTION\n2\nENTITIES',
      entities,
      '0\nENDSEC\n0\nEOF\n',
    ]
      .filter(Boolean)
      .join('\n');
  const line = (x0: number, y0: number, x1: number, y1: number, extra = '') => `0\nLINE\n8\n0${extra}\n10\n${x0}\n20\n${y0}\n11\n${x1}\n21\n${y1}`;
  /** Four lines of a square, in no particular order or direction. */
  const square = (x: number, y: number, size: number, extra = '') =>
    [line(x + size, y, x + size, y + size, extra), line(x, y, x + size, y, extra), line(x, y + size, x, y, extra), line(x, y + size, x + size, y + size, extra)].join('\n');
  it('says what a drawing holds that it leaves out', () => {
    const text = (x: number) => `0\nTEXT\n8\n0\n10\n${x}\n20\n0\n40\n3\n1\nPart`;
    // A square, a center line that meets nothing, a corner of two lines that never closes, and two labels.
    const got = importFile('d.dxf', bytes(dxf([square(0, 0, 10), line(-5, 5, 15, 5), line(30, 0, 40, 0), line(40, 0, 40, 10), text(0), `0\nMTEXT\n8\n0\n10\n20\n20\n0\n1\nNote`].join('\n'))));
    if (got.kind !== 'outline') throw new Error('expected an outline');
    expect(got.parts).toHaveLength(1);
    expect(got.warnings).toEqual(['2 outlines do not close and were left out.', '2 pieces of text were left out.']);
    const plain = importFile('d.dxf', bytes(dxf(square(0, 0, 10))));
    expect('warnings' in plain).toBe(false);
  });

  const partsOf = (text: string | Uint8Array) => {
    const got = importFile('d.dxf', typeof text === 'string' ? bytes(text) : text);
    if (got.kind !== 'outline') throw new Error('expected an outline');
    return got.parts;
  };
  const contoursOf = (text: string | Uint8Array): Polygon[] => {
    const parts = partsOf(text);
    expect(parts.length).toBe(1);
    expect(parts[0].shapes.length).toBe(1);
    return parts[0].shapes[0].contours;
  };
  const area = (contours: Polygon[]) => contours.reduce((sum, c) => sum + Math.abs(signedArea(c)), 0);

  it('chains lines into a closed contour, in millimeters by default', () => {
    const [contour] = contoursOf(dxf(square(5, 5, 10)));
    expect(contour.length).toBe(4);
    expect(Math.abs(signedArea(contour))).toBeCloseTo(100, 6);
    expect(contour.every(([x, y]) => x >= 5 && x <= 15 && y >= 5 && y <= 15)).toBe(true);
  });

  it('scales by $INSUNITS', () => {
    const [contour] = contoursOf(dxf(square(0, 0, 1), { header: '9\n$INSUNITS\n70\n1' }));
    expect(Math.abs(signedArea(contour))).toBeCloseTo(25.4 * 25.4, 6);
  });

  it('reads polylines with bulged sides and circles, nesting one inside another as a hole', () => {
    // A 20 x 10 rectangle whose right side bows out as a half circle, with a circle of radius 2 inside.
    const poly = '0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\n0\n20\n0\n42\n0\n10\n20\n20\n0\n42\n1\n10\n20\n20\n10\n42\n0\n10\n0\n20\n10\n42\n0';
    const circle = '0\nCIRCLE\n8\n0\n10\n10\n20\n5\n40\n2';
    const contours = contoursOf(dxf(`${poly}\n${circle}`));
    expect(contours.length).toBe(2);
    const outer = contours.find((c) => Math.abs(signedArea(c)) > 100)!;
    expect(Math.abs(signedArea(outer))).toBeCloseTo(200 + (Math.PI * 25) / 2, 0);
    // The bulge bows outwards, to x = 25.
    expect(Math.max(...outer.map((p) => p[0]))).toBeCloseTo(25, 1);
    const inner = contours.find((c) => c !== outer)!;
    // A small circle gets the fewest segments allowed, 24, which clip a little of its area.
    expect(Math.abs(signedArea(inner))).toBeCloseTo(Math.PI * 4, 0);
    expect(inner.length).toBe(24);
  });

  it('closes an arc with the line across its ends, and drops a lone line', () => {
    const arc = '0\nARC\n8\n0\n10\n0\n20\n0\n40\n10\n50\n0\n51\n180';
    const contours = contoursOf(dxf(`${arc}\n${line(-10, 0, 10, 0)}\n${line(50, 50, 60, 60)}`));
    expect(contours.length).toBe(1);
    expect(Math.abs(signedArea(contours[0]))).toBeCloseTo((Math.PI * 100) / 2, 0);
  });

  it('reads an ellipse and a spline', () => {
    const ellipse = '0\nELLIPSE\n8\n0\n10\n0\n20\n0\n11\n10\n21\n0\n40\n0.5';
    expect(area(contoursOf(dxf(ellipse)))).toBeCloseTo(Math.PI * 10 * 5, 0);
    // A cubic Bézier as a spline, closed by a line along its chord.
    const spline = '0\nSPLINE\n8\n0\n70\n8\n71\n3\n72\n8\n73\n4\n40\n0\n40\n0\n40\n0\n40\n0\n40\n1\n40\n1\n40\n1\n40\n1\n10\n0\n20\n0\n10\n0\n20\n10\n10\n10\n20\n10\n10\n10\n20\n0';
    const [contour] = contoursOf(dxf(`${spline}\n${line(10, 0, 0, 0)}`));
    expect(Math.max(...contour.map((p) => p[1]))).toBeCloseTo(7.5, 2);
    expect(Math.abs(signedArea(contour))).toBeCloseTo(60, 0);
  });

  it('places blocks where INSERT puts them, scaled, turned and repeated', () => {
    const blocks = '0\nBLOCK\n8\n0\n2\nUNIT\n10\n0\n20\n0\n' + square(0, 0, 1) + '\n0\nENDBLK';
    const insert = '0\nINSERT\n8\n0\n2\nUNIT\n10\n100\n20\n0\n41\n10\n42\n5\n50\n90\n70\n2\n44\n2';
    const contours = contoursOf(dxf(insert, { blocks }));
    expect(contours.length).toBe(2);
    // Turned a quarter turn: the 10 x 5 block stands 5 wide and 10 tall, from x = 95 to 100.
    const xs = contours[0].map((p) => p[0]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([95, 100]);
    expect(area(contours)).toBeCloseTo(100, 6);
    // The second column sits two units further along the block's X, which points up.
    const ys = contours.map((c) => Math.min(...c.map((p) => p[1]))).sort((a, b) => a - b);
    expect(ys).toEqual([0, 2]);
  });

  it('groups by color: the entity, its layer, a true color, with 7 as no color', () => {
    const layers = '0\nLAYER\n2\nCUT\n70\n0\n62\n5\n0\nLAYER\n2\nPLAIN\n70\n0\n62\n7';
    const parts = partsOf(dxf([square(0, 0, 1, '\n62\n1'), square(5, 0, 1).replace(/8\n0/g, '8\nCUT'), square(10, 0, 1, '\n420\n65280'), square(15, 0, 1).replace(/8\n0/g, '8\nPLAIN')].join('\n'), { layers }));
    expect(parts.map((p) => [p.color, p.shapes[0].contours.length])).toEqual([
      ['#ff0000', 1],
      ['#0000ff', 1],
      ['#00ff00', 1],
      [undefined, 1],
    ]);
  });

  it('reads back what the DXF export writes', () => {
    const outline: Polygon[] = [
      [[0, 0], [30, 0], [30, 20], [0, 20]],
      [[10, 5], [20, 5], [20, 15], [10, 15]],
    ];
    const contours = contoursOf(exportOutline('dxf', outline, 'Plate'));
    expect(contours.length).toBe(2);
    expect(area(contours)).toBeCloseTo(600 + 100, 6);
  });

  it('refuses what is not a drawing, or has nothing closed', () => {
    expect(() => importFile('d.dxf', bytes('hello'))).toThrow(/not a DXF/);
    expect(() => importFile('d.dxf', bytes(dxf(line(0, 0, 10, 10))))).toThrow(/no closed outlines/);
    expect(IMPORT_EXTENSIONS).toContain('dxf');
  });

  it('gives a bulge to the vertex it is written after, when only the bulged vertices carry one', () => {
    // A slot 20 long with half-circle ends of radius 5, as AutoCAD writes it: no bulge on the straight sides.
    const slot = '0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\n0\n20\n0\n10\n20\n20\n0\n42\n1\n10\n20\n20\n10\n10\n0\n20\n10\n42\n1';
    const [contour] = contoursOf(dxf(slot));
    expect(Math.abs(signedArea(contour))).toBeCloseTo(200 + Math.PI * 25, 0);
    const xs = contour.map((p) => p[0]);
    const ys = contour.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(-5, 1);
    expect(Math.max(...xs)).toBeCloseTo(25, 1);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([0, 10]);
  });

  it('gives up on a small file whose blocks multiply into a drawing that would never fit', () => {
    const unit = '0\nBLOCK\n2\nB0\n10\n0\n20\n0\n' + line(0, 0, 1, 0) + '\n0\nENDBLK';
    // An array of a thousand million copies.
    const array = '0\nINSERT\n8\n0\n2\nB0\n10\n0\n20\n0\n70\n30000\n71\n30000\n44\n2\n45\n2';
    expect(() => partsOf(dxf(array, { blocks: unit }))).toThrow(/too many/);
    // The same of a block with nothing in it.
    expect(() => partsOf(dxf(array, { blocks: '0\nBLOCK\n2\nB0\n10\n0\n20\n0\n0\nENDBLK' }))).toThrow(/too many/);
    // Eight blocks, each holding forty of the one before.
    let blocks = unit;
    for (let i = 1; i <= 8; i++) blocks += `\n0\nBLOCK\n2\nB${i}\n10\n0\n20\n0\n0\nINSERT\n8\n0\n2\nB${i - 1}\n10\n0\n20\n0\n70\n40\n44\n2\n0\nENDBLK`;
    const text = dxf('0\nINSERT\n8\n0\n2\nB8\n10\n0\n20\n0', { blocks });
    expect(text.length).toBeLessThan(4096);
    expect(() => partsOf(text)).toThrow(/too many/);
  });

  it('reads an arc or an ellipse whose angles are far out of range without hanging', () => {
    // Angles of 1e30 degrees say nothing about where the arc is; it still ends, as some arc of this circle.
    const arc = '0\nARC\n8\n0\n10\n0\n20\n0\n40\n10\n50\n1e30\n51\n0';
    const closing = '0\nCIRCLE\n8\n0\n10\n50\n20\n0\n40\n2';
    expect(contoursOf(dxf(`${arc}\n${closing}`)).length).toBe(1);
    const ellipse = '0\nELLIPSE\n8\n0\n10\n0\n20\n0\n11\n10\n21\n0\n40\n0.5\n41\n1e300\n42\n-1e300';
    expect(contoursOf(dxf(`${ellipse}\n${closing}`)).length).toBe(1);
    // Two turns are one circle, drawn once.
    const twice = '0\nARC\n8\n0\n10\n0\n20\n0\n40\n10\n50\n0\n51\n720';
    const [circle] = contoursOf(dxf(twice));
    expect(Math.abs(signedArea(circle))).toBeCloseTo(Math.PI * 100, -1);
    // An ellipse closed a hair past a whole turn is still whole.
    const whole = '0\nELLIPSE\n8\n0\n10\n0\n20\n0\n11\n10\n21\n0\n40\n0.5\n41\n0\n42\n6.2831853072';
    expect(area(contoursOf(dxf(whole)))).toBeCloseTo(Math.PI * 10 * 5, 0);
  });

  it('chains tens of thousands of loose lines in good time', () => {
    // One loop of 40,000 segments, each a line of its own, in no order.
    const n = 40_000;
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * 2 * Math.PI;
      const a1 = (((i + 1) % n) / n) * 2 * Math.PI;
      lines.push(line(1000 * Math.cos(a0), 1000 * Math.sin(a0), 1000 * Math.cos(a1), 1000 * Math.sin(a1)));
    }
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = lines.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [lines[i], lines[j]] = [lines[j], lines[i]];
    }
    const text = bytes(dxf(lines.join('\n')));
    const started = performance.now();
    const [contour] = contoursOf(text);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(contour.length).toBe(n);
    expect(Math.abs(signedArea(contour))).toBeCloseTo(Math.PI * 1e6, -1);
  });

  it('leaves out what is drawn in paper space', () => {
    const contours = contoursOf(dxf(`${square(0, 0, 10)}\n${square(100, 100, 200, '\n67\n1')}`));
    expect(contours.length).toBe(1);
    expect(area(contours)).toBeCloseTo(100, 6);
  });

  it('mirrors an entity whose extrusion points down', () => {
    const down = '\n210\n0\n220\n0\n230\n-1';
    // A circle whose center is written at x = -10 stands at x = +10.
    const [circle] = contoursOf(dxf(`0\nCIRCLE\n8\n0\n10\n-10\n20\n0\n40\n2${down}`));
    const xs = circle.map((p) => p[0]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([8, 12]);
    // A quarter arc about that center, from 0° to 90° as written, runs from (5, 0) up to (10, 5); a line closes it.
    const [quarter] = contoursOf(dxf(`0\nARC\n8\n0\n10\n-10\n20\n0\n40\n5\n50\n0\n51\n90${down}\n${line(5, 0, 10, 5)}`));
    expect(Math.abs(signedArea(quarter))).toBeCloseTo((Math.PI * 25) / 4 - 12.5, 0);
    expect(quarter.every(([x, y]) => x > 4.99 && x < 10.01 && y > -0.01 && y < 5.01)).toBe(true);
    // A polyline keeps its bulge on the mirrored side: a half disc bowing down, written bowing up.
    const [half] = contoursOf(dxf(`0\nLWPOLYLINE\n8\n0\n90\n2\n70\n1\n10\n0\n20\n0\n42\n1\n10\n10\n20\n0${down}`));
    expect(Math.abs(signedArea(half))).toBeCloseTo((Math.PI * 25) / 2, 0);
    expect(Math.min(...half.map((p) => p[0]))).toBeCloseTo(-10, 6);
    expect(Math.min(...half.map((p) => p[1]))).toBeCloseTo(-5, 1);
    // An ellipse is written where it stands, and gone round the other way: a quarter of it from (10, 0) down to (0, -5).
    const [ellipse] = contoursOf(dxf(`0\nELLIPSE\n8\n0\n10\n0\n20\n0\n11\n10\n21\n0\n40\n0.5\n41\n0\n42\n${Math.PI / 2}${down}\n${line(0, -5, 0, 0)}\n${line(0, 0, 10, 0)}`));
    expect(Math.abs(signedArea(ellipse))).toBeCloseTo((Math.PI * 50) / 4, 0);
    expect(ellipse.every(([x, y]) => x > -0.01 && x < 10.01 && y > -5.01 && y < 0.01)).toBe(true);
    // A block placed that way is mirrored about the drawing's origin.
    const blocks = '0\nBLOCK\n8\n0\n2\nUNIT\n10\n0\n20\n0\n' + square(0, 0, 1) + '\n0\nENDBLK';
    const [placed] = contoursOf(dxf(`0\nINSERT\n8\n0\n2\nUNIT\n10\n-10\n20\n0${down}`, { blocks }));
    const px = placed.map((p) => p[0]);
    expect([Math.min(...px), Math.max(...px)]).toEqual([9, 10]);
  });

  it('says that a binary DXF has to be saved as text', () => {
    const binary = new Uint8Array(64);
    binary.set(bytes('AutoCAD Binary DXF\r\n\x1a\0'));
    expect(() => importFile('d.dxf', binary)).toThrow(/Binary DXF/);
  });

  it('knows the very small and very large units of $INSUNITS', () => {
    /** The side in millimeters of a square `size` units wide. */
    const side = (unit: number, size: number) => Math.sqrt(area(contoursOf(dxf(square(0, 0, size), { header: `9\n$INSUNITS\n70\n${unit}` }))));
    // Ångströms, gigameters, astronomical units, light years and parsecs.
    expect(side(11, 1e8)).toBeCloseTo(10, 6);
    expect(side(17, 1e-11)).toBeCloseTo(10, 6);
    expect(side(18, 1e-13)).toBeCloseTo(14.95978707, 6);
    expect(side(19, 1e-18)).toBeCloseTo(9.4607304725808, 6);
    expect(side(20, 1e-18)).toBeCloseTo(30.856775814913673, 6);
  });
});

describe('SVG import', () => {
  /** A drawing whose user unit is 1 mm. */
  const mm = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">${body}</svg>`;

  const shapesOf = (svg: string) => outlineOf(svg).shapes;

  it('says what a drawing holds that it leaves out', () => {
    const got = importFile(
      'd.svg',
      bytes(
        mm(
          '<defs><style>.a{fill:#f00}</style><rect id="r" width="5" height="5"/><text>not counted: nothing in here is drawn</text></defs>' +
            '<rect class="a" width="10" height="10"/><use href="#r" x="20"/><use href="#r" x="30"/>' +
            '<text x="5" y="50">Label <tspan>one</tspan></text><image href="photo.png" width="10" height="10"/>' +
            '<g display="none"><use href="#r"/><text>hidden</text></g>',
        ),
      ),
    );
    if (got.kind !== 'outline') throw new Error('expected an outline');
    expect(got.parts).toHaveLength(1);
    expect(got.warnings).toEqual([
      '2 copies of other shapes (<use>) were left out.',
      '1 piece of text was left out. Turn text into paths in the drawing program.',
      '1 picture was left out.',
      'Its style sheet was not read: colors and hidden shapes set there are not applied.',
    ]);
    // A drawing of plain shapes has nothing to say.
    const plain = importFile('d.svg', bytes(mm('<rect width="10" height="10"/>')));
    expect('warnings' in plain).toBe(false);
  });

  it('groups shapes by fill color, inherited and in any CSS form', () => {
    const got = importFile('d.svg', bytes(mm('<g fill="#F00"><rect width="10" height="10"/><rect x="20" width="10" height="10" style="fill: rgb(0, 0, 255)"/></g><circle cx="50" cy="50" r="5" fill="none"/><rect x="40" width="4" height="4" fill="GOLD"/><rect x="60" width="4" height="4" fill="#ff0000"/>')));
    if (got.kind !== 'outline') throw new Error('expected an outline');
    expect(got.parts.map((p) => [p.color, p.shapes.length])).toEqual([
      ['#ff0000', 2],
      ['#0000ff', 1],
      [undefined, 1],
      ['#ffd700', 1],
    ]);
  });
  /** The contours of a drawing that should hold exactly one shape. */
  const contoursOf = (svg: string): Polygon[] => {
    const shapes = shapesOf(svg);
    expect(shapes.length).toBe(1);
    return shapes[0].contours;
  };
  /** The only contour of a drawing whose user unit is 1 mm. */
  const contourOf = (body: string): Polygon => {
    const contours = contoursOf(mm(body));
    expect(contours.length).toBe(1);
    return contours[0];
  };

  const box = (contour: Polygon) => {
    const xs = contour.map((p) => p[0]);
    const ys = contour.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const expectBox = (contour: Polygon, expected: number[], digits = 9) => {
    box(contour).forEach((v, i) => expect(v).toBeCloseTo(expected[i], digits));
  };
  const area = (contour: Polygon) => Math.abs(signedArea(contour));
  /** Flattening cuts corners, so areas come out a little under (or over, for concave curves) the true value. */
  const expectArea = (contour: Polygon, expected: number, relative = 0.005) => {
    expect(Math.abs(area(contour) - expected) / expected).toBeLessThan(relative);
  };
  const expectPoints = (contour: Polygon, expected: number[][]) => {
    expect(contour.length).toBe(expected.length);
    contour.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(expected[i][0], 9);
      expect(p[1]).toBeCloseTo(expected[i][1], 9);
    });
  };
  /** Furthest any edge midpoint of the contour lies inside a circle of radius `r` about (cx, cy). */
  const sagitta = (contour: Polygon, cx: number, cy: number, r: number) =>
    Math.max(
      ...contour.map((p, i) => {
        const q = contour[(i + 1) % contour.length];
        return r - Math.hypot((p[0] + q[0]) / 2 - cx, (p[1] + q[1]) / 2 - cy);
      }),
    );

  describe('basic shapes', () => {
    it('reads a rect, with Y pointing up', () => {
      expectPoints(contourOf('<rect x="10" y="5" width="20" height="10"/>'), [
        [10, -5],
        [30, -5],
        [30, -15],
        [10, -15],
      ]);
    });

    it('rounds the corners of a rect', () => {
      const c = contourOf('<rect x="10" y="20" width="40" height="30" rx="5"/>');
      expectBox(c, [10, -50, 50, -20]);
      expect(area(c)).toBeLessThan(40 * 30 - (4 - Math.PI) * 25);
      expect(area(c)).toBeGreaterThan(40 * 30 - (4 - Math.PI) * 25 - 0.5);
      expect(c.length).toBeGreaterThan(4 * 4);
      // rx and ry differ; and radii are limited to half the side, making a full ellipse.
      const e = contourOf('<rect width="40" height="30" rx="100" ry="6"/>');
      expectBox(e, [0, -30, 40, 0]);
      expect(e.some((p) => Math.abs(p[0] - 20) < 1e-9 && Math.abs(p[1]) < 1e-9)).toBe(true);
      expect(e.some((p) => Math.abs(p[0]) < 1e-9 && Math.abs(p[1] + 6) < 1e-9)).toBe(true);
    });

    it('reads a circle to within the flattening tolerance', () => {
      const c = contourOf('<circle cx="30" cy="40" r="10"/>');
      expectBox(c, [20, -50, 40, -30]);
      for (const p of c) expect(Math.hypot(p[0] - 30, p[1] + 40)).toBeCloseTo(10, 9);
      expect(sagitta(c, 30, -40, 10)).toBeLessThan(0.02);
      expect(sagitta(c, 30, -40, 10)).toBeGreaterThan(0.01);
      expectArea(c, Math.PI * 100);
    });

    it('uses more segments for larger circles, but never very few', () => {
      const count = (r: number) => contourOf(`<circle cx="50" cy="50" r="${r}"/>`).length;
      expect(count(0.1)).toBe(24);
      expect(count(40)).toBeGreaterThan(count(10));
      expect(sagitta(contourOf('<circle r="40"/>'), 0, 0, 40)).toBeLessThan(0.02);
    });

    it('reads an ellipse', () => {
      const c = contourOf('<ellipse cx="50" cy="50" rx="20" ry="10"/>');
      expectBox(c, [30, -60, 70, -40]);
      expectArea(c, Math.PI * 200);
      expect(area(c)).toBeLessThan(Math.PI * 200);
    });

    it('reads polygons and polylines, and closes both', () => {
      expectPoints(contourOf('<polygon points="0,0 10,0 10,10"/>'), [
        [0, 0],
        [10, 0],
        [10, -10],
      ]);
      expectPoints(contourOf('<polyline points="0 0 10 0\n10 10 0,10 0,0"/>'), [
        [0, 0],
        [10, 0],
        [10, -10],
        [0, -10],
      ]);
    });

    it('ignores lines and shapes without area', () => {
      const body = '<line x1="0" y1="0" x2="10" y2="10"/><rect width="0" height="5"/><circle r="0"/><polygon points="0,0 5,5 10,10"/><path d="M0 0 L10 0"/>';
      expectBox(contourOf(`${body}<rect width="2" height="3"/>`), [0, -3, 2, 0]);
    });

    it('makes one shape per element', () => {
      const shapes = shapesOf(mm('<rect width="2" height="3"/><circle r="4"/><path d="M0 0h1v1z M5 5h1v1z"/>'));
      expect(shapes.map((s) => s.contours.length)).toEqual([1, 1, 2]);
    });
  });

  describe('units', () => {
    it('takes a user unit for 1/96 inch without a viewBox', () => {
      const c = contoursOf('<svg xmlns="http://www.w3.org/2000/svg" width="5in" height="5in"><rect x="96" y="48" width="192" height="96"/></svg>')[0];
      expectBox(c, [25.4, -38.1, 76.2, -12.7]);
    });

    it('scales by the physical size over the viewBox', () => {
      const svg = (size: string, viewBox: string) =>
        `<svg ${size} viewBox="${viewBox}"><rect x="20" y="40" width="100" height="60"/></svg>`;
      // 200 user units across 100 mm: coordinates halve.
      expectBox(contoursOf(svg('width="100mm" height="100mm"', '0 0 200 200'))[0], [10, -50, 60, -20]);
      // The viewBox origin moves to the corner of the page.
      expectBox(contoursOf(svg('width="100mm" height="100mm"', '20,40,200,200'))[0], [0, -30, 50, 0]);
      expectBox(contoursOf(svg('width="20cm" height="20cm"', '0 0 200 200'))[0], [20, -100, 120, -40]);
      expectBox(contoursOf(svg('width="2in" height="2in"', '0 0 200 200'))[0], [5.08, -25.4, 30.48, -10.16]);
      expectBox(contoursOf(svg('width="144pt" height="144pt"', '0 0 200 200'))[0], [5.08, -25.4, 30.48, -10.16]);
      expectBox(contoursOf(svg('width="12pc" height="12pc"', '0 0 200 200'))[0], [5.08, -25.4, 30.48, -10.16]);
      expectBox(contoursOf(svg('width="192px" height="192"', '0 0 200 200'))[0], [5.08, -25.4, 30.48, -10.16]);
      // One dimension is enough; percentages say nothing, so a user unit is a pixel again.
      expectBox(contoursOf(svg('width="100mm"', '0 0 200 200'))[0], [10, -50, 60, -20]);
      expectBox(contoursOf(svg('height="100mm"', '0 0 200 200'))[0], [10, -50, 60, -20]);
      const px = 25.4 / 96;
      expectBox(contoursOf(svg('width="100%" height="100%"', '0 0 200 200'))[0], [20 * px, -100 * px, 120 * px, -40 * px]);
      expectBox(contoursOf(svg('', '0 0 200 200'))[0], [20 * px, -100 * px, 120 * px, -40 * px]);
    });

    it('keeps the proportions of the drawing unless told to stretch it', () => {
      const svg = (aspect: string) =>
        `<svg width="100mm" height="50mm" viewBox="0 0 100 100" ${aspect}><rect width="100" height="100"/></svg>`;
      const size = (c: Polygon) => [box(c)[2] - box(c)[0], box(c)[3] - box(c)[1]];
      expect(size(contoursOf(svg(''))[0])).toEqual([50, 50]);
      expect(size(contoursOf(svg('preserveAspectRatio="xMinYMin slice"'))[0])).toEqual([100, 100]);
      expect(size(contoursOf(svg('preserveAspectRatio="none"'))[0])).toEqual([100, 50]);
    });

    it('accepts units on the lengths of shapes', () => {
      const c = contoursOf('<svg><rect x="1in" y="0" width="25.4mm" height="1cm"/></svg>')[0];
      expectBox(c, [25.4, -10, 50.8, 0]);
    });

    it('tightens the flattening when the drawing is scaled up', () => {
      // A circle of radius 1 user unit that is 50 mm in the end needs as many segments as one drawn at 50.
      const small = contoursOf('<svg width="100mm" height="100mm" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></svg>')[0];
      const large = contourOf('<circle cx="50" cy="50" r="50"/>');
      expect(small.length).toBe(large.length);
      expect(sagitta(small, 50, -50, 50)).toBeLessThan(0.02);
      const grouped = contourOf('<g transform="scale(50)"><circle cx="1" cy="1" r="1"/></g>');
      expect(grouped.length).toBe(large.length);
    });
  });

  describe('paths', () => {
    it('reads lines in absolute and relative form', () => {
      const square = [
        [0, 0],
        [10, 0],
        [10, -10],
        [0, -10],
      ];
      expectPoints(contourOf('<path d="M0 0 L10 0 L10 10 L0 10 Z"/>'), square);
      expectPoints(contourOf('<path d="M 0,0 H 10 V 10 H 0 Z"/>'), square);
      expectPoints(contourOf('<path d="m0 0h10v10h-10z"/>'), square);
      expectPoints(contourOf('<path d="M0 0l10 0l0 10l-10 0z"/>'), square);
      // Coordinates after a move are lines, relative ones after "m".
      expectPoints(contourOf('<path d="M0 0 10 0 10 10 0 10z"/>'), square);
      expectPoints(contourOf('<path d="m1 1 2 0 0 2z"/>'), [
        [1, -1],
        [3, -1],
        [3, -3],
      ]);
      // Repeated H and V arguments.
      expectPoints(contourOf('<path d="M0 0H5 10V5 10H0z"/>'), [[0, 0], [5, 0], [10, 0], [10, -5], [10, -10], [0, -10]]);
    });

    it('reads compact numbers', () => {
      expectPoints(contourOf('<path d="M.5.5l1e1 0 0 1E+1-10 0z"/>'), [
        [0.5, -0.5],
        [10.5, -0.5],
        [10.5, -10.5],
        [0.5, -10.5],
      ]);
      expectPoints(contourOf('<path d="M1.5.5-2-3.5L10-.5+3,4.e0z"/>'), [
        [1.5, -0.5],
        [-2, 3.5],
        [10, 0.5],
        [3, -4],
      ]);
      expectPoints(contourOf('<path d="M1e-3 0L5 2e-1 5.5.25,0 100e-1"/>'), [
        [0.001, 0],
        [5, -0.2],
        [5.5, -0.25],
        [0, -10],
      ]);
    });

    it('starts a new subpath where the last one closed', () => {
      const contours = contoursOf(mm('<path d="M10 10 h5 v5 z l-5 0 0 -5 z m20 0 h1 v1 z"/>'));
      expect(contours.length).toBe(3);
      expectPoints(contours[1], [
        [10, -10],
        [5, -10],
        [5, -5],
      ]);
      // "m" after "z" is relative to the start of the closed subpath.
      expectPoints(contours[2], [
        [30, -10],
        [31, -10],
        [31, -11],
      ]);
    });

    it('closes open subpaths', () => {
      const contours = contoursOf(mm('<path d="M0 0 L10 0 L10 10 M20 0 L30 0 L30 10"/>'));
      expect(contours.map((c) => c.length)).toEqual([3, 3]);
    });

    // A circle of radius 10 from four cubic Béziers, written with C, S, s and c.
    const K = 5.5228475;
    const bezierCircle = `M10 0 C10 ${K} ${K} 10 0 10 S-10 ${K} -10 0 s${10 - K} -10 10 -10 c${K} 0 10 ${10 - K} 10 10 Z`;

    it('flattens cubic curves, smooth ones included', () => {
      const c = contourOf(`<path d="${bezierCircle}"/>`);
      expectBox(c, [-10, -10, 10, 10], 6);
      // The four-curve circle is itself only good to 0.03 %.
      for (const p of c) expect(Math.abs(Math.hypot(p[0], p[1]) - 10)).toBeLessThan(0.003);
      expect(sagitta(c, 0, 0, 10)).toBeLessThan(0.02 + 0.003);
      expect(c.length).toBeGreaterThan(40);
      expect(c.length).toBeLessThan(120);
    });

    it('takes the current point as the first control point of S after anything but a curve', () => {
      // With no curve before it, S x2 y2 x y is C x0 y0 x2 y2 x y.
      const smooth = contourOf('<path d="M0 0 L10 0 S20 10 10 20 L0 20 Z"/>');
      const plain = contourOf('<path d="M0 0 L10 0 C10 0 20 10 10 20 L0 20 Z"/>');
      expectPoints(smooth, plain);
    });

    it('flattens quadratic curves, smooth ones included', () => {
      // The area between a quadratic Bézier and its chord is two thirds of the control triangle.
      const lobe = contourOf('<path d="M0 0 Q5 10 10 0 Z"/>');
      expectArea(lobe, (2 / 3) * 50);
      expectBox(lobe, [0, -5, 10, 0], 6);
      // T mirrors the control point: the second lobe dips as far as the first one rises.
      const wave = contourOf('<path d="M0 0 Q5 10 10 0 T20 0 V-20 H0 Z"/>');
      expectBox(wave, [0, -5, 20, 20], 6);
      expect(wave.some((p) => Math.abs(p[0] - 15) < 1e-9 && Math.abs(p[1] - 5) < 1e-9)).toBe(true);
      const relative = contourOf('<path d="M0 0 q5 10 10 0 t10 0 v-20 h-20 z"/>');
      expectPoints(relative, wave);
      // After a line, T has nothing to mirror and is a straight line.
      expectPoints(contourOf('<path d="M0 0 L10 0 T10 10 L0 10 Z"/>'), [
        [0, 0],
        [10, 0],
        [10, -10],
        [0, -10],
      ]);
    });

    it('spends no points on curves that are straight, and a few on every other', () => {
      expect(contourOf('<path d="M0 0 C1 0 2 0 3 0 L3 3 Z"/>').length).toBe(3);
      // A corner rounded by 0.01 mm is far inside the tolerance, yet is still drawn as a curve.
      expect(contourOf('<path d="M0 0 H10 V9.99 Q10 10 9.99 10 H0 Z"/>').length).toBe(4 + 4);
    });

    it('flattens arcs', () => {
      // Two half circles: radius 10 about the origin.
      const c = contourOf('<path d="M10 0 A10 10 0 0 1 -10 0 A10 10 0 0 1 10 0 Z"/>');
      expectBox(c, [-10, -10, 10, 10]);
      for (const p of c) expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 9);
      expect(sagitta(c, 0, 0, 10)).toBeLessThan(0.02);
      expect(c.length).toBeLessThan(70);
    });

    it('honors the large-arc and sweep flags', () => {
      const quarter = (Math.PI * 100) / 4;
      // From (10, 0) to (0, 10) about the origin: the short way, then the long way round.
      const short = contourOf('<path d="M10 0 A10 10 0 0 1 0 10 Z"/>');
      expectArea(short, quarter - 50, 0.02);
      expectBox(short, [0, -10, 10, 0]);
      const long = contourOf('<path d="M10 0 A10 10 0 1 0 0 10 Z"/>');
      expectArea(long, 3 * quarter + 50);
      expectBox(long, [-10, -10, 10, 10]);
      // The other two arcs through the same points belong to the circle about (10, 10).
      const other = contourOf('<path d="M10 0 A10 10 0 0 0 0 10 Z"/>');
      expectArea(other, quarter - 50, 0.02);
      for (const p of other) expect(Math.hypot(p[0] - 10, p[1] + 10)).toBeCloseTo(10, 9);
      const otherLong = contourOf('<path d="M10 0 A10 10 0 1 1 0 10 Z"/>');
      expectBox(otherLong, [0, -20, 20, 0]);
    });

    it('reads relative arcs with flags run into the next number', () => {
      const c = contourOf('<path d="M0 0a5 5 0 0110 0a5 5 0 01-10 0z"/>');
      expectBox(c, [0, -5, 10, 5]);
      for (const p of c) expect(Math.hypot(p[0] - 5, p[1])).toBeCloseTo(5, 9);
      const d = contourOf('<path d="M0 0a5 5 0 01.5.5 5 5 0 1010 0z"/>');
      expect(d.some((p) => Math.abs(p[0] - 0.5) < 1e-9 && Math.abs(p[1] + 0.5) < 1e-9)).toBe(true);
      expect(d[d.length - 1][0]).toBeCloseTo(10.5, 9);
      expect(d[d.length - 1][1]).toBeCloseTo(-0.5, 9);
    });

    it('turns and grows ellipse arcs as the specification asks', () => {
      // An ellipse 20 x 10 turned a quarter: 10 wide and 20 tall.
      const turned = contourOf('<path d="M5 0 A10 5 90 0 1 -5 0 A10 5 90 0 1 5 0 Z"/>');
      expectBox(turned, [-5, -10, 5, 10]);
      expectArea(turned, Math.PI * 50);
      // Radii too small to reach are scaled up: a half circle on the chord.
      const grown = contourOf('<path d="M0 0 A1 1 0 0 1 10 0 Z"/>');
      expectBox(grown, [0, 0, 10, 5]);
      // A zero radius makes a straight line.
      expectPoints(contourOf('<path d="M0 0 L10 0 A0 5 0 0 1 10 10 L0 10Z"/>'), [
        [0, 0],
        [10, 0],
        [10, -10],
        [0, -10],
      ]);
    });

    it('draws a path up to the first error in it', () => {
      const square = [
        [0, 0],
        [10, 0],
        [10, -10],
        [0, -10],
      ];
      expectPoints(contourOf('<path d="M0 0 L10 0 L10 10 L0 10 Z L 5 oops 7 7"/>'), square);
      expectPoints(contourOf('<path d="M0 0 L10 0 L10 10 L0 10 L 50"/>'), square);
      expectPoints(contourOf('<path d="M0 0 L10 0 L10 10 L0 10 Z 5 5 9 9 3 4"/>'), square);
      expectPoints(contourOf('<path d="M0 0 L10 0 L10 10 L0 10 X 50 50 60 60"/>'), square);
      expectPoints(contourOf('<path d="M0 0 L10 0 L10 10 L0 10 A 5 5 0 2 1 50 50"/>'), square);
      // Path data that does not begin with a move draws nothing.
      expect(() => shapesOf(mm('<path d="L10 0 L10 10 L0 10 Z"/>'))).toThrow();
    });

    it(
      'finishes an arc whose endpoints differ by less than a rounding error',
      () => {
        // The sweep rounds to exactly zero, which once made the arc step zero and the loop endless.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 A 1 1 0 1 1 2e-17 2e-17 L 10 0 L 10 10 Z"/></svg>';
        const shapes = shapesOf(svg);
        expect(shapes.length).toBe(1);
        expect(shapes[0].contours[0].every((p) => p.every(Number.isFinite))).toBe(true);
        // One of the endpoints alone, with nothing else to draw, is no shape at all.
        expect(() => shapesOf('<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 A 1 1 0 1 1 2e-17 2e-17"/></svg>')).toThrow();
      },
      5_000,
    );
  });

  describe('transforms', () => {
    it('applies every kind of transform', () => {
      const rect = (transform: string) => contourOf(`<rect width="10" height="4" transform="${transform}"/>`);
      expectBox(rect('translate(3 4)'), [3, -8, 13, -4]);
      expectBox(rect('translate(3)'), [3, -4, 13, 0]);
      expectBox(rect('scale(2)'), [0, -8, 20, 0]);
      expectBox(rect('scale(2, 0.5)'), [0, -2, 20, 0]);
      expectBox(rect('rotate(90)'), [-4, -10, 0, 0]);
      expectBox(rect('rotate(180 5 5)'), [0, -10, 10, -6]);
      expectBox(rect('rotate(180,5,5)'), [0, -10, 10, -6]);
      expectBox(rect('skewX(45)'), [0, -4, 14, 0]);
      expectBox(rect('skewY(45)'), [0, -14, 10, 0]);
      expectBox(rect('matrix(0 1 -1 0 20 30)'), [16, -40, 20, -30]);
      expectBox(rect('matrix(1,0,0,1,3,4)'), [3, -8, 13, -4]);
    });

    it('applies a list of transforms from right to left', () => {
      const rect = (transform: string) => contourOf(`<rect width="10" height="4" transform="${transform}"/>`);
      expectBox(rect('translate(10,0) scale(2)'), [10, -8, 30, 0]);
      expectBox(rect('scale(2) translate(10,0)'), [20, -8, 40, 0]);
      expectBox(rect('translate(10 0),rotate(90)scale(2)'), [2, -20, 10, 0]);
    });

    it('nests the transforms of groups', () => {
      const c = contourOf(
        '<g transform="translate(10 20)"><a><g transform="scale(2)"><rect width="5" height="5" transform="rotate(90)"/></g></a></g>',
      );
      expectBox(c, [0, -30, 10, -20]);
      // A sibling after the group is not affected by it.
      const shapes = shapesOf(mm('<g transform="translate(50 50)"><rect width="1" height="1"/></g><rect width="1" height="1"/>'));
      expectBox(shapes[0].contours[0], [50, -51, 51, -50]);
      expectBox(shapes[1].contours[0], [0, -1, 1, 0]);
    });

    it('places the content of a nested svg', () => {
      const c = contourOf('<svg x="10" y="20" width="40" height="40" viewBox="0 0 4 4"><rect x="1" y="1" width="2" height="2"/></svg>');
      expectBox(c, [20, -50, 40, -30]);
      const plain = contourOf('<svg x="10" y="20"><rect width="2" height="2"/></svg>');
      expectBox(plain, [10, -22, 12, -20]);
    });

    it('keeps the winding of a contour as drawn, mirrored once by the Y flip', () => {
      // Clockwise on screen (Y down) is counter-clockwise with Y up.
      expect(signedArea(contourOf('<path d="M0 0 H10 V10 H0 Z"/>'))).toBeLessThan(0);
      expect(signedArea(contourOf('<path d="M0 0 V10 H10 V0 Z"/>'))).toBeGreaterThan(0);
      expect(signedArea(contourOf('<path transform="scale(-1 1)" d="M0 0 H10 V10 H0 Z"/>'))).toBeGreaterThan(0);
    });
  });

  describe('fill rule', () => {
    const ring = 'd="M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z"';
    const rules = (body: string) => shapesOf(mm(body)).map((s) => s.evenodd);

    it('is nonzero unless the element says evenodd', () => {
      expect(rules(`<path ${ring}/>`)).toEqual([false]);
      expect(rules(`<path ${ring} fill-rule="evenodd"/>`)).toEqual([true]);
      expect(rules(`<path ${ring} fill-rule="nonzero"/>`)).toEqual([false]);
      expect(rules(`<path ${ring} style="fill:#000; fill-rule : evenodd ;stroke:none"/>`)).toEqual([true]);
      expect(rules(`<path ${ring} style="FILL-RULE:EvenOdd"/>`)).toEqual([true]);
      // The style wins over the attribute.
      expect(rules(`<path ${ring} fill-rule="evenodd" style="fill-rule:nonzero"/>`)).toEqual([false]);
      expect(rules(`<path ${ring} clip-rule="evenodd"/>`)).toEqual([false]);
    });

    it('is inherited from groups', () => {
      expect(rules(`<g fill-rule="evenodd"><path ${ring}/><g><path ${ring}/></g></g><path ${ring}/>`)).toEqual([
        true,
        true,
        false,
      ]);
      expect(rules(`<g style="fill-rule:evenodd"><path ${ring}/><path ${ring} fill-rule="nonzero"/></g>`)).toEqual([
        true,
        false,
      ]);
      expect(rules(`<g fill-rule="evenodd"><g fill-rule="inherit"><path ${ring}/></g></g>`)).toEqual([true]);
      const root = `<svg fill-rule="evenodd" width="10mm" height="10mm" viewBox="0 0 10 10"><path ${ring}/></svg>`;
      expect(shapesOf(root).map((s) => s.evenodd)).toEqual([true]);
    });
  });

  describe('what is drawn', () => {
    it('imports outlines that are stroked and not filled', () => {
      const c = contourOf('<path d="M0 0 H10 V10 H0 Z" fill="none" stroke="#000" stroke-width="0.05"/>');
      expect(area(c)).toBeCloseTo(100, 9);
      expect(contourOf('<rect width="3" height="3" style="fill:none;stroke:red"/>').length).toBe(4);
    });

    it('skips hidden elements', () => {
      const visible = '<rect width="2" height="2"/>';
      const only = (body: string) => expectBox(contourOf(body + visible), [0, -2, 2, 0]);
      only('<rect width="50" height="50" display="none"/>');
      only('<rect width="50" height="50" style="display: none"/>');
      only('<rect width="50" height="50" visibility="hidden"/>');
      only('<rect width="50" height="50" style="visibility:hidden"/>');
      only('<g display="none"><rect width="50" height="50"/><g><circle r="30"/></g></g>');
      only('<g style="display:none"><rect width="50" height="50" display="inline"/></g>');
      only('<g visibility="hidden"><rect width="50" height="50"/></g>');
      // Unlike display, visibility can be switched back on below.
      const shapes = shapesOf(mm('<g visibility="hidden"><rect width="50" height="50" visibility="visible"/></g>'));
      expectBox(shapes[0].contours[0], [0, -50, 50, 0]);
    });

    it('skips definitions, clip paths, masks, patterns, symbols and markers', () => {
      const big = '<rect width="50" height="50"/><g><path d="M0 0h90v90z"/></g>';
      const body = ['defs', 'clipPath', 'mask', 'pattern', 'symbol', 'marker'].map((tag) => `<${tag} id="x">${big}</${tag}>`).join('');
      expectBox(contourOf(`${body}<defs/><rect width="2" height="2"/>`), [0, -2, 2, 0]);
    });

    it('skips comments, CDATA, the DOCTYPE and other markup', () => {
      const svg = `<?xml version="1.0"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
  <!ENTITY ns_svg "http://www.w3.org/2000/svg">
  <!ENTITY shape "<rect width='70' height='70'/>">
]>
<!-- <svg><rect width="90" height="90"/></svg> -->
<svg:svg xmlns:svg="&ns_svg;" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="100mm" height="100mm" viewBox="0 0 100 100">
  <!-- <rect width="80" height="80"/> -->
  <svg:title>a > b</svg:title>
  <svg:style><![CDATA[ rect { fill: red } /* <rect width="60" height="60"/> */ ]]></svg:style>
  <inkscape:rect width="40" height="40"/>
  <svg:metadata><rect width="30" height="30"/></svg:metadata>
  <svg:text x="1" y="2">not <svg:tspan>outlines</svg:tspan></svg:text>
  <svg:rect width = '2' height
     = "2" data-note="a > b"/>
</svg:svg>`;
      expectBox(contoursOf(svg)[0], [0, -2, 2, 0]);
    });

    it('reads UTF-16 files', () => {
      const text = mm('<rect width="2" height="3"/>');
      const utf16 = new Uint8Array(2 + text.length * 2);
      utf16.set([0xff, 0xfe]);
      for (let i = 0; i < text.length; i++) utf16[2 + i * 2] = text.charCodeAt(i);
      expectBox(outlineOf(utf16).shapes[0].contours[0], [0, -3, 2, 0]);
    });

    it('drops repeated points and contours that enclose nothing', () => {
      const c = contourOf('<path d="M0 0 L0 0 L10 0 L10 0 L10 10 L10 10 L0 0 Z M5 5 L5 5 L5 5 Z M1 1 L9 9 L1 1 Z M3 3 L4 4"/>');
      expectPoints(c, [
        [0, 0],
        [10, 0],
        [10, -10],
      ]);
    });

    it('keeps its place among the elements when one is left open or closed twice', () => {
      // HTML inside a foreignObject need not close its tags; what follows the foreignObject is still drawn.
      expect(shapesOf(mm('<foreignObject><div>a<br>b</div></foreignObject><rect x="50" width="5" height="5"/>')).length).toBe(1);
      // A closing tag too many closes nothing: the square after it is still 10 mm wide.
      const [shape] = shapesOf(mm('<g><rect width="1" height="1" visibility="hidden"/></g></g><rect width="10" height="10"/>'));
      expect(Math.abs(signedArea(shape.contours[0]))).toBeCloseTo(100, 6);
    });

    it('reads a very long number, or a very long word, in good time', () => {
      const started = performance.now();
      expect(() => shapesOf(`<svg width="${'1'.repeat(60_000)}!" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`)).not.toThrow();
      expect(shapesOf(mm(`<rect transform="${'a'.repeat(60_000)}" width="10" height="10"/>`)).length).toBe(1);
      expect(shapesOf(mm('<rect transform="translate(1,2)rotate(90)" width="10" height="5.5e0mm"/>')).length).toBe(1);
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it('says so when there is nothing to extrude', () => {
      const message = 'This SVG has no shapes that can be extruded.';
      expect(() => outlineOf(mm(''))).toThrow(message);
      expect(() => outlineOf('<svg/>')).toThrow(message);
      expect(() => outlineOf(mm('<text>hello</text><line x2="5" y2="5"/><image href="a.png"/>'))).toThrow(message);
      expect(() => outlineOf(mm('<g display="none"><rect width="5" height="5"/></g>'))).toThrow(message);
      expect(() => outlineOf(mm('<rect width="5" height="5" transform="scale(0)"/>'))).toThrow(message);
      expect(() => outlineOf('')).toThrow('This is not an SVG file.');
      expect(() => outlineOf('<html><body><rect width="5" height="5"/></body></html>')).toThrow('This is not an SVG file.');
    });
  });

  describe('round trip', () => {
    it('reads back what the SVG writer wrote', () => {
      // A square with a square hole, off center.
      const square: Polygon[] = [
        [[5, 10], [25, 10], [25, 30], [5, 30]],
        [[10, 15], [10, 25], [20, 25], [20, 15]],
      ];
      const imported = outlineOf(exportOutline('svg', square, 'plate'));
      expect(imported.shapes.length).toBe(1);
      const [shape] = imported.shapes;
      expect(shape.evenodd).toBe(true);
      expect(shape.contours.length).toBe(2);
      const { size, center } = centerOutline(imported);
      expect(size[0]).toBeCloseTo(20, 9);
      expect(size[1]).toBeCloseTo(20, 9);
      // The writer leaves a 1 mm margin, and the page's top left corner is the origin.
      expect(center[0]).toBeCloseTo(11, 9);
      expect(center[1]).toBeCloseTo(-11, 9);
      expectPoints(shape.contours[0], [[-10, -10], [10, -10], [10, 10], [-10, 10]]);
      expectPoints(shape.contours[1], [[-5, -5], [-5, 5], [5, 5], [5, -5]]);
      // Windings survive the two Y flips.
      expect(signedArea(shape.contours[0])).toBeCloseTo(400, 6);
      expect(signedArea(shape.contours[1])).toBeCloseTo(-100, 6);
    });
  });
});

describe('centering', () => {
  it('moves a mesh onto the center of its bounding box', () => {
    const m = mesh('cube.stl', binaryStl(cubeFacets().map((f) => f.map((v, i) => v * (1 + (i % 3)) + 5))));
    const positions = m.positions;
    const { size, center } = centerMesh(m);
    expect(size).toEqual([10, 20, 30]);
    expect(center).toEqual([10, 15, 20]);
    expect(m.positions).toBe(positions);
    expect(meshBounds(m)).toEqual({ min: [-5, -10, -15], max: [5, 10, 15] });
    expect(centerMesh(m)).toEqual({ size: [10, 20, 30], center: [0, 0, 0] });
  });

  it('moves an outline onto the center of its bounding box', () => {
    const o = outlineOf('<svg width="100mm" viewBox="0 0 100 100"><rect x="10" y="20" width="30" height="40"/><circle cx="60" cy="40" r="10"/></svg>');
    const first = o.shapes[0].contours[0];
    const { size, center } = centerOutline(o);
    expect(size[0]).toBeCloseTo(60, 9);
    expect(size[1]).toBeCloseTo(40, 9);
    expect(center[0]).toBeCloseTo(40, 9);
    expect(center[1]).toBeCloseTo(-40, 9);
    expect(o.shapes[0].contours[0]).toBe(first);
    expect(first[0][0]).toBeCloseTo(-30, 9);
    expect(first[0][1]).toBeCloseTo(20, 9);
  });

  it('leaves empty input alone', () => {
    const empty: MeshData = { positions: new Float32Array(0), triangles: new Uint32Array(0) };
    expect(centerMesh(empty)).toEqual({ size: [0, 0, 0], center: [0, 0, 0] });
    expect(centerOutline({ shapes: [] })).toEqual({ size: [0, 0], center: [0, 0] });
  });
});
