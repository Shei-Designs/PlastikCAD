// A track for robots: a belt round a sprocket, an idler and the road wheels
// between them, on a rail that holds their axles, as one part. It comes
// standing on its belt: X along the track from the sprocket to the idler, Z up,
// the axles along Y.
//
// Its figures are told in the track's side view: (along, up) from the
// sprocket's axle, with `across` the way the axles run, from the rail's outer
// face. `trackInPart` takes such a place to the part as it is built, before it
// is centered on its box. The rail is on the +Y side, which is the side a
// robot's body is on; the sprocket's hub is on the other, and its bore goes
// through the rail, for a motor's shaft to come through.
//
// The belt follows the true path round the wheels: straight where it runs from
// one wheel to the next, an arc where it lies on a wheel (see `wrap`). All the
// figures a simulator needs to stand in for the track are worked out from the
// settings (see `trackFigures`), not read off the mesh.
//
// It is a likeness for simulation, not a track to print: the sprocket has no
// teeth and the belt no links.
import { tr, trx } from '../../i18n';
import { addHubAndBore, boreGroup, boreRadius, hubGroup } from '../features';
import { arc, arcN, arcSegments, dedupe, ensureCCW, TAU } from '../math2d';
import { cylinder, difference, extrude, revolve, rotate, translate, union } from '../types';
import type { Polygon, Quality, Solid, Vec2, Vec3 } from '../types';
import { lengthInfo, num } from './types';
import type { BuildResult, GeneratorDef, Params } from './types';

/** A wheel of a track, in its side view: along the track from the sprocket's axle, and up. */
export interface TrackWheel {
  kind: 'sprocket' | 'road' | 'idler';
  center: Vec2;
  radius: number;
  /** Whether the belt under it lies on the floor. */
  onFloor: boolean;
}

/**
 * A stretch of the belt's inside: an arc where it lies on a wheel, a line where it runs to the next. `start` is
 * how far along the belt the stretch begins, `normal` the angle of the way out of the belt there (for an arc,
 * where it begins: it turns by `sweep` along it).
 */
export type TrackRun =
  | { kind: 'arc'; wheel: number; center: Vec2; radius: number; normal: number; sweep: number; start: number; length: number }
  | { kind: 'line'; from: Vec2; to: Vec2; normal: number; start: number; length: number };

/**
 * A track part's figures, from its settings. All lengths in mm, in the track's side view: (along, up) from the
 * sprocket's axle. Across, the track spans `width` from the rail's outer face. See `trackInPart` for the part's own axes.
 */
export interface TrackFigures {
  width: number;
  /** The sprocket first, then the road wheels from it to the idler, then the idler. */
  wheels: TrackWheel[];
  /** The belt's inside, once round: counterclockwise seen from +Z, each stretch beginning where the last ended, the first where the belt comes onto the sprocket. */
  path: TrackRun[];
  /** How long that path is. */
  length: number;
  /** The belt's thickness, without its lugs. */
  thickness: number;
  /** The lugs across the belt's outside: how far they stand out, how far apart they are along the path, and how many there are. */
  lug: { height: number; pitch: number; count: number };
  /** The floor the track stands on: how far up it is (below the sprocket's axle, so under zero), and from where to where along the track the belt lies on it. */
  floor: { up: number; from: number; to: number };
  /**
   * The rail the axles are held by, which a robot's body is fixed to: a bar of half height `half` from axle to
   * axle through `along` (the wheels' centers in turn), `thickness` across from the track's face. The wheels
   * begin `gap` beyond it and reach to the track's other face.
   */
  rail: { along: Vec2[]; half: number; thickness: number; gap: number };
  /** The box round the whole part, hub and all, in the part's own axes as built (see `trackInPart`): the part is centered on it. */
  box: { min: Vec3; max: Vec3 };
}

const cos = Math.cos;
const sin = Math.sin;

/** How far a wheel reaches the way an angle points. */
const reach = (w: { center: Vec2; radius: number }, a: number) => w.center[0] * cos(a) + w.center[1] * sin(a) + w.radius;

/** The wheel that reaches farthest the way an angle points. */
const farthest = (wheels: { center: Vec2; radius: number }[], a: number): number => wheels.reduce((best, w, i) => (reach(w, a) > reach(wheels[best], a) ? i : best), 0);

