import type { Faces, MeshData, RenderMesh } from '../geometry/mesh';
import type { Bounds } from '../model/math';
import type { Asset, PartNode, Polygon, SceneNode } from '../model/types';
import type { MeshProperties } from '../robot/inertia';
import type { CollisionKind } from '../robot/types';

export type WorkerRequest =
  /** Imported data that later requests may refer to. Sent before any node that uses it. */
  | { type: 'assets'; assets: Record<string, Asset> }
  /** Drop every asset not named in `keep` (a design was closed, lettering went out of use); what was built from imported data goes too. */
  | { type: 'forgetAssets'; keep: string[] }
  /** Build the geometry of one node at its built size, centered on the origin (see `builtSize`, `geomKey`). */
  | { type: 'build'; id: number; key: string; node: SceneNode }
  /** Bounds of what the nodes would produce as a group (solids merged, holes cut), in the nodes' own coordinates. */
  | { type: 'measure'; id: number; nodes: SceneNode[] }
  /** Bounds of a part as its generator makes it, before it is centered: where its origin sits in its box. */
  | { type: 'partBox'; id: number; node: PartNode }
  /**
   * Merge the nodes (holes are ignored at the top level) into one mesh for export; `fine` rebuilds curves with
   * more facets. With `local` the geometry stays in the nodes' own built frames, unplaced (one node at a time).
   */
  | { type: 'export'; id: number; nodes: SceneNode[]; outline: boolean; fine: boolean; local?: boolean }
  /**
   * Every node placed, as one closed part per color (holes cut, the parts of a mixed group kept apart), for a
   * colored export. With `local` the parts stay in the nodes' own built frames, unplaced (one node at a time).
   */
  | { type: 'exportColored'; id: number; nodes: SceneNode[]; fine: boolean; local?: boolean }
  /** Volume, area, centroid and inertia of each node as placed in the design, for the robot's links. */
  | { type: 'massProperties'; id: number; nodes: SceneNode[] }
  /** Each node placed, as the visual parts, collision shape and mass properties of a robot link. */
  | { type: 'robotGeometry'; id: number; nodes: SceneNode[]; collisions: Record<string, CollisionKind>; fine: boolean };

export interface BuildResult {
  key: string;
  render: RenderMesh;
  /** For a group: which child each triangle came from, so its parts can be shown in their own colors. */
  faces?: Faces;
  /** Bounds of the built geometry (at built size, centered on the origin). */
  bounds: Bounds;
  triangles: number;
  /** mm³ at built size; 0 for open meshes. */
  volume: number;
  /** False for an imported mesh that is not watertight: it can be shown and exported, but not combined. */
  watertight: boolean;
}

export interface ExportResult {
  mesh: MeshData;
  /** A single group exported in place: which child each triangle came from (see `BuildResult`). */
  faces?: Faces;
  /** A single imported mesh exported in place: the texture coordinates it brought, per corner of `mesh`. */
  uv?: Float32Array;
  /** Outline of the design seen from above, when requested. Even-odd contours. */
  outline?: Polygon[];
  bounds: Bounds;
  volume: number;
  warnings: string[];
}

/** A closed mesh of one color, placed in the design (mm, Z up). */
export interface ColoredPart {
  color: string;
  mesh: MeshData;
}

/** A top-level node as exported: its parts by color, disjoint, together making up the object. */
export interface ColoredObject {
  name: string;
  parts: ColoredPart[];
}

export interface ColoredExport {
  objects: ColoredObject[];
  warnings: string[];
}

/** Mass properties of a node as placed in the design (mm, g-free: see `MeshProperties`). */
export interface LinkProperties extends MeshProperties {
  id: string;
  /** False for an open mesh, whose figures are what its triangles happen to say. */
  watertight: boolean;
  triangles: number;
}

/** A robot link's geometry as exported: everything placed in the design (mm, Z up). */
export interface LinkGeometry {
  id: string;
  visual: ColoredPart[];
  /** The collision mesh (a hull, or the shape itself); null for a box, which `bounds` describes, or none. */
  collision: MeshData | null;
  bounds: Bounds;
  props: LinkProperties;
}

export type WorkerResponse =
  | { type: 'built'; id: number; result: BuildResult }
  | { type: 'measured'; id: number; bounds: Bounds | null }
  | { type: 'partBoxed'; id: number; bounds: Bounds | null }
  | { type: 'exported'; id: number; result: ExportResult }
  | { type: 'exportedColored'; id: number; result: ColoredExport }
  | { type: 'massProperties'; id: number; result: LinkProperties[] }
  | { type: 'robotGeometry'; id: number; result: LinkGeometry[] }
  | { type: 'error'; id: number; message: string };
