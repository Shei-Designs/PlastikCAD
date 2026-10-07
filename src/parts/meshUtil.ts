import earcut from 'earcut';
import { signedArea } from './math2d';
import type { Polygon, Solid } from './types';

/** Triangulate a simple polygon; the triangles get the same winding as `poly` (index triples into it). */
export function triangulate(poly: Polygon): number[] {
  const flat: number[] = [];
  for (const [x, y] of poly) flat.push(x, y);
  const tris = earcut(flat);
  // earcut does not promise a winding; normalise every triangle to CCW.
  const flip = signedArea(poly) < 0;
  for (let i = 0; i < tris.length; i += 3) {
    const [ax, ay] = poly[tris[i]];
    const [bx, by] = poly[tris[i + 1]];
    const [cx, cy] = poly[tris[i + 2]];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area < 0 !== flip) [tris[i + 1], tris[i + 2]] = [tris[i + 2], tris[i + 1]];
  }
  return tris;
}

/**
 * Prism over a CCW polygon from z=0 to z=height whose top is shifted along X
 * by shear·height (used for helical racks, where teeth slant instead of twist).
 */
export function shearedPrism(poly: Polygon, height: number, shear: number): Solid {
  const n = poly.length;
  const positions: number[] = [];
  for (const [x, y] of poly) positions.push(x, y, 0);
  for (const [x, y] of poly) positions.push(x + shear * height, y, height);
  const cap = triangulate(poly);
  const triangles: number[] = [];
  for (let i = 0; i < cap.length; i += 3) {
    triangles.push(cap[i], cap[i + 2], cap[i + 1]);
    triangles.push(n + cap[i], n + cap[i + 1], n + cap[i + 2]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    triangles.push(i, j, n + j, i, n + j, n + i);
  }
  return { op: 'mesh', positions, triangles };
}
