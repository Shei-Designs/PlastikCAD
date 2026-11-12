// Helical threads.
//
// A thread is described by its axial profile: the surface radius over one
// pitch. The ridge between two roots is swept along the helix as a closed coil
// and joined to a core cylinder, which gives exact straight flanks with very
// few triangles.
//
// Every thread made here is phase-aligned: the axial profile starts (t = 0) at
// z = 0 on the +X axis, and a right-handed thread climbs while turning
// counter-clockwise seen from +Z. A bolt and a nut generated from matching
// profiles therefore mesh when placed on the same axis.
import { dedupe, TAU } from './math2d';
import { triangulate } from './meshUtil';
import { cylinder, intersection, revolve, translate, union } from './types';
import type { Polygon, Quality, Solid, Thread, Vec2 } from './types';

/**
 * Thread surface radius over one pitch as [t, radius] breakpoints, t rising
 * from 0 to 1 along +Z, linearly interpolated. First and last radius must match.
 */
export type AxialProfile = Vec2[];

const MIN_RADIUS = 0.05;

export interface TrapezoidOptions {
  pitch: number;
  crestRadius: number;
  rootRadius: number;
  /** Half of the axial width of the crest flat. */
  crestHalfWidth: number;
  /** Angle between a flank and the radial direction, radians. */
  flankAngle: number;
  /**
   * Radial clearance: the thread form is moved outwards (positive, adds
   * material) or inwards (negative) by this amount. Use it to shrink printed
   * screws and to cut nuts oversize. Flanks steeper than 30° are moved a bit
   * further, so that the gap measured square to the flank is at least half
   * the offset.
   */
  offset?: number;
  /**
   * Limits how far the crest of a shrunk thread (or the root of a grown one)
   * follows the offset. Those surfaces only face the mating thread's root, so
   * holding them back keeps the threads engaged when the clearance is large
   * compared to the pitch.
   */
  maxTruncation?: number;
}

/** Symmetric tooth with straight flanks, centered on t = 0.5. */
export function trapezoidProfile(o: TrapezoidOptions): AxialProfile {
  const offset = o.offset ?? 0;
  const cap = o.maxTruncation ?? Infinity;
  const half = o.pitch / 2;
  const tan = Math.max(Math.tan(o.flankAngle), 1e-9);
  let rc = o.crestRadius + (offset < 0 ? Math.max(offset, -cap) : offset);
  let rr = Math.max(MIN_RADIUS, o.rootRadius + (offset > 0 ? Math.min(offset, cap) : offset));
  // Axial half-width of the tooth at radius r, with the flank moved along its normal.
  const flankShift = (offset * Math.max(Math.sin(o.flankAngle), 0.5)) / Math.cos(o.flankAngle);
  const halfWidth = (r: number) => o.crestHalfWidth + (o.crestRadius - r) * tan + flankShift;
  let wc = halfWidth(rc);
  if (wc < 0) {
    // The flanks meet below the crest: the tooth becomes pointed.
    rc += wc / tan;
    wc = 0;
  }
  wc = Math.min(wc, half * 0.95);
  rc = Math.max(rc, rr + 1e-3);
  let wr = wc + (rc - rr) * tan;
  if (wr > half) {
    // The flanks of neighboring teeth meet above the root: V-shaped groove.
    rr = rc - (half - wc) / tan;
    wr = half;
  }
  const tc = wc / o.pitch;
  const tr = wr / o.pitch;
  const flat = tr < 0.5 - 1e-9;
  const pts: AxialProfile = [[0, rr]];
  if (flat) pts.push([0.5 - tr, rr]);
  if (tc > 1e-9) pts.push([0.5 - tc, rc], [0.5 + tc, rc]);
  else pts.push([0.5, rc]);
  if (flat) pts.push([0.5 + tr, rr]);
  pts.push([1, rr]);
  return pts;
}

/**
 * ISO 68-1 basic metric profile: 60° flanks, P/8 crest flat, P/4 root flat.
 * `offset` is the radial clearance; the crest (screw) or root (nut) follows it by at most P/8,
 * which is about what the 6g/6H tolerance classes allow.
 */
export function isoMetricProfile(diameter: number, pitch: number, offset = 0): AxialProfile {
  const h = (Math.sqrt(3) / 2) * pitch;
  return trapezoidProfile({
    pitch,
    crestRadius: diameter / 2,
    rootRadius: diameter / 2 - (5 / 8) * h,
    crestHalfWidth: pitch / 16,
    flankAngle: Math.PI / 6,
    offset,
    maxTruncation: pitch / 8,
  });
}

/** Crest clearance a_c of ISO 2904 trapezoidal threads. */
export function trapezoidalClearance(pitch: number): number {
  if (pitch <= 1.5) return 0.15;
  if (pitch <= 5) return 0.25;
  if (pitch <= 12) return 0.5;
  return 1;
}

