// What the outline importers and exporters share: the bounds and area of
// contours, the 2D transform drawings place their content with, and how
// finely a curve is cut into straight segments.
import type { Polygon, Vec2 } from '../model/types';

/** How far a flattened curve may stray from the true one, in mm. */
export const TOLERANCE = 0.02;
/** Segments per full turn of an arc, however small or large. */
const MIN_TURN = 24;
const MAX_TURN = 1440;
const TAU = Math.PI * 2;

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

export function signedArea(poly: Polygon): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Affine transform in the order of SVG's matrix(): x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number];

/** a·b: apply b first, then a. */
export const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
export const applyTo = (m: Matrix, [x, y]: Vec2): Vec2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Largest factor by which the transform lengthens a segment (its greatest singular value). */
export function maxStretch(m: Matrix): number {
  const p = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3]) / 2;
  const q = (m[0] * m[0] + m[1] * m[1] - m[2] * m[2] - m[3] * m[3]) / 2;
  const r = m[0] * m[2] + m[1] * m[3];
  return Math.sqrt(p + Math.hypot(q, r));
}

/**
 * Segments for a full turn of an arc, so that no chord strays more than
 * `tolerance` from it. Always a multiple of four: arcs put their points at
 * multiples of the step, which lands one on each extreme of the ellipse and
 * makes the outline exactly as wide and tall as the true shape.
 */
export function turnSegments(radius: number, tolerance: number): number {
  const step = tolerance < radius ? 2 * Math.acos(1 - tolerance / radius) : Math.PI;
  return Math.ceil(Math.min(Math.max(TAU / step, MIN_TURN), MAX_TURN) / 4) * 4;
}
