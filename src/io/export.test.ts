import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../app';
import type { MeshData } from '../geometry/mesh';
import type { Polygon } from '../model/types';
import { exportMesh, exportOutline, FORMATS } from './export';
import { writeObj } from './obj';
import { write3mf } from './threemf';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

// A tetrahedron with outward-facing triangles.
const tetra: MeshData = {
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
  triangles: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
};

// One triangle on its own: an open mesh, as an import may be.
const open: MeshData = {
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
  triangles: new Uint32Array([0, 1, 2]),
};

/** A closed ring with `n` flat sides: four vertices and eight outward-facing triangles per side. */
function ringMesh(outer: number, inner: number, height: number, n: number): MeshData {
  const positions: number[] = [];
  const triangles: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n;
    const c = Math.cos(a);
    const s = Math.sin(a);
    positions.push(outer * c, outer * s, 0, outer * c, outer * s, height, inner * c, inner * s, 0, inner * c, inner * s, height);
    // Outer bottom / top and inner bottom / top, of this side and the next.
    const [ob, ot, ib, it] = [0, 1, 2, 3].map((k) => i * 4 + k);
    const [ob2, ot2, ib2, it2] = [0, 1, 2, 3].map((k) => ((i + 1) % n) * 4 + k);
    triangles.push(ob, ob2, ot2, ob, ot2, ot); // outside
    triangles.push(ib, it2, ib2, ib, it, it2); // bore
    triangles.push(ot, ot2, it2, ot, it2, it); // top
    triangles.push(ob, ib2, ob2, ob, ib, ib2); // bottom
  }
  return { positions: new Float32Array(positions), triangles: new Uint32Array(triangles) };
}

const SIDES = 96;
const ring = ringMesh(10, 3, 5, SIDES);
const ringTriangles = SIDES * 8;
const ringVolume = (SIDES / 2) * Math.sin((Math.PI * 2) / SIDES) * (10 * 10 - 3 * 3) * 5;

const circle = (r: number, n: number): Polygon =>
  Array.from({ length: n }, (_, i) => [r * Math.cos((Math.PI * 2 * i) / n), r * Math.sin((Math.PI * 2 * i) / n)]);

// Outer contour with one hole.
const outline: Polygon[] = [circle(10, 24), circle(3, 12).reverse()];

describe('formats', () => {
  it('lists STL first and has unique ids', () => {
    expect(FORMATS.map((f) => f.id)).toEqual(['stl', '3mf', 'obj', 'glb', 'svg', 'dxf']);
    expect(FORMATS.filter((f) => f.kind === '2d').map((f) => f.id)).toEqual(['svg', 'dxf']);
    expect(FORMATS.map((f) => f.extension)).toEqual(['stl', '3mf', 'obj', 'glb', 'svg', 'dxf']);
  });
});

describe('STL', () => {
  it('has the binary layout and round-trips', () => {
    const b = exportMesh('stl', tetra, 'tetra');
    expect(b.length).toBe(84 + 50 * 4);
    expect(text(b.subarray(0, 80))).toContain(APP_NAME);
    expect(text(b.subarray(0, 5))).not.toBe('solid');
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(v.getUint32(80, true)).toBe(4);
    // First facet: normal (0,0,-1), first vertex (0,0,0), second vertex (0,10,0).
    expect(v.getFloat32(84 + 8, true)).toBeCloseTo(-1);
    expect(v.getFloat32(84 + 12, true)).toBe(0);
    expect(v.getFloat32(84 + 24 + 4, true)).toBe(10);
  });

  it('preserves volume and writes unit normals for a real solid', () => {
    const b = exportMesh('stl', ring, 'ring');
    expect(b.length).toBe(84 + 50 * ringTriangles);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(v.getUint32(80, true)).toBe(ringTriangles);
    let volume = 0;
    for (let i = 0; i < ringTriangles; i++) {
      const o = 84 + i * 50;
      const f = (k: number) => v.getFloat32(o + k * 4, true);
      const n = [f(0), f(1), f(2)];
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = [3, 4, 5, 6, 7, 8, 9, 10, 11].map(f);
      const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      volume += det / 6;
      // The stored normal agrees with the winding.
      const cr = [
        (by - ay) * (cz - az) - (bz - az) * (cy - ay),
        (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
        (bx - ax) * (cy - ay) - (by - ay) * (cx - ax),
      ];
      expect(cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2]).toBeGreaterThan(0);
    }
    expect(volume).toBeGreaterThan(1000);
    expect(Math.abs(volume - ringVolume) / ringVolume).toBeLessThan(1e-4);
  });

  it('writes a zero normal rather than NaN for a triangle without area', () => {
    const sliver: MeshData = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), triangles: new Uint32Array([0, 1, 2]) };
    const b = exportMesh('stl', sliver, 'sliver');
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect([v.getFloat32(84, true), v.getFloat32(88, true), v.getFloat32(92, true)]).toEqual([0, 0, 0]);
  });
});