/**
 * The path of a belt pulled tight round the wheels. Turning once round, the wheel that reaches farthest out
 * changes only where a line touches two wheels from outside; between two such angles the belt lies on one wheel,
 * and at each it runs straight to the next.
 */
function wrap(wheels: { center: Vec2; radius: number }[]): TrackRun[] {
  const turns: number[] = [];
  for (let i = 0; i < wheels.length; i++) {
    for (let j = i + 1; j < wheels.length; j++) {
      const dx = wheels[j].center[0] - wheels[i].center[0];
      const dy = wheels[j].center[1] - wheels[i].center[1];
      const d = Math.hypot(dx, dy);
      const gain = wheels[i].radius - wheels[j].radius;
      // One wheel inside the other: no line touches both from outside.
      if (Math.abs(gain) >= d - 1e-9) continue;
      const toward = Math.atan2(dy, dx);
      const off = Math.acos(gain / d);
      for (const a of [toward + off, toward - off]) turns.push(((a % TAU) + TAU) % TAU);
    }
  }
  turns.sort((a, b) => a - b);
  const angles = turns.filter((a, i) => i === 0 || a - turns[i - 1] > 1e-9);
  if (angles.length > 1 && angles[0] + TAU - angles[angles.length - 1] <= 1e-9) angles.pop();
  // Which wheel the belt lies on from each angle to the next, runs on the same wheel joined.
  const on: { wheel: number; from: number; to: number }[] = [];
  for (let i = 0; i < angles.length; i++) {
    const from = angles[i];
    const to = i + 1 < angles.length ? angles[i + 1] : angles[0] + TAU;
    const wheel = farthest(wheels, (from + to) / 2);
    const last = on[on.length - 1];
    if (last && last.wheel === wheel) last.to = to;
    else on.push({ wheel, from, to });
  }
  if (on.length > 1 && on[0].wheel === on[on.length - 1].wheel) {
    const tail = on.pop()!;
    on[0].from = tail.from - TAU;
  }
  // One wheel holds all the others: the belt is a ring round it.
  if (on.length <= 1) {
    const w = wheels[on[0]?.wheel ?? farthest(wheels, 0)];
    return [{ kind: 'arc', wheel: wheels.indexOf(w), center: w.center, radius: w.radius, normal: 0, sweep: TAU, start: 0, length: TAU * w.radius }];
  }
  // The path begins on the first wheel, where the belt comes onto it.
  const first = on.findIndex((o) => o.wheel === 0);
  if (first > 0) on.push(...on.splice(0, first));
  const path: TrackRun[] = [];
  let start = 0;
  const at = (w: { center: Vec2; radius: number }, a: number): Vec2 => [w.center[0] + w.radius * cos(a), w.center[1] + w.radius * sin(a)];
  on.forEach((o, i) => {
    const w = wheels[o.wheel];
    const sweep = o.to - o.from;
    path.push({ kind: 'arc', wheel: o.wheel, center: w.center, radius: w.radius, normal: o.from, sweep, start, length: sweep * w.radius });
    start += sweep * w.radius;
    const from = at(w, o.to);
    const to = at(wheels[on[(i + 1) % on.length].wheel], o.to);
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    path.push({ kind: 'line', from, to, normal: o.to, start, length });
    start += length;
  });
  return path;
}

/**
 * The point `s` along a track's belt, `out` outside the belt's inside, and the way out of the belt there (a
 * unit vector). `s` goes round and round: one `length` on is the same point.
 */
export function trackPoint(f: Pick<TrackFigures, 'path' | 'length'>, s: number, out = 0): { at: Vec2; normal: Vec2 } {
  const along = ((s % f.length) + f.length) % f.length;
  const run = f.path.find((r) => along < r.start + r.length) ?? f.path[f.path.length - 1];
  const d = Math.min(run.length, Math.max(0, along - run.start));
  if (run.kind === 'arc') {
    const a = run.normal + d / run.radius;
    return { at: [run.center[0] + (run.radius + out) * cos(a), run.center[1] + (run.radius + out) * sin(a)], normal: [cos(a), sin(a)] };
  }
  const n: Vec2 = [cos(run.normal), sin(run.normal)];
  const t = run.length > 0 ? d / run.length : 0;
  return { at: [run.from[0] + (run.to[0] - run.from[0]) * t + out * n[0], run.from[1] + (run.to[1] - run.from[1]) * t + out * n[1]], normal: n };
}

