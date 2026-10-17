import type { MeshData, MeshWithUV } from '../geometry/mesh';
import type { OutlineShape, Vec2, Vec3 } from '../model/types';
import { parse3mf } from './import3mf';
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

export const IMPORT_EXTENSIONS = ['stl', 'obj', '3mf', 'glb', 'gltf', 'svg'];
/** Pictures, which come in as picture sheets rather than solids. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg'];

/** Reads a file by its extension. Throws an Error with a message fit to show the user. `companions` are the other files picked with it. */
export function importFile(fileName: string, bytes: Uint8Array, companions: Companion[] = []): Imported {
  const extension = /\.([^./\\]+)$/.exec(fileName)?.[1].toLowerCase() ?? '';
  const name = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1).replace(/\.[^.]+$/, '');
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
    default: {
      const what = extension ? `.${extension} files` : 'Files of this type';
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
