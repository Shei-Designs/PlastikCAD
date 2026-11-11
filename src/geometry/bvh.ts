// A tree of boxes over the triangles of a mesh, so that a ray finds the one it
// hits without trying them all: an imported scan runs to millions, and the
// pointer asks at every move. The tree is made in the geometry worker with the
// mesh and travels with it as three flat arrays; the ray is cast on the main
// thread. Both work on loose triangles (nine numbers each), as the renderer
// has them.

export interface Bvh {
  /** The box of each node: min x, y, z, then max x, y, z. */
  boxes: Float32Array;
  /**
   * Two numbers a node. A leaf: how many triangles, and where its first is in
   * `order`. A branch: zero, and the node of its second half (the first half
   * is the node right after it).
   */
  nodes: Uint32Array;
  /** The triangles, leaf by leaf. */
  order: Uint32Array;
}

/** A leaf holds up to this many triangles: fewer makes the tree deeper than the tests it saves. */
const LEAF = 8;

/** The tree over the triangles of `positions` (nine numbers each). */
export function buildBvh(positions: Float32Array): Bvh {
  const count = Math.floor(positions.length / 9);
  // No triangles, no tree: a leaf of none would read as a branch.
  if (count === 0) return { boxes: new Float32Array(0), nodes: new Uint32Array(0), order: new Uint32Array(0) };
  const order = new Uint32Array(count);
  // Each triangle's box and, for sorting it into a half, its middle.
  const tri = new Float32Array(count * 6);
  const mid = new Float32Array(count * 3);
  for (let t = 0; t < count; t++) {
    order[t] = t;
    const p = t * 9;
    for (let k = 0; k < 3; k++) {
      const a = positions[p + k];
      const b = positions[p + 3 + k];
      const c = positions[p + 6 + k];
      const lo = Math.min(a, b, c);
      const hi = Math.max(a, b, c);
      tri[t * 6 + k] = lo;
      tri[t * 6 + 3 + k] = hi;
      mid[t * 3 + k] = (lo + hi) / 2;
    }
  }
  // At most two nodes for every full leaf, and never fewer than one.
  let capacity = Math.max(1, 2 * Math.ceil(count / (LEAF / 2)));
  let boxes = new Float32Array(capacity * 6);
  let nodes = new Uint32Array(capacity * 2);
  let used = 0;
  const node = (): number => {
    if (used === capacity) {
      capacity *= 2;
      const b = new Float32Array(capacity * 6);
      b.set(boxes);
      boxes = b;
      const n = new Uint32Array(capacity * 2);
      n.set(nodes);
      nodes = n;
    }
    return used++;
  };

  // Ranges of `order` still to be made into nodes, last in, first out: the branch a range is the second
  // half of (-1 for a first half, which is always the node right after its branch), its start and its end.
  const todo: number[] = [-1, 0, count];
  while (todo.length) {
    const end = todo.pop()!;
    const start = todo.pop()!;
    const parent = todo.pop()!;
    const at = node();
    if (parent >= 0) nodes[parent * 2 + 1] = at;
    // The box of the triangles, and that of their middles, which says where to cut.
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = order[i];
      const b = t * 6;
      if (tri[b] < x0) x0 = tri[b];
      if (tri[b + 1] < y0) y0 = tri[b + 1];
      if (tri[b + 2] < z0) z0 = tri[b + 2];
      if (tri[b + 3] > x1) x1 = tri[b + 3];
      if (tri[b + 4] > y1) y1 = tri[b + 4];
      if (tri[b + 5] > z1) z1 = tri[b + 5];
      for (let k = 0; k < 3; k++) {
        const m = mid[t * 3 + k];
        if (m < lo[k]) lo[k] = m;
        if (m > hi[k]) hi[k] = m;
      }
    }
    // Rounded outwards: the boxes are single precision, and a ray must never miss a box whose triangle it hits.
    boxes[at * 6] = down(x0);
    boxes[at * 6 + 1] = down(y0);
    boxes[at * 6 + 2] = down(z0);
    boxes[at * 6 + 3] = up(x1);
    boxes[at * 6 + 4] = up(y1);
    boxes[at * 6 + 5] = up(z1);
    if (end - start <= LEAF) {
      nodes[at * 2] = end - start;
      nodes[at * 2 + 1] = start;
      continue;
    }
    // Cut across the longest side of the middles' box, half way; triangles before the cut go first.
    const axis = hi[0] - lo[0] >= hi[1] - lo[1] && hi[0] - lo[0] >= hi[2] - lo[2] ? 0 : hi[1] - lo[1] >= hi[2] - lo[2] ? 1 : 2;
    const cut = (lo[axis] + hi[axis]) / 2;
    let i = start;
    let j = end - 1;
    while (i <= j) {
      if (mid[order[i] * 3 + axis] < cut) i++;
      else {
        const swap = order[i];
        order[i] = order[j];
        order[j] = swap;
        j--;
      }
    }
    // Middles all in one place (triangles on top of each other) fall on one side: halve the count instead.
    const split = i === start || i === end ? (start + end) >> 1 : i;
    nodes[at * 2] = 0;
    // The first half goes on last, so it is taken up next and numbered right after this node.
    todo.push(at, split, end, -1, start, split);
  }
  return { boxes: boxes.slice(0, used * 6), nodes: nodes.slice(0, used * 2), order };
}

