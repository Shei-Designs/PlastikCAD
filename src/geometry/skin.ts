// What covers an object's surface, worked out from the node alone: its own
// texture, the pictures grouped onto it, or, for a picture node, the picture
// on its sheet. Pure; the pixels are painted in viewer/skin.ts and the
// coordinates come from uv.ts.
import { localScale, nodeMatrix } from '../model/math';
import type { Bounds, Mat } from '../model/math';
import { picturesOf } from '../model/ops';
import type { PictureMapping, SceneNode } from '../model/types';
import type { RenderMesh } from './mesh';
import { clipPictures, coverSurface, projectPictures, sheetUVs } from './uv';
import type { Projector, SkinMesh } from './uv';

export interface Sticker {
  asset: string;
  mapping: PictureMapping;
  angle: number;
  /** The unit sheet into the object's built frame. */
  matrix: Mat;
}

export type Skin =
  /** A picture node: its own picture on its sheet, see-through where the picture is. */
  | { kind: 'picture'; asset: string; mapping: PictureMapping; angle: number; color: string }
  /** A texture over the whole surface, over the object's own color where the picture is transparent. */
  | { kind: 'texture'; asset: string; mode: 'wrap' | 'tile'; scale: number; turn: number; color: string }
  /**
   * Pictures projected onto the object, over its own color. On a mixed group the parts around the
   * pictures keep their own colors (which the surface carries as corner colors), so the atlas is
   * white where nothing is painted; under a transparent picture the group's color shows.
   */
  | { kind: 'stickers'; color: string; mixed?: boolean; stickers: Sticker[] };

/** The skin of a node, or null for a plain colored surface. Pictures grouped onto an object take precedence over its texture. */
export function skinOf(node: SceneNode): Skin | null {
  if (node.type === 'picture') return { kind: 'picture', asset: node.asset, mapping: node.mapping, angle: node.angle, color: node.color };
  const pictures = picturesOf(node).filter((p) => !p.hidden);
  if (pictures.length) {
    const stickers = pictures.map((p) => ({ asset: p.asset, mapping: p.mapping, angle: p.angle, matrix: nodeMatrix(p) }));
    return { kind: 'stickers', color: node.color, ...(node.type === 'group' && node.mixed ? { mixed: true } : {}), stickers };
  }
  if (node.texture) return { kind: 'texture', asset: node.texture.asset, mode: node.texture.mode, scale: node.texture.scale, turn: node.texture.turn, color: node.color };
  return null;
}

/** Tells one skin from another: same key, same pixels and coordinates (for the same mesh). */
export const skinKey = (skin: Skin): string => JSON.stringify(skin);

/** The images a skin is painted from, in the order the atlas lays them out. */
export const skinAssets = (skin: Skin): string[] => (skin.kind === 'stickers' ? skin.stickers.map((s) => s.asset) : [skin.asset]);

/** Pixels of fill color around and between the pictures in an atlas, so that clamping finds plain color. */
export const ATLAS_PAD = 8;
/** Longest side of an atlas; larger ones are scaled down. */
export const ATLAS_MAX = 4096;

export interface AtlasCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Stacks pictures top to bottom in one atlas, each at its own size, scaled down together if the stack is too tall or wide. */
export function layoutAtlas(sizes: { width: number; height: number }[]): { width: number; height: number; cells: AtlasCell[] } {
  const widest = Math.max(1, ...sizes.map((s) => s.width));
  const tall = sizes.reduce((a, s) => a + s.height, 0);
  const width = widest + 2 * ATLAS_PAD;
  const height = tall + (sizes.length + 1) * ATLAS_PAD;
  const scale = Math.min(1, ATLAS_MAX / Math.max(width, height));
  const cells: AtlasCell[] = [];
  let y = ATLAS_PAD;
  for (const s of sizes) {
    cells.push({ x: Math.round(ATLAS_PAD * scale), y: Math.round(y * scale), w: Math.max(1, Math.round(s.width * scale)), h: Math.max(1, Math.round(s.height * scale)) });
    y += s.height + ATLAS_PAD;
  }
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), cells };
}

/** A cell's place in the atlas as texture coordinates, v up: u0, v0, u1, v1. */
export const cellRect = (cell: AtlasCell, width: number, height: number): [number, number, number, number] => [cell.x / width, 1 - (cell.y + cell.h) / height, (cell.x + cell.w) / width, 1 - cell.y / height];

/**
 * Texture coordinates of a node's mesh (unindexed corners in its built frame)
 * for its skin. `rects` places each sticker in the atlas; `bounds` are the
 * mesh's own, for a wrapped texture's height.
 */
export function skinUVs(skin: Skin, node: SceneNode, positions: Float32Array, bounds: Bounds, rects: [number, number, number, number][]): Float32Array {
  switch (skin.kind) {
    case 'picture':
      return sheetUVs(positions, skin.mapping, skin.angle);
    case 'texture': {
      const scale = localScale(node);
      return coverSurface(positions, { mode: skin.mode, scale: skin.scale, turn: skin.turn, mm: [Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2])], z: [bounds.min[2], bounds.max[2]] });
    }
    case 'stickers':
      return projectPictures(positions, projectors(skin.stickers, rects));
  }
}

/** The stickers as projectors, each in its own place in the atlas. */
const projectors = (stickers: Sticker[], rects: [number, number, number, number][]): Projector[] =>
  stickers.map((s, i) => ({ matrix: s.matrix, mapping: s.mapping, angle: s.angle, rect: rects[i] ?? [0, 0, 1, 1] }));

/**
 * The mesh with its skin's texture coordinates, as `skinUVs`, except that a
 * triangle reaching past a sticker's edge is cut there, so that the rest of it
 * samples the fill and not the next picture in the atlas. The corners are the
 * render mesh's own when nothing had to be cut.
 */
export function skinMesh(skin: Skin, node: SceneNode, render: RenderMesh, bounds: Bounds, rects: [number, number, number, number][]): SkinMesh {
  if (skin.kind === 'stickers') return clipPictures(render.positions, render.normals, projectors(skin.stickers, rects));
  return { positions: render.positions, normals: render.normals, uv: skinUVs(skin, node, render.positions, bounds, rects) };
}

/** Whether the picture repeats beyond its edges (a texture) or clamps to its border (pictures on a fill). */
export const skinRepeats = (skin: Skin): boolean => skin.kind === 'texture';