/** A place of a track's side view, `across` from the rail's outer face, in the axes of the part as it is built: X along, Z up, the rail's face at y = 0 and the rest toward -Y. */
export const trackInPart = (at: Vec2, across: number): Vec3 => [at[0], -across, at[1]];

/** What a track part may be given. */
const TRACK = {
  length: { min: 20, max: 1500 },
  width: { min: 5, max: 300 },
  endDiameter: { min: 10, max: 400 },
  roadWheels: { min: 0, max: 12 },
  roadDiameter: { min: 5, max: 400 },
  belt: { min: 0.5, max: 20 },
  rise: { min: 0, max: 300 },
};
export const TRACK_LIMITS: Readonly<typeof TRACK> = TRACK;

/** The figures of a track part, from its settings: all a simulator needs to stand in for it. */
export function trackFigures(p: Params): TrackFigures {
  const L = num(p, 'length');
  const W = num(p, 'width');
  const Re = num(p, 'endDiameter') / 2;
  const N = Math.round(num(p, 'roadWheels'));
  const Rr = num(p, 'roadDiameter') / 2;
  const t = num(p, 'belt');
  // A rise is told from the floor the road wheels stand on; with none, from the lower of the two ends.
  const low = N > 0 ? 0 : Math.min(num(p, 'sprocketRise'), num(p, 'idlerRise'));
  const sprocketRise = num(p, 'sprocketRise') - low;
  const idlerRise = num(p, 'idlerRise') - low;
  // Where the belt's inside lies on the floor's side, under the road wheels.
  const under = -Re - sprocketRise;
  const placed: Omit<TrackWheel, 'onFloor'>[] = [
    { kind: 'sprocket', center: [0, 0], radius: Re },
    ...Array.from({ length: N }, (_, i): Omit<TrackWheel, 'onFloor'> => ({ kind: 'road', center: [(L * (i + 1)) / (N + 1), under + Rr], radius: Rr })),
    { kind: 'idler', center: [L, under + Re + idlerRise], radius: Re },
  ];
  const path = wrap(placed);
  const last = path[path.length - 1];
  const length = last.start + last.length;
  const down = -Math.PI / 2;
  const lowest = Math.max(...placed.map((w) => reach(w, down)));
  const wheels = placed.map((w): TrackWheel => ({ ...w, onFloor: lowest - reach(w, down) < 1e-6 }));
  const standing = wheels.filter((w) => w.onFloor).map((w) => w.center[0]);
  // The lugs stand most of the belt's thickness out of it, about four thicknesses apart, evenly all the way round.
  const height = Math.max(0.8, 0.8 * t);
  const count = Math.max(6, Math.round(length / Math.max(4, 4 * t)));
  const far = (a: number) => Math.max(...placed.map((w) => reach(w, a))) + t + height;
  // The rail is a slice of the track's width on the body's side, no taller than the smallest wheel leaves it room for inside the belt.
  const thickness = Math.max(1, Math.min(0.12 * W, 6));
  const rail = { along: placed.map((w) => w.center), half: 0.45 * Math.min(Re, N > 0 ? Rr : Re), thickness, gap: Math.max(0.5, Math.min(0.04 * W, 2)) };
  return {
    width: W,
    wheels,
    path,
    length,
    thickness: t,
    lug: { height, pitch: length / count, count },
    floor: { up: -far(down), from: Math.min(...standing), to: Math.max(...standing) },
    rail,
    box: { min: [-far(Math.PI), -W - Math.max(0, num(p, 'hubHeight')), -far(down)], max: [far(0), 0, far(Math.PI / 2)] },
  };
}

/** The belt's inside moved `out`, as a closed outline; its corners on the wheels are as close as the quality asks. */
function beltOutline(f: TrackFigures, out: number, q: Quality): Polygon {
  return dedupe(stops(f, out, q, 0, f.length).map((s) => trackPoint(f, s, out).at));
}

/**
 * Where along the belt, from `from` to `to`, an outline `out` from its inside needs a corner: the ends, where a
 * stretch begins, along the arcs as the quality asks, and where an arc is farthest left, right, up or down, so
 * that the outline reaches exactly as far as the belt does.
 */
