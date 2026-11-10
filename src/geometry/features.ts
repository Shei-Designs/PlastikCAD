// What the Measure tool can take hold of on an object: the features of its
// triangle mesh. The mesh arrives as loose triangles, so they are welded back
// into a surface first; then the edges where two faces meet at a crease are
// found, joined end to end and read as straight edges or as circles and arcs,
// the smooth regions between them become faces, and the corners where creases
// meet become points. Like a drafting program's object snaps, the tool can
// also take hold of the quadrants of a circle, the centre of a flat face and
// the centre of the whole object (of its volume, or of the box round it when
// the mesh is not closed), and which snaps are on is the user's to mix.
// Everything is in the coordinates the positions are given in: the caller
// passes the mesh as placed in the design.
import { CREASE_ANGLE } from './mesh';
import { add, cross, dot, length, normalize, scale, sub } from '../model/math';
import type { Vec3 } from '../model/types';

export type FeatureKind = 'point' | 'middle' | 'edge' | 'circle' | 'quadrant' | 'facecenter' | 'face' | 'center';

/** The snaps in the order the tool offers them: the name on the chip's tooltip and what it takes hold of. */
export const FEATURE_KINDS: { id: FeatureKind; label: string; help: string }[] = [
  { id: 'point', label: 'Points', help: 'Snaps to corners, where edges meet.' },
  { id: 'middle', label: 'Edge middles', help: 'Snaps to the middle of a straight edge.' },
  { id: 'edge', label: 'Edges', help: 'Takes a straight edge: its length, and angles between edges.' },
  { id: 'circle', label: 'Circles', help: 'Takes a round edge or arc: its diameter, and distances from its center.' },
  { id: 'quadrant', label: 'Quadrants', help: 'Snaps to the four quadrant points of a circle.' },
  { id: 'facecenter', label: 'Face centers', help: 'Snaps to the center of a flat face.' },
  { id: 'face', label: 'Faces', help: 'Takes a flat face or curved surface: its area, and angles between faces.' },
  { id: 'center', label: 'Object centers', help: 'Snaps to the center of each object.' },
];

/** The snaps that land on a single point. */
export type PointKind = 'point' | 'middle' | 'quadrant' | 'facecenter' | 'center';

export interface PointFeature {
  kind: PointKind;
  node: string;
  at: Vec3;
}
export interface EdgeFeature {
  kind: 'edge';
  node: string;
  a: Vec3;
  b: Vec3;
}
export interface FaceFeature {
  kind: 'face';
  node: string;
  /** Where it was picked, on the surface. */
  at: Vec3;
  /** The face's normal; on a curved surface, the normal where it was picked. */
  normal: Vec3;
  /** The area-weighted centre of the face. */
  center: Vec3;
  area: number;
  flat: boolean;
  /** Which region of the index, for drawing it. */
  region: number;
}
export interface CircleFeature {
  kind: 'circle';
  node: string;
  center: Vec3;
  normal: Vec3;
  radius: number;
  /** Degrees of the circle the edge covers: 360 for a whole one. */
  sweep: number;
  /** Where a part arc starts and ends. */
  ends: [Vec3, Vec3] | null;
}
export type Feature = PointFeature | EdgeFeature | FaceFeature | CircleFeature;

export interface Region {
  normal: Vec3;
  center: Vec3;
  area: number;
  flat: boolean;
  /** Triangles of the mesh (by index, in the order given) that make it up. */
  triangles: number[];
}

export interface FeatureIndex {
  points: Vec3[];
  edges: { a: Vec3; b: Vec3 }[];
  circles: Omit<CircleFeature, 'kind' | 'node'>[];
  regions: Region[];
  /** The region of each triangle. */
  regionOf: Int32Array;
  /** Per-triangle normals, 3 per triangle. */
  normals: Float32Array;
  /** Centre of mass of the enclosed volume; null for an open mesh, which encloses none. */
  mass: Vec3 | null;
  /** Centre of the box round the object. */
  box: Vec3;
  /** The object's centre as the tool offers it: of its volume, or of its box when the mesh is open. */
  center: Vec3;
}

