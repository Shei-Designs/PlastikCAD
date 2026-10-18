import type { MeshData, MeshWithUV } from '../geometry/mesh';
import type { OutlineShape, Vec2, Vec3 } from '../model/types';
import { parse3mf } from './import3mf';
import { parseDxf } from './importDxf';
import { parseGlb } from './importGlb';
import { parseObj } from './importObj';
import { parseStl } from './importStl';
import { parseSvg } from './importSvg';

/** A picture file that came with a model, for its texture. */
export interface ImportedImage {
  name: string;
  mime: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
}

/**
 * One solid of a model: indexed triangles in millimeters, vertices at the
 * same position shared, not necessarily watertight; with the color and the
 * picture the file gave it, if any. Parts of one file sit where the file put
 * them, relative to each other.
 */
export interface ImportedPart {
  name: string;
  mesh: MeshWithUV;
  /** Hex sRGB, as a node's `color`. */
  color?: string;
  image?: ImportedImage;
}

/** A model file: its parts, and the names of the files that came with it and were used (a material library, its pictures). */
export interface ImportedModel {
  kind: 'model';
  parts: ImportedPart[];
  used: string[];
  /** Files the model names (a material library, its pictures) that did not come along. */
  missing?: string[];
}

/** Filled 2D shapes in millimeters, Y up, in groups of one fill color. */
export interface ImportedOutline {
  kind: 'outline';
  parts: { shapes: OutlineShape[]; color?: string }[];
}

export type Imported = ImportedModel | ImportedOutline;

/** A file picked or dropped along with the one being read. */
export interface Companion {
  name: string;
  bytes: Uint8Array;
}

export const IMPORT_EXTENSIONS = ['stl', 'obj', '3mf', 'glb', 'gltf', 'svg', 'dxf'];
/** Pictures, which come in as picture sheets rather than solids. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg'];

const extensionOf = (fileName: string): string => /\.([^./\\]+)$/.exec(fileName)?.[1].toLowerCase() ?? '';

/**
 * What kind of file this is, as an extension: the name's, or when the name has
 * none that is known (a document picked on Android can come without one), what
 * the bytes say. Empty when neither tells.
 */
export function fileKind(fileName: string, bytes: Uint8Array): string {
  const extension = extensionOf(fileName);
  if (IMPORT_EXTENSIONS.includes(extension) || IMAGE_EXTENSIONS.includes(extension)) return extension;
  return sniff(bytes);
}

/** The kind of file these bytes begin like, by the formats' signatures. */
function sniff(bytes: Uint8Array): string {
  if (bytes.length < 4) return '';
  const [a, b, c, d] = bytes;
  if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) return 'png';
  if (a === 0xff && b === 0xd8 && c === 0xff) return 'jpg';
  if (a === 0x50 && b === 0x4b && c === 0x03 && d === 0x04) return '3mf';
  if (a === 0x67 && b === 0x6c && c === 0x54 && d === 0x46) return 'glb';
  // A binary STL is exactly as long as its triangle count says.
  if (bytes.length >= 84) {
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (84 + count * 50 === bytes.length) return 'stl';
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 2048)).replace(/^\ufeff/, '');
  if (/^\s*solid\b/.test(head)) return 'stl';
  if (/^\s*0\s*\r?\n\s*SECTION\b/.test(head) || /^\s*999\s*\r?\n/.test(head)) return 'dxf';
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg\b/i.test(head)) return 'svg';
  if (/^\s*\{[\s\S]*"asset"/.test(head)) return 'gltf';
  if (/^(\s*(#[^\n]*)?\r?\n)*\s*(v|vn|vt|o|g|mtllib|usemtl)\s/.test(head)) return 'obj';
  return '';
}

/** Reads a file by its extension, or by its contents when the name has none. Throws an Error with a message fit to show the user. `companions` are the other files picked with it. */
export function importFile(fileName: string, bytes: Uint8Array, companions: Companion[] = []): Imported {
  const extension = fileKind(fileName, bytes);
  const base = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1);
  const name = extensionOf(base) ? base.replace(/\.[^.]+$/, '') : base || 'Import';
  switch (extension) {
    case 'stl':
      return { kind: 'model', parts: [{ name, mesh: checkedMesh(parseStl(bytes)) }], used: [] };
    case 'obj':
      return checkedModel(parseObj(bytes, name, companions));
    case '3mf':
      return checkedModel(parse3mf(bytes, name));
    case 'glb':
    case 'gltf':
      return checkedModel(parseGlb(bytes, name));
    case 'svg':
      return { kind: 'outline', parts: parseSvg(bytes).map((part) => ({ ...part, shapes: checkedOutline(part.shapes) })) };
    case 'dxf':
      return { kind: 'outline', parts: parseDxf(bytes).map((part) => ({ ...part, shapes: checkedOutline(part.shapes) })) };
    default: {
      const given = extensionOf(fileName);
      const what = given ? `.${given} files` : 'Files of this type';
      const supported = IMPORT_EXTENSIONS.map((e) => e.toUpperCase()).join(', ');
      throw new Error(`${what} can't be imported. Use one of: ${supported}.`);
    }
  }
}

/**
 * The mesh, once every coordinate is known to be a finite number. The readers
 * drop such vertices themselves; this is the last line before the geometry
 * kernel, which cannot cope with NaN or infinity.
 */
export function checkedMesh<T extends { positions: Float32Array; triangles: Uint32Array }>(mesh: T): T {
  const p = mesh.positions;
  for (let i = 0; i < p.length; i++) {
    if (!Number.isFinite(p[i])) throw new Error('This file holds coordinates that are not numbers, and cannot be imported.');
  }
  return mesh;
}

function checkedModel(model: ImportedModel): ImportedModel {
  for (const part of model.parts) checkedMesh(part.mesh);
  return model;
}

/** As `checkedMesh`, for the contours of an outline. */
export function checkedOutline(shapes: OutlineShape[]): OutlineShape[] {
  for (const shape of shapes)
    for (const contour of shape.contours)
      for (const [x, y] of contour) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('This file holds coordinates that are not numbers, and cannot be imported.');
      }
  return shapes;
}

/** Recenters the mesh on the center of its bounding box, in place. Returns the box's size and where its center was. */
export function centerMesh(mesh: MeshData): { size: Vec3; center: Vec3 } {
  const p = mesh.positions;
  if (p.length < 3) return { size: [0, 0, 0], center: [0, 0, 0] };
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  for (let i = 0; i < p.length; i += 3) {
    p[i] -= center[0];
    p[i + 1] -= center[1];
    p[i + 2] -= center[2];
  }
  return { size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], center };
}

/** As `centerMesh`, for the contours of an outline. */
export function centerOutline(outline: { shapes: OutlineShape[] }): { size: Vec2; center: Vec2 } {
  const min: Vec2 = [Infinity, Infinity];
  const max: Vec2 = [-Infinity, -Infinity];
  for (const shape of outline.shapes)
    for (const contour of shape.contours)
      for (const [x, y] of contour) {
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
      }
  if (min[0] > max[0]) return { size: [0, 0], center: [0, 0] };
  const center: Vec2 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
  for (const shape of outline.shapes)
    for (const contour of shape.contours)
      for (const point of contour) {
        point[0] -= center[0];
        point[1] -= center[1];
      }
  return { size: [max[0] - min[0], max[1] - min[1]], center };
}
