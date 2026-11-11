import type { MeshWithUV } from '../geometry/mesh';
import { tr } from '../i18n';
import type { Companion, ImportedModel, ImportedPart } from './import';
import { baseOf, findCompanion, imageMime } from './material';
import { writePng } from './png';
import { ByteReader } from './scan';
import { cutPolygon, MeshBuilder } from './weld';

type Scalar = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

/** The names a PLY header gives the kinds of number: the old ones and the sized ones. */
const TYPES: Record<string, Scalar> = {
  char: 'int8',
  int8: 'int8',
  uchar: 'uint8',
  uint8: 'uint8',
  short: 'int16',
  int16: 'int16',
  ushort: 'uint16',
  uint16: 'uint16',
  int: 'int32',
  int32: 'int32',
  uint: 'uint32',
  uint32: 'uint32',
  float: 'float32',
  float32: 'float32',
  double: 'float64',
  float64: 'float64',
};

interface Property {
  name: string;
  type: Scalar;
  /** The kind of number that says how long the list is, when the property is a list. */
  count?: Scalar;
}

interface Element {
  name: string;
  count: number;
  properties: Property[];
}

/** The numbers of the body, one after the other, whichever way the file wrote them. */
interface Source {
  next(type: Scalar): number;
}

const incomplete = (): Error => new Error(tr('This PLY file is incomplete: it ends before its last point or face.'));

