import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { MeshData } from '../geometry/mesh';
import type { Polygon } from '../model/types';
import { exportMesh, exportOutline } from './export';
import { centreMesh, centreOutline, IMPORT_EXTENSIONS, importFile } from './import';
import type { ImportedMesh, ImportedOutline } from './import';
import { signedArea } from './outline';

const bytes = (s: string) => new TextEncoder().encode(s);

function mesh(name: string, data: Uint8Array | string): ImportedMesh {
  const result = importFile(name, typeof data === 'string' ? bytes(data) : data);
  if (result.kind !== 'mesh') throw new Error('expected a mesh');
  return result;
}

function outlineOf(data: Uint8Array | string): ImportedOutline {
  const result = importFile('drawing.svg', typeof data === 'string' ? bytes(data) : data);
  if (result.kind !== 'outline') throw new Error('expected an outline');
  return result;
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
    expect(IMPORT_EXTENSIONS).toEqual(['stl', 'obj', '3mf', 'svg']);
    expect(importFile('Part.STL', binaryStl(cubeFacets())).kind).toBe('mesh');
    expect(importFile('C:\\models\\my.part.Obj', bytes('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')).kind).toBe('mesh');
    expect(importFile('a.SVG', bytes('<svg><rect width="1" height="1"/></svg>')).kind).toBe('outline');
  });

  it('names the formats it can read when given another', () => {
    expect(() => importFile('part.step', new Uint8Array(4))).toThrow(/\.step files can't be imported.*STL, OBJ, 3MF, SVG/);
    expect(() => importFile('README', new Uint8Array(4))).toThrow(/can't be imported/);
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

  it('copes with CRLF, tabs, continued lines, vertex colours and scientific notation', () => {
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
    const m = mesh('tetra.3mf', exportMesh('3mf', tetra, 'tetra'));
    expect([...m.positions]).toEqual([...tetra.positions]);
    expect([...m.triangles]).toEqual([...tetra.triangles]);
  });

  it('converts the unit of the model to millimetres', () => {
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
    const m = mesh('a.3mf', pack({ '_rels/.rels': RELS, '3D/3dmodel.model': model('unit="millimeter"', resources, build) }));
    expect(m.triangles.length).toBe(3 * 4 * 3);
    expect(m.positions.length).toBe(3 * 4 * 3);
    expect(meshBounds(m)).toEqual({ min: [-1, 0, 0], max: [12, 2, 6] });
    expect(volume(m)).toBeCloseTo(8 / 6 + 1 / 6 + 1 / 6, 5);
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

  it('explains what is wrong with files that hold no mesh', () => {
    expect(() => mesh('a.3mf', new Uint8Array(0))).toThrow('This 3MF file is empty.');
    expect(() => mesh('a.3mf', bytes('this is not a zip archive at all'))).toThrow(
      'This 3MF file is damaged, or is not a 3MF file.',
    );
    expect(() => mesh('a.3mf', pack({ 'readme.txt': 'hello' }))).toThrow('This 3MF file has no 3D model in it.');
    expect(() => mesh('a.3mf', pack({ '3D/3dmodel.model': model('', '', '') }))).toThrow('This 3MF file has no meshes.');
  });
});

describe('SVG import', () => {
  /** A drawing whose user unit is 1 mm. */
  const mm = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">${body}</svg>`;

  const shapesOf = (svg: string) => outlineOf(svg).shapes;
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

    it('honours the large-arc and sweep flags', () => {
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
      // A square with a square hole, off centre.
      const square: Polygon[] = [
        [[5, 10], [25, 10], [25, 30], [5, 30]],
        [[10, 15], [10, 25], [20, 25], [20, 15]],
      ];
      const imported = outlineOf(exportOutline('svg', square, 'plate'));
      expect(imported.shapes.length).toBe(1);
      const [shape] = imported.shapes;
      expect(shape.evenodd).toBe(true);
      expect(shape.contours.length).toBe(2);
      const { size, centre } = centreOutline(imported);
      expect(size[0]).toBeCloseTo(20, 9);
      expect(size[1]).toBeCloseTo(20, 9);
      // The writer leaves a 1 mm margin, and the page's top left corner is the origin.
      expect(centre[0]).toBeCloseTo(11, 9);
      expect(centre[1]).toBeCloseTo(-11, 9);
      expectPoints(shape.contours[0], [[-10, -10], [10, -10], [10, 10], [-10, 10]]);
      expectPoints(shape.contours[1], [[-5, -5], [-5, 5], [5, 5], [5, -5]]);
      // Windings survive the two Y flips.
      expect(signedArea(shape.contours[0])).toBeCloseTo(400, 6);
      expect(signedArea(shape.contours[1])).toBeCloseTo(-100, 6);
    });
  });
});

describe('centring', () => {
  it('moves a mesh onto the centre of its bounding box', () => {
    const m = mesh('cube.stl', binaryStl(cubeFacets().map((f) => f.map((v, i) => v * (1 + (i % 3)) + 5))));
    const positions = m.positions;
    const { size, centre } = centreMesh(m);
    expect(size).toEqual([10, 20, 30]);
    expect(centre).toEqual([10, 15, 20]);
    expect(m.positions).toBe(positions);
    expect(meshBounds(m)).toEqual({ min: [-5, -10, -15], max: [5, 10, 15] });
    expect(centreMesh(m)).toEqual({ size: [10, 20, 30], centre: [0, 0, 0] });
  });

  it('moves an outline onto the centre of its bounding box', () => {
    const o = outlineOf('<svg width="100mm" viewBox="0 0 100 100"><rect x="10" y="20" width="30" height="40"/><circle cx="60" cy="40" r="10"/></svg>');
    const first = o.shapes[0].contours[0];
    const { size, centre } = centreOutline(o);
    expect(size[0]).toBeCloseTo(60, 9);
    expect(size[1]).toBeCloseTo(40, 9);
    expect(centre[0]).toBeCloseTo(40, 9);
    expect(centre[1]).toBeCloseTo(-40, 9);
    expect(o.shapes[0].contours[0]).toBe(first);
    expect(first[0][0]).toBeCloseTo(-30, 9);
    expect(first[0][1]).toBeCloseTo(20, 9);
  });

  it('leaves empty input alone', () => {
    const empty: ImportedMesh = { kind: 'mesh', positions: new Float32Array(0), triangles: new Uint32Array(0) };
    expect(centreMesh(empty)).toEqual({ size: [0, 0, 0], centre: [0, 0, 0] });
    expect(centreOutline({ kind: 'outline', shapes: [] })).toEqual({ size: [0, 0], centre: [0, 0] });
  });
});
