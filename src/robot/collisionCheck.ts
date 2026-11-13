// Whether what a link collides as agrees with what it looks like, judged
// against the floor while the test drive runs: a plain shape larger than
// its link holds the link off the floor, and one smaller (or none) lets it
// sink in. A link that collides as its hull or as itself cannot do either.
import { apply, multiply, rotation } from '../model/math';
import type { Mat } from '../model/math';
import type { MeshData } from '../geometry/mesh';
import type { SceneNode } from '../model/types';
import { collisionPrimitive } from './collision';
import type { Collides, PlacedPrimitive } from './collision';

/** A link to judge: the corners of its looks (its convex hull's points, mm in the design) and the plain shape it collides as, or null for nothing. */
export interface FloorLink {
  id: string;
  points: Float32Array;
  shape: PlacedPrimitive | null;
}

/** `rides`: the link stands on its collision shape, `by` mm clear of the floor. `sinks`: it is `by` mm into the floor. */
export interface FloorFault {
  id: string;
  kind: 'rides' | 'sinks';
  by: number;
}

/** A gap or a depth under this is the simulation's own give, mm. */
export const FLOOR_TOLERANCE = 2;

/** How high the lowest of these points is once `frame` has moved them, mm. */
export function lowestPoint(points: Float32Array, frame: Mat | null): number {
  let low = Infinity;
  for (let i = 0; i < points.length; i += 3) {
    const z = frame ? frame[2] * points[i] + frame[5] * points[i + 1] + frame[8] * points[i + 2] + frame[11] : points[i + 2];
    if (z < low) low = z;
  }
  return low;
}

/** How high the lowest point of a placed primitive is once `frame` has moved it, mm. */
export function lowestOfPrimitive(p: PlacedPrimitive, frame: Mat | null): number {
  const own = rotation(p.rot);
  own[9] = p.at[0];
  own[10] = p.at[1];
  own[11] = p.at[2];
  const m = frame ? multiply(frame, own) : own;
  const center = m[11];
  // How far each of the primitive's own axes leans down: the third row of the turn.
  const [x, y, z] = [Math.abs(m[2]), Math.abs(m[5]), Math.abs(m[8])];
  if ('box' in p.shape) return center - (x * p.shape.box[0] + y * p.shape.box[1] + z * p.shape.box[2]) / 2;
  if ('cylinder' in p.shape) return center - (z * p.shape.cylinder.length) / 2 - p.shape.cylinder.radius * Math.hypot(x, y);
  return center - p.shape.sphere.radius;
}

/** Where a placed primitive's center is once `frame` has moved it, and how far it reaches from there, mm. */
function reachOf(p: PlacedPrimitive, frame: Mat | null): { at: [number, number, number]; reach: number } {
  const at = frame ? apply(frame, p.at) : p.at;
  const reach = 'box' in p.shape ? Math.hypot(...p.shape.box) / 2 : 'cylinder' in p.shape ? Math.hypot(p.shape.cylinder.radius, p.shape.cylinder.length / 2) : p.shape.sphere.radius;
  return { at: [at[0], at[1], at[2]], reach };
}

/** Whether any of these points, once `frame` has moved them, is on the floor within `reach` of `at` across it. */
function touchesNear(points: Float32Array, frame: Mat | null, at: [number, number, number], reach: number, tolerance: number): boolean {
  for (let i = 0; i < points.length; i += 3) {
    const p = frame ? apply(frame, [points[i], points[i + 1], points[i + 2]]) : [points[i], points[i + 1], points[i + 2]];
    if (p[2] <= 2 * tolerance && Math.hypot(p[0] - at[0], p[1] - at[1]) <= reach) return true;
  }
  return false;
}

/**
 * The links that stand on a collision shape clear of the floor, or sink into it, with the floor at z = 0 and
 * each link where `frames` has it. `looks` are the corners of every link of the robot: a shape that reaches
 * the floor where another link's looks do (a ball under a foot, at the tip the calf's mesh draws) holds nothing off it.
 * A depth is measured from where the deepest collision shape rests, not from the floor itself (see `give`).
 */
