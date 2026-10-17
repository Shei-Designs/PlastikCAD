// glTF 2.0, binary (.glb) or JSON with its buffers embedded (.gltf): every
// mesh of the scene, placed by its nodes, one part per primitive with the
// color and picture of its material and the texture coordinates it carries.
// glTF is Y up in meters; parts come out Z up in millimeters.
import type { MeshWithUV } from '../geometry/mesh';
import { determinant, multiply } from '../model/math';
import type { Mat } from '../model/math';
import { base64ToBytes } from './base64';
import type { ImportedImage, ImportedModel, ImportedPart } from './import';
import { hex, imageMime } from './importObj';
import { MeshBuilder } from './weld';

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const MAX_TRIANGLES = 20_000_000;
const MAX_NODES = 100_000;
const MAX_DEPTH = 64;

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

interface Gltf {
  asset?: { version?: string };
  extensionsRequired?: string[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
  materials?: {
    name?: string;
    pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index: number } };
    extensions?: { KHR_materials_pbrSpecularGlossiness?: { diffuseFactor?: number[]; diffuseTexture?: { index: number } } };
  }[];
  textures?: { source?: number }[];
  images?: { name?: string; mimeType?: string; bufferView?: number; uri?: string }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { byteLength: number; uri?: string }[];
}

const bad = (what: string) => new Error(`This glTF file is damaged: ${what}.`);

