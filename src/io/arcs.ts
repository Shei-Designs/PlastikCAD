// Circles and arcs found again in an outline. The kernel knows only straight
// sides: a hole is a polygon of many of them, a rounded corner a run of short
// ones. A drawing program or a laser's software does better with the circle
// and the arc themselves, so before an outline is written its runs of corners
// that lie on one circle are read back as arcs, and a contour that is one such
// run all the way round as a circle.
import { CREASE_ANGLE } from '../geometry/mesh';
import type { Polygon, Vec2 } from '../model/types';

/** A side of a traced contour: straight to `to`, or round `arc` to it. */
export interface Side {
  to: Vec2;
  /** `sweep` is the angle gone round the center, in radians, positive counterclockwise; never more than half a turn. */
  arc?: { center: Vec2; radius: number; sweep: number };
}

/** A closed contour as lines and arcs from `start` back to it, or a whole circle. */
export type Traced = { circle: { center: Vec2; radius: number } } | { start: Vec2; sides: Side[] };

/** Corners this near a circle (mm) are on it: well under what a printer or a laser resolves, well over what the kernel's arithmetic leaves. */
const NEAR = 0.002;
/** Sides turning by more than this at a corner make a corner, not a curve: the angle past which the app itself draws an edge. */
const MAX_TURN = (CREASE_ANGLE * Math.PI) / 180;
/** An arc is read from this many sides at least: fewer are as likely a chamfer, or a stretch of some other curve. */
const MIN_SIDES = 4;

interface Circle {
  center: Vec2;
  radius: number;
}

/** The circle through three points; null when they are in line, or as good as. */
function circleThrough(a: Vec2, b: Vec2, c: Vec2): Circle | null {
  const bx = b[0] - a[0];
  const by = b[1] - a[1];
  const cx = c[0] - a[0];
  const cy = c[1] - a[1];
  const d = 2 * (bx * cy - by * cx);
  if (Math.abs(d) < 1e-12) return null;
  const ux = (cy * (bx * bx + by * by) - by * (cx * cx + cy * cy)) / d;
  const uy = (bx * (cx * cx + cy * cy) - cx * (bx * bx + by * by)) / d;
  const radius = Math.hypot(ux, uy);
  return radius < 1e6 ? { center: [a[0] + ux, a[1] + uy], radius } : null;
}

const on = (p: Vec2, c: Circle): boolean => Math.abs(Math.hypot(p[0] - c.center[0], p[1] - c.center[1]) - c.radius) <= NEAR;

