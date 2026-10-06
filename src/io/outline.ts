import type { Polygon, Vec2 } from '../model/types';

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
