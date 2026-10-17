import type { MeshWithUV } from '../geometry/mesh';
import type { Companion, ImportedImage, ImportedModel, ImportedPart } from './import';
import { ByteReader } from './scan';
import { MeshBuilder } from './weld';

const NEWLINE = 10;
const RETURN = 13;
const SPACE = 32;
const TAB = 9;
const SLASH = 47;
const BACKSLASH = 92;

/** A material from an MTL library: its diffuse color and picture, when it has them. */
interface Material {
  color?: string;
  image?: ImportedImage;
}

/** The faces of one material as they were read: corner vertex and texture indices, six per triangle, resolved at the end. */
interface Bucket {
  name: string | undefined;
  faces: Int32Array;
  length: number;
}

/**
 * Wavefront OBJ: the geometry (`v`, `vt` and `f` lines) and, when its
 * material library and the pictures it names came along, the color and
 * texture of each material (`mtllib`, `usemtl`; `Kd`, `map_Kd`). Each
 * material makes a part of its own. OBJ has no units and no agreed up axis;
 * coordinates are taken as millimeters, as they are.
 */
export function parseObj(bytes: Uint8Array, name = 'Model', companions: Companion[] = []): ImportedModel {
  const n = bytes.length;
  if (n === 0) throw new Error('This OBJ file is empty.');
  const reader = new ByteReader(bytes);
  // UTF-8 byte order mark
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) reader.pos = 3;
  const estimate = Math.ceil(n / 100);
  // Every `v` and `vt` line, in file order, which is how faces refer to them.
  let positions = new Float32Array(Math.max(3, estimate * 3));
  let vertexCount = 0;
  let texcoords = new Float32Array(Math.max(2, estimate * 2));
  let texcoordCount = 0;
  const buckets = new Map<string | undefined, Bucket>();
  let bucket: Bucket = { name: undefined, faces: new Int32Array(6 * 1024), length: 0 };
  buckets.set(undefined, bucket);
  const libraries: string[] = [];
  const polygon: number[] = [];
  let anyTexcoord = false;

  // Steps over blanks within a line; a backslash at the end of a line continues it on the next.
  const skipBlanks = () => {
    for (;;) {
      const c = bytes[reader.pos];
      if (c === SPACE || c === TAB) reader.pos++;
      else if (c === BACKSLASH && (bytes[reader.pos + 1] === NEWLINE || bytes[reader.pos + 1] === RETURN)) {
        reader.pos += bytes[reader.pos + 1] === RETURN && bytes[reader.pos + 2] === NEWLINE ? 3 : 2;
      } else break;
    }
  };
  const lineText = (): string => {
    const end = lineEnd(bytes, reader.pos);
    const text = new TextDecoder().decode(bytes.subarray(reader.pos, end)).trim();
    return text;
  };

  while (reader.pos < n) {
    skipBlanks();
    const c = bytes[reader.pos];
    const c1 = bytes[reader.pos + 1];
    const c2 = bytes[reader.pos + 2];
    const blank1 = c1 === SPACE || c1 === TAB;
    const blank2 = c2 === SPACE || c2 === TAB;
    if (c === 118 && blank1) {
      // v x y z [w] or v x y z r g b
      reader.pos++;
      skipBlanks();
      reader.end = lineEnd(bytes, reader.pos);
      const x = reader.number();
      const y = reader.number();
      const z = reader.number();
      reader.end = n;
      if (vertexCount * 3 === positions.length) positions = growF(positions);
      positions[vertexCount * 3] = x;
      positions[vertexCount * 3 + 1] = y;
      positions[vertexCount * 3 + 2] = z;
      vertexCount++;
    } else if (c === 118 && c1 === 116 && blank2) {
      // vt u v [w]
      reader.pos += 2;
      skipBlanks();
      reader.end = lineEnd(bytes, reader.pos);
      const u = reader.number();
      const v = reader.number();
      reader.end = n;
      if (texcoordCount * 2 === texcoords.length) texcoords = growF(texcoords);
      texcoords[texcoordCount * 2] = u;
      texcoords[texcoordCount * 2 + 1] = v;
      texcoordCount++;
    } else if (c === 102 && blank1) {
      // f v v/vt v/vt/vn v//vn ...: the vertex and, when given, the texture coordinate of each corner.
      reader.pos++;
      polygon.length = 0;
      for (;;) {
        skipBlanks();
        if (reader.pos >= n || bytes[reader.pos] === NEWLINE || bytes[reader.pos] === RETURN) break;
        const index = reader.number();
        if (!Number.isInteger(index)) break;
        // Negative indices count back from the last vertex defined so far.
        const v = index < 0 ? vertexCount + index : index - 1;
        let vt = -1;
        if (bytes[reader.pos] === SLASH) {
          reader.pos++;
          const d = bytes[reader.pos];
          if ((d >= 48 && d <= 57) || d === 45) {
            const t = reader.number();
            if (Number.isInteger(t)) vt = t < 0 ? texcoordCount + t : t - 1;
          }
        }
        polygon.push(v >= 0 && v < 0x7fffffff ? v : -1, vt);
        while (reader.pos < n && bytes[reader.pos] > SPACE && bytes[reader.pos] !== BACKSLASH) reader.pos++;
      }
      for (let i = 4; i < polygon.length; i += 2) {
        if (bucket.length + 6 > bucket.faces.length) bucket.faces = growI(bucket.faces);
        bucket.faces.set([polygon[0], polygon[1], polygon[i - 2], polygon[i - 1], polygon[i], polygon[i + 1]], bucket.length);
        bucket.length += 6;
        if (polygon[1] >= 0 || polygon[i - 1] >= 0 || polygon[i + 1] >= 0) anyTexcoord = true;
      }
    } else if (startsWith(bytes, reader.pos, 'usemtl')) {
      reader.pos += 6;
      const material = lineText() || undefined;
      let found = buckets.get(material);
      if (!found) {
        found = { name: material, faces: new Int32Array(6 * 1024), length: 0 };
        buckets.set(material, found);
      }
      bucket = found;
    } else if (startsWith(bytes, reader.pos, 'mtllib')) {
      reader.pos += 6;
      for (const lib of lineText().split(/\s+/)) if (lib) libraries.push(lib);
    }
    reader.pos = lineEnd(bytes, reader.pos) + 1;
  }

  const materials = loadMaterials(libraries, companions);
  const parts: ImportedPart[] = [];
  const named = [...buckets.values()].filter((b) => b.length > 0);
  let faceCount = 0;
  for (const b of buckets.values()) faceCount += b.length / 6;
  for (const b of named) {
    const builder = new MeshBuilder(Math.max(16, b.length / 6), Math.max(16, b.length / 6));
    // Welded in file order, so that the vertices of the part keep the order the file gave them.
    const used = new Uint8Array(vertexCount);
    for (let i = 0; i < b.length; i += 2) if (b.faces[i] >= 0 && b.faces[i] < vertexCount) used[b.faces[i]] = 1;
    const welded = new Int32Array(vertexCount).fill(-1);
    for (let v = 0; v < vertexCount; v++) if (used[v]) welded[v] = builder.vertex(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    const vertex = (v: number): number => (v < 0 || v >= vertexCount ? -1 : welded[v]);
    const uv: number[] = [];
    for (let i = 0; i < b.length; i += 6) {
      const before = builder.size;
      builder.triangle(vertex(b.faces[i]), vertex(b.faces[i + 2]), vertex(b.faces[i + 4]));
      if (builder.size === before) continue;
      for (const k of [1, 3, 5]) {
        const t = b.faces[i + k];
        const ok = t >= 0 && t < texcoordCount;
        uv.push(ok ? texcoords[t * 2] : 0, ok ? texcoords[t * 2 + 1] : 0);
      }
    }
    if (builder.size === 0) continue;
    const mesh: MeshWithUV = builder.finish();
    if (anyTexcoord && texcoordCount > 0) mesh.uv = Float32Array.from(uv);
    const material = b.name !== undefined ? materials.get(b.name) : undefined;
    const part: ImportedPart = { name: named.length === 1 || b.name === undefined ? name : b.name, mesh };
    if (material?.color) part.color = material.color;
    if (material?.image) part.image = material.image;
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new Error(faceCount ? 'This OBJ file has no usable faces.' : 'This OBJ file has no faces.');
  }
  const used = new Set<string>();
  for (const [, m] of materials) if (m.image) used.add(m.image.name);
  for (const lib of libraries) {
    const companion = findCompanion(companions, lib);
    if (companion) used.add(companion.name);
  }
  return { kind: 'model', parts, used: [...used] };
}

