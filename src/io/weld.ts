import earcut from 'earcut';
import type { MeshData } from '../geometry/mesh';

/**
 * Collects triangles into an indexed mesh, merging vertices whose coordinates
 * are identical as float32. Mesh files mostly store every triangle's corners
 * separately; the kernel needs to know which triangles share an edge.
 *
 * The vertex lookup is an open-addressing hash table in typed arrays keyed on
 * the bit patterns of the coordinates, so that files with millions of
 * triangles cost no per-vertex allocation.
 */
export class MeshBuilder {
  private positions: Float32Array;
  /** The same memory as `positions`, to compare coordinates bit for bit. */
  private bits: Uint32Array;
  private vertexCount = 0;
  /** Vertex index + 1 per slot; 0 marks an empty slot. Its length is a power of two. */
  private table: Int32Array;
  private triangles: Uint32Array;
  private triangleCount = 0;
  private scratch = new Float32Array(3);
  private scratchBits = new Uint32Array(this.scratch.buffer);

  constructor(expectedVertices = 1024, expectedTriangles = expectedVertices * 2) {
    this.positions = new Float32Array(Math.max(16, expectedVertices) * 3);
    this.bits = new Uint32Array(this.positions.buffer);
    let slots = 64;
    while (slots < expectedVertices * 2) slots *= 2;
    this.table = new Int32Array(slots);
    this.triangles = new Uint32Array(Math.max(16, expectedTriangles) * 3);
  }

  /** Index of the vertex at these coordinates, added if it is new; -1 if a coordinate is not a finite float32. */
  vertex(x: number, y: number, z: number): number {
    this.scratch[0] = x;
    this.scratch[1] = y;
    this.scratch[2] = z;
    return this.vertexBits(this.scratchBits[0], this.scratchBits[1], this.scratchBits[2]);
  }

  /** As `vertex`, from the IEEE 754 bit patterns of three float32 coordinates. */
  vertexBits(bx: number, by: number, bz: number): number {
    bx >>>= 0;
    by >>>= 0;
    bz >>>= 0;
    // Infinity and NaN have every exponent bit set.
    if ((bx & 0x7f800000) === 0x7f800000 || (by & 0x7f800000) === 0x7f800000 || (bz & 0x7f800000) === 0x7f800000) {
      return -1;
    }
    // -0 and +0 are the same place.
    if (bx === 0x80000000) bx = 0;
    if (by === 0x80000000) by = 0;
    if (bz === 0x80000000) bz = 0;

    const bits = this.bits;
    const table = this.table;
    const mask = table.length - 1;
    let slot = hash(bx, by, bz) & mask;
    for (;;) {
      const entry = table[slot];
      if (entry === 0) break;
      const o = (entry - 1) * 3;
      if (bits[o] === bx && bits[o + 1] === by && bits[o + 2] === bz) return entry - 1;
      slot = (slot + 1) & mask;
    }

    const index = this.vertexCount++;
    if (index * 3 === this.positions.length) {
      const grown = new Float32Array(this.positions.length * 2);
      grown.set(this.positions);
      this.positions = grown;
      this.bits = new Uint32Array(grown.buffer);
    }
    const o = index * 3;
    this.bits[o] = bx;
    this.bits[o + 1] = by;
    this.bits[o + 2] = bz;
    table[slot] = index + 1;
    // Linear probing degrades quickly past half full.
    if (this.vertexCount * 2 > table.length) this.rehash();
    return index;
  }

  /** Adds a triangle. Ones that touch an invalid vertex (-1) or use a vertex twice have no area and are dropped. */
  triangle(a: number, b: number, c: number): void {
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) return;
    const o = this.triangleCount * 3;
    if (o === this.triangles.length) {
      const grown = new Uint32Array(this.triangles.length * 2);
      grown.set(this.triangles);
      this.triangles = grown;
    }
    this.triangles[o] = a;
    this.triangles[o + 1] = b;
    this.triangles[o + 2] = c;
    this.triangleCount++;
  }

  get size(): number {
    return this.triangleCount;
  }

  /** The finished mesh, without the vertices that no surviving triangle uses (they would stretch its bounding box). */
  finish(): MeshData {
    const triangles = this.triangles.slice(0, this.triangleCount * 3);
    const remap = new Int32Array(this.vertexCount).fill(-1);
    let used = 0;
    for (let i = 0; i < triangles.length; i++) {
      const v = triangles[i];
      if (remap[v] < 0) remap[v] = used++;
    }
    if (used === this.vertexCount) return { positions: this.positions.slice(0, used * 3), triangles };

    const positions = new Float32Array(used * 3);
    for (let v = 0; v < this.vertexCount; v++) {
      const to = remap[v];
      if (to < 0) continue;
      positions[to * 3] = this.positions[v * 3];
      positions[to * 3 + 1] = this.positions[v * 3 + 1];
      positions[to * 3 + 2] = this.positions[v * 3 + 2];
    }
    for (let i = 0; i < triangles.length; i++) triangles[i] = remap[triangles[i]];
    return { positions, triangles };
  }

  private rehash(): void {
    const bits = this.bits;
    const table = new Int32Array(this.table.length * 2);
    const mask = table.length - 1;
    for (let v = 0; v < this.vertexCount; v++) {
      let slot = hash(bits[v * 3], bits[v * 3 + 1], bits[v * 3 + 2]) & mask;
      while (table[slot] !== 0) slot = (slot + 1) & mask;
      table[slot] = v + 1;
    }
    this.table = table;
  }
}

