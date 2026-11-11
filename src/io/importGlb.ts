// glTF 2.0, binary (.glb) or JSON (.gltf) with its buffers and pictures
// embedded or in the files beside it that were picked with it: every
// mesh of the scene, placed by its nodes, one part per primitive with the
// color and picture of its material and the texture coordinates it carries.
// glTF is Y up in meters; parts come out Z up in millimeters.
import type { MeshWithUV } from '../geometry/mesh';
import { tr } from '../i18n';
import { apply, determinant, IDENTITY, multiply } from '../model/math';
import type { Mat } from '../model/math';
import { base64ToBytes } from './base64';
import type { Companion, ImportedImage, ImportedModel, ImportedPart } from './import';
import { hex, imageMime, srgb } from './material';
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
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string; sparse?: unknown }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { byteLength: number; uri?: string }[];
}

const bad = (message: string) => new Error(message);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Absent, or a whole number that could be a place in a list or a count. */
const isIndex = (v: unknown): boolean => v === undefined || (Number.isInteger(v) && (v as number) >= 0);
const isIndices = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.every((x) => x !== undefined && isIndex(x)));
const isNumbers = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'number'));
const isText = (v: unknown): boolean => v === undefined || typeof v === 'string';

/**
 * The JSON, once everything that is read from it is known to have the shape
 * it is read in: lists where lists are gone through, numbers where numbers
 * are counted with. The JSON of a file is whatever its writer put there.
 */
function checkedShape(json: unknown): Gltf {
  if (!isObject(json)) throw new Error(tr('This is not a glTF file.'));
  const need = (ok: boolean, message: string) => {
    if (!ok) throw bad(message);
  };
  const list = (key: string): Record<string, unknown>[] => {
    const v = json[key];
    if (v === undefined) return [];
    need(Array.isArray(v) && v.every(isObject), tr('This glTF file is damaged: its {key} are not a list.', { key }));
    return v as Record<string, unknown>[];
  };
  need(json.extensionsRequired === undefined || Array.isArray(json.extensionsRequired), tr('This glTF file is damaged: its list of extensions is not one.'));
  need(isIndex(json.scene), tr('This glTF file is damaged: its scene is not a number.'));
  for (const scene of list('scenes')) need(isIndices(scene.nodes), tr('This glTF file is damaged: a scene does not list its nodes.'));
  for (const node of list('nodes')) {
    need(isIndex(node.mesh) && isIndices(node.children) && isText(node.name), tr('This glTF file is damaged: a node is not as it should be.'));
    need(isNumbers(node.matrix) && isNumbers(node.translation) && isNumbers(node.rotation) && isNumbers(node.scale), tr('This glTF file is damaged: a node is placed by something other than numbers.'));
  }
  for (const mesh of list('meshes')) {
    need(isText(mesh.name) && Array.isArray(mesh.primitives) && mesh.primitives.every(isObject), tr('This glTF file is damaged: a mesh has no primitives.'));
    for (const primitive of mesh.primitives as Record<string, unknown>[]) {
      need(isObject(primitive.attributes) && Object.values(primitive.attributes).every(isIndex), tr('This glTF file is damaged: a primitive has no attributes.'));
      need(isIndex(primitive.indices) && isIndex(primitive.material) && isIndex(primitive.mode), tr('This glTF file is damaged: a primitive is not as it should be.'));
    }
  }
  for (const material of list('materials')) {
    need(isText(material.name) && (material.extensions === undefined || isObject(material.extensions)), tr('This glTF file is damaged: a material is not as it should be.'));
    const extensions = material.extensions as Record<string, unknown> | undefined;
    for (const group of [material.pbrMetallicRoughness, extensions?.KHR_materials_pbrSpecularGlossiness]) {
      if (group === undefined) continue;
      need(isObject(group), tr('This glTF file is damaged: a material is not as it should be.'));
      const { baseColorFactor, diffuseFactor, baseColorTexture, diffuseTexture } = group as Record<string, unknown>;
      need(isNumbers(baseColorFactor) && isNumbers(diffuseFactor), tr('This glTF file is damaged: a material has a color that is not numbers.'));
      for (const texture of [baseColorTexture, diffuseTexture]) need(texture === undefined || (isObject(texture) && isIndex(texture.index)), tr('This glTF file is damaged: a material names its texture wrongly.'));
    }
  }
  for (const texture of list('textures')) need(isIndex(texture.source), tr('This glTF file is damaged: a texture names its image wrongly.'));
  for (const image of list('images')) need(isIndex(image.bufferView) && isText(image.uri) && isText(image.mimeType) && isText(image.name), tr('This glTF file is damaged: an image is not as it should be.'));
  for (const accessor of list('accessors')) {
    need(isIndex(accessor.bufferView) && isIndex(accessor.byteOffset) && accessor.count !== undefined && isIndex(accessor.count), tr('This glTF file is damaged: an accessor is not as it should be.'));
    need(typeof accessor.type === 'string' && Object.prototype.hasOwnProperty.call(COMPONENTS, accessor.type), tr('This glTF file is damaged: an accessor has an unknown type.'));
  }
  for (const view of list('bufferViews')) {
    need(view.buffer !== undefined && isIndex(view.buffer) && view.byteLength !== undefined && isIndex(view.byteLength) && isIndex(view.byteOffset) && isIndex(view.byteStride), tr('This glTF file is damaged: a buffer view is not as it should be.'));
  }
  for (const buffer of list('buffers')) need(isText(buffer.uri), tr('This glTF file is damaged: a buffer is not as it should be.'));
  return json as Gltf;
}