/** The materials of the named libraries, as far as they came along: `Kd` as the color, `map_Kd` as the picture. */
function loadMaterials(libraries: string[], companions: Companion[]): Map<string, Material> {
  const out = new Map<string, Material>();
  for (const lib of libraries) {
    const file = findCompanion(companions, lib);
    if (!file) continue;
    let current: Material | null = null;
    for (const raw of new TextDecoder().decode(file.bytes).split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('newmtl')) {
        current = {};
        out.set(line.slice(6).trim(), current);
      } else if (!current) continue;
      else if (/^Kd\s/i.test(line)) {
        const [r, g, b] = line.slice(2).trim().split(/\s+/).map(Number);
        if ([r, g, b].every((v) => Number.isFinite(v))) current.color = hex(r, g, b);
      } else if (/^map_Kd\s/i.test(line)) {
        // Options (-s, -o, ...) may come first; the file name is the last word.
        const words = line.slice(6).trim().split(/\s+/);
        const image = findCompanion(companions, words[words.length - 1]);
        const mime = image && imageMime(image.name);
        if (image && mime) current.image = { name: image.name, mime, bytes: image.bytes };
      }
    }
  }
  return out;
}

/** A companion file by the name a file refers to it by, ignoring folders and case. */
function findCompanion(companions: Companion[], ref: string): Companion | undefined {
  const base = ref.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
  return base ? companions.find((c) => c.name.replace(/\\/g, '/').split('/').pop()?.toLowerCase() === base) : undefined;
}

export function imageMime(name: string): ImportedImage['mime'] | undefined {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : undefined;
}

/** sRGB hex from channels in 0..1. */
export function hex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function startsWith(bytes: Uint8Array, at: number, word: string): boolean {
  for (let i = 0; i < word.length; i++) if (bytes[at + i] !== word.charCodeAt(i)) return false;
  const next = bytes[at + word.length];
  return next === SPACE || next === TAB;
}

function lineEnd(bytes: Uint8Array, from: number): number {
  const i = bytes.indexOf(NEWLINE, from);
  return i < 0 ? bytes.length : i;
}

function growF(a: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const grown = new Float32Array(a.length * 2);
  grown.set(a);
  return grown;
}

function growI(a: Int32Array): Int32Array {
  const grown = new Int32Array(a.length * 2);
  grown.set(a);
  return grown;
}
