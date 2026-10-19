import { describe, expect, it } from 'vitest';
import type { MeshData } from '../geometry/mesh';
import { massOf, meshProperties, plausibleInertia, principalMoments, tensorOf } from './inertia';

/** A closed box, `w × d × h`, with its corner at `at`. */
function box(w: number, d: number, h: number, at: [number, number, number] = [0, 0, 0]): MeshData {
  const [x, y, z] = at;
  const positions = new Float32Array([x, y, z, x + w, y, z, x + w, y + d, z, x, y + d, z, x, y, z + h, x + w, y, z + h, x + w, y + d, z + h, x, y + d, z + h]);
  // Outward-facing triangles.
  const triangles = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  return { positions, triangles };
}

/** A closed cylinder of radius `r` and height `h`, standing on z = 0, with `n` sides. */
function cylinder(r: number, h: number, n: number): MeshData {
  const positions: number[] = [0, 0, 0, 0, 0, h];
  const triangles: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n;
    positions.push(r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(a), r * Math.sin(a), h);
  }
  for (let i = 0; i < n; i++) {
    const b0 = 2 + i * 2;
    const t0 = b0 + 1;
    const b1 = 2 + ((i + 1) % n) * 2;
    const t1 = b1 + 1;
    triangles.push(0, b1, b0, 1, t0, t1, b0, b1, t1, b0, t1, t0);
  }
  return { positions: new Float32Array(positions), triangles: new Uint32Array(triangles) };
}

describe('meshProperties', () => {
  it('measures a box: volume, area, centroid and the textbook inertia', () => {
    const p = meshProperties(box(20, 30, 40, [5, -10, 2]));
    expect(p.volume).toBeCloseTo(24000, 3);
    expect(p.area).toBeCloseTo(2 * (20 * 30 + 30 * 40 + 20 * 40), 3);
    expect(p.centroid.map((v) => +v.toFixed(6))).toEqual([15, 5, 22]);
    // I/m = (b² + c²) / 12 about each axis, no products of inertia.
    expect(p.unit[0]).toBeCloseTo((30 * 30 + 40 * 40) / 12, 3);
    expect(p.unit[1]).toBeCloseTo((20 * 20 + 40 * 40) / 12, 3);
    expect(p.unit[2]).toBeCloseTo((20 * 20 + 30 * 30) / 12, 3);
    expect(Math.abs(p.unit[3]) + Math.abs(p.unit[4]) + Math.abs(p.unit[5])).toBeLessThan(1e-6);
  });

  it('measures a cylinder close to the formula', () => {
    const p = meshProperties(cylinder(10, 30, 256));
    expect(p.volume).toBeCloseTo(Math.PI * 100 * 30, -1);
    expect(p.centroid[2]).toBeCloseTo(15, 3);
    expect(p.unit[2]).toBeCloseTo(100 / 2, 0);
    expect(p.unit[0]).toBeCloseTo((3 * 100 + 900) / 12, 0);
  });

  it('comes out the same for an inside-out mesh', () => {
    const b = box(10, 10, 10);
    const flipped = { positions: b.positions, triangles: b.triangles.slice() };
    for (let i = 0; i < flipped.triangles.length; i += 3) [flipped.triangles[i + 1], flipped.triangles[i + 2]] = [b.triangles[i + 2], b.triangles[i + 1]];
    const p = meshProperties(flipped);
    expect(p.volume).toBeCloseTo(1000, 3);
    expect(p.unit[0]).toBeCloseTo(200 / 12, 3);
  });

  it('gives no volume for an open mesh', () => {
    const p = meshProperties({ positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), triangles: new Uint32Array([0, 1, 2]) });
    expect(p.volume).toBe(0);
    expect(p.area).toBeCloseTo(50, 6);
  });
});

describe('massOf', () => {
  const props = { volume: 10000, area: 2000 };
  it('weighs a solid material by density', () => {
    expect(massOf({ kind: 'material', material: 'steel', infill: 100, shell: 1.2 }, props)).toBeCloseTo(78.5, 6);
  });
  it('weighs a printed part by shell and infill', () => {
    // Shell 2000 × 1.2 = 2400 mm³ solid, the remaining 7600 at 20%.
    expect(massOf({ kind: 'material', material: 'pla', infill: 20, shell: 1.2 }, props)).toBeCloseTo(0.00124 * (2400 + 0.2 * 7600), 6);
    // Solid infill is the full volume.
    expect(massOf({ kind: 'material', material: 'pla', infill: 100, shell: 1.2 }, props)).toBeCloseTo(12.4, 6);
    // A shell thicker than the part is just the part.
    expect(massOf({ kind: 'material', material: 'pla', infill: 0, shell: 100 }, props)).toBeCloseTo(12.4, 6);
  });
  it('takes a weighed mass as it is', () => {
    expect(massOf({ kind: 'measured', grams: 42 }, props)).toBe(42);
  });
});

describe('plausibleInertia', () => {
  it('accepts a real body and rejects an impossible one', () => {
    expect(plausibleInertia(tensorOf(5, meshProperties(box(20, 30, 40)).unit))).toBe(true);
    expect(plausibleInertia([1, 1, 5, 0, 0, 0])).toBe(false);
    expect(plausibleInertia([0, 1, 1, 0, 0, 0])).toBe(false);
    expect(plausibleInertia([1, 1, 1, 0.9, 0.9, 0.9])).toBe(false);
  });
});

describe('principalMoments', () => {
  it('finds the eigenvalues of a tensor with products of inertia', () => {
    const sorted = principalMoments([1, 1, 1, 0.9, 0.9, 0.9]).sort((a, b) => a - b);
    expect(sorted[0]).toBeCloseTo(0.1, 9);
    expect(sorted[1]).toBeCloseTo(0.1, 9);
    expect(sorted[2]).toBeCloseTo(2.8, 9);
    expect(principalMoments([3, 2, 1, 0, 0, 0]).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
