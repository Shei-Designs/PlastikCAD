import type { MeshData, RenderMesh } from '../geometry/mesh';
import type { Bounds } from '../model/math';
import type { Asset, Polygon, SceneNode } from '../model/types';

export type WorkerRequest =
  /** Imported data that later requests may refer to. Sent before any node that uses it. */
  | { type: 'assets'; assets: Record<string, Asset> }
  /** Build the geometry of one node at its built size, centred on the origin (see `builtSize`, `geomKey`). */
  | { type: 'build'; id: number; key: string; node: SceneNode }
  /** Bounds of what the nodes would produce as a group (solids merged, holes cut), in the nodes' own coordinates. */
  | { type: 'measure'; id: number; nodes: SceneNode[] }
  /** Merge the nodes (holes are ignored at the top level) into one mesh for export; `fine` rebuilds curves with more facets. */
  | { type: 'export'; id: number; nodes: SceneNode[]; outline: boolean; fine: boolean };

export interface BuildResult {
  key: string;
  render: RenderMesh;
  /** Bounds of the built geometry (at built size, centred on the origin). */
  bounds: Bounds;
  triangles: number;
  /** mm³ at built size; 0 for open meshes. */
  volume: number;
  /** False for an imported mesh that is not watertight: it can be shown and exported, but not combined. */
  watertight: boolean;
}

export interface ExportResult {
  mesh: MeshData;
  /** Outline of the design seen from above, when requested. Even-odd contours. */
  outline?: Polygon[];
  bounds: Bounds;
  volume: number;
  warnings: string[];
}

export type WorkerResponse =
  | { type: 'built'; id: number; result: BuildResult }
  | { type: 'measured'; id: number; bounds: Bounds | null }
  | { type: 'exported'; id: number; result: ExportResult }
  | { type: 'error'; id: number; message: string };