/** Faces whose normals differ by less than this are one flat face. */
const FLAT = 1;
/** Consecutive edge segments turning by less than this run straight on. */
const STRAIGHT = 1;
/** Positions this close (mm) are one vertex. */
const WELD = 1e-3;

const degrees = (a: Vec3, b: Vec3): number => (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;

/**
 * Reads the features out of a mesh of loose triangles (nine numbers each, as
 * the renderer has them), placed wherever the positions say.
 */
export function indexFeatures(positions: Float32Array): FeatureIndex {
  const triCount = Math.floor(positions.length / 9);
  // Weld the corners back into shared vertices.
  const verts: number[] = [];
  const index = new Map<string, number>();
  const tri = new Uint32Array(triCount * 3);
  const q = 1 / WELD;
  const bounds = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
  for (let c = 0; c < triCount * 3; c++) {
    const x = positions[c * 3];
    const y = positions[c * 3 + 1];
    const z = positions[c * 3 + 2];
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let v = index.get(key);
    if (v === undefined) {
      v = verts.length / 3;
      index.set(key, v);
      verts.push(x, y, z);
      for (let k = 0; k < 3; k++) {
        const value = k === 0 ? x : k === 1 ? y : z;
        if (value < bounds.min[k]) bounds.min[k] = value;
        if (value > bounds.max[k]) bounds.max[k] = value;
      }
    }
    tri[c] = v;
  }
  const vertexCount = verts.length / 3;
  const at = (v: number): Vec3 => [verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]];
  const box: Vec3 = triCount ? [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2] : [0, 0, 0];

  // Triangle normals and areas, and the centre of mass of the volume they enclose.
  const normals = new Float32Array(triCount * 3);
  const areas = new Float64Array(triCount);
  let volume = 0;
  const moment: Vec3 = [0, 0, 0];
  for (let t = 0; t < triCount; t++) {
    const a = at(tri[t * 3]);
    const b = at(tri[t * 3 + 1]);
    const c = at(tri[t * 3 + 2]);
    const n = cross(sub(b, a), sub(c, a));
    const twice = length(n);
    areas[t] = twice / 2;
    const unit = twice > 0 ? scale(n, 1 / twice) : [0, 0, 1];
    normals[t * 3] = unit[0];
    normals[t * 3 + 1] = unit[1];
    normals[t * 3 + 2] = unit[2];
    // The signed volume of the tetrahedron from the origin, and its centroid at a quarter of the way to the triangle.
    const v = dot(a, cross(b, c)) / 6;
    volume += v;
    moment[0] += ((a[0] + b[0] + c[0]) / 4) * v;
    moment[1] += ((a[1] + b[1] + c[1]) / 4) * v;
    moment[2] += ((a[2] + b[2] + c[2]) / 4) * v;
  }

  // Edges, with the triangles on each; the sharp ones are creases or the rim of an open mesh.
  const edgeTris = new Map<number, number[]>();
  const edgeKey = (a: number, b: number): number => (a < b ? a * vertexCount + b : b * vertexCount + a);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(tri[t * 3 + k], tri[t * 3 + ((k + 1) % 3)]);
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  }
  const normalOf = (t: number): Vec3 => [normals[t * 3], normals[t * 3 + 1], normals[t * 3 + 2]];
  const cosCrease = Math.cos((CREASE_ANGLE * Math.PI) / 180);
  const sharp = new Set<number>();
  // A surface encloses a volume only when it is closed: every edge run along as often one way as the
  // other. What the triangles of an open mesh add up to depends on where it lies, and means nothing.
  let closed = triCount > 0;
  for (const [key, tris] of edgeTris) {
    if (tris.length !== 2 || dot(normalOf(tris[0]), normalOf(tris[1])) < cosCrease) sharp.add(key);
    if (!closed) continue;
    const a = Math.floor(key / vertexCount);
    const b = key % vertexCount;
    if (a === b) continue;
    let balance = 0;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const from = tri[t * 3 + k];
        const to = tri[t * 3 + ((k + 1) % 3)];
        if (from === a && to === b) balance++;
        else if (from === b && to === a) balance--;
      }
    }
    if (balance !== 0) closed = false;
  }
  const mass: Vec3 | null = closed && Math.abs(volume) > 1e-6 ? scale(moment, 1 / volume) : null;

  // Regions: triangles joined across smooth edges.
  const regionOf = new Int32Array(triCount).fill(-1);
  const regions: Region[] = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (regionOf[seed] >= 0) continue;
    const id = regions.length;
    const triangles: number[] = [];
    const stack = [seed];
    regionOf[seed] = id;
    while (stack.length) {
      const t = stack.pop()!;
      triangles.push(t);
      for (let k = 0; k < 3; k++) {
        const key = edgeKey(tri[t * 3 + k], tri[t * 3 + ((k + 1) % 3)]);
        if (sharp.has(key)) continue;
        for (const other of edgeTris.get(key) ?? []) {
          if (regionOf[other] >= 0) continue;
          regionOf[other] = id;
          stack.push(other);
        }
      }
    }
    let area = 0;
    let normal: Vec3 = [0, 0, 0];
    let center: Vec3 = [0, 0, 0];
    for (const t of triangles) {
      area += areas[t];
      normal = add(normal, scale(normalOf(t), areas[t]));
      const a = at(tri[t * 3]);
      const b = at(tri[t * 3 + 1]);
      const c = at(tri[t * 3 + 2]);
      center = add(center, scale(add(add(a, b), c), areas[t] / 3));
    }
    const unit = normalize(normal);
    const cosFlat = Math.cos((FLAT * Math.PI) / 180);
    const flat = triangles.every((t) => dot(normalOf(t), unit) >= cosFlat);
    regions.push({ normal: unit, center: area > 0 ? scale(center, 1 / area) : at(tri[seed * 3]), area, flat, triangles });
  }

  // Chains of sharp edges: walked from the corners where three or more meet (or anywhere round a closed loop).
  const sharpAt = new Map<number, number[]>();
  const ends = (key: number): [number, number] => [Math.floor(key / vertexCount), key % vertexCount];
  for (const key of sharp) {
    for (const v of ends(key)) {
      const list = sharpAt.get(v);
      if (list) list.push(key);
      else sharpAt.set(v, [key]);
    }
  }
  const corner = (v: number): boolean => (sharpAt.get(v)?.length ?? 0) !== 2;
  const visited = new Set<number>();
  const chains: { vertices: number[]; closed: boolean }[] = [];
  const walk = (start: number, first: number) => {
    const vertices = [start];
    let v = start;
    let key = first;
    for (;;) {
      visited.add(key);
      const [a, b] = ends(key);
      v = a === v ? b : a;
      vertices.push(v);
      if (v === start) return { vertices, closed: true };
      if (corner(v)) return { vertices, closed: false };
      const next = sharpAt.get(v)!.find((k) => k !== key)!;
      if (visited.has(next)) return { vertices, closed: false };
      key = next;
    }
  };
  // From the corners first, so that open chains start and end at corners...
  for (const [v, keys] of sharpAt) {
    if (!corner(v)) continue;
    for (const key of keys) if (!visited.has(key)) chains.push(walk(v, key));
  }
  // ...then whatever is left is a closed loop with no corner on it.
  for (const key of sharp) if (!visited.has(key)) chains.push(walk(ends(key)[0], key));

  const points: Vec3[] = [];
  const seen = new Set<string>();
  const addPoint = (p: Vec3) => {
    const key = `${Math.round(p[0] * q)},${Math.round(p[1] * q)},${Math.round(p[2] * q)}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push(p);
  };
  const edges: FeatureIndex['edges'] = [];
  const circles: FeatureIndex['circles'] = [];
  for (const chain of chains) {
    const pts = chain.vertices.map(at);
    for (const run of runsOf(pts, chain.closed)) {
      if (run.kind === 'edge') {
        edges.push({ a: run.points[0], b: run.points[run.points.length - 1] });
        addPoint(run.points[0]);
        addPoint(run.points[run.points.length - 1]);
      } else {
        circles.push(run.circle);
        if (run.circle.ends) {
          addPoint(run.circle.ends[0]);
          addPoint(run.circle.ends[1]);
        }
      }
    }
  }
  return { points, edges, circles, regions, regionOf, normals, mass, box, center: mass ?? box };
}

type Run = { kind: 'edge'; points: Vec3[] } | { kind: 'circle'; circle: Omit<CircleFeature, 'kind' | 'node'> };
type Segment = { a: Vec3; b: Vec3 };

/**
 * Cuts a chain of edge segments into straight edges and arcs. A closed chain
 * of even, gentle turns is a circle. Otherwise the chain is cut at its sharp
 * corners, segments that carry straight on are joined, and a stretch of
 * segments alike in length and turning alike at every vertex is tried as an
 * arc; what fits no circle is edges, one segment each.
 */
function runsOf(pts: Vec3[], closed: boolean): Run[] {
  // A closed chain repeats its first vertex at the end, so both kinds have one segment per consecutive pair.
  const n = pts.length - 1;
  if (n < 1) return [];
  const segs: Segment[] = Array.from({ length: n }, (_, i) => ({ a: pts[i], b: pts[i + 1] }));
  const dirOf = (s: Segment): Vec3 => normalize(sub(s.b, s.a));
  const lenOf = (s: Segment): number => length(sub(s.b, s.a));
  const turnOf = (s: Segment, t: Segment): number => degrees(dirOf(s), dirOf(t));
  const similar = (x: number, y: number): boolean => x > 0 && y > 0 && x / y < 1.3 && y / x < 1.3;
  const kindOf = (turn: number): 'S' | 'A' | 'C' => (turn < STRAIGHT ? 'S' : turn < CREASE_ANGLE ? 'A' : 'C');
  if (closed && n >= 8) {
    const turns = segs.map((s, i) => turnOf(segs[(i + n - 1) % n], s));
    if (turns.every((t) => kindOf(t) === 'A') && segs.every((s) => similar(lenOf(s), lenOf(segs[0])))) {
      const circle = fitCircle(pts.slice(0, n), true);
      if (circle) return [{ kind: 'circle', circle }];
    }
  }
  // Round a closed chain, start just after a corner, or failing one where neighbouring segments differ most in length
  // (where a straight edge meets an arc), so that no run is cut in two by the chain's own start.
  let order = segs.map((_, i) => i);
  if (closed) {
    let cut = order.find((i) => kindOf(turnOf(segs[(i + n - 1) % n], segs[i])) === 'C');
    if (cut === undefined) {
      let worst = 1;
      cut = 0;
      for (const i of order) {
        const r = lenOf(segs[(i + n - 1) % n]) / Math.max(lenOf(segs[i]), 1e-9);
        const ratio = Math.max(r, 1 / r);
        if (ratio > worst) {
          worst = ratio;
          cut = i;
        }
      }
    }
    order = order.map((i) => (i + cut) % n);
  }
  // Pieces between corners.
  const pieces: Segment[][] = [[segs[order[0]]]];
  for (let k = 1; k < n; k++) {
    const s = segs[order[k]];
    if (kindOf(turnOf(segs[order[k - 1]], s)) === 'C') pieces.push([s]);
    else pieces[pieces.length - 1].push(s);
  }
  const runs: Run[] = [];
  for (const piece of pieces) {
    // Segments that carry straight on are one edge.
    const merged: Segment[] = [piece[0]];
    for (let k = 1; k < piece.length; k++) {
      const last = merged[merged.length - 1];
      if (kindOf(turnOf(last, piece[k])) === 'S') merged[merged.length - 1] = { a: last.a, b: piece[k].b };
      else merged.push(piece[k]);
    }
    let i = 0;
    while (i < merged.length) {
      let j = i;
      while (j + 1 < merged.length && similar(lenOf(merged[j]), lenOf(merged[j + 1])) && (j === i || similar(turnOf(merged[j - 1], merged[j]), turnOf(merged[j], merged[j + 1])))) j++;
      const group = merged.slice(i, j + 1);
      const circle = group.length >= 3 ? fitCircle([group[0].a, ...group.map((s) => s.b)], false) : null;
      if (circle) runs.push({ kind: 'circle', circle });
      else for (const s of group) runs.push({ kind: 'edge', points: [s.a, s.b] });
      i = j + 1;
    }
  }
  return runs;
}

/**
 * The circle through a run of points, if they lie on one: a least-squares fit
 * in their own plane, accepted when every point sits on it to within a small
 * share of the radius. An open run that fits gives an arc with its sweep.
 */
export function fitCircle(pts: Vec3[], closed: boolean): Omit<CircleFeature, 'kind' | 'node'> | null {
  if (pts.length < 3) return null;
  let centroid: Vec3 = [0, 0, 0];
  for (const p of pts) centroid = add(centroid, p);
  centroid = scale(centroid, 1 / pts.length);
  // The plane: the summed cross products of consecutive points round the centroid give its normal.
  let normal: Vec3 = [0, 0, 0];
  for (let i = 0; i + 1 < pts.length; i++) normal = add(normal, cross(sub(pts[i], centroid), sub(pts[i + 1], centroid)));
  if (length(normal) < 1e-12) return null;
  normal = normalize(normal);
  const u = normalize(Math.abs(normal[0]) < 0.9 ? cross(normal, [1, 0, 0]) : cross(normal, [0, 1, 0]));
  const v = cross(normal, u);
  // Kåsa's fit: x² + y² + D x + E y + F = 0, solved by least squares (normal equations).
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  const flat: [number, number][] = [];
  let off = 0;
  for (const p of pts) {
    const d = sub(p, centroid);
    off = Math.max(off, Math.abs(dot(d, normal)));
    const x = dot(d, u);
    const y = dot(d, v);
    flat.push([x, y]);
    const z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z;
  }
  const m = pts.length;
  // Solve [sxx sxy sx; sxy syy sy; sx sy m] [D E F]' = -[sxz syz sz]'.
  const sol = solve3([sxx, sxy, sx, sxy, syy, sy, sx, sy, m], [-sxz, -syz, -sz]);
  if (!sol) return null;
  const [D, E, F] = sol;
  const cx = -D / 2;
  const cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  if (!(r2 > 0)) return null;
  const radius = Math.sqrt(r2);
  const tolerance = Math.max(0.003 * radius, 0.02);
  if (off > tolerance) return null;
  for (const [x, y] of flat) if (Math.abs(Math.hypot(x - cx, y - cy) - radius) > tolerance) return null;
  const center = add(centroid, add(scale(u, cx), scale(v, cy)));
  if (closed) return { center, normal, radius, sweep: 360, ends: null };
  // The sweep of an arc: the angle from the first point round to the last, the way the points go.
  const angle = (p: [number, number]) => Math.atan2(p[1] - cy, p[0] - cx);
  let sweep = 0;
  for (let i = 0; i + 1 < flat.length; i++) {
    let step = angle(flat[i + 1]) - angle(flat[i]);
    while (step > Math.PI) step -= 2 * Math.PI;
    while (step < -Math.PI) step += 2 * Math.PI;
    sweep += step;
  }
  return { center, normal: sweep < 0 ? scale(normal, -1) : normal, radius, sweep: Math.min(360, (Math.abs(sweep) * 180) / Math.PI), ends: [pts[0], pts[pts.length - 1]] };
}

/** Solves a 3×3 system by Cramer's rule; null when singular. */
function solve3(a: number[], b: number[]): [number, number, number] | null {
  const det = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const d = det(a);
  if (Math.abs(d) < 1e-12) return null;
  const col = (c: number) => {
    const m = [...a];
    m[c] = b[0];
    m[c + 3] = b[1];
    m[c + 6] = b[2];
    return det(m) / d;
  };
  return [col(0), col(1), col(2)];
}

/** The nearest point of a segment to `p`. */
export function closestOnSegment(a: Vec3, b: Vec3, p: Vec3): Vec3 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return add(a, scale(ab, t));
}

/** The nearest point of a circle or arc to `p`. */
export function closestOnCircle(c: Omit<CircleFeature, 'kind' | 'node'>, p: Vec3): Vec3 {
  const d = sub(p, c.center);
  const inPlane = sub(d, scale(c.normal, dot(d, c.normal)));
  const r = length(inPlane);
  if (r < 1e-9) return add(c.center, scale(normalize(cross(c.normal, [1, 0, 0])), c.radius));
  const on = add(c.center, scale(inPlane, c.radius / r));
  // On an arc the point must lie within the sweep; otherwise the nearer end.
  if (withinSweep(c, on)) return on;
  return length(sub(p, c.ends![0])) < length(sub(p, c.ends![1])) ? c.ends![0] : c.ends![1];
}

/** Whether a point on the circle's rim lies on the arc (always, for a whole circle). */
function withinSweep(c: Omit<CircleFeature, 'kind' | 'node'>, p: Vec3): boolean {
  if (!c.ends || c.sweep >= 360) return true;
  const a0 = sub(c.ends[0], c.center);
  const x = sub(p, c.center);
  let ang = (Math.atan2(dot(cross(a0, x), c.normal), dot(a0, x)) * 180) / Math.PI;
  if (ang < 0) ang += 360;
  return ang <= c.sweep;
}

/**
 * The quadrant points of a circle or arc: where the world axes, laid in its
 * plane, cross the rim. Four for a circle square to an axis, up to six for a
 * tilted one; on an arc, only those the arc reaches.
 */
export function quadrantsOf(c: Omit<CircleFeature, 'kind' | 'node'>): Vec3[] {
  const out: Vec3[] = [];
  for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]) {
    const inPlane = sub(axis, scale(c.normal, dot(axis, c.normal)));
    if (length(inPlane) < 1e-6) continue;
    const u = normalize(inPlane);
    for (const s of [1, -1]) {
      const p = add(c.center, scale(u, s * c.radius));
      if (withinSweep(c, p) && !out.some((q) => length(sub(q, p)) < 1e-6)) out.push(p);
    }
  }
  return out;
}

/**
 * The feature under a pick on the surface of an indexed object: of the wanted
 * kinds within `tolerance` mm of the hit, a point (a corner, an edge's middle,
 * a quadrant or a face's centre) before a circle before an edge, the nearest
 * of each; else the face the hit triangle belongs to (when faces are wanted).
 * Points come first however near an edge runs, since they are the smaller
 * target. The object's centre is not here: it floats inside the object, so
 * the viewer offers it as a dot of its own.
 */
export function nearestFeature(index: FeatureIndex, node: string, hit: Vec3, triangle: number, kinds: Set<FeatureKind>, tolerance: number): Feature | null {
  let best: { feature: Feature; rank: number; distance: number } | null = null;
  const offer = (feature: Feature, distance: number, rank: number) => {
    if (distance > tolerance) return;
    if (!best || rank < best.rank || (rank === best.rank && distance < best.distance)) best = { feature, rank, distance };
  };
  if (kinds.has('point')) for (const p of index.points) offer({ kind: 'point', node, at: p }, length(sub(p, hit)), 0);
  if (kinds.has('middle')) {
    for (const e of index.edges) {
      const mid = scale(add(e.a, e.b), 0.5);
      offer({ kind: 'middle', node, at: mid }, length(sub(mid, hit)), 0);
    }
  }
  if (kinds.has('quadrant')) for (const c of index.circles) for (const q of quadrantsOf(c)) offer({ kind: 'quadrant', node, at: q }, length(sub(q, hit)), 0);
  if (kinds.has('facecenter')) for (const r of index.regions) if (r.flat) offer({ kind: 'facecenter', node, at: r.center }, length(sub(r.center, hit)), 0);
  if (kinds.has('circle')) for (const c of index.circles) offer({ kind: 'circle', node, ...c }, length(sub(closestOnCircle(c, hit), hit)), 1);
  if (kinds.has('edge')) for (const e of index.edges) offer({ kind: 'edge', node, a: e.a, b: e.b }, length(sub(closestOnSegment(e.a, e.b, hit), hit)), 2);
  if (best) return (best as { feature: Feature }).feature;
  if (kinds.has('face') && triangle >= 0 && triangle < index.regionOf.length) {
    const id = index.regionOf[triangle];
    const region = index.regions[id];
    if (!region) return null;
    const normal: Vec3 = region.flat ? region.normal : [index.normals[triangle * 3], index.normals[triangle * 3 + 1], index.normals[triangle * 3 + 2]];
    return { kind: 'face', node, at: hit, normal, center: region.center, area: region.area, flat: region.flat, region: id };
  }
  return null;
}