function stops(f: TrackFigures, out: number, q: Quality, from: number, to: number): number[] {
  const all: number[] = [from, to];
  // The stretch may begin before the path's beginning or run past its end: the belt goes round.
  for (const lap of [-f.length, 0, f.length]) {
    for (const run of f.path) {
      const add = (s: number) => {
        if (s + lap > from + 1e-9 && s + lap < to - 1e-9) all.push(s + lap);
      };
      add(run.start);
      if (run.kind !== 'arc') continue;
      const n = arcN(q, run.radius + out, run.sweep);
      for (let i = 1; i < n; i++) add(run.start + (run.length * i) / n);
      for (let k = Math.ceil(run.normal / (Math.PI / 2)); (k * Math.PI) / 2 < run.normal + run.sweep; k++) add(run.start + ((k * Math.PI) / 2 - run.normal) * run.radius);
    }
  }
  all.sort((a, b) => a - b);
  return all.filter((s, i) => i === 0 || s - all[i - 1] > 1e-9);
}

/**
 * The lugs of half the belt's width, as outlines: one in two along the belt, `shift` of a pitch on from the
 * path's beginning. Each is longer than half a pitch, so the two halves' lugs together leave no place along
 * the belt without one: the track is as long and as tall as its lugs' tops all the way round.
 */
function lugs(f: TrackFigures, shift: number, q: Quality): Polygon[] {
  const { pitch, count, height } = f.lug;
  const top = f.thickness + height;
  // Sunk into the belt a little, to be one solid with it.
  const foot = f.thickness - Math.min(0.2, f.thickness / 3);
  return Array.from({ length: count }, (_, i) => {
    const mid = (i + shift) * pitch;
    const at = stops(f, top, q, mid - 0.3 * pitch, mid + 0.3 * pitch);
    return ensureCCW(dedupe([...at.map((s) => trackPoint(f, s, foot).at), ...at.reverse().map((s) => trackPoint(f, s, top).at)]));
  });
}

function buildTrack(p: Params, q: Quality): BuildResult {
  const warnings: string[] = [];
  const f = trackFigures(p);
  const W = f.width;
  const t = f.thickness;
  const hubbed = num(p, 'hubHeight') > 0;

  // Everything is drawn lying down, the side view in XY and across along Z, and stood up at the end.
  // The rail: a bar from each axle to the next, on the body's side of the track.
  const { along, half, thickness, gap } = f.rail;
  const bar = (a: Vec2, b: Vec2): Solid => {
    const way = Math.atan2(b[1] - a[1], b[0] - a[0]);
    return extrude([[...arc(b[0], b[1], half, way - Math.PI / 2, way + Math.PI / 2, 12), ...arc(a[0], a[1], half, way + Math.PI / 2, way + (3 * Math.PI) / 2, 12)]], thickness);
  };
  const rail = along.slice(1).map((b, i) => bar(along[i], b));
  // Each wheel stands off the rail on a stub of its axle.
  const from = thickness + gap;
  const wide = W - from;

  // A wheel: a rim and a boss as wide as it is, a thinner web between them. It is sunk a little into the belt, to be one solid with it.
  const sunk = Math.min(0.5, t / 2);
  const wheel = (w: TrackWheel): Solid => {
    const R = w.radius;
    const driven = w.kind === 'sprocket';
    const boss = driven ? Math.max(boreRadius(p) + Math.max(2, 0.08 * R), hubbed ? num(p, 'hubDiameter') / 2 : 0, 0.3 * R) : 0.3 * R;
    const inner = R - Math.max(1.2, 0.16 * R);
    const depth = 0.3 * wide;
    const dished = inner - boss > 1;
    const profile: Polygon = dished
      ? [[0, 0], [boss, 0], [boss, depth], [inner, depth], [inner, 0], [R + sunk, 0], [R + sunk, wide], [inner, wide], [inner, wide - depth], [boss, wide - depth], [boss, wide], [0, wide]]
      : [[0, 0], [R + sunk, 0], [R + sunk, wide], [0, wide]];
    const segments = Math.max(20, Math.min(arcSegments(q, TAU), Math.round(arcSegments(q, TAU) * Math.sqrt(R / 80))));
    let solid = revolve(profile, segments);
    // The sprocket is told from the others by the holes through its web.
    const hole = Math.min(0.32 * (inner - boss), 0.2 * R);
    if (driven && dished && hole >= 1) {
      const ring = (inner + boss) / 2;
      const holes = Math.max(3, Math.min(6, Math.floor((TAU * ring) / (3.2 * hole))));
      solid = difference(solid, ...Array.from({ length: holes }, (_, i) => rotate(translate(cylinder(hole, wide + 2, 20), [ring, 0, -1]), [0, 0, (360 * (i + 0.5)) / holes])));
    }
    const stub = translate(cylinder(Math.min(boss, half), gap + 0.2, 20), [0, 0, -gap - 0.1]);
    return translate(union(solid, stub), [w.center[0], w.center[1], from]);
  };

  const inside = beltOutline(f, 0, q);
  const belt = extrude([beltOutline(f, t, q), inside], W);
  const body = union(belt, extrude(lugs(f, 0, q), W / 2), translate(extrude(lugs(f, 0.5, q), W / 2), [0, 0, W / 2]), ...rail, ...f.wheels.map(wheel));

  const apart = f.wheels.some((a, i) => f.wheels.some((b, j) => j > i && Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) < a.radius + b.radius - 1e-6));
  if (apart) warnings.push(tr('The wheels run into each other. Make the track longer or the wheels smaller.'));
  else if (f.wheels.some((w, i) => w.kind !== 'road' && !f.path.some((r) => r.kind === 'arc' && r.wheel === i))) warnings.push(tr('The belt does not reach every wheel. Make the road wheels smaller.'));

  const sprocket = f.wheels[0].radius;
  const { solid: lying, height } = addHubAndBore(body, 0, W, p, q, warnings, sprocket);
  // Stood up: the side view's up is the part's Z, and across runs toward -Y.
  const solid = rotate(lying, [90, 0, 0]);
  const drive = sprocket + t / 2;
  return {
    solid,
    info: [
      lengthInfo(tr('Overall length'), f.box.max[0] - f.box.min[0]),
      lengthInfo(tr('Overall height'), f.box.max[2] - f.box.min[2]),
      lengthInfo(tr('Overall width'), height),
      lengthInfo(tr('Length on the floor'), f.floor.to - f.floor.from, 1),
      lengthInfo(trx('track', 'Belt length'), f.length + Math.PI * t, 1),
      lengthInfo(tr('Travel per turn'), TAU * drive, 1),
    ],
    warnings,
  };
}

