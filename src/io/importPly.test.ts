import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { MeshData } from '../geometry/mesh';
import { fileKind, importFile } from './import';
import type { Companion, ImportedModel, ImportedPart } from './import';
import { paint } from './importPly';
import { writePng } from './png';

const bytes = (s: string) => new TextEncoder().encode(s);

function model(data: Uint8Array | string, companions: Companion[] = [], name = 'scan.ply'): ImportedModel {
  const result = importFile(name, typeof data === 'string' ? bytes(data) : data, companions);
  if (result.kind !== 'model') throw new Error('expected a model');
  return result;
}

const part = (data: Uint8Array | string, companions: Companion[] = []): ImportedPart => model(data, companions).parts[0];

function volume({ positions: p, triangles: t }: MeshData): number {
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/** Whether every edge is used once each way. */
function isClosed({ triangles: t }: MeshData): boolean {
  const edges = new Map<string, number>();
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const key = `${t[i + k]}>${t[i + ((k + 1) % 3)]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of edges) {
    const [a, b] = key.split('>');
    if (n !== 1 || edges.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

/** The pixels of a PNG as `writePng` writes them: its size and three bytes a pixel. */
function pixels(png: Uint8Array): { width: number; height: number; at(x: number, y: number): string } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const length = view.getUint32(33);
  expect(String.fromCharCode(...png.subarray(37, 41))).toBe('IDAT');
  const rows = unzlibSync(png.subarray(41, 41 + length));
  expect(rows.length).toBe(height * (width * 3 + 1));
  return {
    width,
    height,
    at: (x, y) => {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      return `#${[rows[o], rows[o + 1], rows[o + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    },
  };
}

/** What these read of a part: its picture, and where its triangles' corners are on it. */
interface Worn {
  image?: { bytes: Uint8Array };
  mesh: { uv?: Float32Array };
}

/** The color the picture of a part holds at each corner of each of its triangles. */
function cornerColors(p: Worn): string[][] {
  const picture = pixels(p.image!.bytes);
  const uv = p.mesh.uv!;
  const out: string[][] = [];
  for (let t = 0; t < uv.length / 6; t++) {
    out.push(
      [0, 1, 2].map((c) => {
        const x = uv[t * 6 + c * 2] * picture.width - 0.5;
        const y = (1 - uv[t * 6 + c * 2 + 1]) * picture.height - 0.5;
        // The middle of a pixel, where every way of drawing the picture gives the pixel's own color.
        expect(Math.abs(x - Math.round(x))).toBeLessThan(1e-3);
        expect(Math.abs(y - Math.round(y))).toBeLessThan(1e-3);
        return picture.at(Math.round(x), Math.round(y));
      }),
    );
  }
  return out;
}

/** The one color of each triangle of a part whose triangles are each one color all over. */
function faceColors(p: ImportedPart): string[] {
  expect(p.mesh.uv!.length).toBe(p.mesh.triangles.length * 2);
  return cornerColors(p).map(([a, b, c]) => {
    expect(b).toBe(a);
    expect(c).toBe(a);
    return a;
  });
}

/** How bright a stored value of a channel is, 0 to 1: pictures are blended in light. */
const light = (v: number): number => (v <= 10 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
const lights = (hex: string): number[] => [1, 3, 5].map((i) => light(parseInt(hex.slice(i, i + 2), 16)));

/**
 * What a triangle shows at a point given by its weights on the three corners, drawn the way pictures are: the
 * blend, in light, of the four pixels around the point.
 */
function shown(p: Worn, t: number, weights: [number, number, number]): number[] {
  const picture = pixels(p.image!.bytes);
  const uv = p.mesh.uv!;
  let [u, v] = [0, 0];
  for (let c = 0; c < 3; c++) {
    u += weights[c] * uv[t * 6 + c * 2];
    v += weights[c] * uv[t * 6 + c * 2 + 1];
  }
  const x = u * picture.width - 0.5;
  const y = (1 - v) * picture.height - 0.5;
  const [x0, y0] = [Math.floor(x + 1e-9), Math.floor(y + 1e-9)];
  const [fx, fy] = [x - x0, y - y0];
  const at = (i: number, j: number): number[] => lights(picture.at(Math.min(picture.width - 1, x0 + i), Math.min(picture.height - 1, y0 + j)));
  const [a, b, c, d] = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
  return [0, 1, 2].map((k) => a[k] * (1 - fx) * (1 - fy) + b[k] * fx * (1 - fy) + c[k] * (1 - fx) * fy + d[k] * fx * fy);
}

/** The nine bytes `paint` takes for each triangle, from the colors of its corners. */
const corners = (...triangles: [string, string, string][]): Uint8Array => Uint8Array.from(triangles.flatMap((t) => t.flatMap((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)))));

