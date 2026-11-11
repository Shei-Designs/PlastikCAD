import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { circle, signedArea } from '../math2d';
import { QUALITY, extrude } from '../types';
import type { Polygon, Solid } from '../types';
import { CUTOUT_LENGTH } from './cutouts';
import { FANS, fan, fanOpenings } from './fans';
import type { FanPattern } from './fans';
import { defaultParams } from './types';
import type { Params } from './types';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.normal;
const made = (over: Params = {}) => {
  const r = fan.build({ ...defaultParams(fan), ...over }, q);
  return { ...r, stats: evaluate(r.solid).stats };
};
const extent = (s: { min: number[]; max: number[] }, axis: number) => s.max[axis] - s.min[axis];
const disc = (d: number) => (Math.PI / 4) * d * d;
const PATTERNS: FanPattern[] = ['open', 'rings', 'slots', 'honeycomb', 'grid'];
const farthest = (poly: Polygon) => Math.max(...poly.map(([x, y]) => Math.hypot(x, y)));

describe('fans', () => {
  it('builds every size in every form and pattern', () => {
    for (const f of FANS) {
      for (const form of ['holes', 'body']) expect(made({ size: String(f.size), form }).stats.volume, `${f.size} ${form}`).toBeGreaterThan(0);
      for (const pattern of PATTERNS) for (const form of ['cutout', 'grill']) expect(made({ size: String(f.size), form, pattern }).stats.volume, `${f.size} ${form} ${pattern}`).toBeGreaterThan(0);
    }
    expect(fan.build(defaultParams(fan), q).outline?.length).toBeGreaterThan(0);
  });

  it('cuts the opening with four holes, lying flat and centered on the wall', () => {
    const f80 = FANS.find((f) => f.size === 80)!;
    const L = CUTOUT_LENGTH;
    const round = made({ size: '80', form: 'cutout', pattern: 'open', clearance: 0 });
    expect(extent(round.stats, 0)).toBeCloseTo(Math.max(f80.opening, f80.spacing + f80.hole), 2);
    expect(extent(round.stats, 2)).toBeCloseTo(L, 6);
    expect(round.stats.volume).toBeCloseTo((disc(f80.opening) + 4 * disc(f80.hole)) * L, -3);
    const holesOnly = made({ size: '80', form: 'holes', clearance: 0 });
    expect(holesOnly.stats.volume).toBeCloseTo(4 * disc(f80.hole) * L, -1);
    // The clearance grows the opening and every hole.
    const grown = made({ size: '80', form: 'cutout', pattern: 'open', clearance: 0.5 });
    expect(grown.stats.volume).toBeCloseTo((disc(f80.opening + 1) + 4 * disc(f80.hole + 1)) * L, -3);
    expect(round.stats.min[2]).toBeCloseTo(-L / 2, 6);
  });

  it('keeps every pattern inside the circle, with bars between the openings', () => {
    const R = 39;
    for (const pattern of PATTERNS.filter((p) => p !== 'open')) {
      const openings = fanOpenings(pattern, R, 2, 6, 4, q);
      expect(openings.length, pattern).toBeGreaterThan(3);
      const open = openings.reduce((a, o) => a + signedArea(o), 0);
      // Every opening is CCW, inside the circle, and together they leave the bars behind.
      for (const o of openings) {
        expect(signedArea(o), pattern).toBeGreaterThan(0);
        expect(farthest(o), pattern).toBeLessThanOrEqual(R + 1e-6);
      }
      expect(open / (Math.PI * R * R), pattern).toBeGreaterThan(0.35);
      expect(open / (Math.PI * R * R), pattern).toBeLessThan(0.85);
      // Cut into a wall the pattern takes out exactly the openings' area.
      const cut = made({ size: '80', form: 'cutout', pattern, clearance: 0, bar: 2, gap: 6 });
      expect(cut.stats.volume, pattern).toBeCloseTo((open + 4 * disc(4.5)) * CUTOUT_LENGTH, -1);
    }
    // Rings: a wider bar leaves less open; more spokes too.
    const thin = fanOpenings('rings', R, 1, 6, 4, q).reduce((a, o) => a + signedArea(o), 0);
    const thick = fanOpenings('rings', R, 3, 6, 4, q).reduce((a, o) => a + signedArea(o), 0);
    const many = fanOpenings('rings', R, 1, 6, 8, q).reduce((a, o) => a + signedArea(o), 0);
    expect(thick).toBeLessThan(thin);
    expect(many).toBeLessThan(thin);
    // Rings with four spokes come as four sectors a ring: the 80 mm has six rings and a disc.
    expect(fanOpenings('rings', R, 2, 6, 4, q).length % 4).toBe(0);
    // Slots run across, horizontally: wider than they are tall.
    for (const s of fanOpenings('slots', R, 2, 6, 4, q)) {
      const xs = s.map((p) => p[0]);
      const ys = s.map((p) => p[1]);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(6, 6);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(6);
    }
  });

  it('makes a grill the size of the fan, a plate with the pattern and the screw holes', () => {
    const f120 = FANS.find((f) => f.size === 120)!;
    const grill = made({ size: '120', form: 'grill', pattern: 'honeycomb', clearance: 0.3, thickness: 2, rim: 3, bar: 2, gap: 6 });
    expect(extent(grill.stats, 0)).toBeCloseTo(120, 2);
    expect(extent(grill.stats, 1)).toBeCloseTo(120, 2);
    expect(extent(grill.stats, 2)).toBeCloseTo(2, 6);
    const R = 60 - 3;
    const open = fanOpenings('honeycomb', R, 2, 6, 4, q).reduce((a, o) => a + signedArea(o), 0);
    const plate = made({ size: '120', form: 'grill', pattern: 'open', clearance: 0.3, thickness: 2, rim: 3 });
    const clear = signedArea(fanOpenings('open', R, 2, 6, 4, q)[0]);
    expect(plate.stats.volume).toBeCloseTo((120 * 120 - (4 - Math.PI) * f120.corner ** 2 - Math.PI * R * R - 4 * disc(f120.hole + 0.6)) * 2, -2);
    expect(plate.stats.volume - grill.stats.volume).toBeCloseTo((open - clear) * 2, -1);
    expect(grill.warnings).toEqual([]);
    expect(plate.warnings).toEqual([]);
    // Without the screw holes and with square corners the plate is a full square less the opening.
    const square = made({ size: '120', form: 'grill', pattern: 'open', clearance: 0.3, thickness: 2, rim: 3, grillHoles: false, grillCorners: false });
    expect(square.stats.volume).toBeCloseTo((120 * 120 - clear) * 2, -1);
    expect(square.stats.volume).toBeGreaterThan(plate.stats.volume);
  });

  it('stands in for the fan itself: a frame the fan size and depth, bored through, with hub and blades inside', () => {
    const f40 = FANS.find((f) => f.size === 40)!;
    const body = made({ size: '40', form: 'body', clearance: 0 });
    expect(extent(body.stats, 0)).toBeCloseTo(40, 2);
    expect(extent(body.stats, 1)).toBeCloseTo(40, 2);
    expect(extent(body.stats, 2)).toBeCloseTo(f40.depth, 6);
    const frame = (40 * 40 - (4 - Math.PI) * f40.corner ** 2 - disc(f40.opening) - 4 * disc(f40.hole)) * f40.depth;
    expect(body.stats.volume).toBeGreaterThan(frame + disc(f40.hub) * (f40.depth - 2));
    expect(body.stats.volume).toBeLessThan(frame + disc(f40.opening) * f40.depth);
    const grown = made({ size: '40', form: 'body', clearance: 0.5 });
    expect(extent(grown.stats, 0)).toBeCloseTo(41, 2);
  });
});

describe('fan cutout with screw holes reaching into the opening', () => {
  it('cuts the overlap instead of leaving islands', () => {
    const f = FANS[0];
    const grow = 3;
    const r = made({ size: String(f.size), form: 'cutout', pattern: 'open', clearance: grow });
    const pieces: Solid[] = [extrude([circle(f.opening / 2 + grow, q.circle)], CUTOUT_LENGTH)];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) pieces.push(extrude([circle(f.hole / 2 + grow, q.circle, (sx * f.spacing) / 2, (sy * f.spacing) / 2)], CUTOUT_LENGTH));
    const union = evaluate({ op: 'union', children: pieces }).stats.volume;
    expect(r.stats.volume / union).toBeCloseTo(1, 2);
    // The holes do reach in: separate pieces would add up to more than the union.
    expect(pieces.reduce((a, s) => a + evaluate(s).stats.volume, 0)).toBeGreaterThan(union * 1.05);
  });
});