/** The body of a binary file. */
class Binary implements Source {
  private readonly view: DataView;
  constructor(
    bytes: Uint8Array,
    private pos: number,
    private readonly little: boolean,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  next(type: Scalar): number {
    const { view, little } = this;
    const at = this.pos;
    const size = type === 'int8' || type === 'uint8' ? 1 : type === 'int16' || type === 'uint16' ? 2 : type === 'float64' ? 8 : 4;
    if (at + size > view.byteLength) throw incomplete();
    this.pos = at + size;
    switch (type) {
      case 'int8':
        return view.getInt8(at);
      case 'uint8':
        return view.getUint8(at);
      case 'int16':
        return view.getInt16(at, little);
      case 'uint16':
        return view.getUint16(at, little);
      case 'int32':
        return view.getInt32(at, little);
      case 'uint32':
        return view.getUint32(at, little);
      case 'float32':
        return view.getFloat32(at, little);
      default:
        return view.getFloat64(at, little);
    }
  }
}

/** The body of a text file: numbers with blanks between them. */
class Text implements Source {
  private readonly reader: ByteReader;
  constructor(bytes: Uint8Array, pos: number) {
    this.reader = new ByteReader(bytes);
    this.reader.pos = pos;
  }
  next(): number {
    const { reader } = this;
    const value = reader.number();
    if (!Number.isNaN(value)) return value;
    reader.skipSpace();
    if (reader.pos >= reader.end) throw incomplete();
    // A word that is no number ("nan", "inf"): the point it belongs to is dropped with its faces.
    reader.skipToken();
    return NaN;
  }
}

/** Where a property of a point goes: x, y, z, then red, green, blue, then the two texture coordinates. */
const VERTEX_SLOTS: Record<string, number> = {
  x: 0,
  y: 1,
  z: 2,
  red: 3,
  green: 4,
  blue: 5,
  r: 3,
  g: 4,
  b: 5,
  diffuse_red: 3,
  diffuse_green: 4,
  diffuse_blue: 5,
  s: 6,
  t: 7,
  u: 6,
  v: 7,
  texture_u: 6,
  texture_v: 7,
  texture_s: 6,
  texture_t: 7,
};
const FACE_COLOR: Record<string, number> = { red: 0, green: 1, blue: 2, r: 0, g: 1, b: 2, diffuse_red: 0, diffuse_green: 1, diffuse_blue: 2 };
const INDEX_LISTS = ['vertex_indices', 'vertex_index'];

/** What multiplies a color written as this kind of number to give 0 to 255. */
const colorScale = (type: Scalar): number => (type === 'float32' || type === 'float64' ? 255 : type === 'uint16' || type === 'int16' ? 1 / 257 : 1);
const byte = (v: number): number => (v >= 255 ? 255 : v > 0 ? Math.round(v) : 0);

/** Splits the header off: its lines, and where the body begins. */
function header(bytes: Uint8Array): { lines: string[]; body: number } {
  // The header is text whatever the body is; a megabyte of it is more than any file has.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1 << 20));
  if (!/^ply\s*\r?\n/.test(head)) throw new Error(tr('This is not a PLY file.'));
  const end = /(^|\n)end_header[ \t]*(\r?\n|$)/.exec(head);
  if (!end) throw new Error(tr('This PLY file is damaged: its header has no end.'));
  return { lines: head.slice(0, end.index).split(/\r?\n/), body: end.index + end[0].length };
}

/**
 * Stanford PLY, as scanners and mesh tools write it: text or binary, either
 * byte order. The points and faces make one part. Its colors, which a PLY
 * file gives point by point or face by face, come in as a picture the part
 * wears: a face the file gives a color is that color all over, and one whose
 * points have colors goes from each corner's color to the next; a file that
 * names a picture for its texture coordinates wears that picture instead,
 * when it came along. PLY has no units: millimeters are taken, as they are.
 */
export function parsePly(bytes: Uint8Array, name = 'Model', companions: Companion[] = []): ImportedModel {
  if (bytes.length === 0) throw new Error(tr('This PLY file is empty.'));
  const { lines, body } = header(bytes);
  let format = '';
  const elements: Element[] = [];
  const textures: string[] = [];
  for (const line of lines.slice(1)) {
    const words = line.trim().split(/\s+/);
    if (words[0] === 'format') format = words[1] ?? '';
    else if (words[0] === 'comment' && /^texturefile$/i.test(words[1] ?? '')) {
      const file = line.trim().replace(/^comment\s+\S+\s*/, '');
      if (file) textures.push(file);
    } else if (words[0] === 'element') {
      const count = Number(words[2]);
      if (!words[1] || !Number.isInteger(count) || count < 0) throw new Error(tr('This PLY file is damaged: its header cannot be read.'));
      elements.push({ name: words[1], count, properties: [] });
    } else if (words[0] === 'property') {
      const element = elements[elements.length - 1];
      const list = words[1] === 'list';
      const type = TYPES[list ? words[3] : words[1]];
      const count = list ? TYPES[words[2]] : undefined;
      const property = list ? words[4] : words[2];
      if (!element || !type || !property || (list && !count)) throw new Error(tr('This PLY file is damaged: its header cannot be read.'));
      element.properties.push(list ? { name: property, type, count } : { name: property, type });
    }
  }
  if (format !== 'ascii' && format !== 'binary_little_endian' && format !== 'binary_big_endian') throw new Error(tr('This PLY file is damaged: its header cannot be read.'));
  const source: Source = format === 'ascii' ? new Text(bytes, body) : new Binary(bytes, body, format === 'binary_little_endian');
  const vertexElement = elements.find((e) => e.name === 'vertex');
  const faceElement = elements.find((e) => e.name === 'face');
  if (!vertexElement || vertexElement.count === 0) throw new Error(tr('This PLY file has no points.'));
  if (!faceElement || faceElement.count === 0 || !faceElement.properties.some((p) => p.count && INDEX_LISTS.includes(p.name))) {
    throw new Error(tr('This PLY file holds points with no faces between them, which cannot be made into a solid.'));
  }
  // Every point and every face takes room in the file: a count beyond its length is a header gone wrong.
  for (const element of [vertexElement, faceElement]) if (element.count > bytes.length) throw incomplete();

  // The points: where they are and, when the file says, their color and their place on a picture.
  const vertexCount = vertexElement.count;
  const positions = new Float32Array(vertexCount * 3);
  const has = (element: Element, slots: Record<string, number>, from: number, to: number): boolean => {
    const found = new Set(element.properties.filter((p) => !p.count && slots[p.name] >= from && slots[p.name] <= to).map((p) => slots[p.name]));
    return found.size === to - from + 1;
  };
  if (!has(vertexElement, VERTEX_SLOTS, 0, 2)) throw new Error(tr('This PLY file has no points.'));
  const vertexColors = has(vertexElement, VERTEX_SLOTS, 3, 5) ? new Uint8Array(vertexCount * 3) : null;
  const vertexUV = has(vertexElement, VERTEX_SLOTS, 6, 7) ? new Float32Array(vertexCount * 2) : null;

  // The faces as written: how many corners each has, the corners one after the other, and what goes with them.
  const faceCount = faceElement.count;
  const sizes = new Uint32Array(faceCount);
  let corners = new Int32Array(Math.max(16, faceCount * 3));
  let cornerCount = 0;
  const cornerUVs = faceElement.properties.some((p) => p.count && p.name === 'texcoord');
  let coords = new Float32Array(cornerUVs ? corners.length * 2 : 0);
  const faceColors = has(faceElement, FACE_COLOR, 0, 2) ? new Uint8Array(faceCount * 3) : null;

  // The picture the texture coordinates are for, when the file names one and it came along.
  const anyUV = vertexUV !== null || cornerUVs;
  const picture = anyUV && textures.length ? findCompanion(companions, textures[0]) : undefined;
  const mime = picture && imageMime(picture.name);
  const textured = picture !== undefined && mime !== undefined;
  const colored = !textured && (vertexColors !== null || faceColors !== null);

  const row = new Float64Array(8);
  for (const element of elements) {
    if (element === vertexElement) {
      const slots = element.properties.map((p) => (p.count ? -1 : (VERTEX_SLOTS[p.name] ?? -1)));
      const scales = element.properties.map((p, i) => (slots[i] >= 3 && slots[i] <= 5 ? colorScale(p.type) : 1));
      for (let v = 0; v < vertexCount; v++) {
        for (let k = 0; k < slots.length; k++) {
          const p = element.properties[k];
          if (p.count) {
            const n = source.next(p.count);
            if (!(n >= 0)) throw new Error(tr('This PLY file is damaged: a list has no length.'));
            for (let i = 0; i < n; i++) source.next(p.type);
          } else {
            const value = source.next(p.type);
            if (slots[k] >= 0) row[slots[k]] = value * scales[k];
          }
        }
        positions[v * 3] = row[0];
        positions[v * 3 + 1] = row[1];
        positions[v * 3 + 2] = row[2];
        if (vertexColors) {
          vertexColors[v * 3] = byte(row[3]);
          vertexColors[v * 3 + 1] = byte(row[4]);
          vertexColors[v * 3 + 2] = byte(row[5]);
        }
        if (vertexUV) {
          vertexUV[v * 2] = row[6];
          vertexUV[v * 2 + 1] = row[7];
        }
      }
    } else if (element === faceElement) {
      const given: number[] = [];
      for (let f = 0; f < faceCount; f++) {
        let size = 0;
        given.length = 0;
        for (const p of element.properties) {
          if (!p.count) {
            const value = source.next(p.type);
            const slot = FACE_COLOR[p.name];
            if (faceColors && slot !== undefined) faceColors[f * 3 + slot] = byte(value * colorScale(p.type));
            continue;
          }
          const n = source.next(p.count);
          if (!(n >= 0)) throw new Error(tr('This PLY file is damaged: a list has no length.'));
          if (INDEX_LISTS.includes(p.name)) {
            size = n;
            while (cornerCount + n > corners.length) corners = grow(corners);
            for (let i = 0; i < n; i++) {
              const index = source.next(p.type);
              corners[cornerCount + i] = Number.isInteger(index) && index >= 0 && index < vertexCount ? index : -1;
            }
          } else if (p.name === 'texcoord') {
            for (let i = 0; i < n; i++) given.push(source.next(p.type));
          } else for (let i = 0; i < n; i++) source.next(p.type);
        }
        if (cornerUVs) {
          // Two for each corner, kept beside the corners; coordinates that do not go two to a corner are none.
          while ((cornerCount + size) * 2 > coords.length) coords = grow(coords);
          if (given.length === size * 2) coords.set(given, cornerCount * 2);
        }
        sizes[f] = size;
        cornerCount += size;
      }
    } else {
      // Something else (edges, a camera, a material): stepped over to reach what follows it.
      for (let i = 0; i < element.count; i++) {
        for (const p of element.properties) {
          const n = p.count ? source.next(p.count) : 1;
          if (!(n >= 0)) throw new Error(tr('This PLY file is damaged: a list has no length.'));
          for (let k = 0; k < n; k++) source.next(p.type);
        }
      }
    }
    // Nothing after the points and the faces is of use.
    if (element === elements[Math.max(elements.indexOf(vertexElement), elements.indexOf(faceElement))]) break;
  }

  // The points the faces use, joined where they are at one place, in the order the file has them.
  const used = new Uint8Array(vertexCount);
  for (let i = 0; i < cornerCount; i++) if (corners[i] >= 0) used[corners[i]] = 1;
  const builder = new MeshBuilder(vertexCount, cornerCount);
  const welded = new Int32Array(vertexCount).fill(-1);
  for (let v = 0; v < vertexCount; v++) if (used[v]) welded[v] = builder.vertex(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);

  // The triangles, with what each keeps: its place on the picture, or the colors of its three corners.
  const uv: number[] = [];
  let colors = new Uint8Array(colored ? Math.max(144, cornerCount * 9) : 0);
  const outline: number[] = [];
  let at = 0;
  for (let f = 0; f < faceCount; f++) {
    const size = sizes[f];
    const first = at;
    at += size;
    if (size < 3) continue;
    // A fan around the first corner, unless the face is not convex.
    let cut: number[] | null = null;
    if (size > 3) {
      outline.length = 0;
      for (let i = 0; i < size; i++) {
        const v = corners[first + i];
        if (v < 0) break;
        outline.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
      }
      if (outline.length === size * 3) cut = cutPolygon(outline);
    }
    const count = cut ? cut.length / 3 : size - 2;
    for (let t = 0; t < count; t++) {
      const local = cut ? [cut[t * 3], cut[t * 3 + 1], cut[t * 3 + 2]] : [0, t + 1, t + 2];
      const [a, b, c] = local.map((k) => corners[first + k]);
      const before = builder.size;
      builder.triangle(a < 0 ? -1 : welded[a], b < 0 ? -1 : welded[b], c < 0 ? -1 : welded[c]);
      if (builder.size === before) continue;
      if (textured) {
        for (const k of local) {
          const v = corners[first + k];
          if (cornerUVs) uv.push(coords[(first + k) * 2], coords[(first + k) * 2 + 1]);
          else uv.push(vertexUV![v * 2], vertexUV![v * 2 + 1]);
        }
      } else if (colored) {
        const o = before * 9;
        if (o + 9 > colors.length) colors = grow(colors);
        // The face's own color at every corner, or each corner's own.
        const from = faceColors ? [f * 3, f * 3, f * 3] : [a * 3, b * 3, c * 3];
        const source = faceColors ?? vertexColors!;
        for (let corner = 0; corner < 3; corner++) for (let k = 0; k < 3; k++) colors[o + corner * 3 + k] = source[from[corner] + k];
      }
    }
  }
  if (builder.size === 0) throw new Error(tr('This PLY file has no usable faces.'));
  const mesh: MeshWithUV = builder.finish();
  const part: ImportedPart = { name, mesh };
  const model: ImportedModel = { kind: 'model', parts: [part], used: [] };
  if (textured) {
    mesh.uv = Float32Array.from(uv);
    part.image = { name: picture.name, mime, bytes: picture.bytes };
    model.used.push(picture.name);
  } else {
    if (anyUV && textures.length) model.missing = [baseOf(textures[0])];
    if (colored) {
      const painted = paint(colors, builder.size);
      part.color = painted.color;
      if (painted.picture) {
        mesh.uv = painted.picture.uv;
        part.image = { name: `${name}.png`, mime: 'image/png', bytes: painted.picture.png };
      }
    }
  }
  return model;
}

function grow<T extends Int32Array | Float32Array | Uint8Array>(a: T): T {
  const grown = new (a.constructor as new (n: number) => T)(Math.max(16, a.length * 2));
  grown.set(a);
  return grown;
}

/** The most colors the picture of a part's faces holds, when each face has one: 256 by 256 of them. */
const PALETTE = 65536;
/** The most triangles' worth of corner colors the picture holds, when colors run across the faces: 1024 by 1024. */
const BLOCKS = 1 << 20;

/** A byte with its bits spread three apart, to weave three channels into one number. */
const SPREAD = new Uint32Array(256);
for (let v = 0; v < 256; v++) for (let bit = 0; bit < 8; bit++) if (v & (1 << bit)) SPREAD[v] |= 1 << (bit * 3);
/** A color as one number in which colors near each other are near each other. */
const weave = (r: number, g: number, b: number): number => (SPREAD[r] << 2) | (SPREAD[g] << 1) | SPREAD[b];

/** How bright each value of a channel is, 0 to 1: a picture is blended in light, not in the values it is stored in. */
const LIGHT = new Float64Array(256);
for (let v = 0; v < 256; v++) LIGHT[v] = v <= 10 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4;
/** The value of a channel that is nearest a brightness. */
const stored = (light: number): number => byte((light <= 0.0031308 ? light * 12.92 : 1.055 * light ** (1 / 2.4) - 0.055) * 255);

const hex = (r: number, g: number, b: number): string => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

export interface Painted {
  color: string;
  picture?: { png: Uint8Array; uv: Float32Array };
}

/**
 * The colors of a part's triangles (nine bytes each: red, green and blue at
 * each corner) as the design keeps them: the one color when there is only
 * one, or else their mean and a picture, with for every corner of every
 * triangle its place on it. Triangles that are each one color all over share
 * a picture that holds each color once (`paintFlat`); as soon as one goes
 * from a color to another, the picture holds the corners (`paintBlended`).
 */
export function paint(colors: Uint8Array, count: number, blocks = BLOCKS): Painted {
  const sum = [0, 0, 0];
  let flat = true;
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    for (let i = 0; i < 9; i++) sum[i % 3] += colors[o + i];
    if (flat) for (let i = 3; i < 9; i++) if (colors[o + i] !== colors[o + (i % 3)]) flat = false;
  }
  const color = hex(Math.round(sum[0] / (count * 3)), Math.round(sum[1] / (count * 3)), Math.round(sum[2] / (count * 3)));
  const picture = flat ? paintFlat(colors, count) : paintBlended(colors, count, blocks);
  return picture ? { color, picture } : { color };
}

