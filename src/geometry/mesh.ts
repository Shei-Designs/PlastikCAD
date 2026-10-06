export interface MeshData {
  /** xyz per vertex, shared between triangles (indexed). */
  positions: Float32Array;
  triangles: Uint32Array;
}

/**
 * Faces meeting at more than this many degrees get a hard edge, in shading
 * and as an edge line alike. A twelve-sided prism (30 degrees a corner) is
 * still faceted; anything with fifteen sides or more reads as round.
 */
export const CREASE_ANGLE = 25;

export interface RenderMesh {
  /** Unindexed triangles (9 floats each); corners carry their own normal so sharp edges shade crisply. */
  positions: Float32Array;
  normals: Float32Array;
}
