import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../evaluate';
import { selfIntersects, signedArea } from '../math2d';
import { QUALITY } from '../types';
import type { Polygon } from '../types';
import { SIZES, extrusion, profile } from './extrusion';
import { defaultParams } from './types';
import type { Params } from './types';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.normal;
const params = (over: Params = {}): Params => ({ ...defaultParams(extrusion), ...over });
const sectionArea = (over: Params = {}) => evaluate(extrusion.build(params(over), q).solid).stats.volume / 20;
const maxX = (poly: Polygon) => Math.max(...poly.map(([x]) => x));
const maxY = (poly: Polygon) => Math.max(...poly.map(([, y]) => y));
const minY = (poly: Polygon) => Math.min(...poly.map(([, y]) => y));

describe('aluminum extrusion', () => {
  it('is a 20 mm V-slot cell with four slots and a bore by default', () => {
    const pr = profile(params(), q);
    expect(pr.size).toBe(SIZES['20']);
    expect([pr.width, pr.height]).toEqual([20, 20]);
    expect(pr.mouths).toHaveLength(4);
    expect(pr.bores).toHaveLength(1);
    expect(pr.cavities).toHaveLength(0);
    // Four channels, each a convex hexagon wound the right way.
    expect(pr.voids).toHaveLength(4);
    for (const v of pr.voids) {
      expect(v).toHaveLength(6);
      expect(signedArea(v)).toBeGreaterThan(0);
      expect(selfIntersects(v)).toBe(false);
    }
    expect(signedArea(pr.outline)).toBeGreaterThan(0);
    expect(selfIntersects(pr.outline)).toBe(false);
    expect(Object.keys(defaultParams(extrusion))).toEqual(['size', 'style', 'cells', 'double', 'bores']);
  });

  it('follows the V-Slot drawing: 6 mm between the lip tips, 45° V, 12 mm channel, 9 mm core 5.5 under the face', () => {
    const pr = profile(params(), q);
    // The notch through the top lips, read off the outline: tips 6 apart, chamfered 1.1 at 45° to the surface.
    const tips = pr.outline.filter(([, y]) => Math.abs(y - (10 - 1.5)) < 1e-9).map(([x]) => x);
    expect(Math.max(...tips) - Math.min(...tips)).toBeCloseTo(6, 9);
    const mouth = pr.outline.filter(([, y]) => Math.abs(y - 10) < 1e-9).map(([x]) => x);
    expect(mouth.some((x) => Math.abs(x - (3 + 1.1)) < 1e-9)).toBe(true);
    // The channel behind the top lips: 12 wide, straight walls down to the taper, floor on the core's top 5.5 under the face.
    const channel = pr.voids.find((v) => minY(v) > 0 && maxY(v) > 8)!;
    expect(maxY(channel)).toBeCloseTo(10 - 1.5, 9);
    expect(minY(channel)).toBeCloseTo(10 - 5.5, 9);
    expect(maxX(channel)).toBeCloseTo(6, 9);
    // The floor is 45° in from the walls, leaving a 1.5 mm web beside the next slot's taper.
    const floor = channel.filter(([, y]) => Math.abs(y - 4.5) < 1e-9).map(([x]) => x);
    expect(Math.max(...floor)).toBeCloseTo(10 - 5.5 - 1.5 / Math.SQRT2, 9);
    expect(pr.bores[0].some(([x, y]) => Math.abs(Math.hypot(x, y) - 2.75) < 1e-9)).toBe(true);
  });

  it('makes a T-slot from the same section by squaring the lips', () => {
    const t = profile(params({ style: 't' }), q);
    const mouth = t.outline.filter(([, y]) => Math.abs(y - 10) < 1e-9).map(([x]) => Math.abs(x));
    expect(Math.min(...mouth)).toBeCloseTo(3, 9);
    expect(t.voids.map((v) => signedArea(v))).toEqual(profile(params(), q).voids.map((v) => signedArea(v)));
    expect(sectionArea({ style: 't' })).toBeGreaterThan(sectionArea());
    expect(extrusion.build(params({ style: 't' }), q).info.find((i) => i.label === 'Slot')?.value).toMatch(/^T/);
  });

  it('extrudes to a watertight 20 mm stub with rounded corners', () => {
    const r = extrusion.build(params(), q);
    const m = evaluate(r.solid);
    expect(m.stats.max[2] - m.stats.min[2]).toBeCloseTo(20, 6);
    expect(m.stats.max[0] - m.stats.min[0]).toBeCloseTo(20, 6);
    expect(m.stats.max[1] - m.stats.min[1]).toBeCloseTo(20, 6);
    expect(r.warnings).toEqual([]);
    // R2 corners: the outline never reaches the actual corner point.
    expect(Math.max(...profile(params(), q).outline.map(([x, y]) => Math.abs(x) + Math.abs(y)))).toBeLessThan(20 - 2 * (2 - Math.SQRT2) + 1e-6);
  });

  it('matches the catalog sectional areas for every size', () => {
    for (const [size, s] of Object.entries(SIZES)) {
      const style = size === '20' ? 'v' : 't';
      const pr = profile(params({ size, style }), q);
      expect(Math.abs(pr.area - s.catalogueArea) / s.catalogueArea, size).toBeLessThan(0.04);
      expect(sectionArea({ size, style }), size).toBeCloseTo(pr.area, 3);
      for (const st of ['v', 't']) expect(extrusion.build(params({ size, style: st }), q).warnings).toEqual([]);
    }
  });

  it('makes a 2040 with six slots, two bores and one hollow between the cells', () => {
    const pr = profile(params({ cells: 2 }), q);
    expect([pr.width, pr.height]).toEqual([40, 20]);
    expect(pr.mouths).toHaveLength(6);
    expect(pr.bores).toHaveLength(2);
    // Six channels and the hollow between the cores, which reaches the skin through a 4.6 mm neck.
    expect(pr.voids).toHaveLength(7);
    const hollow = pr.voids.find((v) => v.length === 12)!;
    expect(minY(hollow)).toBeCloseTo(-8.5, 9);
    expect(maxY(hollow)).toBeCloseTo(8.5, 9);
    expect(hollow.filter(([, y]) => Math.abs(y) > 8).map(([x]) => Math.abs(x))).toEqual([2.3, 2.3, 2.3, 2.3]);
    // Its sides are the cores' faces, 5.5 either side of the junction.
    expect(hollow.filter(([x]) => Math.abs(Math.abs(x) - 5.5) < 1e-9)).toHaveLength(4);
    expect(sectionArea({ cells: 2 })).toBeLessThan(2 * sectionArea());
    expect(extrusion.build(params({ cells: 1, double: true }), q).info.find((i) => i.label === 'Profile')?.value).toContain('4020: 20 × 40');
    expect(extrusion.build(params({ cells: 2 }), q).info.find((i) => i.label === 'Profile')?.value).toContain('2040: 40 × 20');
  });

  it('leaves the middle of a 2×2 open, with the cores’ corners rounded off', () => {
    const four = profile(params({ cells: 2, double: true }), q);
    expect([four.width, four.height]).toEqual([40, 40]);
    expect(four.mouths).toHaveLength(8);
    expect(four.bores).toHaveLength(4);
    // Eight channels, four hollows, the 11 mm square middle and four fillets; nothing crosses the center.
    expect(four.voids).toHaveLength(17);
    const middle = four.voids.find((v) => v.length === 4 && v.every(([x, y]) => Math.abs(x) < 6 && Math.abs(y) < 6))!;
    expect(signedArea(middle)).toBeCloseTo(121, 9);
    // Each fillet is what a 1.5 mm arc takes off a core's corner, between the two hollows that meet there.
    const fillets = four.voids.filter((v) => Math.abs(signedArea(v)) < 1 && v.every(([x, y]) => Math.abs(x) >= 5.5 - 1e-9 && Math.abs(y) >= 5.5 - 1e-9 && Math.abs(x) <= 7 + 1e-9 && Math.abs(y) <= 7 + 1e-9));
    expect(fillets).toHaveLength(4);
    for (const f of fillets) expect(signedArea(f)).toBeCloseTo(1.5 * 1.5 * (1 - Math.PI / 4), 1);
    // The hollows run straight onto the cores' corners: their open ends are flat cuts at ±5.5.
    const arms = four.voids.filter((v) => v.length === 8 && signedArea(v) > 10 && v.some(([x, y]) => Math.abs(Math.abs(x) - 5.5) < 1e-9 && Math.abs(Math.abs(y) - 5.5) < 1e-9));
    expect(arms).toHaveLength(4);
    const m = evaluate(extrusion.build(params({ cells: 2, double: true }), q).solid);
    expect(m.stats.max[0] - m.stats.min[0]).toBeCloseTo(40, 6);
    expect(m.stats.volume / 20).toBeCloseTo(four.area, 3);
    // The same for the T-slot sizes, whose hollows are octagons.
    const t = profile(params({ size: '30', style: 't', cells: 2, double: true }), q);
    expect(t.voids).toHaveLength(17);
    expect(evaluate(extrusion.build(params({ size: '30', style: 't', cells: 2, double: true }), q).solid).stats.volume / 20).toBeCloseTo(t.area, 3);
  });

  it('walls the inner cells of a two-row bar of three or four', () => {
    const three = profile(params({ cells: 3, double: true }), q);
    expect([three.width, three.height]).toEqual([60, 40]);
    // The hollow between the middle column's stacked cores is narrowed by a wall down each side,
    // flush with the cores' faces: 9 wide between the cores, 6 between the walls.
    const between = three.voids.find((v) => v.length === 4 && v.every(([x, y]) => Math.abs(x) < 5 && Math.abs(y) < 6))!;
    expect(signedArea(between)).toBeCloseTo((9 - 2 * 1.5) * 11, 9);
    expect(maxX(between)).toBeCloseTo(4.5 - 1.5, 9);
    // The open middles either side keep their full 11 mm, filleted only on the outer corners.
    const middles = three.voids.filter((v) => v.length === 4 && Math.abs(signedArea(v) - 121) < 1e-9);
    expect(middles).toHaveLength(2);
    expect(maxX(middles.find((v) => maxX(v) < 0)!)).toBeCloseTo(-10 + 5.5, 9);
    const fillets = three.voids.filter((v) => Math.abs(signedArea(v)) < 1);
    expect(fillets).toHaveLength(4);
    expect(fillets.every((f) => f.every(([x]) => Math.abs(x) > 10))).toBe(true);
    // A 2×4 has two inner columns, each walled, and the middle between them with no fillets at all.
    const fourWide = profile(params({ cells: 4, double: true }), q);
    const narrowed = fourWide.voids.filter((v) => v.length === 4 && Math.abs(signedArea(v) - 6 * 11) < 1e-9);
    expect(narrowed).toHaveLength(2);
    expect(fourWide.voids.filter((v) => Math.abs(signedArea(v)) < 1)).toHaveLength(4);
    expect(evaluate(extrusion.build(params({ cells: 4, double: true }), q).solid).stats.volume / 20).toBeCloseTo(fourWide.area, 3);
    // A single row never gets walls.
    expect(profile(params({ cells: 4 }), q).voids.filter((v) => v.length === 4)).toHaveLength(0);
  });

  it('puts the corner holes and hollows where the drawings do', () => {
    const thirty = profile(params({ size: '30' }), q);
    expect(thirty.cavities).toHaveLength(4);
    expect(thirty.cavities[0].some(([x, y]) => Math.abs(Math.hypot(x + (15 - 3.4), y + (15 - 3.4)) - 2.1) < 1e-9)).toBe(true);
    const forty = profile(params({ size: '40', cells: 2 }), q);
    expect(forty.cavities).toHaveLength(4);
    expect(Math.max(...forty.cavities.map(maxX))).toBeCloseTo(40 - 2, 9);
  });

  it('can do without the bores', () => {
    expect(profile(params({ bores: false }), q).bores).toHaveLength(0);
    expect(extrusion.build(params({ bores: false }), q).info.find((i) => i.label === 'Center bore')?.value).toBe('none');
  });
});
