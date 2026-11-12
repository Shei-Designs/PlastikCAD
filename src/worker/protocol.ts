import type { Bvh } from '../geometry/bvh';
import type { FeatureIndex } from '../geometry/features';
import type { Faces, MeshData, RenderMesh } from '../geometry/mesh';
import type { Companion } from '../io/import';
import type { Bounds } from '../model/math';
import type { Asset, PartNode, Polygon, SceneNode } from '../model/types';
import type { MeshProperties } from '../robot/inertia';
import type { CollisionKind } from '../robot/types';
import type { ImportResult } from './importing';

export type WorkerRequest =
  /** Imported data that later requests may refer to. Sent before any node that uses it. */
  | { type: 'assets'; assets: Record<string, Asset> }
  /** Drop every asset not named in `keep` (a design was closed, lettering went out of use); what was built from imported data goes too. */
  | { type: 'forgetAssets'; keep: string[] }
  /**
   * Read a model or drawing file into what a design keeps (see worker/importing.ts). `companions` are
   * the files picked with it; `scale` the unit it was made in, in millimeters, when that is known.
   */
  | { type: 'import'; id: number; name: string; bytes: Uint8Array; companions: Companion[]; scale?: number }
  /** Unpack a zip archive into the files of it the app could read (see io/zip.ts). */
  | { type: 'unzip'; id: number; bytes: Uint8Array }
  /** The unit, in millimeters, of the file request `held` read and is holding (it answered `kind: 'units'`). */
  | { type: 'importHeld'; id: number; held: number; scale: number }
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
  /**
   * What the Measure tool can take hold of on a mesh: loose triangles (nine numbers each), which are
   * first placed by `matrix` (sixteen numbers, column by column). A large mesh takes seconds to read.
   */
  | { type: 'features'; id: number; positions: Float32Array; matrix: number[] }
  /** Every node placed, as a STEP file: a solid per object and color, named and colored (see io/stepExport.ts). */
  | { type: 'exportStep'; id: number; nodes: SceneNode[] }
  /** Volume, area, centroid and inertia of each node as placed in the design, for the robot's links. */
  | { type: 'massProperties'; id: number; nodes: SceneNode[] }
  /** What each node collides as where that is a mesh (a hull, the shape itself), placed in the design, for showing on the plate. */
  | { type: 'collisionMeshes'; id: number; nodes: SceneNode[]; collisions: Record<string, CollisionKind>; pieces: Record<string, number> }
  /** Each node placed, as the visual parts, collision shape and mass properties of a robot link. */
  | { type: 'robotGeometry'; id: number; nodes: SceneNode[]; collisions: Record<string, CollisionKind>; fine: boolean; pieces: Record<string, number> };

export interface BuildResult {
  key: string;
  render: RenderMesh;
  /** For a group: which child each triangle came from, so its parts can be shown in their own colors. */
  faces?: Faces;
  /** The tree a pointer ray goes down to find the triangle of `render` it hits. */
  bvh: Bvh;
  /** The edge lines of `render` (six numbers each); none for a mesh with more of them than are worth drawing. */
  edges?: Float32Array;
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

/** A STEP file, and what there is to say of it. */
export interface StepExport {
  bytes: Uint8Array;
  warnings: string[];
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
  /** The convex pieces of `collision`, where it is the hulls of several parts and not one. */
  hulls?: MeshData[];
  bounds: Bounds;
  props: LinkProperties;
}

export type WorkerResponse =
  | { type: 'built'; id: number; result: BuildResult }
  | { type: 'measured'; id: number; bounds: Bounds | null }
  | { type: 'partBoxed'; id: number; bounds: Bounds | null }
  | { type: 'exported'; id: number; result: ExportResult }
  | { type: 'exportedColored'; id: number; result: ColoredExport }
  | { type: 'exportedStep'; id: number; result: StepExport }
  | { type: 'imported'; id: number; result: ImportResult }
  | { type: 'unzipped'; id: number; result: Companion[] }
  | { type: 'features'; id: number; result: FeatureIndex }
  | { type: 'massProperties'; id: number; result: LinkProperties[] }
  | { type: 'collisionMeshes'; id: number; result: (MeshData | null)[] }
  | { type: 'robotGeometry'; id: number; result: LinkGeometry[] }
  | { type: 'error'; id: number; message: string };
