export interface MeshData {
  /** xyz per vertex, shared between triangles (indexed). */
  positions: Float32Array;
  triangles: Uint32Array;
}

export interface RenderMesh {
  /** Unindexed triangles (9 floats each); corners carry their own normal so sharp edges shade crisply. */
  positions: Float32Array;
  normals: Float32Array;
}