/** The bytes of a `data:` address. */
function dataBytes(uri: string): Uint8Array {
  try {
    return base64ToBytes(uri.slice(uri.indexOf(',') + 1));
  } catch {
    throw bad(tr('This glTF file is damaged: its embedded data cannot be read.'));
  }
}

/**
 * Where a file a glTF names is, as a path below the glTF's own folder; null for anything else (another
 * site, an absolute path, a path that climbs out of the folder), which is never fetched.
 */
function besidePath(uri: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(uri);
  } catch {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || /^[\\/]/.test(path) || path.split(/[\\/]/).includes('..')) return null;
  return path.replace(/^\.\//, '');
}

const tail = (path: string): string => path.split(/[\\/]/).pop()!.toLowerCase();

/**
 * `companions` are the files picked with a .gltf: the buffers and pictures it keeps beside it. The
 * ones it names that did not come are listed in `missing`; without a buffer there are no shapes to
 * read, and the model comes back with no parts, for the caller to fetch the files and ask again.
 */
export function parseGlb(bytes: Uint8Array, name = 'Model', companions: Companion[] = []): ImportedModel {
  if (bytes.length === 0) throw new Error(tr('This glTF file is empty.'));
  const { json, bin } = unpack(bytes);
  const gltf = checkedShape(json);
  const required = gltf.extensionsRequired ?? [];
  if (required.includes('KHR_draco_mesh_compression') || required.includes('EXT_meshopt_compression'))
    throw new Error(tr('This glTF file is compressed. Export it again without mesh compression and import that.'));
  const used = new Set<string>();
  const missing = new Set<string>();
  /** The file beside the glTF that `uri` names, if it came along; noted as used, or as missing. */
  const beside = (uri: string): Uint8Array | undefined => {
    const path = besidePath(uri);
    if (path === null) return undefined;
    const file = companions.find((c) => c.name === path) ?? companions.find((c) => tail(c.name) === tail(path));
    if (file) used.add(file.name);
    else missing.add(path);
    return file?.bytes;
  };
  const buffers = (gltf.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) {
      if (i === 0 && bin) return bin;
      throw bad(tr('This glTF file is damaged: a buffer is missing.'));
    }
    if (b.uri.startsWith('data:')) return dataBytes(b.uri);
    if (besidePath(b.uri) === null) throw new Error(tr('This glTF file keeps its data in separate files. Save it as a single .glb and import that.'));
    return beside(b.uri);
  });
  if (buffers.includes(undefined)) {
    // The pictures it names are asked for in the same breath as the buffers.
    for (const image of gltf.images ?? []) if (image.uri && !image.uri.startsWith('data:')) beside(image.uri);
    return { kind: 'model', parts: [], used: [...used], missing: [...missing] };
  }
  const viewOf = (index: number): Uint8Array => {
    const view = gltf.bufferViews?.[index];
    const buffer = view && buffers[view.buffer];
    if (!view || !buffer) throw bad(tr('This glTF file is damaged: a buffer view is missing.'));
    const start = view.byteOffset ?? 0;
    if (start + view.byteLength > buffer.length) throw bad(tr('This glTF file is damaged: a buffer view runs past its buffer.'));
    return buffer.subarray(start, start + view.byteLength);
  };
  const images = new Map<number, ImportedImage | undefined>();
  const imageOf = (index: number): ImportedImage | undefined => {
    if (images.has(index)) return images.get(index);
    const image = gltf.images?.[index];
    let out: ImportedImage | undefined;
    if (image) {
      let data: Uint8Array | undefined;
      let mime = image.mimeType;
      if (image.bufferView !== undefined) data = viewOf(image.bufferView).slice();
      else if (image.uri?.startsWith('data:')) {
        data = dataBytes(image.uri);
        mime ??= image.uri.slice(5, image.uri.indexOf(';'));
      } else if (image.uri) data = beside(image.uri);
      const kind = mime === 'image/png' || mime === 'image/jpeg' ? mime : image.uri && !image.uri.startsWith('data:') ? imageMime(image.uri) : undefined;
      if (data && kind) out = { name: image.name ?? `${name}.${kind === 'image/png' ? 'png' : 'jpg'}`, mime: kind, bytes: data };
    }
    images.set(index, out);
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
    if (a.sparse !== undefined) throw new Error(tr('This glTF file keeps a mesh as a sparse accessor, which cannot be read. Export it again without sparse accessors.'));
    // Without a buffer view an accessor is all zeros, as many as it says: nothing to draw, and nothing to make room for.
    if (a.bufferView === undefined) throw bad(tr('This glTF file is damaged: an accessor has no data.'));
    const view = gltf.bufferViews?.[a.bufferView];
    const bytes = viewOf(a.bufferView);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = a.componentType === 5126 || a.componentType === 5125 ? 4 : a.componentType === 5122 || a.componentType === 5123 ? 2 : 1;
    const stride = view?.byteStride || size * width;
    const start = a.byteOffset ?? 0;
    // Checked before any room is made, so that a count the bytes cannot back is never believed.
    if (stride < size * width || start + (a.count - 1) * stride + size * width > bytes.length) throw bad(tr('This glTF file is damaged: an accessor runs past its buffer view.'));
    const data = new Float64Array(a.count * size);
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
            throw bad(tr('This glTF file is damaged: an accessor has an unknown component type.'));
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
      if (triangles > MAX_TRIANGLES) throw new Error(tr('This glTF file has too many triangles to open.'));
      // Placed in the scene, then Y up in meters turned into Z up in millimeters.
      const builder = new MeshBuilder(count, Math.max(16, tris.length / 3));
      const welded = new Int32Array(count);
      for (let v = 0; v < count; v++) {
        const w = apply(world, [position.data[v * 3], position.data[v * 3 + 1], position.data[v * 3 + 2]]);
        welded[v] = builder.vertex(w[0] * 1000, -w[2] * 1000, w[1] * 1000);
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
    if (++visited > MAX_NODES) throw new Error(tr('This glTF file has too many nodes to open.'));
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) emitMesh(node.mesh, node.name, world);
    for (const child of node.children ?? []) visit(child, world, depth + 1);
  };
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  let roots = scene?.nodes;
  if (!roots) {
    // No scene: every node that is nobody's child.
    const children = new Set((gltf.nodes ?? []).flatMap((n) => n.children ?? []));
    roots = (gltf.nodes ?? []).map((_, i) => i).filter((i) => !children.has(i));
  }
  for (const root of roots) visit(root, IDENTITY, 0);
  // Meshes no node places still count, at the origin.
  if (parts.length === 0 && !gltf.nodes?.length) for (const [i] of (gltf.meshes ?? []).entries()) emitMesh(i, undefined, IDENTITY);
  if (parts.length === 0) throw new Error(tr('This glTF file has no meshes.'));
  // Only the pictures a material in use asked for are counted, came or not.
  return { kind: 'model', parts, used: [...used], missing: [...missing] };
}

