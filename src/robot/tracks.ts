// A track made with the Track part, as robot mode reads it. A simulator has
// no belt: a row of wheels stands in for it, all of one size and turning as
// one, placed so that together they reach wherever the belt's outside does
// under the track and round its two ends. They are worked out here from the
// part's settings and where it stands, never from its mesh. A track stretched
// unevenly is no longer the track its settings describe.
import type { MeshData } from '../geometry/mesh';
import { apply, multiply, translation } from '../model/math';
import type { Mat } from '../model/math';
import type { PartNode, SceneNode, Vec3 } from '../model/types';
import { getGenerator } from '../parts/generators';
import { sanitizeParams } from '../parts/generators/types';
import { trackFigures, trackInPart, trackPoint } from '../parts/generators/track';
import type { TrackFigures } from '../parts/generators/track';
import { evenScale, wheelParts } from './wheels';

const TRACK = 'track';

/** Why an object is not a track a simulator can be given: it is not the part, it holds several, or it was stretched unevenly. */
export type TrackFault = 'not-a-part' | 'several' | 'stretched';

export interface Track {
  part: PartNode;
  figures: TrackFigures;
  /** From the part's frame as it is built (X along the track from the sprocket's axle, Z up, the rail's face at y = 0) to the design, mm. */
  toDesign: Mat;
  /** How much larger the track stands in the design than its settings say. */
  scale: number;
}

/** The track an object is or holds, or why it does not count as one. */
export function trackOf(node: SceneNode): Track | TrackFault {
  const found = wheelParts(node).filter((w) => w.part.part === TRACK);
  if (found.length === 0) return 'not-a-part';
  if (found.length > 1) return 'several';
  const { part, to } = found[0];
  const scale = evenScale(to);
  if (scale === null) return 'stretched';
  const figures = trackFigures(sanitizeParams(getGenerator(TRACK), part.params));
  // The part is built in its own frame and then centered on its box.
  const { min, max } = figures.box;
  const toDesign = multiply(to, translation([-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -(min[2] + max[2]) / 2]));
  return { part, figures, toDesign, scale };
}

/** Whether an object is a track a simulator can be given. */
export const isTrack = (node: SceneNode): boolean => typeof trackOf(node) !== 'string';

/** The most wheels that stand in for one track: a longer row costs every step of a simulation. */
export const MAX_TRACK_WHEELS = 24;

/**
 * The wheels that stand in for a track's belt, in its side view (along, up, from the sprocket's axle): every one
 * as large as the sprocket with the belt on it, so that one speed turns them all alike. Their centers follow the
 * belt's outside from the sprocket, under the track, to the idler, one wheel's radius inside it; where the belt
 * bends tighter than such a wheel (round a small road wheel, at the foot of a raised nose) the wheel sits in the
 * corner and touches both sides of it. They are no farther apart than their radius, as far as `MAX_TRACK_WHEELS` lets them.
 */