describe('3MF', () => {
  it('is a zip with the three core parts', () => {
    const files = unzipSync(write3mf([{ name: 'Ring', parts: [{ color: '#d8605a', mesh: ring }] }], 'ring <1> & "co"'));
    expect(Object.keys(files)).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    expect(strFromU8(files['_rels/.rels'])).toContain('Target="/3D/3dmodel.model"');
    expect(strFromU8(files['[Content_Types].xml'])).toContain('Extension="model"');
    const xml = strFromU8(files['3D/3dmodel.model']);
    expect(xml).toContain('unit="millimeter"');
    expect(xml).toContain('ring &lt;1&gt; &amp; &quot;co&quot;');
    expect(xml).toContain(`<metadata name="Application">${APP_NAME}</metadata>`);
    expect(xml.match(/<vertex /g)?.length).toBe(ring.positions.length / 3);
    expect(xml.match(/<triangle /g)?.length).toBe(ringTriangles);
    expect(xml.match(/<object /g)?.length).toBe(1);
    expect(xml).toContain('<item objectid="2"/>');
  });

  it('gives every object its color as a base material, and a multicolored one a part per color', () => {
    const objects = [
      { name: 'Plate', parts: [{ color: '#d8605a', mesh: tetra }] },
      { name: 'Knob', parts: [{ color: '#5fa777', mesh: tetra }, { color: '#d8605a', mesh: ring }] },
    ];
    const xml = strFromU8(unzipSync(write3mf(objects, 'two'))['3D/3dmodel.model']);
    expect(xml).toContain('<basematerials id="1">');
    expect(xml).toContain('<base name="Red" displaycolor="#D8605AFF"/>');
    expect(xml).toContain('<base name="Green" displaycolor="#5FA777FF"/>');
    expect(xml.match(/<base /g)?.length).toBe(2);
    expect(xml).toContain('<object id="2" type="model" name="Plate" pid="1" pindex="0">');
    expect(xml).toContain('<object id="3" type="model" name="Knob (Green)" pid="1" pindex="1">');
    expect(xml).toContain('<object id="4" type="model" name="Knob (Red)" pid="1" pindex="0">');
    expect(xml).toContain('<object id="5" type="model" name="Knob">');
    expect(xml).toContain('<component objectid="3"/>');
    expect(xml).toContain('<component objectid="4"/>');
    expect(xml).toContain('<item objectid="2"/>');
    expect(xml).toContain('<item objectid="5"/>');
    expect(xml.match(/<item /g)?.length).toBe(2);
    // A color off the palette is named by its value.
    expect(strFromU8(unzipSync(write3mf([{ name: 'X', parts: [{ color: '#123456', mesh: tetra }] }], 'x'))['3D/3dmodel.model'])).toContain('<base name="#123456" displaycolor="#123456FF"/>');
  });
});

describe('OBJ', () => {
  it('writes a material library for colored parts, and none for plain ones', () => {
    const { obj, mtl, mtlName } = writeObj([{ name: 'Plate', parts: [{ color: '#d8605a', mesh: tetra }] }, { name: 'Knob', parts: [{ color: '#5fa777', mesh: tetra }, { color: '#d8605a', mesh: tetra }] }], 'my part');
    const lines = text(obj).split('\n');
    expect(mtlName).toBe('my_part.mtl');
    expect(lines).toContain('mtllib my_part.mtl');
    expect(lines).toContain('o Plate');
    expect(lines).toContain('o Knob');
    expect(lines).toContain('g Knob_Green');
    expect(lines.filter((l) => l === 'usemtl Red')).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('v '))).toHaveLength(12);
    // Faces of the third part count on from the vertices before them.
    expect(lines.filter((l) => l.startsWith('f ')).pop()).toBe('f 9 12 11');
    const library = text(mtl!).split('\n');
    expect(library).toContain('newmtl Red');
    expect(library).toContain('Kd 0.847059 0.376471 0.352941');
    expect(library.filter((l) => l.startsWith('newmtl'))).toEqual(['newmtl Red', 'newmtl Green']);
    expect(writeObj([{ name: 'x', parts: [{ color: '', mesh: tetra }] }], 'x').mtl).toBeNull();
  });

  it('writes vertices and 1-based faces', () => {
    const lines = text(exportMesh('obj', tetra, 'my part')).split('\n');
    expect(lines[0]).toContain(APP_NAME);
    expect(lines).toContain('o my_part');
    expect(lines.filter((l) => l.startsWith('v '))).toEqual(['v 0 0 0', 'v 10 0 0', 'v 0 10 0', 'v 0 0 10']);
    expect(lines.filter((l) => l.startsWith('f '))).toEqual(['f 1 3 2', 'f 1 2 4', 'f 2 3 4', 'f 1 4 3']);
    const big = text(exportMesh('obj', ring, 'ring')).split('\n');
    expect(big.filter((l) => l.startsWith('v ')).length).toBe(ring.positions.length / 3);
    expect(big.filter((l) => l.startsWith('f ')).length).toBe(ringTriangles);
  });
});

