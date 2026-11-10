import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { QUALITY } from '../types';
import { DUCTS, elbow, pipe, reducer, tee } from './ducts';
import { defaultParams } from './types';
import type { GeneratorDef, Params } from './types';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.normal;
const params = (def: GeneratorDef, over: Params = {}): Params => ({ ...defaultParams(def), ...over });
const made = (def: GeneratorDef, over: Params = {}) => {
  const r = def.build(params(def, over), q);
  return { ...r, stats: evaluate(r.solid).stats };
};
const extent = (s: { min: number[]; max: number[] }, axis: number) => s.max[axis] - s.min[axis];
/** Area of a hollow round section at the lofted polygon's resolution. */
const annulus = (d: number, wall: number) => (Math.PI / 4) * (d * d - (d - 2 * wall) * (d - 2 * wall));

describe('pipes and ducts', () => {
  it('builds every kind watertight with its defaults', () => {
    for (const def of DUCTS) {
      const r = made(def);
      expect(r.stats.volume, def.id).toBeGreaterThan(0);
      expect(r.warnings, def.id).toEqual([]);
      const rect = made(def, { section: 'rect' });
      expect(rect.stats.volume, def.id).toBeGreaterThan(0);
      const solid = made(def, { wall: 0 });
      expect(solid.stats.volume, def.id).toBeGreaterThan(r.stats.volume);
    }
  });

  it('makes a straight pipe of the right size and wall', () => {
    const r = made(pipe, { diameter: 25, wall: 2, length: 40 });
    expect(extent(r.stats, 2)).toBeCloseTo(40, 6);
    expect(extent(r.stats, 0)).toBeCloseTo(25, 1);
    expect(r.stats.volume).toBeCloseTo(annulus(25, 2) * 40, -1);
    expect(r.stats.volume / (annulus(25, 2) * 40)).toBeGreaterThan(0.99);
    // A rectangular duct with sharp corners is exact.
    const d = made(pipe, { section: 'rect', width: 50, height: 30, corner: 0, wall: 2, length: 40 });
    expect(d.stats.volume).toBeCloseTo((50 * 30 - 46 * 26) * 40, 6);
    expect(extent(d.stats, 0)).toBeCloseTo(50, 6);
    expect(extent(d.stats, 1)).toBeCloseTo(30, 6);
    // Rounded corners take a little off each corner.
    const rounded = made(pipe, { section: 'rect', width: 50, height: 30, corner: 5, wall: 0, length: 40 });
    expect(rounded.stats.volume).toBeLessThan(50 * 30 * 40);
    expect(rounded.stats.volume).toBeGreaterThan((50 * 30 - 25 * (4 - Math.PI)) * 40 * 0.995);
    expect(r.info.find((i) => i.label === 'Inside')?.value).toBe('Ø21.0 mm');
  });

  it('bends an elbow round a true arc, legs included', () => {
    const r = made(elbow, { diameter: 25, wall: 2, angle: 90, bendRadius: 30, legA: 10, legB: 10 });
    expect(r.warnings).toEqual([]);
    const centerLine = 10 + 10 + (Math.PI / 2) * 30;
    expect(r.stats.volume / (annulus(25, 2) * centerLine)).toBeGreaterThan(0.985);
    expect(r.stats.volume / (annulus(25, 2) * centerLine)).toBeLessThan(1.005);
    // Up 10 + 30, and across 30 + 10, plus half the diameter either way.
    expect(extent(r.stats, 2)).toBeCloseTo(10 + 30 + 12.5, 1);
    expect(extent(r.stats, 0)).toBeCloseTo(12.5 + 30 + 10, 1);
    expect(extent(r.stats, 1)).toBeCloseTo(25, 1);
    // A U-bend and a slight kink both work; a square duct bends in the plane of its width.
    expect(made(elbow, { angle: 180, legA: 0, legB: 0 }).stats.volume).toBeGreaterThan(0);
    expect(made(elbow, { angle: 5 }).stats.volume).toBeGreaterThan(0);
    const duct = made(elbow, { section: 'rect', width: 50, height: 30, bendRadius: 40, legA: 0, legB: 0 });
    expect(extent(duct.stats, 1)).toBeCloseTo(30, 6);
    expect(extent(duct.stats, 0)).toBeCloseTo(40 + 25, 1);
  });

  it('refuses a bend tighter than the pipe and a wall thicker than the bore', () => {
    const tight = made(elbow, { diameter: 25, bendRadius: 5 });
    expect(tight.warnings).toHaveLength(1);
    expect(tight.warnings[0]).toMatch(/bend radius was raised/);
    expect(tight.stats.volume).toBeGreaterThan(0);
    expect(tight.info.find((i) => i.label === 'Bend radius')?.value).toBe('12.7 mm');
    const thick = made(pipe, { diameter: 10, wall: 6 });
    expect(thick.warnings[0]).toMatch(/thinned/);
    expect(thick.stats.volume).toBeLessThan((Math.PI / 4) * 100 * 40);
  });

  it('tapers a reducer between its two ends, in line or offset', () => {
    const r = made(reducer, { diameter: 25, diameter2: 16, wall: 0, length: 40 });
    // A frustum.
    const frustum = (Math.PI * 40 * (12.5 * 12.5 + 12.5 * 8 + 8 * 8)) / 3;
    expect(r.stats.volume / frustum).toBeGreaterThan(0.99);
    expect(r.stats.volume / frustum).toBeLessThan(1.001);
    expect(extent(r.stats, 0)).toBeCloseTo(25, 1);
    const hollow = made(reducer, { diameter: 25, diameter2: 16, wall: 2, length: 40 });
    expect(hollow.stats.volume).toBeLessThan(r.stats.volume);
    expect(hollow.stats.volume).toBeGreaterThan(0);
    // Offset keeps one side flat: the box spans the larger end plus the shift.
    const ecc = made(reducer, { diameter: 25, diameter2: 16, offset: 4.5, wall: 0 });
    expect(ecc.stats.max[0] - ecc.stats.min[0]).toBeCloseTo(25, 1);
    expect(ecc.stats.volume).toBeCloseTo(r.stats.volume, 0);
    // Rectangular ducts can change aspect.
    const duct = made(reducer, { section: 'rect', width: 50, height: 30, width2: 30, height2: 20, corner: 0, wall: 0, length: 40 });
    expect(duct.stats.volume).toBeGreaterThan(30 * 20 * 40);
    expect(duct.stats.volume).toBeLessThan(50 * 30 * 40);
    expect(duct.info.find((i) => i.label === 'Ratio')?.value).toBe('1.67 : 1');
  });

  it('branches a tee off the run, square or leaning', () => {
    const run = made(pipe, { length: 60, diameter: 25, wall: 2 });
    const t = made(tee, { length: 60, diameter: 25, diameter2: 25, wall: 2, branchLength: 25, branchAngle: 90 });
    expect(t.stats.volume).toBeGreaterThan(run.stats.volume);
    expect(extent(t.stats, 0)).toBeCloseTo(60, 6);
    expect(extent(t.stats, 2)).toBeCloseTo(12.5 + 12.5 + 25, 1);
    // The branch bore breaks into the run bore: less metal than run plus a closed branch.
    const closedBranch = annulus(25, 2) * 25 + (Math.PI / 4) * 21 * 21 * 12.5;
    expect(t.stats.volume).toBeLessThan(run.stats.volume + closedBranch);
    const wye = made(tee, { branchAngle: 45 });
    expect(wye.stats.volume).toBeGreaterThan(0);
    expect(wye.stats.max[0]).toBeGreaterThan(t.stats.max[0]);
    const duct = made(tee, { section: 'rect', width2: 30, height2: 20 });
    expect(duct.stats.volume).toBeGreaterThan(0);
    expect(duct.warnings).toEqual([]);
  });
});