export interface TrapezoidalOptions {
  offset?: number;
  /** Profile of the nut thread (as the solid to cut out of the nut) instead of the screw. */
  internal?: boolean;
}

/** ISO 2904 metric trapezoidal (Tr) profile: 30° included angle, depth P/2 + a_c. */
export function trapezoidalProfile(diameter: number, pitch: number, o: TrapezoidalOptions = {}): AxialProfile {
  const ac = trapezoidalClearance(pitch);
  const flankAngle = Math.PI / 12;
  const pitchRadius = diameter / 2 - pitch / 4;
  const crestRadius = o.internal ? diameter / 2 + ac : diameter / 2;
  const rootRadius = o.internal ? diameter / 2 - pitch / 2 : diameter / 2 - pitch / 2 - ac;
  return trapezoidProfile({
    pitch,
    crestRadius,
    rootRadius,
    crestHalfWidth: pitch / 4 - (crestRadius - pitchRadius) * Math.tan(flankAngle),
    flankAngle,
    offset: o.offset,
  });
}

export interface PressureAngleOptions {
  /** Axial pitch. */
  pitch: number;
  pitchRadius: number;
  addendum: number;
  dedendum: number;
  /** Radians, measured in the axial section. */
  pressureAngle: number;
  /** Axial tooth thickness on the pitch cylinder; defaults to half the pitch. */
  thickness?: number;
  offset?: number;
}

/** Rack-like tooth defined gear-style (worms). */
export function pressureAngleProfile(o: PressureAngleOptions): AxialProfile {
  const thickness = o.thickness ?? o.pitch / 2;
  return trapezoidProfile({
    pitch: o.pitch,
    crestRadius: o.pitchRadius + o.addendum,
    rootRadius: o.pitchRadius - o.dedendum,
    crestHalfWidth: thickness / 2 - o.addendum * Math.tan(o.pressureAngle),
    flankAngle: o.pressureAngle,
    offset: o.offset,
  });
}

export function profileExtent(profile: AxialProfile): { rMin: number; rMax: number } {
  let rMin = Infinity;
  let rMax = -Infinity;
  for (const [, r] of profile) {
    rMin = Math.min(rMin, r);
    rMax = Math.max(rMax, r);
  }
  return { rMin, rMax };
}

/** Radius of the profile at t (periodic). */
export function profileRadius(profile: AxialProfile, t: number): number {
  const u = t - Math.floor(t);
  for (let i = 1; i < profile.length; i++) {
    const [t0, r0] = profile[i - 1];
    const [t1, r1] = profile[i];
    if (u <= t1) return t1 > t0 ? r0 + ((r1 - r0) * (u - t0)) / (t1 - t0) : r1;
  }
  return profile[profile.length - 1][1];
}

export interface ThreadOptions {
  profile: AxialProfile;
  /** Axial distance between neighboring crests. */
  pitch: number;
  starts?: number;
  length: number;
  leftHanded?: boolean;
  q: Quality;
  /**
   * Leaves the thread without the description a writer of true surfaces makes it from (see `Thread`): for a thread
   * that is only a tool, carried through many places to cut with, which such a writer should not try to follow.
   */
  facetsOnly?: boolean;
}

/** The part of one thread ridge that stands proud of the root, as (z, radius) corners from the root point it rises from to the one it comes down to. */
function proudOf(profile: AxialProfile, pitch: number, rMin: number): Vec2[] {
  const eps = 1e-9;
  // Keep the part of the profile that stands proud of the root, plus the root
  // points it rises from; the root flats themselves belong to the core.
  let first = 0;
  while (first < profile.length - 2 && profile[first + 1][1] <= rMin + eps) first++;
  let last = profile.length - 1;
  while (last > first + 1 && profile[last - 1][1] <= rMin + eps) last--;
  const pts: Polygon = [];
  for (let i = first; i <= last; i++) pts.push([profile[i][0] * pitch, profile[i][1]]);
  return pts;
}

/** One thread ridge as a closed (z, radius) polygon, rooted inside the core cylinder. */
function ridgePolygon(proud: Vec2[], pitch: number, rMin: number): Polygon {
  // The foot tapers slightly so that successive turns never share a face.
  const inset = 0.02 * pitch;
  const foot = rMin * 0.6;
  return dedupe([...proud, [proud[proud.length - 1][0] - inset, foot], [proud[0][0] + inset, foot]]);
}