export function parseGlb(bytes: Uint8Array, name = 'Model'): ImportedModel {
  if (bytes.length === 0) throw new Error('This glTF file is empty.');
  const { json, bin } = unpack(bytes);
  const gltf = json;
  const required = gltf.extensionsRequired ?? [];
  if (required.includes('KHR_draco_mesh_compression') || required.includes('EXT_meshopt_compression'))
    throw new Error('This glTF file is compressed. Export it again without mesh compression and import that.');
  const buffers = (gltf.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) {
      if (i === 0 && bin) return bin;
      throw bad('a buffer is missing');
    }
    if (!b.uri.startsWith('data:')) throw new Error('This glTF file keeps its data in separate files. Save it as a single .glb and import that.');
    return base64ToBytes(b.uri.slice(b.uri.indexOf(',') + 1));
  });
  const viewOf = (index: number): Uint8Array => {
    const view = gltf.bufferViews?.[index];
    const buffer = view && buffers[view.buffer];
    if (!view || !buffer) throw bad('a buffer view is missing');
    const start = view.byteOffset ?? 0;
    if (start + view.byteLength > buffer.length) throw bad('a buffer view runs past its buffer');
    return buffer.subarray(start, start + view.byteLength);
  };
  const images = new Map<number, ImportedImage>();
  const imageOf = (index: number): ImportedImage | undefined => {
    if (images.has(index)) return images.get(index);
    const image = gltf.images?.[index];
    let out: ImportedImage | undefined;
    if (image) {
      let data: Uint8Array | undefined;
      let mime = image.mimeType;
      if (image.bufferView !== undefined) data = viewOf(image.bufferView).slice();
      else if (image.uri?.startsWith('data:')) {
        data = base64ToBytes(image.uri.slice(image.uri.indexOf(',') + 1));
        mime ??= image.uri.slice(5, image.uri.indexOf(';'));
      }
      const kind = mime === 'image/png' || mime === 'image/jpeg' ? mime : image.uri && !image.uri.startsWith('data:') ? imageMime(image.uri) : undefined;
      if (data && kind) out = { name: image.name ?? `${name}.${kind === 'image/png' ? 'png' : 'jpg'}`, mime: kind, bytes: data };
    }
    images.set(index, out!);
    return out;
  };
  const textureImage = (index: number | undefined): ImportedImage | undefined => {
    const source = index === undefined ? undefined : gltf.textures?.[index]?.source;
    return source === undefined ? undefined : imageOf(source);
  };
  const materialOf = (index: number | undefined): { color?: string; image?: ImportedImage; name?: string } => {
    const m = index === undefined ? undefined : gltf.materials?.[index];
    if (!m) return {};
    const pbr = m.pbrMetallicRoughness;
    const sg = m.extensions?.KHR_materials_pbrSpecularGlossiness;
    const factor = pbr?.baseColorFactor ?? sg?.diffuseFactor;
    const image = textureImage(pbr?.baseColorTexture?.index ?? sg?.diffuseTexture?.index);
    const out: { color?: string; image?: ImportedImage; name?: string } = { name: m.name };
    // A texture is multiplied by the factor; a white factor (the default) is no color of its own.
    if (factor && factor.length >= 3 && !(image && factor.slice(0, 3).every((c) => c >= 0.999))) out.color = hex(srgb(factor[0]), srgb(factor[1]), srgb(factor[2]));
    if (image) out.image = image;
    return out;
  };
  const accessor = (index: number | undefined): { data: Float64Array; size: number } | null => {
    const a = index === undefined ? undefined : gltf.accessors?.[index];
    if (!a) return null;
    const size = COMPONENTS[a.type];
    if (!size) throw bad('an accessor has an unknown type');
    const data = new Float64Array(a.count * size);
    if (a.bufferView === undefined) return { data, size };
    const view = gltf.bufferViews?.[a.bufferView];
    const bytes = viewOf(a.bufferView);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = a.componentType === 5126 || a.componentType === 5125 ? 4 : a.componentType === 5122 || a.componentType === 5123 ? 2 : 1;
    const stride = view?.byteStride || size * width;
    const start = a.byteOffset ?? 0;
    if (start + (a.count - 1) * stride + size * width > bytes.length) throw bad('an accessor runs past its buffer view');
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < size; c++) {
        const at = start + i * stride + c * width;
        let v: number;
        switch (a.componentType) {
          case 5126:
            v = dv.getFloat32(at, true);
            break;
          case 5125:
            v = dv.getUint32(at, true);
            break;
          case 5123:
            v = dv.getUint16(at, true);
            if (a.normalized) v /= 65535;
            break;
          case 5122:
            v = dv.getInt16(at, true);
            if (a.normalized) v = Math.max(v / 32767, -1);
            break;
          case 5121:
            v = dv.getUint8(at);
            if (a.normalized) v /= 255;
            break;
          case 5120:
            v = dv.getInt8(at);
            if (a.normalized) v = Math.max(v / 127, -1);
            break;
          default:
            throw bad('an accessor has an unknown component type');
        }
        data[i * size + c] = v;
      }
    }
    return { data, size };
  };

  const parts: ImportedPart[] = [];
  let triangles = 0;
  let visited = 0;
  const emitMesh = (meshIndex: number, nodeName: string | undefined, world: Mat) => {
    const mesh = gltf.meshes?.[meshIndex];
    if (!mesh) return;
    const mirrored = determinant(world) < 0;
    for (const [p, primitive] of mesh.primitives.entries()) {
      const mode = primitive.mode ?? 4;
      if (mode !== 4 && mode !== 5 && mode !== 6) continue;
      const position = accessor(primitive.attributes.POSITION);
      if (!position || position.size !== 3) continue;
      const count = position.data.length / 3;
      const texcoord = accessor(primitive.attributes.TEXCOORD_0);
      const indices = accessor(primitive.indices)?.data ?? Float64Array.from({ length: count }, (_, i) => i);
      const tris: number[] = [];
      if (mode === 4) for (let i = 0; i + 2 < indices.length; i += 3) tris.push(indices[i], indices[i + 1], indices[i + 2]);
      else if (mode === 5) for (let i = 0; i + 2 < indices.length; i++) tris.push(indices[i], indices[i + (i % 2 ? 2 : 1)], indices[i + (i % 2 ? 1 : 2)]);
      else for (let i = 1; i + 1 < indices.length; i++) tris.push(indices[0], indices[i], indices[i + 1]);
      triangles += tris.length / 3;
      if (triangles > MAX_TRIANGLES) throw new Error('This glTF file has too many triangles to open.');
      // Placed in the scene, then Y up in meters turned into Z up in millimeters.
      const builder = new MeshBuilder(count, Math.max(16, tris.length / 3));
      const welded = new Int32Array(count);
      const m = world;
      for (let v = 0; v < count; v++) {
        const x = position.data[v * 3];
        const y = position.data[v * 3 + 1];
        const z = position.data[v * 3 + 2];
        const wx = m[0] * x + m[3] * y + m[6] * z + m[9];
        const wy = m[1] * x + m[4] * y + m[7] * z + m[10];
        const wz = m[2] * x + m[5] * y + m[8] * z + m[11];
        welded[v] = builder.vertex(wx * 1000, -wz * 1000, wy * 1000);
      }
      const uv: number[] = [];
      for (let i = 0; i < tris.length; i += 3) {
        const a = tris[i];
        const b = tris[i + (mirrored ? 2 : 1)];
        const c = tris[i + (mirrored ? 1 : 2)];
        if (!(a < count && b < count && c < count)) continue;
        const before = builder.size;
        builder.triangle(welded[a], welded[b], welded[c]);
        if (texcoord && builder.size > before) {
          // v runs down in glTF and up here.
          for (const corner of [a, b, c]) uv.push(texcoord.data[corner * texcoord.size], 1 - texcoord.data[corner * texcoord.size + 1]);
        }
      }
      if (builder.size === 0) continue;
      const out: MeshWithUV = builder.finish();
      if (texcoord && texcoord.size >= 2) out.uv = Float32Array.from(uv);
      const material = materialOf(primitive.material);
      const base = nodeName || mesh.name || name;
      // The parts of a mesh are told apart by their materials' names, or numbered.
      const tag = material.name && material.name !== base ? material.name : String(p + 1);
      const part: ImportedPart = { name: mesh.primitives.length > 1 ? `${base} (${tag})` : base, mesh: out };
      if (material.color) part.color = material.color;
      if (material.image) part.image = material.image;
      parts.push(part);
    }
  };
  const visit = (index: number, parent: Mat, depth: number) => {
    const node = gltf.nodes?.[index];
    if (!node || depth > MAX_DEPTH) return;
    if (++visited > MAX_NODES) throw new Error('This glTF file has too many nodes to open.');
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) emitMesh(node.mesh, node.name, world);
    for (const child of node.children ?? []) visit(child, world, depth + 1);
  };
  const IDENT: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  let roots = scene?.nodes;
  if (!roots) {
    // No scene: every node that is nobody's child.
    const children = new Set((gltf.nodes ?? []).flatMap((n) => n.children ?? []));
    roots = (gltf.nodes ?? []).map((_, i) => i).filter((i) => !children.has(i));
  }
  for (const root of roots) visit(root, IDENT, 0);
  // Meshes no node places still count, at the origin.
  if (parts.length === 0 && !gltf.nodes?.length) for (const [i] of (gltf.meshes ?? []).entries()) emitMesh(i, undefined, IDENT);
  if (parts.length === 0) throw new Error('This glTF file has no meshes.');
  return { kind: 'model', parts, used: [] };
}