const CUBE = [
  [0, 0, 0],
  [10, 0, 0],
  [10, 10, 0],
  [0, 10, 0],
  [0, 0, 10],
  [10, 0, 10],
  [10, 10, 10],
  [0, 10, 10],
];
/** The six sides, each seen from outside going round counterclockwise. */
const SIDES = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
];

const cubeText = (): string =>
  ['ply', 'format ascii 1.0', 'comment made by hand', 'element vertex 8', 'property float x', 'property float y', 'property float z', 'element face 6', 'property list uchar int vertex_indices', 'end_header', ...CUBE.map((v) => v.join(' ')), ...SIDES.map((f) => `4 ${f.join(' ')}`), ''].join('\n');

/** The cube as a binary file, with a normal on every point that the reader has to step over. */
function cubeBinary(little: boolean, newline = '\n'): Uint8Array {
  const head = bytes(
    ['ply', `format binary_${little ? 'little' : 'big'}_endian 1.0`, 'element vertex 8', 'property double x', 'property double y', 'property double z', 'property float nx', 'property float ny', 'property float nz', 'element face 6', 'property list uchar uint vertex_index', 'end_header', ''].join(newline),
  );
  const out = new Uint8Array(head.length + 8 * 36 + 6 * 17);
  out.set(head);
  const view = new DataView(out.buffer);
  let at = head.length;
  for (const v of CUBE) {
    for (const c of v) {
      view.setFloat64(at, c, little);
      at += 8;
    }
    at += 12;
  }
  for (const f of SIDES) {
    view.setUint8(at++, 4);
    for (const i of f) {
      view.setUint32(at, i, little);
      at += 4;
    }
  }
  return out;
}

/** A tetrahedron whose points carry what `columns` names, each row of `rows` following its coordinates. */
function tetra(columns: string[], rows: string[], faces = ['3 0 2 1', '3 0 1 3', '3 1 2 3', '3 0 3 2'], faceColumns: string[] = [], comments: string[] = []): string {
  const points = ['0 0 0', '10 0 0', '0 10 0', '0 0 10'];
  return ['ply', 'format ascii 1.0', ...comments, 'element vertex 4', 'property float x', 'property float y', 'property float z', ...columns, `element face ${faces.length}`, 'property list uchar int vertex_indices', ...faceColumns, 'end_header', ...points.map((p, i) => `${p} ${rows[i] ?? ''}`.trim()), ...faces, ''].join(
    '\n',
  );
}

const RGB = ['property uchar red', 'property uchar green', 'property uchar blue'];

