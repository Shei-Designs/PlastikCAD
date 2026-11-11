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

/**
 * For each vertex, the first vertex at exactly the same place. A mesh that
 * carries texture coordinates has a vertex for every corner that differs in
 * them, so its seams would otherwise read as open edges.
 */
export function samePlace(positions: Float32Array): Uint32Array {
  const count = positions.length / 3;
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, count * 3);
  const first = new Uint32Array(count);
  let slots = 64;
  while (slots < count * 2) slots *= 2;
  // Vertex + 1 per slot; 0 marks an empty one.
  const table = new Uint32Array(slots);
  const mask = slots - 1;
  for (let v = 0; v < count; v++) {
    // -0 and +0 are the same place.
    const x = bits[v * 3] === 0x80000000 ? 0 : bits[v * 3];
    const y = bits[v * 3 + 1] === 0x80000000 ? 0 : bits[v * 3 + 1];
    const z = bits[v * 3 + 2] === 0x80000000 ? 0 : bits[v * 3 + 2];
    let slot = mix(mix(x, y), z) & mask;
    for (;;) {
      const entry = table[slot];
      if (entry === 0) {
        table[slot] = v + 1;
        first[v] = v;
        break;
      }
      const o = (entry - 1) * 3;
      if ((bits[o] === 0x80000000 ? 0 : bits[o]) === x && (bits[o + 1] === 0x80000000 ? 0 : bits[o + 1]) === y && (bits[o + 2] === 0x80000000 ? 0 : bits[o + 2]) === z) {
        first[v] = entry - 1;
        break;
      }
      slot = (slot + 1) & mask;
    }
  }
  return first;
}

/** Two words into one, well stirred (murmur3's rounds and finaliser): vertex numbers and grid coordinates differ in few bits. */
function mix(a: number, b: number): number {
  let h = Math.imul(a, 0xcc9e2d51);
  h = (h << 15) | (h >>> 17);
  h = Math.imul(h ^ b, 0x1b873593);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/**
 * The edge lines of a mesh: where two faces meet at more than `angle` degrees,
 * and where a face has no neighbour (the rim of an open mesh). Two numbers of
 * xyz a line. The rule is that of three.js's EdgesGeometry, which this stands
 * in for: that one runs on the main thread and takes seconds on a large mesh.
 * `same` names the vertices that are one place (see `samePlace`); without it
 * every vertex is its own. Null when there are more than `limit` lines: a
 * rough scan is all edges, and drawing them costs more than they tell.
 */
export function creaseEdges(positions: Float32Array, triangles: Uint32Array, angle: number, limit = Infinity, same?: Uint32Array): Float32Array | null {
  const nTri = triangles.length / 3;
  const unit = new Float32Array(nTri * 3);
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
    // A triangle with no area has no normal: left at zero, which makes an edge of every side it shares.
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) unit.set([nx / len, ny / len, nz / len], t * 3);
  }

  // Every side waits, under its two ends in the order its triangle goes round, for the neighbour that
  // has it the other way round. A closed mesh has half its sides waiting at most; an open one grows the table.
  let slots = 64;
  while (slots < nTri * 4) slots *= 2;
  let from = new Uint32Array(slots);
  let to = new Uint32Array(slots);
  /** The triangle + 1 while the side waits, -1 once it has met its neighbour, 0 for an empty slot. */
  let owner = new Int32Array(slots);
  /** The vertices as the mesh numbers them, for the line's ends. */
  let ends = new Uint32Array(slots * 2);
  let held = 0;
  const find = (a: number, b: number): number => {
    const mask = slots - 1;
    let slot = mix(a, b) & mask;
    while (owner[slot] !== 0 && (from[slot] !== a || to[slot] !== b)) slot = (slot + 1) & mask;
    return slot;
  };
  const grow = (): void => {
    const [oldFrom, oldTo, oldOwner, oldEnds, oldSlots] = [from, to, owner, ends, slots];
    slots *= 2;
    from = new Uint32Array(slots);
    to = new Uint32Array(slots);
    owner = new Int32Array(slots);
    ends = new Uint32Array(slots * 2);
    for (let i = 0; i < oldSlots; i++) {
      if (oldOwner[i] === 0) continue;
      const slot = find(oldFrom[i], oldTo[i]);
      from[slot] = oldFrom[i];
      to[slot] = oldTo[i];
      owner[slot] = oldOwner[i];
      ends[slot * 2] = oldEnds[i * 2];
      ends[slot * 2 + 1] = oldEnds[i * 2 + 1];
    }
  };

  let lines = new Float32Array(1024 * 6);
  let count = 0;
  const line = (a: number, b: number): boolean => {
    if (count >= limit) return false;
    if (count * 6 === lines.length) {
      const grown = new Float32Array(lines.length * 2);
      grown.set(lines);
      lines = grown;
    }
    lines.set(positions.subarray(a * 3, a * 3 + 3), count * 6);
    lines.set(positions.subarray(b * 3, b * 3 + 3), count * 6 + 3);
    count++;
    return true;
  };

  const limitDot = Math.cos((angle * Math.PI) / 180);
  for (let t = 0; t < nTri; t++) {
    const v0 = triangles[t * 3];
    const v1 = triangles[t * 3 + 1];
    const v2 = triangles[t * 3 + 2];
    const p0 = same ? same[v0] : v0;
    const p1 = same ? same[v1] : v1;
    const p2 = same ? same[v2] : v2;
    // Two corners in one place: a sliver with no sides worth drawing.
    if (p0 === p1 || p1 === p2 || p2 === p0) continue;
    for (let k = 0; k < 3; k++) {
      const a = k === 0 ? p0 : k === 1 ? p1 : p2;
      const b = k === 0 ? p1 : k === 1 ? p2 : p0;
      const other = find(b, a);
      if (owner[other] > 0) {
        const o = (owner[other] - 1) * 3;
        owner[other] = -1;
        if (unit[t * 3] * unit[o] + unit[t * 3 + 1] * unit[o + 1] + unit[t * 3 + 2] * unit[o + 2] <= limitDot) {
          if (!line(ends[other * 2], ends[other * 2 + 1])) return null;
        }
        continue;
      }
      const own = find(a, b);
      // A third face on a side already taken adds nothing.
      if (owner[own] !== 0) continue;
      from[own] = a;
      to[own] = b;
      owner[own] = t + 1;
      ends[own * 2] = k === 0 ? v0 : k === 1 ? v1 : v2;
      ends[own * 2 + 1] = k === 0 ? v1 : k === 1 ? v2 : v0;
      // Probing slows down quickly past half full.
      if (++held * 2 > slots) grow();
    }
  }
  // Whatever still waits has no neighbour.
  for (let i = 0; i < slots; i++) {
    if (owner[i] > 0 && !line(ends[i * 2], ends[i * 2 + 1])) return null;
  }
  return lines.slice(0, count * 6);
}
