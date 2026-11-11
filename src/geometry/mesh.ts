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
  /** Texture coordinates per corner (v up) that an imported mesh brought with it. */
  uv?: Float32Array;
}

/** An indexed mesh that may carry texture coordinates, two per corner (not per vertex: a seam has two). */
export interface MeshWithUV extends MeshData {
  uv?: Float32Array;
}

/**
 * Where the faces of a group came from: for each triangle, an index into
 * `sources`, the path (from the group's children down) to the part that made
 * it. Each step is the part's place among its parent's children, pictures not
 * counted, rather than its id: groups of the same geometry share one build,
 * and the parts of a copy have ids of their own. `NO_SOURCE` for a face of
 * unknown origin. A triangle of a RenderMesh and the indexed mesh it was made
 * from share a number.
 */
export interface Faces {
  source: Uint16Array;
  sources: number[][];
}

export const NO_SOURCE = 0xffff;

/**
 * Per-corner normals: each corner averages the faces around its vertex that
 * lie within `angle` degrees of its own face. Linear in the triangle count
 * (Manifold's calculateNormals takes seconds on finely detailed surfaces).
 */
export function creasedNormals(positions: Float32Array, triangles: Uint32Array, angle: number): RenderMesh {
  const nTri = triangles.length / 3;
  const nVert = positions.length / 3;
  // Face normals scaled by twice the face area, and their unit versions.
  const scaled = new Float32Array(nTri * 3);
  const unit = new Float32Array(nTri * 3);
  const first = new Uint32Array(nVert + 1);
  for (let t = 0; t < nTri; t++) {
    const a = triangles[t * 3] * 3;
    const b = triangles[t * 3 + 1] * 3;
    const c = triangles[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    scaled.set([nx, ny, nz], t * 3);
    unit.set([nx / len, ny / len, nz / len], t * 3);
    first[triangles[t * 3] + 1]++;
    first[triangles[t * 3 + 1] + 1]++;
    first[triangles[t * 3 + 2] + 1]++;
  }
  // Faces around each vertex, stored back to back.
  for (let v = 0; v < nVert; v++) first[v + 1] += first[v];
  const fill = first.slice(0, nVert);
  const around = new Uint32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) for (let k = 0; k < 3; k++) around[fill[triangles[t * 3 + k]]++] = t;

  const limit = Math.cos((angle * Math.PI) / 180);
  const outPositions = new Float32Array(nTri * 9);
  const outNormals = new Float32Array(nTri * 9);
  for (let t = 0; t < nTri; t++) {
    const fx = unit[t * 3];
    const fy = unit[t * 3 + 1];
    const fz = unit[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = triangles[t * 3 + k];
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = first[v]; i < first[v + 1]; i++) {
        const f = around[i] * 3;
        if (f === t * 3 || unit[f] * fx + unit[f + 1] * fy + unit[f + 2] * fz >= limit) {
          nx += scaled[f];
          ny += scaled[f + 1];
          nz += scaled[f + 2];
        }
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      const o = t * 9 + k * 3;
      outPositions[o] = positions[v * 3];
      outPositions[o + 1] = positions[v * 3 + 1];
      outPositions[o + 2] = positions[v * 3 + 2];
      outNormals[o] = nx / len;
      outNormals[o + 1] = ny / len;
      outNormals[o + 2] = nz / len;
    }
  }
  return { positions: outPositions, normals: outNormals };
}
