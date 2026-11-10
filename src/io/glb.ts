// glTF 2.0 binary (.glb): the one export that carries colors, textures and
// pictures along with the mesh. One node per object, each with its own
// material; images go in as the PNG or JPEG they are. glTF is Y up and in
// meters, so Z-up millimeters are turned on the way out.
import { APP_NAME } from '../appInfo';
import { determinant } from '../model/math';
import type { Mat } from '../model/math';

export interface GlbObject {
  name: string;
  /** Objects with the same key are the parts of one thing: they become the primitives of one mesh, under one node. */
  of?: string;
  /** Unindexed corners, three per triangle, in the object's built frame; `matrix` places them (mm, Z up). */
  positions: Float32Array;
  normals: Float32Array;
  matrix: Mat;
  /** Hex color, used as the base color factor, or the fill under a picture. */
  color: string;
  /** Texture coordinates per corner (v up), with the picture to sample. */
  skin?: { uv: Float32Array; image: Uint8Array; mime: 'image/png' | 'image/jpeg'; repeat: boolean };
  /** Linear RGB per corner, for an object whose parts have colors of their own; the base color is then white. */
  colors?: Float32Array;
}

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT = 5126;
const ARRAY_BUFFER = 34962;
const LINEAR = 9729;
const LINEAR_MIPMAP_LINEAR = 9987;
const CLAMP_TO_EDGE = 33071;
const REPEAT = 10497;

/** sRGB hex to linear RGB, as glTF wants its factors. */
export function linearColor(hex: string): [number, number, number] {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [channel(0), channel(1), channel(2)];
}

const pad = (n: number, to = 4) => (to - (n % to)) % to;