/** The angle from `a` to `b` as seen from `center`, in (-π, π]. */
function swept(center: Vec2, a: Vec2, b: Vec2): number {
  const ax = a[0] - center[0];
  const ay = a[1] - center[1];
  const bx = b[0] - center[0];
  const by = b[1] - center[1];
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

/**
 * The radius of the circle a round contour stands for. Its corners are on `circle`; but the app's own
 * cylinders are made with their flats on the true circle and their corners outside it, so that a
 * cylinder 20 mm wide measures 20 mm across. Such a contour is as wide, or as tall, as the circle
 * inside its sides, and that circle is then the one meant. Any other (a part's bore, an imported
 * hole, a cylinder turned by an odd angle) has its corners on the circle meant, as near as can be told.
 */
function trueRadius(contour: Polygon, circle: Circle): number {
  const n = contour.length;
  const inner = circle.radius * Math.cos(Math.PI / n);
  // Sides of one length all round, or the circle inside them is not one circle.
  let shortest = Infinity;
  let longest = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const [x, y] = contour[i];
    const [x1, y1] = contour[(i + 1) % n];
    const side = Math.hypot(x1 - x, y1 - y);
    shortest = Math.min(shortest, side);
    longest = Math.max(longest, side);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (longest - shortest > NEAR) return circle.radius;
  // Told apart only where the two circles are: a micron or more.
  if (circle.radius - inner < NEAR / 2) return circle.radius;
  const across = (width: number): boolean => Math.abs(width - 2 * inner) < (circle.radius - inner) / 4;
  return across(maxX - minX) || across(maxY - minY) ? inner : circle.radius;
}

/**
 * A closed contour read as lines and arcs. Corners are kept as they are: an
 * arc begins and ends on corners of the contour, and passes within `NEAR` of
 * every corner between them.
 */
export function traceArcs(contour: Polygon): Traced {
  const n = contour.length;
  const at = (i: number): Vec2 => contour[((i % n) + n) % n];
  if (n < 3) return { start: contour[0] ?? [0, 0], sides: contour.slice(1).map((to) => ({ to })) };

  /** How many sides from corner `i` on lie on one circle, turning one way by little at a time, and that circle; up to `limit` sides. */
  const run = (i: number, limit: number): { sides: number; circle: Circle } | null => {
    if (limit < MIN_SIDES) return null;
    const near = circleThrough(at(i), at(i + 1), at(i + 2));
    if (!near) return null;
    const way = Math.sign(swept(near.center, at(i), at(i + 1)));
    const fits = (circle: Circle, sides: number): boolean => {
      for (let k = 0; k < sides; k++) {
        const step = swept(circle.center, at(i + k), at(i + k + 1));
        if (Math.sign(step) !== way || Math.abs(step) > MAX_TURN || !on(at(i + k + 1), circle)) return false;
      }
      return on(at(i), circle);
    };
    // Three neighbouring corners say little of a circle when each is a micron off, so the circle is taken
    // through corners twice as far apart each time, for as long as everything between them lies on it.
    let circle = near;
    let sides = 2;
    for (let w = 2; 2 * w <= limit; w *= 2) {
      const wider = circleThrough(at(i), at(i + w), at(i + 2 * w));
      if (!wider || !fits(wider, 2 * w)) break;
      circle = wider;
      sides = 2 * w;
    }
    // Then on, a side at a time; and once more from a circle through the ends and the middle of what was found.
    for (let pass = 0; pass < 2; pass++) {
      while (sides < limit && fits(circle, sides + 1)) sides++;
      const last = sides === n ? sides - 1 : sides;
      const whole = circleThrough(at(i), at(i + (last >> 1)), at(i + last));
      if (!whole || !fits(whole, sides)) break;
      circle = whole;
    }
    return sides >= MIN_SIDES && fits(circle, sides) ? { sides, circle } : null;
  };

  // All the way round on one circle: a circle.
  const round = run(0, n);
  if (round && round.sides === n) return { circle: { center: round.circle.center, radius: trueRadius(contour, round.circle) } };

  // Begun where an arc ends, if there is one, so that no arc is cut in two by where the list of corners
  // happens to start: the first arc found may be the tail of one, but its end is an end.
  let from = 0;
  for (let i = 0; i < n; i++) {
    const found = run(i, n);
    if (found) {
      from = i + found.sides;
      break;
    }
  }
  const sides: Side[] = [];
  let done = 0;
  while (done < n) {
    const i = from + done;
    const found = run(i, n - done);
    if (!found) {
      sides.push({ to: at(i + 1) });
      done++;
      continue;
    }
    const { circle } = found;
    let sweep = 0;
    for (let k = 0; k < found.sides; k++) sweep += swept(circle.center, at(i + k), at(i + k + 1));
    // Over half a turn is written as two arcs: both formats say an arc by its ends, and past half a turn that says two different arcs.
    const cuts = Math.abs(sweep) > Math.PI ? [found.sides >> 1, found.sides] : [found.sides];
    let begun = 0;
    for (const cut of cuts) {
      let part = 0;
      for (let k = begun; k < cut; k++) part += swept(circle.center, at(i + k), at(i + k + 1));
      sides.push({ to: at(i + cut), arc: { center: circle.center, radius: circle.radius, sweep: part } });
      begun = cut;
    }
    done += found.sides;
  }
  return { start: at(from), sides };
}
