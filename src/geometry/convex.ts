// Splitting a mesh into pieces that are each close to convex, for a link to
// collide as: a hull round the whole of a bent or forked part fills what is
// between its ends. The mesh is cut by planes across its own axes, each time
// where a hull round each side takes the most off the hulls' volume together,
// until a cut gains little or there are as many pieces as asked for. It need
// not be closed: only where its triangles are is looked at.
import type { MeshData } from './mesh';

export type Corner = [number, number, number];

/** Places along each axis a cut is tried at, evenly between the piece's ends. */
const TRIES = 7;
/** How many times the best place is looked round more closely, a quarter of the step each time. */
const REFINE = 3;
/** A cut that takes less than this share of the whole mesh's hull off is not worth a piece. */
const WORTH = 0.02;

interface Cut {
  axis: number;
  at: number;
  gain: number;
}

interface Piece {
  points: Corner[];
  /** Its triangles, and what the cuts so far left of them. */
  faces: Corner[][];
  volume: number;
  /** The best cut of it, once looked for; null when none divides it. */
  cut?: Cut | null;
}

/**
 * The corners of each piece of `mesh`, at most `max` of them, for a hull round each. `volumeOf` gives the volume of
 * the hull round some points (0 when they have none).
 */
export function splitConvex(mesh: MeshData, max: number, volumeOf: (points: Corner[]) => number): Corner[][] {
  const points: Corner[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) points.push([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
  const faces: Corner[][] = [];
  for (let i = 0; i < mesh.triangles.length; i += 3) faces.push([points[mesh.triangles[i]], points[mesh.triangles[i + 1]], points[mesh.triangles[i + 2]]]);
  const whole = volumeOf(points);
  let pieces: Piece[] = [{ points, faces, volume: whole }];
  while (whole > 0 && pieces.length < max) {
    let best: Piece | null = null;
    for (const piece of pieces) {
      if (piece.cut === undefined) piece.cut = bestCut(piece, volumeOf);
      if (piece.cut && (!best || piece.cut.gain > best.cut!.gain)) best = piece;
    }
    if (!best || best.cut!.gain < WORTH * whole) break;
    const halves = divide(best, best.cut!).map((h) => ({ ...h, volume: volumeOf(h.points) }));
    pieces = [...pieces.filter((p) => p !== best), ...halves];
  }
  return pieces.map((p) => p.points);
}

/** Where an edge from `p` to `q` crosses the plane, `dp` and `dq` being how far each is from it. */
const crossing = (p: Corner, q: Corner, dp: number, dq: number): Corner => {
  const u = dp / (dp - dq);
  return [p[0] + u * (q[0] - p[0]), p[1] + u * (q[1] - p[1]), p[2] + u * (q[2] - p[2])];
};

/** The corners on each side of a plane across `axis` at `at`: the piece's own, and where its faces cross it. */
function sides(piece: Piece, axis: number, at: number): [Corner[], Corner[]] {
  const low: Corner[] = [];
  const high: Corner[] = [];
  for (const p of piece.points) {
    if (p[axis] <= at) low.push(p);
    if (p[axis] >= at) high.push(p);
  }
  for (const face of piece.faces) {
    for (let i = 0; i < face.length; i++) {
      const p = face[i];
      const q = face[(i + 1) % face.length];
      const dp = p[axis] - at;
      const dq = q[axis] - at;
      if (dp * dq < 0) {
        const x = crossing(p, q, dp, dq);
        low.push(x);
        high.push(x);
      }
    }
  }
  return [low, high];
}

function bestCut(piece: Piece, volumeOf: (points: Corner[]) => number): Cut | null {
  const gainAt = (axis: number, at: number): number | null => {
    const [low, high] = sides(piece, axis, at);
    if (low.length < 4 || high.length < 4) return null;
    return piece.volume - volumeOf(low) - volumeOf(high);
  };
  let found: Cut | null = null;
  let step = 0;
  for (let axis = 0; axis < 3; axis++) {
    let min = Infinity;
    let max = -Infinity;
    for (const p of piece.points) {
      min = Math.min(min, p[axis]);
      max = Math.max(max, p[axis]);
    }
    if (!(max > min)) continue;
    for (let n = 1; n <= TRIES; n++) {
      const at = min + ((max - min) * n) / (TRIES + 1);
      const gain = gainAt(axis, at);
      if (gain !== null && (!found || gain > found.gain)) {
        found = { axis, at, gain };
        step = (max - min) / (TRIES + 1);
      }
    }
  }
  if (!found) return null;
  let best: Cut = found;
  // Looked for more closely on either side of the best place: an edge of the mesh seldom falls on an even division.
  for (let round = 0; round < REFINE; round++) {
    const from: number = best.at - step;
    step /= 4;
    for (let n = 1; n < 8; n++) {
      if (n === 4) continue;
      const at: number = from + n * step;
      const gain = gainAt(best.axis, at);
      if (gain !== null && gain > best.gain) best = { axis: best.axis, at, gain };
    }
  }
  return best;
}

/** The piece as the two a cut makes of it, its faces cut along the plane. */
function divide(piece: Piece, cut: Cut): { points: Corner[]; faces: Corner[][] }[] {
  const { axis, at } = cut;
  const [low, high] = sides(piece, axis, at);
  const below: Corner[][] = [];
  const above: Corner[][] = [];
  for (const face of piece.faces) {
    const far = face.map((p) => p[axis] - at);
    if (far.every((d) => d <= 0)) below.push(face);
    else if (far.every((d) => d >= 0)) above.push(face);
    else {
      const a: Corner[] = [];
      const b: Corner[] = [];
      for (let i = 0; i < face.length; i++) {
        const j = (i + 1) % face.length;
        if (far[i] <= 0) a.push(face[i]);
        if (far[i] >= 0) b.push(face[i]);
        if (far[i] * far[j] < 0) {
          const x = crossing(face[i], face[j], far[i], far[j]);
          a.push(x);
          b.push(x);
        }
      }
      if (a.length >= 3) below.push(a);
      if (b.length >= 3) above.push(b);
    }
  }
  return [
    { points: low, faces: below },
    { points: high, faces: above },
  ];
}
