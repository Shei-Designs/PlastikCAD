import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../evaluate';
import { selfIntersects, signedArea } from '../math2d';
import { QUALITY } from '../types';
import type { Polygon } from '../types';
import { FAMILIES, extrusion, profile } from './extrusion';
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

describe('aluminium extrusion', () => {
  it('is a 20 mm V-Slot cell with four slots and a bore by default', () => {
    const pr = profile(params(), q);
    expect(pr.family).toBe(FAMILIES.vslot20);
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
    expect(Object.keys(defaultParams(extrusion))).not.toContain('length');
  });

  it('follows the V-Slot drawing: 6 mm between the lip tips, 45° V, 12 mm channel, 9 mm core 5.5 under the face', () => {
    const pr = profile(params(), q);
    // The notch through the top lips, read off the outline: tips 6 apart, chamfered 1.1 at 45° to the surface.
    const top = pr.outline.filter(([, y]) => y > 9.9 - 1.5 - 1e-9 && y < 10 + 1e-9 && Math.abs(signedArea([[0, 0]])) === 0);
    const tips = top.filter(([, y]) => Math.abs(y - (10 - 1.5)) < 1e-9).map(([x]) => x);
    expect(Math.max(...tips) - Math.min(...tips)).toBeCloseTo(6, 9);
    const mouth = top.filter(([, y]) => Math.abs(y - 10) < 1e-9 && Math.abs(signedArea(pr.outline)) > 0).map(([x]) => x);
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

  it('matches the catalogue sectional areas for every standard', () => {
    for (const [family, f] of Object.entries(FAMILIES)) {
      const pr = profile(params({ family }), q);
      expect(Math.abs(pr.area - f.catalogueArea) / f.catalogueArea, family).toBeLessThan(0.08);
      expect(sectionArea({ family }), family).toBeCloseTo(pr.area, 3);
      expect(extrusion.build(params({ family }), q).warnings).toEqual([]);
    }
    // Misumi list the 2040 at 324 mm².
    expect(Math.abs(profile(params({ family: 'hfs5', up: 2 }), q).area - 324) / 324).toBeLessThan(0.02);
  });

  it('makes a 2040 with six slots, two bores and one hollow between the cells', () => {
    const pr = profile(params({ family: 'hfs5', across: 2 }), q);
    expect([pr.width, pr.height]).toEqual([40, 20]);
    expect(pr.mouths).toHaveLength(6);
    expect(pr.bores).toHaveLength(2);
    // Six channels and the octagon between the cores, which reaches the skin through a short neck.
    expect(pr.voids).toHaveLength(7);
    const hollow = pr.voids.find((v) => v.length === 8)!;
    expect(minY(hollow)).toBeCloseTo(-8, 9);
    expect(maxY(hollow)).toBeCloseTo(8, 9);
    // Its sides are the cores' faces, 6 either side of the junction, exposed up to a web's width from their corners.
    const sides = hollow.filter(([x]) => Math.abs(Math.abs(x) - 6) < 1e-9);
    expect(sides).toHaveLength(4);
    for (const [, y] of sides) expect(Math.abs(y)).toBeCloseTo(10 - 6 - 1.5 / Math.SQRT2, 9);
    expect(sectionArea({ family: 'hfs5', across: 2 })).toBeLessThan(2 * sectionArea({ family: 'hfs5' }));
  });

  it('leaves the middle of a 2×2 open, with the cores’ corners on it', () => {
    const four = profile(params({ family: 'hfs5', across: 2, up: 2 }), q);
    expect(four.mouths).toHaveLength(8);
    expect(four.bores).toHaveLength(4);
    // Eight channels, four hollows and the 12 mm square between the cores; nothing crosses the centre.
    expect(four.voids).toHaveLength(13);
    const centre = four.voids.find((v) => v.every(([x, y]) => Math.abs(x) <= 6 + 1e-9 && Math.abs(y) <= 6 + 1e-9))!;
    expect(signedArea(centre)).toBeCloseTo(144, 9);
    const touching = four.voids.filter((v) => v !== centre && v.some(([x, y]) => Math.abs(Math.abs(x) - 6) < 1e-9 || Math.abs(Math.abs(y) - 6) < 1e-9));
    expect(touching).toHaveLength(4);
    const m = evaluate(extrusion.build(params({ family: 'hfs5', across: 2, up: 2 }), q).solid);
    expect(m.stats.max[0] - m.stats.min[0]).toBeCloseTo(40, 6);
    expect(m.stats.volume / 20).toBeCloseTo(four.area, 3);
    // The same for the V-Slot, whose hollows open at 45° onto the cores' sides.
    const v = profile(params({ across: 2, up: 2 }), q);
    expect(v.voids).toHaveLength(13);
    expect(evaluate(extrusion.build(params({ across: 2, up: 2 }), q).solid).stats.volume / 20).toBeCloseTo(v.area, 3);
  });

  it('puts the corner holes and hollows where the drawings do', () => {
    const hfs6 = profile(params({ family: 'hfs6' }), q);
    expect(hfs6.cavities).toHaveLength(4);
    expect(hfs6.cavities[0].some(([x, y]) => Math.abs(Math.hypot(x + (15 - 3.4), y + (15 - 3.4)) - 2.1) < 1e-9)).toBe(true);
    const hfs8 = profile(params({ family: 'hfs8', across: 2 }), q);
    expect(hfs8.cavities).toHaveLength(4);
    expect(Math.max(...hfs8.cavities.map(maxX))).toBeCloseTo(40 - 2, 9);
    expect(profile(params({ family: 'tslot30' }), q).cavities).toHaveLength(4);
    expect(profile(params({ family: 'tslot20' }), q).cavities).toHaveLength(0);
  });

  it('shrinks the slots and grows the outside with clearance', () => {
    const loose = profile(params({ clearance: 0.3 }), q);
    expect(loose.width).toBeCloseTo(20.6, 9);
    expect(selfIntersects(loose.outline)).toBe(false);
    expect(evaluate(extrusion.build(params({ clearance: 0.3 }), q).solid).stats.max[0]).toBeCloseTo(10.3, 6);
    const tips = loose.outline.filter(([, y]) => Math.abs(y - (10.3 - 1.5 - 0.6)) < 1e-9).map(([x]) => x);
    expect(Math.max(...tips) - Math.min(...tips)).toBeCloseTo(6 - 0.6, 9);
    expect(sectionArea({ clearance: 0.3 })).toBeGreaterThan(sectionArea());
  });

  it('can do without the bores', () => {
    expect(profile(params({ bores: false }), q).bores).toHaveLength(0);
    expect(extrusion.build(params({ bores: false }), q).info.find((i) => i.label === 'Centre bore')?.value).toBe('none');
    expect(extrusion.build(params({ family: 'tslot40', up: 2 }), q).info.find((i) => i.label === 'Profile')?.value).toContain('40 × 80');
  });
});
