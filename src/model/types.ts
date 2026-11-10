// The design document. Everything is in millimeters, Z up, with the build
// plate at z=0. A design is a flat list of nodes; grouping nodes combines
// them (solids are merged, holes are cut away), exactly like Tinkercad.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** Closed contour; the edge from the last point back to the first is implied. */
export type Polygon = Vec2[];

export type ShapeKind =
  | 'box'
  | 'cylinder'
  | 'sphere'
  | 'cone'
  | 'pyramid'
  | 'wedge'
  | 'roof'
  | 'roundroof'
  | 'prism'
  | 'torus'
  | 'dome'
  | 'fillet';

interface NodeBase {
  id: string;
  name: string;
  /** Center of the node's local bounding box, in the parent's coordinates. */
  pos: Vec3;
  /** Degrees, applied about X, then Y, then Z (fixed axes). */
  rot: Vec3;
  /** Size of the local bounding box (before rotation). Always positive. */
  size: Vec3;
  /** Mirror along the local X / Y / Z axis, applied before rotation. */
  flip?: [boolean, boolean, boolean];
  /** Holes cut material away from the solids they are grouped with. */
  hole: boolean;
  color: string;
  hidden?: boolean;
  locked?: boolean;
  /** Faded and out of reach: still in view, but a click goes through it to what is around or inside it. */
  ghost?: boolean;
  /** A picture stretched over the whole surface (see `Texture`); not shown while the object carries pictures of its own. */
  texture?: Texture;
  /** Words the user attached to the object. They stay with it through grouping: a group's children keep their own. */
  note?: string;
}

/**
 * A picture over an object's whole surface: wrapped once around its vertical
 * axis, tiled every `scale` mm, or, on an imported mesh that brought its own
 * texture coordinates, laid out as the file had it (`own`).
 */
export interface Texture {
  /** Key of an image in `Doc.assets`. */
  asset: string;
  mode: 'wrap' | 'tile' | 'own';
  /** Millimeters per repeat of a tiled picture. */
  scale: number;
  /** Degrees a wrapped picture is turned round the object; 0 puts its middle on the +X side. */
  turn: number;
}

/** How a picture is laid onto the surfaces it is grouped with. */
export type PictureMapping = 'flat' | 'wrap';

export interface ShapeNode extends NodeBase {
  type: 'shape';
  shape: ShapeKind;
  /** Shape-specific numbers (sides, corner radius, wall thickness, ...). */
  params: Record<string, number>;
}

export interface GroupNode extends NodeBase {
  type: 'group';
  /**
   * The children show their own colors (the group's `color` then only stands for it in lists and
   * on selection). Choosing a color for the group paints the whole and clears this.
   */
  mixed?: boolean;
  /** Bounding box of the combined children when the group was made; `size / natural` is its scale. */
  natural: Vec3;
  /** Positioned relative to the center of the group. */
  children: SceneNode[];
}

/** An imported mesh (STL, OBJ, 3MF) or an extruded imported outline (SVG). */
export interface ImportNode extends NodeBase {
  type: 'import';
  /** Key into `Doc.assets`. */
  asset: string;
  /** Bounding box of the asset as imported; `size / natural` is its scale. */
  natural: Vec3;
}

export type TextAlign = 'left' | 'center' | 'right';

/** Lettering, extruded along Z. Only the words are stored; the outlines come from the built-in fonts. */
export interface TextNode extends NodeBase {
  type: 'text';
  /** May hold several lines. */
  text: string;
  /** Id of a built-in font (see `TEXT_FONTS`). */
  font: string;
  align: TextAlign;
  /** Bent round a cylinder or laid along an arc; straight when absent (see `src/text/curve.ts`). */
  curve?: TextCurve;
  /**
   * Bounding box of the lettering as laid out (10 mm em, 1 mm thick; curved, the box round the curved
   * lettering at that scale); `size / natural` is its scale.
   */
  natural: Vec3;
}

/** A value of a part parameter: the generators take numbers, choices and switches. */
export type PartParamValue = number | string | boolean;

/**
 * A parametric part: a gear, pulley, sprocket or thread made from a handful
 * of parameters. Only the parameters are stored; the generator (see
 * `src/parts`) makes the geometry.
 */
export interface PartNode extends NodeBase {
  type: 'part';
  /** Id of the generator. */
  part: string;
  params: Record<string, PartParamValue>;
  /** Bounding box of the part as generated; `size / natural` is its scale. */
  natural: Vec3;
}

/**
 * A picture: a sheet showing an image, which prints onto the surfaces of
 * whatever it is grouped with. Flat, it is a square sheet facing +Z that
 * projects onto what is behind it; wrapped, a band around its own Z axis,
 * `angle` degrees of the way round, that projects outwards. Built as a unit
 * sheet; `size` is its width, depth and height (the band's diameter and height).
 */
export interface PictureNode extends NodeBase {
  type: 'picture';
  /** Key of an image in `Doc.assets`. */
  asset: string;
  mapping: PictureMapping;
  /** Degrees of the circumference a wrapped picture covers. */
  angle: number;
  /** Always [1, 1, 1]: the sheet is built at unit size and scaled to `size`. */
  natural: Vec3;
}

export type SceneNode = ShapeNode | GroupNode | ImportNode | TextNode | PartNode | PictureNode;

import { tr } from '../i18n';
import type { TextCurve } from '../text/curve';
import type { Robot } from '../robot/types';
export type { Robot };

/** The fonts lettering can be set in. All are bold or heavy cuts: thin strokes do not print. */
export const TEXT_FONTS: { id: string; name: string }[] = [
  { id: 'sans', name: tr('Sans') },
  { id: 'serif', name: tr('Slab serif') },
  { id: 'mono', name: tr('Monospace') },
  { id: 'stencil', name: tr('Stencil') },
];
export type Scene = SceneNode[];

/** Imported triangle mesh, centered on its bounding box. Arrays are base64 (little-endian). */
export interface MeshAsset {
  kind: 'mesh';
  /** Float32 xyz per vertex. */
  positions: string;
  /** Uint32 vertex indices, three per triangle. */
  triangles: string;
  /** Float32 texture coordinates per corner (two per corner, three corners per triangle, v up), when the file had them. */
  uv?: string;
}

/** Imported 2D artwork, centered on its bounding box; extruded 1 mm along Z (then scaled by the node). */
export interface OutlineAsset {
  kind: 'outline';
  shapes: OutlineShape[];
}

export interface OutlineShape {
  contours: Polygon[];
  /** Fill rule of the source element: even-odd, or non-zero winding. */
  evenodd: boolean;
}

/** An imported PNG or JPEG, for pictures and textures. */
export interface ImageAsset {
  kind: 'image';
  /** The file's name, to tell images apart in the inspector. */
  name: string;
  mime: 'image/png' | 'image/jpeg';
  /** The file's bytes, base64. */
  data: string;
  /** Pixel size. */
  width: number;
  height: number;
}

export type Asset = MeshAsset | OutlineAsset | ImageAsset;

export interface Doc {
  /** Identifies the project across renames, copies to other devices and sync. */
  id: string;
  name: string;
  scene: Scene;
  assets: Record<string, Asset>;
  /** Small picture of the design (a JPEG data URL), shown by the projects browser. */
  thumb?: string;
  /** Stamped on every save: this revision, the one it followed, the device that made it and when. Sync tells changes apart by them. */
  revision?: string;
  parent?: string;
  device?: string;
  saved?: string;
  /** The robot laid over the design (Robot mode): links, joints and their physical settings. */
  robot?: Robot;
}