export function standIns(f: TrackFigures): { radius: number; centers: [number, number][] } {
  const end = f.wheels[0].radius;
  const radius = end + f.thickness + f.lug.height;
  // The belt from where it comes onto the sprocket, down round it, under the track and up round the idler.
  const idler = f.path.find((r) => r.kind === 'arc' && r.wheel === f.wheels.length - 1);
  const upTo = idler ? idler.start + idler.length : f.length;
  // A wheel lies inside the belt when it reaches no farther than the track's wheels do, whichever way one looks.
  const ways = Array.from({ length: 180 }, (_, i) => (i * Math.PI) / 90).map((a) => {
    const [c, s] = [Math.cos(a), Math.sin(a)];
    return { c, s, far: Math.max(...f.wheels.map((w) => w.center[0] * c + w.center[1] * s + w.radius)) };
  });
  const inside = (at: [number, number]) => ways.every((w) => at[0] * w.c + at[1] * w.s + end <= w.far + 1e-6);
  const steps = 600;
  const line: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const at = trackPoint(f, (upTo * i) / steps, -end).at as [number, number];
    const last = line[line.length - 1];
    if (inside(at) && !(last && Math.hypot(at[0] - last[0], at[1] - last[1]) < 1e-6)) line.push(at);
  }
  if (line.length === 0) line.push([...f.wheels[0].center] as [number, number]);
  const lengths = line.slice(1).map((p, i) => Math.hypot(p[0] - line[i][0], p[1] - line[i][1]));
  const whole = lengths.reduce((a, b) => a + b, 0);
  if (whole < 1e-6) return { radius, centers: [line[0]] };
  // A wheel stands at each end and in each corner of that line, and the stretches between are shared out evenly.
  const along: number[] = [0];
  for (const l of lengths) along.push(along[along.length - 1] + l);
  const stops = [0];
  for (let i = 1; i < line.length - 1; i++) {
    const [a, b] = [Math.atan2(line[i][1] - line[i - 1][1], line[i][0] - line[i - 1][0]), Math.atan2(line[i + 1][1] - line[i][1], line[i + 1][0] - line[i][0])];
    const bend = Math.abs(((b - a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    if (bend > 0.05 && along[i] - stops[stops.length - 1] > radius / 4 && whole - along[i] > radius / 4) stops.push(along[i]);
  }
  stops.push(whole);
  let places = stops.slice(1).flatMap((to, i) => {
    const gaps = Math.max(1, Math.ceil((to - stops[i]) / radius - 1e-9));
    return Array.from({ length: gaps }, (_, k) => stops[i] + ((to - stops[i]) * k) / gaps);
  });
  places.push(whole);
  // Too many for a simulation to bear: as many as it can, evenly, corners or no.
  if (places.length > MAX_TRACK_WHEELS) places = Array.from({ length: MAX_TRACK_WHEELS }, (_, i) => (whole * i) / (MAX_TRACK_WHEELS - 1));
  let seg = 0;
  const centers = places.map((want): [number, number] => {
    while (seg < lengths.length - 1 && along[seg + 1] < want) seg++;
    const t = lengths[seg] > 0 ? Math.min(1, Math.max(0, (want - along[seg]) / lengths[seg])) : 0;
    return [line[seg][0] + (line[seg + 1][0] - line[seg][0]) * t, line[seg][1] + (line[seg + 1][1] - line[seg][1]) * t];
  });
  return { radius, centers };
}

/**
 * Which of a track's stand-in wheels are on its run along the floor, one for each of `standIns`' centers: those
 * as low as the lowest, between the ends of the stretch of belt that lies on the floor. The rest are up a raised
 * end, in the air on a flat floor.
 */
export function standInsOnFloor(f: TrackFigures, centers: [number, number][] = standIns(f).centers): boolean[] {
  const lowest = Math.min(...centers.map((c) => c[1]));
  return centers.map((c) => c[1] - lowest < 1e-3 && c[0] >= f.floor.from - 1e-3 && c[0] <= f.floor.to + 1e-3);
}

/** The wheels that stand in for a track, placed in the design: mm. */
export interface TrackWheels {
  /** The way the axles run, a unit vector. */
  axis: Vec3;
  radius: number;
  /** How long each wheel is along its axle: the track's width. */
  length: number;
  /** Each wheel's middle, from the sprocket's end to the idler's. */
  centers: Vec3[];
  /** The middle of the row: where the track is, for telling how far apart two tracks are. */
  middle: Vec3;
}

export function trackWheels(t: Track): TrackWheels {
  const { radius, centers } = standIns(t.figures);
  const o = apply(t.toDesign, [0, 0, 0]);
  const y = apply(t.toDesign, [0, 1, 0]);
  const dir: Vec3 = [y[0] - o[0], y[1] - o[1], y[2] - o[2]];
  const n = Math.hypot(...dir) || 1;
  const placed = centers.map((c) => apply(t.toDesign, trackInPart(c, t.figures.width / 2)));
  return {
    axis: dir.map((x) => x / n) as Vec3,
    radius: radius * t.scale,
    length: t.figures.width * t.scale,
    centers: placed,
    middle: placed.reduce((sum, c) => sum.map((v, i) => v + c[i] / placed.length) as Vec3, [0, 0, 0] as Vec3),
  };
}

/** Where a track's motor turns it: the middle of its sprocket's axle, and the way its axles run, in the design. A joint that hangs a track begins here. */
export function trackAxle(t: Track): { origin: Vec3; axis: Vec3 } {
  return { origin: apply(t.toDesign, trackInPart(t.figures.wheels[0].center, t.figures.width / 2)), axis: trackWheels(t).axis };
}

/** What a track collides as, as triangles in the design, for the plate to draw: each of its wheels, coarse, since it is only looked at. */
export function trackMesh(t: Track): MeshData {
  const AROUND = 20;
  const w = trackWheels(t);
  const [ax, ay, az] = w.axis;
  // Two directions square to the axle and to each other.
  const seed: Vec3 = Math.abs(az) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u0: Vec3 = [ay * seed[2] - az * seed[1], az * seed[0] - ax * seed[2], ax * seed[1] - ay * seed[0]];
  const un = Math.hypot(...u0) || 1;
  const u = u0.map((x) => x / un) as Vec3;
  const v: Vec3 = [ay * u[2] - az * u[1], az * u[0] - ax * u[2], ax * u[1] - ay * u[0]];
  const positions: number[] = [];
  const triangles: number[] = [];
  for (const c of w.centers) {
    const first = positions.length / 3;
    for (const side of [-0.5, 0.5]) {
      const m = c.map((x, i) => x + w.axis[i] * w.length * side) as Vec3;
      positions.push(...m);
      for (let j = 0; j < AROUND; j++) {
        const a = (j / AROUND) * 2 * Math.PI;
        positions.push(...(m.map((x, i) => x + w.radius * (Math.cos(a) * u[i] + Math.sin(a) * v[i])) as Vec3));
      }
    }
    const low = (j: number) => first + 1 + (j % AROUND);
    const high = (j: number) => first + AROUND + 2 + (j % AROUND);
    for (let j = 0; j < AROUND; j++) {
      triangles.push(first, low(j + 1), low(j), first + AROUND + 1, high(j), high(j + 1));
      triangles.push(low(j), low(j + 1), high(j + 1), low(j), high(j + 1), high(j));
    }
  }
  return { positions: new Float32Array(positions), triangles: new Uint32Array(triangles) };
}
