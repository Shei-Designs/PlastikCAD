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