export function writeGlb(objects: GlbObject[], name: string): Uint8Array {
  const views: { bytes: Uint8Array; target?: number }[] = [];
  // The same picture is embedded once however many parts wear it. It is known by its bytes, not by the array they
  // come in: pictures of one length are few, and are compared byte for byte.
  const embedded = new Map<number, { bytes: Uint8Array; image: number }[]>();
  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a === b) return true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const accessors: Record<string, unknown>[] = [];
  const images: Record<string, unknown>[] = [];
  const textures: Record<string, unknown>[] = [];
  const samplers: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];

  const view = (bytes: Uint8Array, target?: number): number => {
    views.push({ bytes, target });
    return views.length - 1;
  };
  const accessor = (data: Float32Array, size: 2 | 3, bounds: boolean): number => {
    const index = view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), ARRAY_BUFFER);
    const a: Record<string, unknown> = { bufferView: index, componentType: FLOAT, count: data.length / size, type: size === 3 ? 'VEC3' : 'VEC2' };
    if (bounds) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.length; i += 3)
        for (let k = 0; k < 3; k++) {
          if (data[i + k] < min[k]) min[k] = data[i + k];
          if (data[i + k] > max[k]) max[k] = data[i + k];
        }
      a.min = min;
      a.max = max;
    }
    accessors.push(a);
    return accessors.length - 1;
  };

  for (const o of objects) {
    const { positions, normals, flipped } = placed(o);
    const attributes: Record<string, number> = { POSITION: accessor(positions, 3, true), NORMAL: accessor(normals, 3, false) };
    const material: Record<string, unknown> = { name: o.name, pbrMetallicRoughness: { baseColorFactor: [...linearColor(o.color), 1], metallicFactor: 0, roughnessFactor: 0.6 } };
    if (o.colors) {
      // Every corner of a triangle has the same color, so a mirrored placement turning the corners round changes nothing.
      attributes.COLOR_0 = accessor(o.colors, 3, false);
      (material.pbrMetallicRoughness as Record<string, unknown>).baseColorFactor = [1, 1, 1, 1];
    }
    if (o.skin) {
      // v runs up in our coordinates and down in glTF's; a mirrored placement has turned the corners round too.
      const uv = new Float32Array(o.skin.uv.length);
      for (let i = 0; i < uv.length; i += 6) {
        for (let c = 0; c < 3; c++) {
          const from = flipped ? i + ((c === 0 ? 0 : 3 - c) * 2) : i + c * 2;
          uv[i + c * 2] = o.skin.uv[from];
          uv[i + c * 2 + 1] = 1 - o.skin.uv[from + 1];
        }
      }
      attributes.TEXCOORD_0 = accessor(uv, 2, false);
      const bytes = o.skin.image;
      const mime = o.skin.mime;
      const ofLength = embedded.get(bytes.length) ?? [];
      let image = ofLength.find((e) => images[e.image].mimeType === mime && sameBytes(e.bytes, bytes))?.image;
      if (image === undefined) {
        images.push({ bufferView: view(bytes), mimeType: mime, name: o.name });
        image = images.length - 1;
        ofLength.push({ bytes, image });
        embedded.set(bytes.length, ofLength);
      }
      const wrap = o.skin.repeat ? REPEAT : CLAMP_TO_EDGE;
      samplers.push({ magFilter: LINEAR, minFilter: LINEAR_MIPMAP_LINEAR, wrapS: wrap, wrapT: wrap });
      textures.push({ sampler: samplers.length - 1, source: image });
      (material.pbrMetallicRoughness as Record<string, unknown>).baseColorFactor = [1, 1, 1, 1];
      (material.pbrMetallicRoughness as Record<string, unknown>).baseColorTexture = { index: textures.length - 1 };
    }
    materials.push(material);
    const primitive = { attributes, material: materials.length - 1 };
    const last = meshes[meshes.length - 1] as { primitives: unknown[]; of?: string } | undefined;
    if (o.of !== undefined && last && last.of === o.of) {
      last.primitives.push(primitive);
      continue;
    }
    meshes.push({ name: o.name, primitives: [primitive], ...(o.of !== undefined ? { of: o.of } : {}) });
    nodes.push({ name: o.name, mesh: meshes.length - 1 });
  }
  for (const mesh of meshes) delete mesh.of;

  // The binary chunk: every view four-byte aligned.
  let offset = 0;
  const bufferViews = views.map((v) => {
    const entry: Record<string, unknown> = { buffer: 0, byteOffset: offset, byteLength: v.bytes.length };
    if (v.target !== undefined) entry.target = v.target;
    offset += v.bytes.length + pad(v.bytes.length);
    return entry;
  });
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const v of views) {
    bin.set(v.bytes, at);
    at += v.bytes.length + pad(v.bytes.length);
  }

  const gltf = {
    asset: { version: '2.0', generator: `${APP_NAME}` },
    scene: 0,
    scenes: [{ name, nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    ...(textures.length ? { textures, images, samplers } : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = json.length + pad(json.length);
  const total = 12 + 8 + jsonLength + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, JSON_CHUNK, true);
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + jsonLength);
  dv.setUint32(20 + jsonLength, bin.length, true);
  dv.setUint32(24 + jsonLength, BIN_CHUNK, true);
  out.set(bin, 28 + jsonLength);
  return out;
}

/** The corners placed in the world, in meters, Y up; a mirrored placement has its triangles turned back outwards. */
function placed(o: GlbObject): { positions: Float32Array; normals: Float32Array; flipped: boolean } {
  const m = o.matrix;
  const flipped = determinant(m) < 0;
  // Normals go through the inverse transpose of the linear part, which is the
  // cofactor matrix divided by the determinant: a mirror's negative determinant
  // would otherwise turn every normal inside out.
  const [a, b, c, d, e, f, g, h, i] = m;
  const sign = flipped ? -1 : 1;
  const cof = [e * i - f * h, f * g - d * i, d * h - e * g, c * h - b * i, a * i - c * g, b * g - a * h, b * f - c * e, c * d - a * f, a * e - b * d].map((v) => v * sign);
  const n = o.positions.length / 3;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  for (let t = 0; t < n; t += 3) {
    for (let k = 0; k < 3; k++) {
      // Reversing the corner order of every triangle undoes the mirror.
      const src = (t + (flipped ? (k === 0 ? 0 : 3 - k) : k)) * 3;
      const dst = (t + k) * 3;
      const [x, y, z] = [o.positions[src], o.positions[src + 1], o.positions[src + 2]];
      const wx = (m[0] * x + m[3] * y + m[6] * z + m[9]) / 1000;
      const wy = (m[1] * x + m[4] * y + m[7] * z + m[10]) / 1000;
      const wz = (m[2] * x + m[5] * y + m[8] * z + m[11]) / 1000;
      positions.set([wx, wz, -wy], dst);
      const [nx, ny, nz] = [o.normals[src], o.normals[src + 1], o.normals[src + 2]];
      let tx = cof[0] * nx + cof[3] * ny + cof[6] * nz;
      let ty = cof[1] * nx + cof[4] * ny + cof[7] * nz;
      let tz = cof[2] * nx + cof[5] * ny + cof[8] * nz;
      const len = Math.hypot(tx, ty, tz) || 1;
      tx /= len;
      ty /= len;
      tz /= len;
      normals.set([tx, tz, -ty], dst);
    }
  }
  return { positions, normals, flipped };
}

/** The JSON and binary chunks of a .glb, for tests and for anything that wants to look inside one. */
export function readGlb(bytes: Uint8Array): { json: Record<string, unknown>; bin: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Not a glTF binary');
  const jsonLength = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Record<string, unknown>;
  const binLength = dv.getUint32(20 + jsonLength, true);
  return { json, bin: bytes.subarray(28 + jsonLength, 28 + jsonLength + binLength) };
}
