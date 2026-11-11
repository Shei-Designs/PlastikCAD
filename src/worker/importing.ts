// A model or drawing file read in the geometry worker: parsed, its corners
// joined, centered and put in the form a design keeps it in. A large file
// takes seconds of that, which would otherwise hold up the screen.
import { tr } from '../i18n';
import { encodeFloat32, encodeUint32 } from '../io/base64';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import type { DracoDecode } from '../io/draco';
import { centerMesh, centerOutline, checkedMesh, fileKind, guarded, importFile, needsDraco, STEP_EXTENSIONS } from '../io/import';
import type { Companion, Imported, ImportedImage, ImportedModel } from '../io/import';
import { parseStep } from '../io/importStep';
import { hashString } from '../model/geomKey';
import type { MeshAsset, OutlineAsset, Vec2, Vec3 } from '../model/types';

/** One solid of a model as the design keeps it: the mesh centered on its box, where the box's middle was and how big it is. */
export interface ImportedMesh {
  name: string;
  /** The name the asset goes under: made from its contents, so the same mesh twice is kept once. */
  key: string;
  asset: MeshAsset;
  size: Vec3;
  center: Vec3;
  color?: string;
  image?: ImportedImage;
}

/** The filled shapes of one color of a drawing, centered likewise. */
export interface ImportedDrawing {
  key: string;
  asset: OutlineAsset;
  size: Vec2;
  center: Vec2;
  color?: string;
}

export type ImportResult =
  | { kind: 'model'; parts: ImportedMesh[]; used: string[]; missing: string[]; warnings: string[] }
  | { kind: 'outline'; parts: ImportedDrawing[]; warnings: string[] }
  /**
   * The file names no unit and is tiny as millimeters: it was most likely made in another. The
   * worker holds on to what it read until it is told the unit (`importHeld`, naming `held`).
   * `extent` is its size taken as millimeters.
   */
  | { kind: 'units'; held: number; extent: Vec3 };

/** The formats that say nothing of their unit: by custom millimeters, but meters and inches are common. */
const UNITLESS = ['stl', 'obj', 'ply'];
/**
 * A model without a unit that is smaller than this as millimeters is asked
 * about: nothing printable is, while a robot's part written in meters or a
 * bracket written in inches is.
 */
export const TINY = 5;

/** What was read of a file whose unit is being asked, and the request it came with. */
let held: { id: number; data: Imported } | null = null;

/** A model whose every mesh has been checked for the numbers the kernel cannot take (see `checkedMesh`). */
function checkedParts(model: ImportedModel): ImportedModel {
  for (const part of model.parts) checkedMesh(part.mesh);
  return model;
}

/** The size of everything in a model taken together. */
function extentOf(data: Imported): Vec3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  if (data.kind === 'model') {
    for (const part of data.parts) {
      const p = part.mesh.positions;
      for (let i = 0; i < p.length; i++) {
        const k = i % 3;
        if (p[i] < min[k]) min[k] = p[i];
        if (p[i] > max[k]) max[k] = p[i];
      }
    }
  }
  return min[0] > max[0] ? [0, 0, 0] : [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

/**
 * Reads a file (see `importFile`) into what the design keeps. `scale` is the
 * unit the file was made in, in millimeters, when that is known; without it a
 * file that names no unit and comes out tiny is held, and `kind: 'units'`
 * asks which it is.
 */
export async function readFile(id: number, name: string, bytes: Uint8Array, companions: Companion[], scale?: number, occ?: () => Promise<OpenCascadeInstance>, draco?: () => Promise<DracoDecode>): Promise<ImportResult> {
  held = null;
  const kind = fileKind(name, bytes);
  let data: Imported;
  if (STEP_EXTENSIONS.includes(kind)) {
    if (!occ) throw new Error(tr('STEP files cannot be read here.'));
    const oc = await occ().catch(() => {
      throw new Error(tr('The STEP reader could not be loaded.'));
    });
    const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).replace(/\.[^.]+$/, '');
    data = checkedParts(guarded('STEP', () => parseStep(oc, bytes, base || undefined)));
  } else if (draco && (kind === 'glb' || kind === 'gltf') && needsDraco(bytes)) {
    const decode = await draco().catch(() => {
      throw new Error(tr('The decoder for this compressed glTF file could not be loaded.'));
    });
    data = importFile(name, bytes, companions, { draco: decode });
  } else data = importFile(name, bytes, companions);
  if (scale === undefined && data.kind === 'model' && UNITLESS.includes(kind)) {
    const extent = extentOf(data);
    const largest = Math.max(...extent);
    if (largest > 0 && largest < TINY) {
      held = { id, data };
      return { kind: 'units', held: id, extent };
    }
  }
  return kept(data, scale ?? 1);
}

/** What was held for its unit (see `readFile`), now that the unit is known: `scale` millimeters. */
export function readHeld(id: number, scale: number): ImportResult {
  const mine = held;
  held = null;
  if (!mine || mine.id !== id) throw new Error(tr('The file is no longer at hand. Import it again.'));
  return kept(mine.data, scale);
}

function kept(data: Imported, scale: number): ImportResult {
  const warnings = data.warnings ?? [];
  if (data.kind === 'outline') {
    return {
      kind: 'outline',
      warnings,
      parts: data.parts.map((part) => {
        const { size, center } = centerOutline(part);
        const asset: OutlineAsset = { kind: 'outline', shapes: part.shapes };
        const text = JSON.stringify(asset);
        const drawing: ImportedDrawing = { key: `outline-${hashString(text)}-${text.length.toString(36)}`, asset, size, center };
        if (part.color) drawing.color = part.color;
        return drawing;
      }),
    };
  }
  const parts = data.parts.map((part) => {
    const { positions } = part.mesh;
    if (scale !== 1) for (let i = 0; i < positions.length; i++) positions[i] *= scale;
    const { size, center } = centerMesh(part.mesh);
    const asset: MeshAsset = { kind: 'mesh', positions: encodeFloat32(positions), triangles: encodeUint32(part.mesh.triangles) };
    if (part.mesh.uv) asset.uv = encodeFloat32(part.mesh.uv);
    const text = asset.positions + asset.triangles + (asset.uv ?? '');
    const mesh: ImportedMesh = { name: part.name, key: `mesh-${hashString(text)}-${text.length.toString(36)}`, asset, size, center };
    if (part.color) mesh.color = part.color;
    if (part.image) mesh.image = part.image;
    return mesh;
  });
  return { kind: 'model', parts, used: data.used, missing: data.missing ?? [], warnings };
}