/** The JSON of a .glb or a .gltf, and the binary chunk of a .glb. */
function unpack(bytes: Uint8Array): { json: Gltf; bin: Uint8Array | null } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (b: Uint8Array) => {
    try {
      return JSON.parse(new TextDecoder().decode(b)) as Gltf;
    } catch {
      throw new Error('This is not a glTF file: it could not be read as JSON.');
    }
  };
  if (bytes.length >= 12 && dv.getUint32(0, true) === MAGIC) {
    if (dv.getUint32(4, true) !== 2) throw new Error('Only glTF version 2 files can be imported.');
    let json: Gltf | null = null;
    let bin: Uint8Array | null = null;
    let at = 12;
    while (at + 8 <= bytes.length) {
      const length = dv.getUint32(at, true);
      const type = dv.getUint32(at + 4, true);
      if (at + 8 + length > bytes.length) throw bad('a chunk runs past the end of the file');
      const chunk = bytes.subarray(at + 8, at + 8 + length);
      if (type === JSON_CHUNK && !json) json = text(chunk);
      else if (type === BIN_CHUNK && !bin) bin = chunk;
      at += 8 + length + ((4 - (length % 4)) % 4);
    }
    if (!json) throw bad('it has no JSON chunk');
    return { json, bin };
  }
  const json = text(bytes);
  if (typeof json !== 'object' || json === null || !json.asset) throw new Error('This is not a glTF file.');
  return { json, bin: null };
}

/** A node's own transform as a `Mat` (the images of X, Y and Z, then the translation), from its matrix or its parts. */
function localMatrix(node: NonNullable<Gltf['nodes']>[number]): Mat {
  if (node.matrix && node.matrix.length === 16) {
    const g = node.matrix;
    return [g[0], g[1], g[2], g[4], g[5], g[6], g[8], g[9], g[10], g[12], g[13], g[14]];
  }
  const [sx, sy, sz] = node.scale && node.scale.length === 3 ? node.scale : [1, 1, 1];
  const [qx, qy, qz, qw] = node.rotation && node.rotation.length === 4 ? node.rotation : [0, 0, 0, 1];
  const [tx, ty, tz] = node.translation && node.translation.length === 3 ? node.translation : [0, 0, 0];
  const r = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw),
    2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw),
    2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy),
  ];
  return [r[0] * sx, r[1] * sx, r[2] * sx, r[3] * sy, r[4] * sy, r[5] * sy, r[6] * sz, r[7] * sz, r[8] * sz, tx, ty, tz];
}

/** Linear to sRGB, in 0..1. */
export const srgb = (c: number): number => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
};
