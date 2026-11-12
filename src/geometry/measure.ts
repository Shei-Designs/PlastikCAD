// What the Measure tool says about one feature, or about two of them: a
// point's place, an edge's length, a circle's diameter, a face's area; and
// between two, the distance (with how far apart they are along each axis),
// the angle between edges or faces, or the gap between parallel ones. The
// line drawn on the plate runs between the two nearest points.
import { closestOnCircle, closestOnSegment } from './features';
import type { Feature, PointKind } from './features';
import { tr } from '../i18n';
import { add, dot, length, normalize, scale, sub } from '../model/math';
import type { Vec3 } from '../model/types';
import { areaText, lengthFigure, lengthText } from '../units';
import type { Unit } from '../units';

export interface Measurement {
  /** The value that matters most, short enough for a label. */
  text: string;
  /** Everything, one figure a line. */
  lines: string[];
  /** The line to draw, if two points are involved. */
  from: Vec3;
  to: Vec3 | null;
}

/** A length in `unit`, with it after. Under five thousandths of a millimeter is nothing. */
const reading = (v: number, unit: Unit): string => lengthText(Math.abs(v) < 5e-3 ? 0 : v, unit);
/** Degrees to one decimal. */
export const deg = (v: number): string => `${Number(v.toFixed(1))}°`;
/** Where a point is, in `unit`. */
const place = (p: Vec3, unit: Unit): string => `(${p.map((v) => lengthFigure(v, unit)).join(', ')})`;
/** A direction, which has no unit. */
const heading = (v: Vec3): string => `(${v.map((c) => Number(c.toFixed(2))).join(', ')})`;
/** The acute angle between two lines (0–90°) and its supplement, as "45° (135°)"; a right angle alone. */
const between = (a: Vec3, b: Vec3): { acute: number; text: string } => {
  const c = Math.min(1, Math.abs(dot(normalize(a), normalize(b))));
  const acute = (Math.acos(c) * 180) / Math.PI;
  return { acute, text: Math.abs(acute - 90) < 0.05 ? deg(90) : `${deg(acute)} (${deg(180 - acute)})` };
};

const NAMES: Record<Feature['kind'], string> = { point: tr('Point'), middle: tr('Edge middle'), quadrant: tr('Quadrant'), facecenter: tr('Face center'), center: tr('Object center'), edge: tr('Edge'), face: tr('Face'), circle: tr('Circle') };

