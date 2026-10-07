// The design document. Everything is in millimetres, Z up, with the build
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
  /** Centre of the node's local bounding box, in the parent's coordinates. */
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
}

export interface ShapeNode extends NodeBase {
  type: 'shape';
  shape: ShapeKind;
  /** Shape-specific numbers (sides, corner radius, wall thickness, ...). */
  params: Record<string, number>;
}

export interface GroupNode extends NodeBase {
  type: 'group';
  /** Bounding box of the combined children when the group was made; `size / natural` is its scale. */
  natural: Vec3;
  /** Positioned relative to the centre of the group. */
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

export type TextAlign = 'left' | 'centre' | 'right';

/** Lettering, extruded along Z. Only the words are stored; the outlines come from the built-in fonts. */
export interface TextNode extends NodeBase {
  type: 'text';
  /** May hold several lines. */
  text: string;
  /** Id of a built-in font (see `TEXT_FONTS`). */
  font: string;
  align: TextAlign;
  /** Bounding box of the lettering as laid out (10 mm em, 1 mm thick); `size / natural` is its scale. */
  natural: Vec3;
}

export type PartQuality = 'draft' | 'normal' | 'fine';

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
  /** How finely curves are tessellated; draft is quickest, fine is for export. */
  quality: PartQuality;
  /** Bounding box of the part as generated; `size / natural` is its scale. */
  natural: Vec3;
}

export type SceneNode = ShapeNode | GroupNode | ImportNode | TextNode | PartNode;

/** The fonts lettering can be set in. All are bold or heavy cuts: thin strokes do not print. */
export const TEXT_FONTS: { id: string; name: string }[] = [
  { id: 'sans', name: 'Sans' },
  { id: 'serif', name: 'Slab serif' },
  { id: 'mono', name: 'Monospace' },
  { id: 'stencil', name: 'Stencil' },
];
export type Scene = SceneNode[];

/** Imported triangle mesh, centred on its bounding box. Arrays are base64 (little-endian). */
export interface MeshAsset {
  kind: 'mesh';
  /** Float32 xyz per vertex. */
  positions: string;
  /** Uint32 vertex indices, three per triangle. */
  triangles: string;
}

/** Imported 2D artwork, centred on its bounding box; extruded 1 mm along Z (then scaled by the node). */
export interface OutlineAsset {
  kind: 'outline';
  shapes: OutlineShape[];
}

export interface OutlineShape {
  contours: Polygon[];
  /** Fill rule of the source element: even-odd, or non-zero winding. */
  evenodd: boolean;
}

export type Asset = MeshAsset | OutlineAsset;

/** A saved point in the design's history. */
export interface Version {
  id: string;
  /** Version this one was made from; null for the first. Restoring an old version and saving again branches. */
  parent: string | null;
  label: string;
  /** ISO 8601 timestamp. */
  time: string;
  scene: Scene;
  /** Small preview image (data URL). */
  thumb?: string;
}

export interface Doc {
  name: string;
  scene: Scene;
  versions: Version[];
  /** Version the working scene descends from. */
  head: string | null;
  assets: Record<string, Asset>;
}