export function floorFaults(links: FloorLink[], frames: Map<string, Mat>, tolerance = FLOOR_TOLERANCE, looks: { id: string; points: Float32Array }[] = []): FloorFault[] {
  const out: FloorFault[] = [];
  // How far the floor gives under the robot: a simulator's contact is soft, and lets the shape that carries a
  // heavy robot some millimeters in. A link is in the floor only by what it is deeper than that.
  let give = 0;
  for (const link of links) if (link.shape) give = Math.max(give, -lowestOfPrimitive(link.shape, frames.get(link.id) ?? null));
  for (const link of links) {
    const frame = frames.get(link.id) ?? null;
    const low = lowestPoint(link.points, frame);
    if (!Number.isFinite(low)) continue;
    if (low < -tolerance - give) {
      out.push({ id: link.id, kind: 'sinks', by: -low - give });
      continue;
    }
    // On the floor, give or take: the shape is what the link stands on.
    if (link.shape && lowestOfPrimitive(link.shape, frame) <= tolerance && low > 2 * tolerance) {
      const { at, reach } = reachOf(link.shape, frame);
      if (!looks.some((other) => other.id !== link.id && touchesNear(other.points, frames.get(other.id) ?? null, at, reach, tolerance))) out.push({ id: link.id, kind: 'rides', by: low });
    }
  }
  return out;
}


/** The corners of every link's looks, from their hulls (in the order of `nodes`; a link without one is left out). */
export const linkLooks = (nodes: SceneNode[], hulls: (MeshData | null)[]): { id: string; points: Float32Array }[] => nodes.flatMap((n, i) => (hulls[i] ? [{ id: n.id, points: hulls[i]!.positions }] : []));

/** The links to judge: those that collide as a plain shape or as nothing, each with the hull of its looks (`hulls`, in the order of `nodes`; a link without one is left out). */
export function floorLinks(nodes: SceneNode[], links: Record<string, Collides>, hulls: (MeshData | null)[]): FloorLink[] {
  return nodes.flatMap((n, i) => {
    const link = links[n.id] ?? { collision: 'hull' };
    const hull = hulls[i];
    if (!hull || link.collision === 'hull' || link.collision === 'mesh') return [];
    return [{ id: n.id, points: hull.positions, shape: link.collision === 'none' ? null : collisionPrimitive(n, link) }];
  });
}

/** A link must stand on its collision shape, or in the floor, this long before it is said: a bounce is not a fault. Seconds of the simulation. */
export const FAULT_SECONDS = 0.3;

/** A fault that lasted, at the most it reached, to the millimeter; `bare` for a link that collides with nothing. */
export type KeptFault = FloorFault & { bare: boolean };

/**
 * Watches the links through a test drive, frame by frame: a fault that has lasted long enough is kept until
 * `clear`, at the most it reached. `see` gives the same list back while nothing changes.
 */
export class FaultWatch {
  private since = new Map<string, number>();
  private kept: KeptFault[] = [];

  /** `looks`: the corners of every link of the robot, the judged ones among them (see `floorFaults`). */
  constructor(
    private readonly links: FloorLink[] = [],
    private readonly looks: { id: string; points: Float32Array }[] = [],
  ) {}

  clear(): KeptFault[] {
    this.since.clear();
    this.kept = [];
    return this.kept;
  }

  see(frames: Map<string, Mat>, time: number): KeptFault[] {
    const seen = new Set<string>();
    for (const f of floorFaults(this.links, frames, FLOOR_TOLERANCE, this.looks)) {
      const key = `${f.id}:${f.kind}`;
      seen.add(key);
      if (!this.since.has(key)) this.since.set(key, time);
      if (time - this.since.get(key)! < FAULT_SECONDS) continue;
      const known = this.kept.find((k) => k.id === f.id && k.kind === f.kind);
      // To the millimeter: a figure that creeps by less is not news.
      const by = Math.round(f.by);
      if (known && known.by >= by) continue;
      const bare = this.links.find((l) => l.id === f.id)?.shape === null;
      this.kept = [...this.kept.filter((k) => k !== known), { id: f.id, kind: f.kind, by, bare }];
    }
    for (const key of [...this.since.keys()]) if (!seen.has(key)) this.since.delete(key);
    return this.kept;
  }
}