export const track: GeneratorDef = {
  id: 'track',
  name: tr('Track'),
  category: 'wheels',
  summary: tr('Belt round a sprocket, an idler and road wheels on a rail, for a robot on tracks.'),
  groups: [
    {
      title: tr('Track'),
      params: [
        { type: 'number', key: 'length', label: tr('Length'), help: tr('Sets the distance between the sprocket and idler axles.'), default: 240, min: TRACK.length.min, max: TRACK.length.max, step: 1, unit: 'mm' },
        { type: 'number', key: 'width', label: tr('Width'), default: 40, min: TRACK.width.min, max: TRACK.width.max, step: 0.5, unit: 'mm' },
        { type: 'number', key: 'belt', label: tr('Belt thickness'), default: 3, min: TRACK.belt.min, max: TRACK.belt.max, step: 0.5, unit: 'mm' },
      ],
    },
    {
      title: tr('Wheels'),
      params: [
        { type: 'number', key: 'endDiameter', label: tr('Sprocket and idler diameter'), default: 60, min: TRACK.endDiameter.min, max: TRACK.endDiameter.max, step: 1, unit: 'mm' },
        { type: 'number', key: 'roadWheels', label: tr('Road wheels'), default: 3, min: TRACK.roadWheels.min, max: TRACK.roadWheels.max, step: 1, integer: true },
        { type: 'number', key: 'roadDiameter', label: tr('Road wheel diameter'), default: 40, min: TRACK.roadDiameter.min, max: TRACK.roadDiameter.max, step: 1, unit: 'mm', visible: (p) => num(p, 'roadWheels') > 0 },
        { type: 'number', key: 'sprocketRise', label: tr('Sprocket rise'), help: tr('Lifts the sprocket off the floor. 0 leaves it on the floor.'), default: 0, min: TRACK.rise.min, max: TRACK.rise.max, step: 1, unit: 'mm' },
        { type: 'number', key: 'idlerRise', label: tr('Idler rise'), help: tr('Lifts the idler off the floor. 0 leaves it on the floor.'), default: 0, min: TRACK.rise.min, max: TRACK.rise.max, step: 1, unit: 'mm' },
      ],
    },
    hubGroup({ height: 0, diameter: 16, setScrews: 1, setScrewDiameter: 2.8 }),
    boreGroup({ type: 'round', diameter: 5 }),
  ],
  build: buildTrack,
};