// Coordinates on a grid differ only in a few high bits of their patterns, so
// the three words are mixed thoroughly (murmur3's rounds and finaliser).
function hash(x: number, y: number, z: number): number {
  let h = Math.imul(x, 0xcc9e2d51);
  h = (h << 15) | (h >>> 17);
  h = Math.imul(h ^ y, 0x1b873593);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ z, 0x85ebca6b);
  h ^= h >>> 16;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 13);
}

/**
 * How to cut a polygon into triangles when a fan around its first corner
 * would leave its outline: triples of indices into its corners, wound as the
 * polygon is. Null when the fan will do: for a triangle, a convex polygon, or
 * one too crooked to tell. `xyz` holds the corners, three coordinates each.
 */
export function cutPolygon(xyz: ArrayLike<number>): number[] | null {
  const n = xyz.length / 3;
  if (n < 4) return null;
  // The polygon's normal by Newell's method, which holds for corners that are not quite in one plane.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 3;
    const b = ((i + 1) % n) * 3;
    nx += (xyz[a + 1] - xyz[b + 1]) * (xyz[a + 2] + xyz[b + 2]);
    ny += (xyz[a + 2] - xyz[b + 2]) * (xyz[a] + xyz[b]);
    nz += (xyz[a] - xyz[b]) * (xyz[a + 1] + xyz[b + 1]);
  }
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  // Convex when every corner turns the way the polygon goes round.
  let convex = true;
  for (let i = 0; i < n && convex; i++) {
    const p = ((i + n - 1) % n) * 3;
    const c = i * 3;
    const q = ((i + 1) % n) * 3;
    const ux = xyz[c] - xyz[p];
    const uy = xyz[c + 1] - xyz[p + 1];
    const uz = xyz[c + 2] - xyz[p + 2];
    const vx = xyz[q] - xyz[c];
    const vy = xyz[q + 1] - xyz[c + 1];
    const vz = xyz[q + 2] - xyz[c + 2];
    const turn = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    if (turn < -1e-10 * length * length) convex = false;
  }
  if (convex) return null;

  // Two axes in the polygon's plane, from which it is seen going round counterclockwise.
  nx /= length;
  ny /= length;
  nz /= length;
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  // The axis furthest from the normal, crossed with it.
  let [ux, uy, uz] = ax <= ay && ax <= az ? [0, nz, -ny] : ay <= az ? [-nz, 0, nx] : [ny, -nx, 0];
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  // A corner written twice running is one corner.
  const kept: number[] = [];
  const same = (a: number, b: number) => xyz[a * 3] === xyz[b * 3] && xyz[a * 3 + 1] === xyz[b * 3 + 1] && xyz[a * 3 + 2] === xyz[b * 3 + 2];
  for (let i = 0; i < n; i++) if (kept.length === 0 || !same(i, kept[kept.length - 1])) kept.push(i);
  while (kept.length > 1 && same(kept[0], kept[kept.length - 1])) kept.pop();
  const flat = new Array<number>(kept.length * 2);
  for (const [k, i] of kept.entries()) {
    flat[k * 2] = xyz[i * 3] * ux + xyz[i * 3 + 1] * uy + xyz[i * 3 + 2] * uz;
    flat[k * 2 + 1] = xyz[i * 3] * vx + xyz[i * 3 + 1] * vy + xyz[i * 3 + 2] * vz;
  }
  const cut = earcut(flat);
  // Anything but a triangle less than two per corner means the outline crosses itself or folds flat: the fan is no worse.
  if (cut.length !== (kept.length - 2) * 3) return null;
  for (let t = 0; t < cut.length; t += 3) {
    const [a, b, c] = [cut[t] * 2, cut[t + 1] * 2, cut[t + 2] * 2];
    const area = (flat[b] - flat[a]) * (flat[c + 1] - flat[a + 1]) - (flat[b + 1] - flat[a + 1]) * (flat[c] - flat[a]);
    const swap = area < 0;
    cut[t] = kept[cut[t]];
    const second = kept[cut[t + 1]];
    const third = kept[cut[t + 2]];
    cut[t + 1] = swap ? third : second;
    cut[t + 2] = swap ? second : third;
  }
  return cut;
}
