import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { MeshData } from '../geometry/mesh';
import { fileKind, importFile } from './import';
import type { Companion, ImportedModel, ImportedPart } from './import';
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

/** The color the picture of a part holds for each of its triangles, read at the triangle's corners. */
function faceColors(p: ImportedPart): string[] {
  const picture = pixels(p.image!.bytes);
  const uv = p.mesh.uv!;
  expect(uv.length).toBe(p.mesh.triangles.length * 2);
  const out: string[] = [];
  for (let t = 0; t < uv.length / 6; t++) {
    const corner = (c: number): string => {
      const x = uv[t * 6 + c * 2] * picture.width - 0.5;
      const y = (1 - uv[t * 6 + c * 2 + 1]) * picture.height - 0.5;
      // The middle of a pixel, where every way of drawing the picture gives the pixel's own color.
      expect(Math.abs(x - Math.round(x))).toBeLessThan(1e-3);
      expect(Math.abs(y - Math.round(y))).toBeLessThan(1e-3);
      return picture.at(Math.round(x), Math.round(y));
    };
    expect(corner(1)).toBe(corner(0));
    expect(corner(2)).toBe(corner(0));
    out.push(corner(0));
  }
  return out;
}

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

  it('paints the colors of the points onto a picture, each face the mean of its corners', () => {
    const p = part(tetra(RGB, ['255 0 0', '0 255 0', '0 0 255', '255 255 255']));
    expect(p.image?.mime).toBe('image/png');
    expect(p.image?.name).toBe('scan.png');
    // Faces 0 2 1, 0 1 3, 1 2 3 and 0 3 2.
    expect(faceColors(p)).toEqual(['#555555', '#aaaa55', '#55aaaa', '#aa55aa']);
    // The part's own color, for where a picture does not go, is the mean of them all.
    expect(p.color).toBe('#808080');
    expect(isClosed(p.mesh)).toBe(true);
  });

  it('takes colors written as fractions or as sixteen bits', () => {
    const fractions = part(tetra(['property float red', 'property float green', 'property float blue'], ['1 0 0', '1 0 0', '1 0 0', '0 0 1']));
    expect(faceColors(fractions)).toEqual(['#ff0000', '#aa0055', '#aa0055', '#aa0055']);
    const wide = part(tetra(['property ushort red', 'property ushort green', 'property ushort blue'], ['65535 0 0', '65535 0 0', '65535 0 0', '0 0 65535']));
    expect(faceColors(wide)).toEqual(['#ff0000', '#aa0055', '#aa0055', '#aa0055']);
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
    expect(faceColors(bare.parts[0])).toHaveLength(4);
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