describe('PLY import', () => {
  it('reads a text file of four-sided faces as a closed solid', () => {
    const { mesh } = part(cubeText());
    expect(mesh.positions.length).toBe(8 * 3);
    expect(mesh.triangles.length).toBe(12 * 3);
    expect(volume(mesh)).toBeCloseTo(1000, 6);
    expect(isClosed(mesh)).toBe(true);
    expect(part(cubeText()).color).toBeUndefined();
    expect(part(cubeText()).image).toBeUndefined();
    expect(model(cubeText()).parts[0].name).toBe('scan');
  });

  it('reads a binary file in either byte order, stepping over what it has no use for', () => {
    for (const data of [cubeBinary(true), cubeBinary(false), cubeBinary(true, '\r\n')]) {
      const { mesh } = part(data);
      expect(mesh.triangles.length).toBe(12 * 3);
      expect(volume(mesh)).toBeCloseTo(1000, 6);
      expect(isClosed(mesh)).toBe(true);
    }
  });

  it('is known by its first line when the name does not tell', () => {
    expect(fileKind('msf:31', bytes(cubeText()))).toBe('ply');
    expect(fileKind('msf:32', cubeBinary(true))).toBe('ply');
    expect(importFile('msf:31', bytes(cubeText())).kind).toBe('model');
  });

  it('paints the colors of the points onto a picture, each face going from the color of one corner to the next', () => {
    const p = part(tetra(RGB, ['255 0 0', '0 255 0', '0 0 255', '255 255 255']));
    expect(p.image?.mime).toBe('image/png');
    expect(p.image?.name).toBe('scan.png');
    // Faces 0 2 1, 0 1 3, 1 2 3 and 0 3 2, corner by corner.
    const [red, green, blue, white] = ['#ff0000', '#00ff00', '#0000ff', '#ffffff'];
    expect(cornerColors(p)).toEqual([
      [red, blue, green],
      [red, green, white],
      [green, blue, white],
      [red, white, blue],
    ]);
    // Four faces, a block of two pixels by two for each.
    const picture = pixels(p.image!.bytes);
    expect([picture.width, picture.height]).toEqual([4, 4]);
    // The part's own color, for where a picture does not go, is the mean of them all.
    expect(p.color).toBe('#808080');
    expect(isClosed(p.mesh)).toBe(true);
  });

  it('takes colors written as fractions or as sixteen bits', () => {
    const [red, blue] = ['#ff0000', '#0000ff'];
    const expected = [
      [red, red, red],
      [red, red, blue],
      [red, red, blue],
      [red, blue, red],
    ];
    const fractions = part(tetra(['property float red', 'property float green', 'property float blue'], ['1 0 0', '1 0 0', '1 0 0', '0 0 1']));
    expect(cornerColors(fractions)).toEqual(expected);
    const wide = part(tetra(['property ushort red', 'property ushort green', 'property ushort blue'], ['65535 0 0', '65535 0 0', '65535 0 0', '0 0 65535']));
    expect(cornerColors(wide)).toEqual(expected);
  });

  it('keeps one pixel a color when every face is one color all over, though the points carry them', () => {
    // Two triangles with points of their own, as a tool writes faces that each have a color.
    const lines = ['ply', 'format ascii 1.0', 'element vertex 6', 'property float x', 'property float y', 'property float z', ...RGB, 'element face 2', 'property list uchar int vertex_indices', 'end_header'];
    lines.push('0 0 0 255 0 0', '10 0 0 255 0 0', '0 10 0 255 0 0', '0 0 5 0 0 255', '10 0 5 0 0 255', '0 10 5 0 0 255', '3 0 1 2', '3 3 4 5');
    const p = part(lines.join('\n'));
    expect(faceColors(p)).toEqual(['#ff0000', '#0000ff']);
    const picture = pixels(p.image!.bytes);
    expect([picture.width, picture.height]).toEqual([2, 1]);
  });

  it('gives a part of one color that color and no picture', () => {
    const p = part(tetra([...RGB, 'property uchar alpha'], ['200 100 50 255', '200 100 50 255', '200 100 50 255', '200 100 50 255']));
    expect(p.color).toBe('#c86432');
    expect(p.image).toBeUndefined();
    expect(p.mesh.uv).toBeUndefined();
  });

  it('takes the color a face names over those of its corners', () => {
    const faces = ['3 0 2 1 255 0 0', '3 0 1 3 0 255 0', '3 1 2 3 0 0 255', '3 0 3 2 255 0 0'];
    const p = part(tetra(RGB, ['9 9 9', '9 9 9', '9 9 9', '9 9 9'], faces, RGB));
    expect(faceColors(p)).toEqual(['#ff0000', '#00ff00', '#0000ff', '#ff0000']);
    // Three colors: a picture of two by two, the odd pixel repeating the last.
    const picture = pixels(p.image!.bytes);
    expect([picture.width, picture.height]).toEqual([2, 2]);
  });

  it('keeps no more colors than the picture holds, the nearest standing in for the rest', () => {
    // A strip of 70,000 triangles, each in a color of its own.
    const count = 70_000;
    const lines = ['ply', 'format ascii 1.0', `element vertex ${count + 2}`, 'property float x', 'property float y', 'property float z', `element face ${count}`, 'property list uchar int vertex_indices', ...RGB, 'end_header'];
    for (let i = 0; i < count + 2; i++) lines.push(`${i >> 1} ${i & 1} 0`);
    for (let i = 0; i < count; i++) lines.push(`3 ${i} ${i + 1} ${i + 2} ${i & 255} ${(i >> 8) & 255} ${(i * 7) & 255}`);
    const p = part(lines.join('\n'));
    const picture = pixels(p.image!.bytes);
    expect(picture.width).toBeLessThanOrEqual(256);
    expect(picture.height).toBeLessThanOrEqual(256);
    const shown = faceColors(p);
    expect(shown).toHaveLength(count);
    // Each face within a step of its own color.
    const channel = (hex: string, k: number): number => parseInt(hex.slice(1 + k * 2, 3 + k * 2), 16);
    for (const i of [0, 1, 255, 256, 4321, 65535, 69_999]) {
      const own = [i & 255, (i >> 8) & 255, (i * 7) & 255];
      for (let k = 0; k < 3; k++) expect(Math.abs(channel(shown[i], k) - own[k])).toBeLessThanOrEqual(2);
    }
  });

  it('wears the picture the file names, by the coordinates of its points, when it came along', () => {
    const text = tetra(['property float s', 'property float t', ...RGB], ['0 0 255 0 0', '1 0 255 0 0', '0 1 0 255 0', '1 1 0 0 255'], undefined, [], ['comment TextureFile skins/My Skin.PNG']);
    const skin = { name: 'my skin.png', bytes: writePng(1, 1, new Uint8Array([1, 2, 3])) };
    const worn = model(text, [skin]);
    expect(worn.used).toEqual(['my skin.png']);
    expect(worn.missing).toBeUndefined();
    expect(worn.parts[0].image).toEqual({ name: 'my skin.png', mime: 'image/png', bytes: skin.bytes });
    // Face 0 2 1, then 0 1 3: the coordinates of those points, corner by corner.
    expect([...worn.parts[0].mesh.uv!.subarray(0, 12)]).toEqual([0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1]);
    expect(worn.parts[0].color).toBeUndefined();
    // Without it the file says what it wants, and shows its points' colors meanwhile.
    const bare = model(text);
    expect(bare.missing).toEqual(['My Skin.PNG']);
    expect(bare.parts[0].image?.name).toBe('scan.png');
    expect(cornerColors(bare.parts[0])).toHaveLength(4);
  });

  it('wears the picture by the coordinates of its faces, which may come before their corners', () => {
    const faces = ['6 0 0 0 1 1 0 3 0 2 1', '6 0 0 1 0 1 1 3 0 1 3', '4 0 0 1 1 3 1 2 3', '6 0.5 0.5 0.25 0.25 0.75 0.75 3 0 3 2'];
    const text = tetra([], [], faces, ['property list uchar float texcoord'], ['comment TextureFile skin.jpg']).replace('property list uchar int vertex_indices\nproperty list uchar float texcoord', 'property list uchar float texcoord\nproperty list uchar int vertex_indices');
    const p = part(text, [{ name: 'skin.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff]) }]);
    expect(p.image?.mime).toBe('image/jpeg');
    const uv = [...p.mesh.uv!];
    expect(uv.slice(0, 12)).toEqual([0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1]);
    // Coordinates that do not go two to a corner count for none.
    expect(uv.slice(12, 18)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(uv.slice(18)).toEqual([0.5, 0.5, 0.25, 0.25, 0.75, 0.75]);
  });

  it('joins points at one place and drops those no face uses', () => {
    const lines = ['ply', 'format ascii 1.0', 'element vertex 7', 'property float x', 'property float y', 'property float z', 'element face 2', 'property list uchar int vertex_indices', 'end_header', '0 0 0', '1 0 0', '0 1 0', '1 0 0', '1 1 0', '0 1 0', '99 99 99', '3 0 1 2', '3 3 4 5', ''];
    const { mesh } = part(lines.join('\n'));
    expect(mesh.positions.length).toBe(4 * 3);
    expect([...mesh.triangles]).toEqual([0, 1, 2, 1, 3, 2]);
  });

  it('drops the faces that name points the file does not have, or points that are no numbers', () => {
    const lines = ['ply', 'format ascii 1.0', 'element vertex 4', 'property float x', 'property float y', 'property float z', 'element face 4', 'property list uchar int vertex_indices', 'end_header', '0 0 0', '1 0 0', '0 1 0', 'nan 0 1', '3 0 1 2', '3 0 1 9', '3 0 1 3', '2 0 1', ''];
    expect([...part(lines.join('\n')).mesh.triangles]).toEqual([0, 1, 2]);
  });

  it('reads the faces wherever they are among what else the file holds', () => {
    const lines = [
      'ply',
      'format ascii 1.0',
      'obj_info made elsewhere',
      'element camera 1',
      'property float view_px',
      'property list uchar float extra',
      'element face 1',
      'property list uchar int vertex_indices',
      'element vertex 3',
      'property float x',
      'property float y',
      'property float z',
      'element edge 1',
      'property int vertex1',
      'property int vertex2',
      'end_header',
      '5 2 7 8',
      '3 0 1 2',
      '0 0 0',
      '1 0 0',
      '0 1 0',
      '0 1',
      '',
    ];
    const { mesh } = part(lines.join('\n'));
    expect([...mesh.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect([...mesh.triangles]).toEqual([0, 1, 2]);
  });

  it('cuts a face that is not convex along its own outline', () => {
    // An L lying flat: a fan around its first corner would cover the notch.
    const lines = ['ply', 'format ascii 1.0', 'element vertex 6', 'property float x', 'property float y', 'property float z', 'element face 1', 'property list uchar int vertex_indices', 'end_header', '2 2 0', '0 2 0', '0 0 0', '4 0 0', '4 1 0', '2 1 0', '6 0 1 2 3 4 5', ''];
    const { mesh } = part(lines.join('\n'));
    let area = 0;
    const p = mesh.positions;
    for (let i = 0; i < mesh.triangles.length; i += 3) {
      const [a, b, c] = [mesh.triangles[i] * 3, mesh.triangles[i + 1] * 3, mesh.triangles[i + 2] * 3];
      area += ((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1])) / 2;
    }
    // Every triangle the way round the outline goes, and together no more than the L.
    expect(area).toBeCloseTo(6, 6);
    expect(mesh.triangles.length).toBe(4 * 3);
  });

  it('says what is wrong with a file it cannot make a solid of', () => {
    expect(() => model(new Uint8Array(0))).toThrow('This PLY file is empty.');
    expect(() => model('solid a\n')).toThrow('This is not a PLY file.');
    expect(() => model('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n')).toThrow('This PLY file is damaged: its header has no end.');
    expect(() => model('ply\nformat ascii 2.0 beta\nelement vertex many\nend_header\n')).toThrow('This PLY file is damaged: its header cannot be read.');
    expect(() => model('ply\nformat binary_middle_endian 1.0\nend_header\n')).toThrow('This PLY file is damaged: its header cannot be read.');
    expect(() => model('ply\nformat ascii 1.0\nelement face 0\nend_header\n')).toThrow('This PLY file has no points.');
    // A scan that was never meshed, or a splat.
    const cloud = 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 1 1\n';
    expect(() => model(cloud)).toThrow('This PLY file holds points with no faces between them, which cannot be made into a solid.');
    expect(() => model(cubeText().replace(/\n4 [^]*$/, '\n'))).toThrow('This PLY file is incomplete: it ends before its last point or face.');
    expect(() => model(cubeBinary(true).slice(0, -5))).toThrow('This PLY file is incomplete: it ends before its last point or face.');
    expect(() => model(cubeText().replace('element vertex 8', 'element vertex 4000000000'))).toThrow('This PLY file is incomplete: it ends before its last point or face.');
    const flat = cubeText().replace(/\n4 [^]*$/, '\n') + '3 0 0 1\n3 1 1 1\n3 2 2 0\n3 0 9 1\n3 1 2\n1 0\n';
    expect(() => model(flat)).toThrow('This PLY file has no usable faces.');
  });
});

describe('the colors of triangles as a picture', () => {
  const worn = (painted: ReturnType<typeof paint>): Worn => ({ image: { bytes: painted.picture!.png }, mesh: { uv: painted.picture!.uv } });
  const close = (got: number[], want: number[], within: number): void => got.forEach((v, k) => expect(Math.abs(v - want[k])).toBeLessThan(within));
  const mix = (colors: string[], weights: number[]): number[] => [0, 1, 2].map((k) => colors.reduce((sum, hex, c) => sum + weights[c] * lights(hex)[k], 0));
  const POINTS: [number, number, number][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0.5, 0.5, 0],
    [0, 0.5, 0.5],
    [0.5, 0, 0.5],
    [1 / 3, 1 / 3, 1 / 3],
    [0.1, 0.2, 0.7],
  ];

  it('goes evenly from each corner to the next, drawn the way pictures are', () => {
    const triangles: [string, string, string][] = [
      ['#804020', '#c0a060', '#406080'],
      ['#ffffff', '#000000', '#000000'],
      ['#000000', '#ffffff', '#000000'],
      ['#101010', '#f0f0f0', '#808080'],
      ['#ff0000', '#ffff00', '#00ff00'],
    ];
    const painted = paint(corners(...triangles), triangles.length);
    const p = worn(painted);
    expect(cornerColors(p)).toEqual(triangles);
    // A stored value is a whole number: the fourth pixel of a block is out by half a step at most.
    triangles.forEach((colors, t) => POINTS.forEach((weights) => close(shown(p, t, weights), mix(colors, weights), 0.004)));
  });

  it('shows the same along a side two triangles share', () => {
    const [a, b, c, d] = ['#c02040', '#20c060', '#4060e0', '#e0e020'];
    // The side from b to c, which the first triangle has second and third and the other first and third.
    const painted = paint(corners([a, b, c], [c, d, b]), 2);
    const p = worn(painted);
    for (const along of [0, 0.25, 0.5, 0.75, 1]) close(shown(p, 0, [0, 1 - along, along]), shown(p, 1, [along, 0, 1 - along]), 0.004);
  });

  it('stays near what the corners say where no pixel can hold what an even blend needs', () => {
    // Each corner the only one bright in its channel: whichever comes first, the fourth pixel is cut off at black.
    const colors: [string, string, string] = ['#ff0000', '#00ff00', '#0000ff'];
    const painted = paint(corners(colors), 1);
    const p = worn(painted);
    expect(cornerColors(p)).toEqual([colors]);
    // The two sides at the corner that comes first are exact; the third is off by a quarter of a channel at its middle.
    for (const weights of POINTS) close(shown(p, 0, weights), mix(colors, weights), 0.2501);
    const off = POINTS.slice(3, 6).map((weights) => Math.max(...shown(p, 0, weights).map((v, k) => Math.abs(v - mix(colors, weights)[k]))));
    expect(off.filter((d) => d < 0.004)).toHaveLength(2);
  });

  it('gives triangles of the same three colors one block, whichever corner they begin with', () => {
    const [a, b, c] = ['#102030', '#405060', '#708090'];
    const painted = paint(corners([a, b, c], [b, c, a], [c, a, b], [a, a, c]), 4);
    const picture = pixels(painted.picture!.png);
    // Two blocks, side by side.
    expect([picture.width, picture.height]).toEqual([4, 2]);
    const p = worn(painted);
    expect(cornerColors(p)).toEqual([
      [a, b, c],
      [b, c, a],
      [c, a, b],
      [a, a, c],
    ]);
  });

  it('keeps no more blocks than the picture holds, colors in coarser steps standing in', () => {
    // 6,000 triangles, each with three colors of its own, in a picture with room for 1,024.
    const count = 6000;
    const own = new Uint8Array(count * 9);
    for (let t = 0; t < count; t++) for (let i = 0; i < 9; i++) own[t * 9 + i] = (t * (7 + 2 * i) + i * 37) & 255;
    const painted = paint(own, count, 1024);
    const picture = pixels(painted.picture!.png);
    expect(picture.width).toBeLessThanOrEqual(64);
    expect(picture.height).toBeLessThanOrEqual(64);
    const p = worn(painted);
    const drawn = cornerColors(p);
    expect(drawn).toHaveLength(count);
    // Four steps a channel at the least: every corner within half a step of its own color.
    for (const t of [0, 1, 255, 2048, 5999]) {
      drawn[t].forEach((hex, c) => {
        for (let k = 0; k < 3; k++) expect(Math.abs(parseInt(hex.slice(1 + k * 2, 3 + k * 2), 16) - own[t * 9 + c * 3 + k])).toBeLessThanOrEqual(64);
      });
    }
  });

  it('gives one color and no picture when there is only one', () => {
    expect(paint(corners(['#c86432', '#c86432', '#c86432'], ['#c86432', '#c86432', '#c86432']), 2)).toEqual({ color: '#c86432' });
  });
});

describe('a picture written as PNG', () => {
  it('holds its pixels row by row, under checksums a reader accepts', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    const png = writePng(3, 2, rgb);
    const picture = pixels(png);
    expect([picture.width, picture.height]).toEqual([3, 2]);
    expect(picture.at(0, 0)).toBe('#ff0000');
    expect(picture.at(2, 0)).toBe('#0000ff');
    expect(picture.at(0, 1)).toBe('#0a141e');
    expect(picture.at(2, 1)).toBe('#46505a');
    // The header's checksum, as the PNG specification works it out for this header.
    const view = new DataView(png.buffer);
    expect(view.getUint32(8)).toBe(13);
    expect([png[24], png[25]]).toEqual([8, 2]);
    // And the file ends on the empty closing chunk, whose checksum is always the same.
    expect([...png.subarray(png.length - 12)]).toEqual([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  });
});