/**
 * A picture that holds each color once, with every corner of a triangle at
 * the middle of the pixel of its color: a triangle whose corners are all at
 * one pixel's middle is that color all over, however the picture is drawn.
 * Colors near each other sit near each other in the picture, so that one
 * scaled down still looks right. Nothing, when there is one color only.
 */
function paintFlat(colors: Uint8Array, count: number): Painted['picture'] {
  // Coarser steps, when there are more colors than the picture holds: no scan has that many that the eye tells apart.
  let bits = 8;
  let places = new Map<number, number>();
  const key = (t: number): number => {
    let k = 0;
    for (let c = 0; c < 3; c++) {
      const top = colors[t * 9 + c] >> (8 - bits);
      k = (k << 8) | (bits === 8 ? top : (top << (8 - bits)) | (top >> (2 * bits - 8)));
    }
    return k;
  };
  for (;;) {
    places = new Map();
    for (let t = 0; t < count && places.size <= PALETTE; t++) places.set(key(t), 0);
    if (places.size <= PALETTE) break;
    bits--;
  }
  if (places.size === 1) return undefined;

  const order = [...places.keys()].sort((p, q) => weave(p >> 16, (p >> 8) & 0xff, p & 0xff) - weave(q >> 16, (q >> 8) & 0xff, q & 0xff));
  let width = 2;
  while (width * width < order.length) width *= 2;
  const height = Math.ceil(order.length / width);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    // What is left of the last row repeats the last color.
    const k = order[Math.min(i, order.length - 1)];
    rgb[i * 3] = k >> 16;
    rgb[i * 3 + 1] = (k >> 8) & 0xff;
    rgb[i * 3 + 2] = k & 0xff;
    if (i < order.length) places.set(k, i);
  }
  const uv = new Float32Array(count * 6);
  for (let t = 0; t < count; t++) {
    const place = places.get(key(t))!;
    const u = ((place % width) + 0.5) / width;
    // Texture coordinates go up from the bottom of the picture, its rows down from the top.
    const v = 1 - (Math.floor(place / width) + 0.5) / height;
    for (let c = 0; c < 3; c++) {
      uv[t * 6 + c * 2] = u;
      uv[t * 6 + c * 2 + 1] = v;
    }
  }
  return { png: writePng(width, height, rgb), uv };
}

