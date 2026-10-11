import type { Polygon, Quality, Vec2 } from './types';

export const TAU = Math.PI * 2;
export const deg = (d: number) => (d * Math.PI) / 180;
export const toDeg = (r: number) => (r * 180) / Math.PI;

export const polar = (r: number, a: number, cx = 0, cy = 0): Vec2 => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

export const rotatePoint = ([x, y]: Vec2, a: number): Vec2 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
};

/** Number of segments to use for an arc of `angle` radians at the given quality (at least `min`). */
export const arcSegments = (q: Quality, angle: number, min = 1) =>
  Math.max(min, Math.ceil((Math.abs(angle) / TAU) * q.circle));

/** Points along an arc from angle a0 to a1 (inclusive of both ends), n segments. */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) pts.push(polar(r, a0 + ((a1 - a0) * i) / n, cx, cy));
  return pts;
}

/** CCW circle polygon. */
export function circle(r: number, n: number, cx = 0, cy = 0): Polygon {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) pts.push(polar(r, (TAU * i) / n, cx, cy));
  return pts;
}

/** CCW regular polygon given its apothem (center-to-flat distance). First flat faces +X. */
export function regularPolygon(sides: number, apothem: number): Polygon {
  const rc = apothem / Math.cos(Math.PI / sides);
  const pts: Vec2[] = [];
  for (let i = 0; i < sides; i++) pts.push(polar(rc, (TAU * (i + 0.5)) / sides));
  return pts;
}

export function signedArea(poly: Polygon): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export const ensureCCW = (poly: Polygon): Polygon => (signedArea(poly) < 0 ? [...poly].reverse() : poly);

/** Drop consecutive (and wrap-around) points closer than eps. */
export function dedupe(poly: Polygon, eps = 1e-7): Polygon {
  const out: Vec2[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps) {
    out.pop();
  }
  return out;
}

/** True if any two non-adjacent edges of the closed polygon cross. O(n^2), meant for tests. */
export function selfIntersects(poly: Polygon): boolean {
  const n = poly.length;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j];
      const d = poly[(j + 1) % n];
      const d1 = cross(a, b, c);
      const d2 = cross(a, b, d);
      const d3 = cross(c, d, a);
      const d4 = cross(c, d, b);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

export function bounds(polys: Polygon[]): { min: Vec2; max: Vec2 } {
  const min: Vec2 = [Infinity, Infinity];
  const max: Vec2 = [-Infinity, -Infinity];
  for (const poly of polys)
    for (const [x, y] of poly) {
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
    }
  return { min, max };
}

/**
 * The polygon moved out by `d` (in by a negative `d`): each vertex slides along
 * the bisector of its two edges so that both edges end up `d` further out.
 * Meant for CCW outlines with no very sharp corners, such as board shapes.
 */
export function offsetPolygon(poly: Polygon, d: number): Polygon {
  const n = poly.length;
  if (d === 0 || n < 3) return poly;
  const out: Polygon = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = poly[(i + n - 1) % n];
    const [x, y] = poly[i];
    const [nx, ny] = poly[(i + 1) % n];
    // Outward unit normals of the edge in and the edge out (CCW: outward is to the right of travel).
    const l1 = Math.hypot(x - px, y - py) || 1;
    const l2 = Math.hypot(nx - x, ny - y) || 1;
    const ax = (y - py) / l1;
    const ay = -(x - px) / l1;
    const bx = (ny - y) / l2;
    const by = -(nx - x) / l2;
    const dot = Math.max(-0.9, ax * bx + ay * by);
    const k = d / (1 + dot);
    out.push([x + (ax + bx) * k, y + (ay + by) * k]);
  }
  return out;
}