const scratch = new Float32Array(1);
const scratchBits = new Uint32Array(scratch.buffer);

/** The largest single-precision number not above `v`. */
function down(v: number): number {
  scratch[0] = v;
  if (scratch[0] <= v) return scratch[0];
  // Rounded up on the way in: one step back.
  scratchBits[0] += scratch[0] > 0 ? -1 : 1;
  return scratch[0];
}

/** The smallest single-precision number not below `v`. */
function up(v: number): number {
  scratch[0] = v;
  if (scratch[0] >= v) return scratch[0];
  scratchBits[0] += scratch[0] > 0 ? 1 : -1;
  return scratch[0];
}

export interface RayHit {
  /** How far along the ray, in lengths of `direction`. */
  t: number;
  triangle: number;
}

/**
 * The first triangle the ray meets from its front (the side its corners go
 * round counterclockwise as seen from), nearer than `limit`; null if none.
 * `direction` need not be of unit length.
 */
export function castRay(bvh: Bvh, positions: Float32Array, origin: ArrayLike<number>, direction: ArrayLike<number>, limit = Infinity): RayHit | null {
  const { boxes, nodes, order } = bvh;
  if (nodes.length === 0) return null;
  const ox = origin[0];
  const oy = origin[1];
  const oz = origin[2];
  const dx = direction[0];
  const dy = direction[1];
  const dz = direction[2];
  const ix = 1 / dx;
  const iy = 1 / dy;
  const iz = 1 / dz;
  let best = limit;
  let found = -1;
  const stack: number[] = [0];
  while (stack.length) {
    const at = stack.pop()!;
    const b = at * 6;
    // Where the ray enters and leaves the box, slab by slab. A ray that runs along a slab is either
    // between its faces all the way or never.
    let near = 0;
    let far = best;
    if (dx !== 0) {
      const a = (boxes[b] - ox) * ix;
      const c = (boxes[b + 3] - ox) * ix;
      near = Math.max(near, Math.min(a, c));
      far = Math.min(far, Math.max(a, c));
    } else if (ox < boxes[b] || ox > boxes[b + 3]) continue;
    if (dy !== 0) {
      const a = (boxes[b + 1] - oy) * iy;
      const c = (boxes[b + 4] - oy) * iy;
      near = Math.max(near, Math.min(a, c));
      far = Math.min(far, Math.max(a, c));
    } else if (oy < boxes[b + 1] || oy > boxes[b + 4]) continue;
    if (dz !== 0) {
      const a = (boxes[b + 2] - oz) * iz;
      const c = (boxes[b + 5] - oz) * iz;
      near = Math.max(near, Math.min(a, c));
      far = Math.min(far, Math.max(a, c));
    } else if (oz < boxes[b + 2] || oz > boxes[b + 5]) continue;
    if (near > far) continue;
    const n = nodes[at * 2];
    if (n === 0) {
      stack.push(nodes[at * 2 + 1], at + 1);
      continue;
    }
    const start = nodes[at * 2 + 1];
    for (let i = start; i < start + n; i++) {
      const t = order[i];
      const p = t * 9;
      const ax = positions[p];
      const ay = positions[p + 1];
      const az = positions[p + 2];
      const e1x = positions[p + 3] - ax;
      const e1y = positions[p + 4] - ay;
      const e1z = positions[p + 5] - az;
      const e2x = positions[p + 6] - ax;
      const e2y = positions[p + 7] - ay;
      const e2z = positions[p + 8] - az;
      // The ray against the triangle's plane: only from the front.
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const facing = -(dx * nx + dy * ny + dz * nz);
      if (!(facing > 0)) continue;
      const sx = ox - ax;
      const sy = oy - ay;
      const sz = oz - az;
      const along = sx * nx + sy * ny + sz * nz;
      if (along < 0) continue;
      // Inside the triangle: the two weights of the far corners, neither negative, together no more than one.
      const cx = sy * dz - sz * dy;
      const cy = sz * dx - sx * dz;
      const cz = sx * dy - sy * dx;
      const u = e2x * cx + e2y * cy + e2z * cz;
      if (u < 0 || u > facing) continue;
      const v = -(e1x * cx + e1y * cy + e1z * cz);
      if (v < 0 || u + v > facing) continue;
      const hit = along / facing;
      if (hit < best) {
        best = hit;
        found = t;
      }
    }
  }
  return found < 0 ? null : { t: best, triangle: found };
}