describe('open meshes', () => {
  it('are written by every mesh format', () => {
    expect(exportMesh('stl', open, 'open').length).toBe(84 + 50);
    expect(text(exportMesh('obj', open, 'open'))).toContain('f 1 2 3');
    const xml = strFromU8(unzipSync(write3mf([{ name: 'open', parts: [{ color: '#8fa3bf', mesh: open }] }], 'open'))['3D/3dmodel.model']);
    expect(xml).toContain('<triangle v1="0" v2="1" v3="2"/>');
  });
});

describe('DXF', () => {
  it('writes one closed polyline per contour', () => {
    const lines = text(exportOutline('dxf', outline, 'ring')).split('\r\n');
    expect(lines[1]).toContain(APP_NAME);
    expect(lines[lines.length - 1]).toBe('');
    expect(lines.slice(-3, -1)).toEqual(['0', 'EOF']);
    const count = (s: string) => lines.filter((l) => l === s).length;
    expect(count('POLYLINE')).toBe(2);
    expect(count('SEQEND')).toBe(2);
    expect(count('VERTEX')).toBe(24 + 12);
    expect(count('$INSUNITS')).toBe(1);
    // Group codes and values strictly alternate.
    expect((lines.length - 1) % 2).toBe(0);
    // Each POLYLINE carries the closed flag (70 = 1) and the right number of vertices.
    const sizes: number[] = [];
    for (let i = 0; i < lines.length - 1; i += 2) {
      if (lines[i] !== '0') continue;
      if (lines[i + 1] === 'POLYLINE') {
        sizes.push(0);
        const header = lines.slice(i + 2, i + 14);
        expect(header.slice(header.indexOf('70'), header.indexOf('70') + 2)).toEqual(['70', '1']);
      } else if (lines[i + 1] === 'VERTEX') sizes[sizes.length - 1]++;
    }
    expect(sizes).toEqual([24, 12]);
    expect(lines).toContain('10');
  });

  it('copes with an empty outline', () => {
    const lines = text(exportOutline('dxf', [], 'nothing')).split('\r\n');
    expect(lines).not.toContain('POLYLINE');
    expect(lines.join(' ')).not.toMatch(/Infinity|NaN/);
  });
});

describe('SVG', () => {
  it('fits the viewBox and writes one subpath per contour', () => {
    const svg = text(exportOutline('svg', outline, 'ring'));
    expect(svg).toContain('viewBox="-11 -11 22 22"');
    expect(svg).toContain('width="22mm"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg.match(/<path /g)?.length).toBe(1);
    const d = /<path d="([^"]+)"/.exec(svg)![1];
    expect(d.match(/M/g)?.length).toBe(2);
    expect(d.match(/Z/g)?.length).toBe(2);
    expect(d.match(/L/g)?.length).toBe(24 + 12 - 2);
    // Y is flipped: the outline point (0, 10) lands at y = -10.
    const asym: Polygon[] = [[[0, 0], [4, 0], [0, 10]]];
    const flipped = text(exportOutline('svg', asym, 'tri'));
    expect(flipped).toContain('M0 0 L4 0 L0 -10 Z');
    expect(flipped).toContain('viewBox="-1 -11 6 12"');
  });

  it('copes with an empty outline', () => {
    expect(text(exportOutline('svg', [], 'nothing'))).not.toMatch(/Infinity|NaN/);
  });
});