/** The JSON of a .glb or a .gltf, and the binary chunk of a .glb. */
function unpack(bytes: Uint8Array): { json: unknown; bin: Uint8Array | null } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (b: Uint8Array): unknown => {
    try {
      return JSON.parse(new TextDecoder().decode(b));
    } catch {
      throw new Error(tr('This is not a glTF file: it could not be read as JSON.'));
    }
  };
  if (bytes.length >= 12 && dv.getUint32(0, true) === MAGIC) {
    if (dv.getUint32(4, true) !== 2) throw new Error(tr('Only glTF version 2 files can be imported.'));
    let json: unknown = null;
    let bin: Uint8Array | null = null;
    let at = 12;
    while (at + 8 <= bytes.length) {
      const length = dv.getUint32(at, true);
      const type = dv.getUint32(at + 4, true);
      if (at + 8 + length > bytes.length) throw bad(tr('This glTF file is damaged: a chunk runs past the end of the file.'));
      const chunk = bytes.subarray(at + 8, at + 8 + length);
      if (type === JSON_CHUNK && json === null) json = text(chunk);
      else if (type === BIN_CHUNK && !bin) bin = chunk;
      at += 8 + length + ((4 - (length % 4)) % 4);
    }
    if (json === null) throw bad(tr('This glTF file is damaged: it has no JSON chunk.'));
    return { json, bin };
  }
  const json = text(bytes);
  if (!isObject(json) || !json.asset) throw new Error(tr('This is not a glTF file.'));
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