/** A feature's own figures, its lengths in `unit`. */
export function describe(f: Feature, unit: Unit = 'mm'): Measurement {
  const len = (v: number) => reading(v, unit);
  switch (f.kind) {
    case 'point':
    case 'middle':
    case 'quadrant':
    case 'facecenter':
    case 'center':
      return { text: NAMES[f.kind], lines: [NAMES[f.kind], place(f.at, unit)], from: f.at, to: null };
    case 'edge': {
      const l = length(sub(f.b, f.a));
      return { text: len(l), lines: [tr('Edge {length}', { length: len(l) }), tr('from {point}', { point: place(f.a, unit) }), tr('to {point}', { point: place(f.b, unit) })], from: f.a, to: f.b };
    }
    case 'circle': {
      const whole = f.sweep >= 359.9;
      const head = whole ? tr('Circle Ø {diameter}', { diameter: len(2 * f.radius) }) : tr('Arc R {radius}, {sweep}', { radius: len(f.radius), sweep: deg(f.sweep) });
      return { text: whole ? `Ø ${len(2 * f.radius)}` : `R ${len(f.radius)}`, lines: [head, whole ? `R ${len(f.radius)}` : `Ø ${len(2 * f.radius)}`, tr('center {point}', { point: place(f.center, unit) })], from: f.center, to: null };
    }
    case 'face': {
      const area = areaText(f.area, unit);
      return { text: area, lines: [f.flat ? tr('Face {area}', { area }) : tr('Surface {area}', { area }), tr('normal {vector}', { vector: heading(f.normal) })], from: f.at, to: null };
    }
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

/** Distance between two points, with how far apart they are along each axis; `head` words the first line around the distance. */
function apart(a: Vec3, b: Vec3, unit: Unit, head: (distance: string) => string): Measurement {
  const len = (v: number) => reading(v, unit);
  const d = sub(b, a);
  const lines = [head(len(length(d)))];
  const parts = ['X', 'Y', 'Z'].map((axis, k) => (Math.abs(d[k]) >= 5e-3 ? `${axis} ${len(Math.abs(d[k]))}` : null)).filter((x): x is string => x !== null);
  if (parts.length > 1) lines.push(parts.join(' · '));
  return { text: len(length(d)), lines, from: a, to: b };
}

/** Where a point lands on a plane. */
const foot = (p: Vec3, on: Vec3, normal: Vec3): Vec3 => sub(p, scale(normal, dot(sub(p, on), normal)));

/**
 * Two features measured against each other. Points (and circles, by their
 * centres) give distances; two edges or two faces give the angle between
 * them, or the gap when they run parallel; an edge against a face gives its
 * angle to the face. Lengths are in `unit`.
 */
export function measure(a: Feature, b: Feature, unit: Unit = 'mm'): Measurement {
  const len = (v: number) => reading(v, unit);
  if (isPoint(a) && isPoint(b)) {
    const m = apart(pointOf(a), pointOf(b), unit, (distance) => (a.kind === 'circle' && b.kind === 'circle' ? tr('Centers {distance}', { distance }) : tr('Distance {distance}', { distance })));
    if (a.kind === 'circle' && b.kind === 'circle') {
      const axes = between(a.normal, b.normal);
      if (axes.acute > 0.05) m.lines.push(tr('axes {angle} apart', { angle: axes.text }));
    }
    return m;
  }
  // One point against an edge or face: the nearest point of the edge, or the foot on the face.
  if (isPoint(a) || isPoint(b)) {
    const [p, other] = isPoint(a) ? [pointOf(a), b as Exclude<Feature, AsPoint>] : [pointOf(b), a as Exclude<Feature, AsPoint>];
    if (other.kind === 'edge') {
      const m = apart(p, closestOnSegment(other.a, other.b, p), unit, (distance) => tr('To the edge {distance}', { distance }));
      return m;
    }
    const f = foot(p, other.at, other.normal);
    const d = Math.abs(dot(sub(p, other.at), other.normal));
    return { text: len(d), lines: [other.flat ? tr('To the face {distance}', { distance: len(d) }) : tr('To the surface {distance}', { distance: len(d) })], from: p, to: f };
  }
  if (a.kind === 'edge' && b.kind === 'edge') {
    const da = sub(a.b, a.a);
    const db = sub(b.b, b.a);
    const angle = between(da, db);
    const { p, q } = closestBetweenSegments(a.a, a.b, b.a, b.b);
    const gap = length(sub(q, p));
    if (angle.acute < 0.05) {
      const m = apart(p, q, unit, (distance) => tr('Parallel, apart {distance}', { distance }));
      return m;
    }
    const lines = [tr('Angle {angle}', { angle: angle.text })];
    if (gap >= 5e-3) lines.push(tr('nearest {distance} apart', { distance: len(gap) }));
    return { text: angle.text, lines, from: p, to: q };
  }
  if (a.kind === 'face' && b.kind === 'face') {
    const angle = between(a.normal, b.normal);
    if (angle.acute < 0.05) {
      const f = foot(a.at, b.at, b.normal);
      const d = Math.abs(dot(sub(a.at, b.at), b.normal));
      return { text: len(d), lines: [tr('Parallel, {distance} apart', { distance: len(d) })], from: a.at, to: f };
    }
    return { text: angle.text, lines: [tr('Angle {angle}', { angle: angle.text })], from: a.at, to: b.at };
  }
  // An edge against a face: the edge's angle to the face, or its distance when it runs along it.
  const [edge, face] = a.kind === 'edge' ? [a, b as Extract<Feature, { kind: 'face' }>] : [b as Extract<Feature, { kind: 'edge' }>, a as Extract<Feature, { kind: 'face' }>];
  const dir = normalize(sub(edge.b, edge.a));
  const toNormal = between(dir, face.normal).acute;
  const tilt = 90 - toNormal;
  const mid = scale(add(edge.a, edge.b), 0.5);
  if (tilt < 0.05) {
    const d = Math.abs(dot(sub(mid, face.at), face.normal));
    return { text: len(d), lines: [tr('Along the face, {distance} off it', { distance: len(d) })], from: mid, to: foot(mid, face.at, face.normal) };
  }
  return { text: deg(tilt), lines: [tr('Angle to the face {angle}', { angle: deg(tilt) }), tr('to its normal {angle}', { angle: deg(toNormal) })], from: mid, to: face.at };
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