/** Ridge polygon swept along a helix: a closed coil with flat ends. */
function coil(ridge: Polygon, o: { lead: number; perTurn: number; steps: number; zStart: number; leftHanded: boolean }): Solid {
  const m = ridge.length;
  const positions: number[] = [];
  for (let j = 0; j <= o.steps; j++) {
    const theta = ((o.leftHanded ? -TAU : TAU) * j) / o.perTurn;
    const z0 = o.zStart + (o.lead * j) / o.perTurn;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    for (const [z, r] of ridge) positions.push(r * c, r * s, z0 + z);
  }
  const triangles: number[] = [];
  for (let j = 0; j < o.steps; j++)
    for (let i = 0; i < m; i++) {
      const a = j * m + i;
      const b = j * m + ((i + 1) % m);
      triangles.push(a, b, b + m, a, b + m, a + m);
    }
  const cap = triangulate(ridge);
  const end = o.steps * m;
  for (let i = 0; i < cap.length; i += 3) {
    triangles.push(cap[i], cap[i + 2], cap[i + 1]);
    triangles.push(end + cap[i], end + cap[i + 1], end + cap[i + 2]);
  }
  // Which way is "out" depends on the hand and the polygon winding: measure it.
  let volume = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = [triangles[i] * 3, triangles[i + 1] * 3, triangles[i + 2] * 3];
    volume +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  if (volume < 0) for (let i = 0; i < triangles.length; i += 3) [triangles[i + 1], triangles[i + 2]] = [triangles[i + 2], triangles[i + 1]];
  return { op: 'mesh', positions, triangles };
}

/**
 * Core cylinder plus one helical ridge per start, running past both ends of
 * 0..length. Callers trim it to the end shape they want.
 */
function untrimmedThread(o: ThreadOptions): Solid {
  const starts = o.starts ?? 1;
  const lead = o.pitch * starts;
  const { rMin, rMax } = profileExtent(o.profile);
  const proud = proudOf(o.profile, o.pitch, rMin);
  const ridge = ridgePolygon(proud, o.pitch, rMin);
  // Fewer facets per turn on small threads, where they would be invisible.
  const perTurn = Math.max(24, Math.min(o.q.circle, Math.round(o.q.circle * (0.5 + rMax / 20))));
  const margin = 2 * lead;
  const parts: Solid[] = [translate(cylinder(rMin, o.length + 2 * margin, perTurn), [0, 0, -margin])];
  for (let k = 0; k < starts; k++) {
    // At angle 0 each ridge sits a whole number of pitches from z = 0, which keeps the phase.
    const zStart = k * o.pitch - margin;
    const steps = Math.ceil(((o.length + margin - zStart) / lead) * perTurn) + 1;
    parts.push(coil(ridge, { lead, perTurn, steps, zStart, leftHanded: o.leftHanded ?? false }));
  }
  if (o.facetsOnly) return union(...parts);
  // The same thread as its surface over one lead: every start's ridge where its coil begins, the root between them.
  const outline: Vec2[] = [];
  for (let k = 0; k < starts; k++) for (const [z, r] of proud) outline.push([z + k * o.pitch - margin, r]);
  outline.push([outline[0][0] + lead, outline[0][1]]);
  const thread: Thread = { outline, lead, leftHanded: o.leftHanded ?? false, turns: Math.ceil((o.length - outline[0][0]) / lead) + 1 };
  return { op: 'union', children: parts, thread };
}

/** Thread along +Z from z = 0 to z = length, with flat ends. */
export function threadSolid(o: ThreadOptions): Solid {
  const { rMax } = profileExtent(o.profile);
  return intersection(untrimmedThread(o), cylinder(rMax + 1, o.length, 24));
}

export interface ThreadedRodOptions {
  profile: AxialProfile;
  pitch: number;
  starts?: number;
  length: number;
  leftHanded?: boolean;
  q: Quality;
  /** Lead-in chamfer (45°, down to the thread root) at z = 0. */
  chamferBottom?: boolean;
  /** Lead-in chamfer at z = length. */
  chamferTop?: boolean;
}

/** Threaded rod from z = 0 to z = length with optional chamfered ends. */
export function threadedRod(o: ThreadedRodOptions): Solid {
  const options: ThreadOptions = { profile: o.profile, pitch: o.pitch, starts: o.starts, length: o.length, leftHanded: o.leftHanded, q: o.q };
  if (!o.chamferBottom && !o.chamferTop) return threadSolid(options);

  const { rMin, rMax } = profileExtent(o.profile);
  const c = Math.min(rMax - rMin, o.length / 4);
  const ext = Math.min(0.5, o.length / 8);
  const wall = rMax + ext;
  const top = o.length;
  const envelope: Polygon = [];
  if (o.chamferBottom) envelope.push([0, 0], [rMax - c, 0], [wall, c + ext]);
  else envelope.push([0, 0], [wall, 0]);
  if (o.chamferTop) envelope.push([wall, top - c - ext], [rMax - c, top], [0, top]);
  else envelope.push([wall, top], [0, top]);
  return intersection(untrimmedThread(options), revolve(envelope, o.q.circle));
}