/** How far outside what a pixel can hold a brightness is. */
const beyond = (light: number): number => (light < 0 ? -light : light > 1 ? light - 1 : 0);

/**
 * A picture that holds, for each triangle, a block of two pixels by two:
 * one corner's color, the next one's beside it, the third's under it, and
 * the triangle's corners at the middles of those three pixels. Drawn the way
 * pictures are, each point between pixel middles a blend of the four around
 * it, the triangle goes evenly from each corner's color to the next: the
 * fourth pixel is given the color that leaves the blend of the other three
 * as it is (the second and third less the first, in light).
 *
 * That color can be brighter than white or darker than black, and the pixel
 * then holds the nearest there is. The corner that comes first is the one
 * that keeps it within reach, or nearest to it: there is one that does for
 * all but triangles whose corners are each the brightest in a channel of
 * their own (pure red, green and blue), which come out a little off toward
 * the side across from the first corner, by a quarter of the excess at most.
 *
 * Triangles with the same three colors share a block, and blocks of colors
 * near each other sit near each other, so that the picture scaled down still
 * looks right: at half its size, each block is one color.
 */
function paintBlended(colors: Uint8Array, count: number, blocks: number): Painted['picture'] {
  const stepped = new Uint8Array(count * 9);
  /** Which corner of each triangle comes first in its block. */
  const first = new Uint8Array(count);
  const order = new Uint32Array(count);
  const rank = new Uint32Array(count);
  const block = new Uint32Array(count);
  const differ = (p: number, q: number): number => {
    for (let i = 0; i < 9; i++) if (stepped[p * 9 + i] !== stepped[q * 9 + i]) return stepped[p * 9 + i] - stepped[q * 9 + i];
    return 0;
  };
  const step = new Uint8Array(256);
  const light = new Float64Array(9);
  let used = 0;
  // Coarser steps, when there are more triangles of colors of their own than the picture holds.
  for (let bits = 8; ; bits--) {
    const top = (1 << bits) - 1;
    for (let v = 0; v < 256; v++) step[v] = Math.round(((v >> (8 - bits)) * 255) / top);
    for (let t = 0; t < count; t++) {
      const o = t * 9;
      for (let i = 0; i < 9; i++) light[i] = LIGHT[step[colors[o + i]]];
      // The corner that keeps the fourth pixel within reach; of several that do, the one that puts the darkest
      // color first, so that triangles with the same three colors are the same whichever corner they begin with.
      let best = 0;
      let least = Infinity;
      for (let corner = 0; corner < 3; corner++) {
        const [a, b, c] = [corner * 3, ((corner + 1) % 3) * 3, ((corner + 2) % 3) * 3];
        const excess = beyond(light[b] + light[c] - light[a]) + beyond(light[b + 1] + light[c + 1] - light[a + 1]) + beyond(light[b + 2] + light[c + 2] - light[a + 2]);
        let sooner = excess < least;
        if (excess === least) {
          for (let i = 0; i < 9; i++) {
            const d = step[colors[o + ((a + i) % 9)]] - step[colors[o + ((best * 3 + i) % 9)]];
            if (d !== 0) {
              sooner = d < 0;
              break;
            }
          }
        }
        if (sooner) {
          least = excess;
          best = corner;
        }
      }
      first[t] = best;
      const sum = [0, 0, 0];
      for (let i = 0; i < 9; i++) {
        const value = step[colors[o + ((best * 3 + i) % 9)]];
        stepped[o + i] = value;
        sum[i % 3] += value;
      }
      order[t] = t;
      rank[t] = weave(Math.round(sum[0] / 3), Math.round(sum[1] / 3), Math.round(sum[2] / 3));
    }
    order.sort((p, q) => rank[p] - rank[q] || differ(p, q));
    used = 0;
    for (let i = 0; i < count; i++) {
      if (i === 0 || differ(order[i], order[i - 1]) !== 0) used++;
      block[order[i]] = used - 1;
    }
    if (used <= blocks || bits === 1) break;
  }

  let across = 1;
  while (across * across < used) across *= 2;
  const down = Math.ceil(used / across);
  const width = across * 2;
  const height = down * 2;
  const rgb = new Uint8Array(width * height * 3);
  const put = (place: number, t: number): void => {
    const x = (place % across) * 2;
    const y = Math.floor(place / across) * 2;
    const o = t * 9;
    for (let k = 0; k < 3; k++) {
      const [a, b, c] = [stepped[o + k], stepped[o + 3 + k], stepped[o + 6 + k]];
      rgb[(y * width + x) * 3 + k] = a;
      rgb[(y * width + x + 1) * 3 + k] = b;
      rgb[((y + 1) * width + x) * 3 + k] = c;
      rgb[((y + 1) * width + x + 1) * 3 + k] = stored(LIGHT[b] + LIGHT[c] - LIGHT[a]);
    }
  };
  for (let i = 0; i < count; i++) {
    const t = order[i];
    if (i === 0 || block[t] !== block[order[i - 1]]) put(block[t], t);
  }
  // What is left of the last row repeats the last block.
  for (let place = used; place < across * down; place++) put(place, order[count - 1]);

  const uv = new Float32Array(count * 6);
  for (let t = 0; t < count; t++) {
    const x = (block[t] % across) * 2;
    const y = Math.floor(block[t] / across) * 2;
    for (let corner = 0; corner < 3; corner++) {
      // Where the corner is in the block: 0 the first pixel, 1 the one beside it, 2 the one under it.
      const slot = (corner + 3 - first[t]) % 3;
      uv[t * 6 + corner * 2] = (x + (slot === 1 ? 1.5 : 0.5)) / width;
      // Texture coordinates go up from the bottom of the picture, its rows down from the top.
      uv[t * 6 + corner * 2 + 1] = 1 - (y + (slot === 2 ? 1.5 : 0.5)) / height;
    }
  }
  return { png: writePng(width, height, rgb), uv };
}
