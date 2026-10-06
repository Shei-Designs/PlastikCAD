import type { OutlineShape, Vec2, Vec3 } from '../model/types';
import { parse3mf } from './import3mf';
import { parseObj } from './importObj';
import { parseStl } from './importStl';
import { parseSvg } from './importSvg';

/** Indexed triangles in millimetres; vertices at the same position are shared. Not necessarily watertight. */
export interface ImportedMesh {
  kind: 'mesh';
  positions: Float32Array;
  triangles: Uint32Array;
}

/** Filled 2D shapes in millimetres, Y up. */
export interface ImportedOutline {
  kind: 'outline';
  shapes: OutlineShape[];
}

export type Imported = ImportedMesh | ImportedOutline;

export const IMPORT_EXTENSIONS = ['stl', 'obj', '3mf', 'svg'];

/** Reads a file by its extension. Throws an Error with a message fit to show the user. */
export function importFile(fileName: string, bytes: Uint8Array): Imported {
  const extension = /\.([^./\\]+)$/.exec(fileName)?.[1].toLowerCase() ?? '';
  switch (extension) {
    case 'stl':
      return { kind: 'mesh', ...parseStl(bytes) };
    case 'obj':
      return { kind: 'mesh', ...parseObj(bytes) };
    case '3mf':
      return { kind: 'mesh', ...parse3mf(bytes) };
    case 'svg':
      return { kind: 'outline', shapes: parseSvg(bytes) };
    default: {
      const what = extension ? `.${extension} files` : 'Files of this type';
      const supported = IMPORT_EXTENSIONS.map((e) => e.toUpperCase()).join(', ');
      throw new Error(`${what} can't be imported. Use one of: ${supported}.`);
    }
  }
}

/** Recentres the mesh on the centre of its bounding box, in place. Returns the box's size and where its centre was. */
export function centreMesh(mesh: ImportedMesh): { size: Vec3; centre: Vec3 } {
  const p = mesh.positions;
  if (p.length < 3) return { size: [0, 0, 0], centre: [0, 0, 0] };
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  for (let i = 0; i < p.length; i += 3) {
    p[i] -= centre[0];
    p[i + 1] -= centre[1];
    p[i + 2] -= centre[2];
  }
  return { size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], centre };
}

/** As `centreMesh`, for the contours of an outline. */
export function centreOutline(outline: ImportedOutline): { size: Vec2; centre: Vec2 } {
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
  if (min[0] > max[0]) return { size: [0, 0], centre: [0, 0] };
  const centre: Vec2 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
  for (const shape of outline.shapes)
    for (const contour of shape.contours)
      for (const point of contour) {
        point[0] -= centre[0];
        point[1] -= centre[1];
      }
  return { size: [max[0] - min[0], max[1] - min[1]], centre };
}
