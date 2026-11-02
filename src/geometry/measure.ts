// What the Measure tool says about one feature, or about two of them: a
// point's place, an edge's length, a circle's diameter, a face's area; and
// between two, the distance (with how far apart they are along each axis),
// the angle between edges or faces, or the gap between parallel ones. The
// line drawn on the plate runs between the two nearest points.
import { closestOnCircle, closestOnSegment } from './features';
import type { Feature, PointKind } from './features';
import type { Vec3 } from '../model/types';

export interface Measurement {
  /** The value that matters most, short enough for a label. */
  text: string;
  /** Everything, one figure a line. */
  lines: string[];
  /** The line to draw, if two points are involved. */
  from: Vec3;
  to: Vec3 | null;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => {
  const n = length(a);
  return n > 0 ? scale(a, 1 / n) : [0, 0, 1];
};

/** Millimetres to two decimals, without trailing zeros. */
export const mm = (v: number): string => `${Number((Math.abs(v) < 5e-3 ? 0 : v).toFixed(2))} mm`;
/** Degrees to one decimal. */
export const deg = (v: number): string => `${Number(v.toFixed(1))}°`;
const place = (p: Vec3): string => `(${[0, 1, 2].map((k) => Number(p[k].toFixed(2))).join(', ')})`;
/** The acute angle between two lines (0–90°) and its supplement, as "45° (135°)"; a right angle alone. */
const between = (a: Vec3, b: Vec3): { acute: number; text: string } => {
  const c = Math.min(1, Math.abs(dot(normalize(a), normalize(b))));
  const acute = (Math.acos(c) * 180) / Math.PI;
  return { acute, text: Math.abs(acute - 90) < 0.05 ? deg(90) : `${deg(acute)} (${deg(180 - acute)})` };
};

const NAMES: Record<Feature['kind'], string> = { point: 'Point', middle: 'Edge middle', quadrant: 'Quadrant', facecenter: 'Face centre', center: 'Object centre', edge: 'Edge', face: 'Face', circle: 'Circle' };

/** A feature's own figures. */
export function describe(f: Feature): Measurement {
  switch (f.kind) {
    case 'point':
    case 'middle':
    case 'quadrant':
    case 'facecenter':
    case 'center':
      return { text: NAMES[f.kind], lines: [NAMES[f.kind], place(f.at)], from: f.at, to: null };
    case 'edge': {
      const l = length(sub(f.b, f.a));
      return { text: mm(l), lines: [`Edge ${mm(l)}`, `from ${place(f.a)}`, `to ${place(f.b)}`], from: f.a, to: f.b };
    }
    case 'circle': {
      const whole = f.sweep >= 359.9;
      const head = whole ? `Circle Ø ${mm(2 * f.radius)}` : `Arc R ${mm(f.radius)}, ${deg(f.sweep)}`;
      return { text: whole ? `Ø ${mm(2 * f.radius)}` : `R ${mm(f.radius)}`, lines: [head, whole ? `R ${mm(f.radius)}` : `Ø ${mm(2 * f.radius)}`, `centre ${place(f.center)}`], from: f.center, to: null };
    }
    case 'face':
      return { text: `${Number(f.area.toFixed(1))} mm²`, lines: [`${f.flat ? 'Face' : 'Surface'} ${Number(f.area.toFixed(1))} mm²`, `normal ${place(f.normal)}`], from: f.at, to: null };
  }
}

/** The point a feature stands for when it is measured to as a point. */
export function pointOf(f: Feature): Vec3 {
  switch (f.kind) {
    case 'edge':
      return scale(add(f.a, f.b), 0.5);
    case 'circle':
      return f.center;
    case 'face':
      return f.at;
    default:
      return f.at;
  }
}

type AsPoint = Extract<Feature, { kind: PointKind | 'circle' }>;
const isPoint = (f: Feature): f is AsPoint => f.kind !== 'edge' && f.kind !== 'face';

/** Distance between two points, with how far apart they are along each axis. */
function apart(a: Vec3, b: Vec3, head = 'Distance'): Measurement {
  const d = sub(b, a);
  const lines = [`${head} ${mm(length(d))}`];
  const parts = ['X', 'Y', 'Z'].map((axis, k) => (Math.abs(d[k]) >= 5e-3 ? `${axis} ${mm(Math.abs(d[k]))}` : null)).filter((x): x is string => x !== null);
  if (parts.length > 1) lines.push(parts.join(' · '));
  return { text: mm(length(d)), lines, from: a, to: b };
}

/** Where a point lands on a plane. */
const foot = (p: Vec3, on: Vec3, normal: Vec3): Vec3 => sub(p, scale(normal, dot(sub(p, on), normal)));

/**
 * Two features measured against each other. Points (and circles, by their
 * centres) give distances; two edges or two faces give the angle between
 * them, or the gap when they run parallel; an edge against a face gives its
 * angle to the face.
 */
export function measure(a: Feature, b: Feature): Measurement {
  if (isPoint(a) && isPoint(b)) {
    const m = apart(pointOf(a), pointOf(b), a.kind === 'circle' && b.kind === 'circle' ? 'Centres' : 'Distance');
    if (a.kind === 'circle' && b.kind === 'circle') {
      const axes = between(a.normal, b.normal);
      if (axes.acute > 0.05) m.lines.push(`axes ${axes.text} apart`);
    }
    return m;
  }
  // One point against an edge or face: the nearest point of the edge, or the foot on the face.
  if (isPoint(a) || isPoint(b)) {
    const [p, other] = isPoint(a) ? [pointOf(a), b as Exclude<Feature, AsPoint>] : [pointOf(b), a as Exclude<Feature, AsPoint>];
    if (other.kind === 'edge') {
      const m = apart(p, closestOnSegment(other.a, other.b, p), 'To the edge');
      return m;
    }
    const f = foot(p, other.at, other.normal);
    const d = Math.abs(dot(sub(p, other.at), other.normal));
    return { text: mm(d), lines: [`To the ${other.flat ? 'face' : 'surface'} ${mm(d)}`], from: p, to: f };
  }
  if (a.kind === 'edge' && b.kind === 'edge') {
    const da = sub(a.b, a.a);
    const db = sub(b.b, b.a);
    const angle = between(da, db);
    const { p, q } = closestBetweenSegments(a.a, a.b, b.a, b.b);
    const gap = length(sub(q, p));
    if (angle.acute < 0.05) {
      const m = apart(p, q, 'Parallel, apart');
      return m;
    }
    const lines = [`Angle ${angle.text}`];
    if (gap >= 5e-3) lines.push(`nearest ${mm(gap)} apart`);
    return { text: angle.text, lines, from: p, to: q };
  }
  if (a.kind === 'face' && b.kind === 'face') {
    const angle = between(a.normal, b.normal);
    if (angle.acute < 0.05) {
      const f = foot(a.at, b.at, b.normal);
      const d = Math.abs(dot(sub(a.at, b.at), b.normal));
      return { text: mm(d), lines: [`Parallel, ${mm(d)} apart`], from: a.at, to: f };
    }
    return { text: angle.text, lines: [`Angle ${angle.text}`], from: a.at, to: b.at };
  }
  // An edge against a face: the edge's angle to the face, or its distance when it runs along it.
  const [edge, face] = a.kind === 'edge' ? [a, b as Extract<Feature, { kind: 'face' }>] : [b as Extract<Feature, { kind: 'edge' }>, a as Extract<Feature, { kind: 'face' }>];
  const dir = normalize(sub(edge.b, edge.a));
  const toNormal = between(dir, face.normal).acute;
  const tilt = 90 - toNormal;
  const mid = scale(add(edge.a, edge.b), 0.5);
  if (tilt < 0.05) {
    const d = Math.abs(dot(sub(mid, face.at), face.normal));
    return { text: mm(d), lines: [`Along the face, ${mm(d)} off it`], from: mid, to: foot(mid, face.at, face.normal) };
  }
  return { text: deg(tilt), lines: [`Angle to the face ${deg(tilt)}`, `to its normal ${deg(toNormal)}`], from: mid, to: face.at };
}

/** The nearest points of two segments. */
export function closestBetweenSegments(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): { p: Vec3; q: Vec3 } {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s = 0;
  let t = 0;
  if (a <= 1e-12 && e <= 1e-12) return { p: p1, q: p2 };
  if (a <= 1e-12) t = Math.max(0, Math.min(1, f / e));
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) s = Math.max(0, Math.min(1, -c / a));
    else {
      const bb = dot(d1, d2);
      const denom = a * e - bb * bb;
      s = denom !== 0 ? Math.max(0, Math.min(1, (bb * f - c * e) / denom)) : 0;
      t = (bb * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (bb - c) / a));
      }
    }
  }
  return { p: add(p1, scale(d1, s)), q: add(p2, scale(d2, t)) };
}

/** The nearest point of a feature to a point, for drawing the measuring line to it. */
export function nearestOn(f: Feature, p: Vec3): Vec3 {
  switch (f.kind) {
    case 'edge':
      return closestOnSegment(f.a, f.b, p);
    case 'circle':
      return closestOnCircle(f, p);
    case 'face':
      return foot(p, f.at, f.normal);
    default:
      return f.at;
  }
}

