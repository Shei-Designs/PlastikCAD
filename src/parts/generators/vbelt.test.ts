import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { QUALITY } from '../types';
import { defaultParams } from './types';
import type { BuildResult, Params } from './types';
import { vBeltPulley } from './vbelt';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.fine;
const made = (over: Params = {}): BuildResult => vBeltPulley.build({ ...defaultParams(vBeltPulley), boreType: 'none', ...over }, q);
/** A figure of the part's info, as a number ("64.00 mm", "34°"). */
const info = (r: BuildResult, label: string): number => parseFloat(r.info.find((i) => i.label === label)?.value ?? '');

/** What a pulley of these figures holds, by Pappus: the disc, less each groove's section turned about the axis at its own middle. */
function volume(rim: number, width: number, grooves: number, top: number, floor: number, depth: number): number {
  const area = (top + floor) * depth;
  // The middle of a trapezoid lies nearer its wide side, which is at the rim.
  const down = (depth * (2 * floor + top)) / (3 * (floor + top));
  return Math.PI * rim * rim * width - grooves * area * 2 * Math.PI * (rim - down);
}

describe('V-belt pulley', () => {
  it('has the rim, the width and the groove the standard gives a Z section', () => {
    const r = made();
    expect(r.warnings).toEqual([]);
    // 60 at the datum, 2 above it to the rim; 8 from each side to the middle of the one groove.
    expect(info(r, 'Outside diameter')).toBe(64);
    expect(info(r, 'Width')).toBe(16);
    expect(info(r, 'Groove angle')).toBe(34);
    const { stats } = evaluate(r.solid);
    expect(stats.max[0] - stats.min[0]).toBeCloseTo(64, 2);
    expect(stats.max[2] - stats.min[2]).toBeCloseTo(16, 6);
    // 8.5 wide at the datum, flanks 17° off the middle: 9.72 at the rim, 4.22 at the floor 9 below it.
    const slope = Math.tan((17 * Math.PI) / 180);
    const expected = volume(32, 16, 1, 4.25 + 2 * slope, 4.25 - 7 * slope, 9);
    expect(stats.volume / expected).toBeGreaterThan(0.995);
    expect(stats.volume / expected).toBeLessThanOrEqual(1.0001);
  });

  it('opens the groove to 38° on a large pulley, or to the angle asked for', () => {
    expect(info(made({ diameter: 80 }), 'Groove angle')).toBe(34);
    expect(info(made({ diameter: 81 }), 'Groove angle')).toBe(38);
    expect(info(made({ section: 'B', diameter: 190 }), 'Groove angle')).toBe(34);
    expect(info(made({ section: 'B', diameter: 200 }), 'Groove angle')).toBe(38);
    expect(info(made({ diameter: 60, grooveAngle: '36' }), 'Groove angle')).toBe(36);
    // The groove keeps its width at the datum: opened wider it is wider above and narrower below, where most of it is.
    expect(evaluate(made({ grooveAngle: '38' }).solid).stats.volume).toBeGreaterThan(evaluate(made({ grooveAngle: '34' }).solid).stats.volume);
  });

  it('takes several belts side by side, and the deeper groove of a narrow section', () => {
    const three = made({ section: 'A', diameter: 100, grooves: 3 });
    // 15 from groove to groove, 10 from each side.
    expect(info(three, 'Width')).toBe(50);
    expect(info(three, 'Outside diameter')).toBe(105.5);
    const wide = evaluate(three.solid).stats;
    expect(wide.max[2] - wide.min[2]).toBeCloseTo(50, 6);
    // SPA has the A section's groove at the rim, cut 2.3 mm deeper.
    expect(evaluate(made({ section: 'SPA', diameter: 100 }).solid).stats.volume).toBeLessThan(evaluate(made({ section: 'A', diameter: 100 }).solid).stats.volume);
    for (const section of ['Z', 'A', 'B', 'C', 'SPZ', 'SPA', 'SPB', 'SPC']) {
      // Every section builds (the kernel makes nothing that is not closed), and has material left under its grooves.
      expect(evaluate(made({ section, diameter: 250, grooves: 2 }).solid).stats.volume, section).toBeGreaterThan(0);
    }
  });

  it('says so when the bore leaves too little under the grooves, and carries a hub', () => {
    expect(made({ boreType: 'round', boreDiameter: 8 }).warnings).toEqual([]);
    expect(made({ diameter: 30, boreType: 'round', boreDiameter: 14 }).warnings).toEqual(['The bore leaves less than 1 mm of material below the belt grooves.']);
    const hubbed = made({ hubHeight: 10, hubDiameter: 24, boreType: 'round', boreDiameter: 8 });
    expect(info(hubbed, 'Total height')).toBe(26);
    const tall = evaluate(hubbed.solid).stats;
    expect(tall.max[2] - tall.min[2]).toBeCloseTo(26, 6);
  });
});
