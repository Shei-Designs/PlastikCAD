import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../evaluate';
import { cylinder, intersection, QUALITY, translate } from '../types';
import type { Quality, Solid } from '../types';
import { leadScrew, leadScrewNut, METRIC_SIZES, metricBolt, metricNut } from './screws';
import { defaultParams } from './types';
import type { GeneratorDef, Params } from './types';

const { draft, normal } = QUALITY;

beforeAll(async () => {
  await initKernel();
});

const build = (def: GeneratorDef, overrides: Params = {}, q: Quality = normal) =>
  def.build({ ...defaultParams(def), ...overrides }, q);

/** Volume of a solid that may legitimately be empty. */
function volume(solid: Solid): number {
  try {
    return evaluate(solid).stats.volume;
  } catch (e) {
    if (String(e).includes('empty')) return 0;
    throw e;
  }
}

/** Triangles in the twisted extrusions of a solid, which dominate the mesh size. */
function threadTriangles(solid: Solid): number {
  switch (solid.op) {
    case 'extrude':
      return solid.twist ? ((solid.divisions ?? 0) + 1) * solid.shape[0].length * 2 : 0;
    case 'union':
    case 'intersection':
    case 'difference':
      return solid.children.reduce((n, c) => n + threadTriangles(c), 0);
    case 'transform':
      return threadTriangles(solid.child);
    default:
      return 0;
  }
}

const info = (def: GeneratorDef, overrides: Params, label: string) => {
  const item = build(def, overrides).info.find((i) => i.label === label);
  if (!item) throw new Error(`no info item "${label}"`);
  return parseFloat(item.value);
};

describe('metric bolt', () => {
  it('builds every size and head type', () => {
    for (const size of METRIC_SIZES) {
      for (const head of ['hex', 'socket', 'none']) {
        const params = { size, head, length: 8 };
        const result = build(metricBolt, params, draft);
        const r = evaluate(result.solid);
        expect(result.warnings).toEqual([]);
        expect(r.stats.volume).toBeGreaterThan(0);
        expect(r.stats.min[2]).toBeCloseTo(0, 4);
        expect(r.stats.max[2]).toBeCloseTo(info(metricBolt, params, 'Total length'), 4);
      }
    }
  });

  it('M8 hex bolt has the standard head', () => {
    const r = evaluate(build(metricBolt, { length: 10 }).solid);
    expect(r.stats.max[2]).toBeCloseTo(5.3 + 10, 4);
    // a flat faces +X, a corner faces +Y
    expect(r.stats.max[0]).toBeCloseTo(6.5, 4);
    expect(r.stats.min[0]).toBeCloseTo(-6.5, 4);
    expect(r.stats.max[1]).toBeCloseTo(6.5 / Math.cos(Math.PI / 6), 4);
    expect(info(metricBolt, {}, 'Total length')).toBeCloseTo(35.3, 6);
    expect(info(metricBolt, {}, 'Across flats')).toBe(13);
  });

  it('socket cap head has a hex recess', () => {
    const solid = build(metricBolt, { head: 'socket', length: 10 }, draft).solid;
    const r = evaluate(solid);
    expect(r.stats.max[0]).toBeCloseTo(6.5, 1);
    expect(r.stats.max[2]).toBeCloseTo(8 + 10, 4);
    const plain = Math.PI * 6.5 ** 2 * 8;
    const headOnly = volume(intersection(solid, cylinder(20, 8, 32)));
    // recess: hex 6.2 mm across flats, 4.4 mm deep = 146 mm³
    expect(headOnly).toBeLessThan(plain - 130);
    expect(headOnly).toBeGreaterThan(plain - 180);
  });

  it('threaded rod matches the thread dimensions', () => {
    const clearance = 0.15;
    const r = evaluate(build(metricBolt, { head: 'none', chamfer: false, clearance, length: 10 }).solid);
    expect(r.stats.max[0]).toBeLessThanOrEqual(4 - clearance + 1e-6);
    expect(r.stats.max[0]).toBeGreaterThan(4 - clearance - 0.01);
    expect(r.stats.min[2]).toBeCloseTo(0, 5);
    expect(r.stats.max[2]).toBeCloseTo(10, 5);

    const exact = evaluate(build(metricBolt, { head: 'none', chamfer: false, clearance: 0, length: 10 }).solid);
    const minorR = (8 - 1.082532 * 1.25) / 2;
    expect(exact.stats.volume).toBeGreaterThan(Math.PI * minorR ** 2 * 10);
    expect(exact.stats.volume).toBeLessThan(Math.PI * 16 * 10);
    // close to the pitch cylinder (d2 = d - 0.6495P)
    const pitchR = (8 - 0.649519 * 1.25) / 2;
    expect(exact.stats.volume / (Math.PI * pitchR ** 2 * 10)).toBeGreaterThan(0.98);
    expect(exact.stats.volume / (Math.PI * pitchR ** 2 * 10)).toBeLessThan(1.03);
  });

  it('chamfers both ends of a rod but only the tip of a bolt', () => {
    const rod = evaluate(build(metricBolt, { head: 'none', length: 10 }, draft).solid);
    expect(rod.stats.min[2]).toBeCloseTo(0, 5);
    expect(rod.stats.max[2]).toBeCloseTo(10, 5);
    const plain = evaluate(build(metricBolt, { head: 'none', length: 10, chamfer: false }, draft).solid);
    expect(rod.stats.volume).toBeLessThan(plain.stats.volume - 1);
    expect(rod.stats.volume).toBeGreaterThan(plain.stats.volume - 8);
  });

  it('honours a custom pitch and limits silly ones', () => {
    expect(info(metricBolt, { pitch: 2 }, 'Pitch')).toBe(2);
    const silly = build(metricBolt, { size: 'M3', pitch: 5, length: 6 }, draft);
    expect(silly.warnings.length).toBe(1);
    expect(info(metricBolt, { size: 'M3', pitch: 5 }, 'Pitch')).toBe(1.5);
    expect(evaluate(silly.solid).stats.volume).toBeGreaterThan(0);
  });

  it('warns when the clearance eats the thread', () => {
    expect(build(metricBolt, { size: 'M3', clearance: 0.3 }).warnings.length).toBe(1);
    expect(build(metricBolt, { size: 'M3', clearance: 0.3, pitch: 1 }).warnings).toEqual([]);
  });

  it('stays light enough for a live preview', () => {
    expect(threadTriangles(build(metricBolt).solid)).toBeLessThan(80_000);
    expect(threadTriangles(build(metricBolt, { size: 'M3', length: 100 }).solid)).toBeLessThan(170_000);
    expect(threadTriangles(build(metricBolt, { size: 'M20', length: 100 }).solid)).toBeLessThan(120_000);
    expect(threadTriangles(build(metricBolt, {}, QUALITY.fine).solid)).toBeLessThan(300_000);
  });
});

describe('metric nut', () => {
  it('builds every size at the standard height', () => {
    for (const size of METRIC_SIZES) {
      const result = build(metricNut, { size }, draft);
      const r = evaluate(result.solid);
      // M3 at the default clearance barely engages, which is reported
      expect(result.warnings.length).toBe(size === 'M3' ? 1 : 0);
      expect(r.stats.min[2]).toBeCloseTo(0, 4);
      expect(r.stats.max[2]).toBeCloseTo(info(metricNut, { size }, 'Height'), 4);
      expect(r.stats.max[0]).toBeCloseTo(info(metricNut, { size }, 'Across flats') / 2, 3);
    }
  });

  it('has a bore that clears the screw core', () => {
    for (const size of ['M3', 'M8', 'M20']) {
      const nut = build(metricNut, { size });
      const minorR = info(metricBolt, { size, clearance: 0 }, 'Minor diameter') / 2;
      expect(volume(intersection(nut.solid, translate(cylinder(minorR, 40, 96), [0, 0, -10])))).toBeLessThan(1e-6);
      // ...but the thread does reach inside the major diameter
      const majorR = info(metricBolt, { size, clearance: 0 }, 'Major diameter') / 2;
      expect(volume(intersection(nut.solid, translate(cylinder(majorR, 40, 96), [0, 0, -10])))).toBeGreaterThan(0.5);
    }
  });

  it('mates with a bolt of the same size and hand only', () => {
    const rod = (overrides: Params) => build(metricBolt, { head: 'none', length: 20, ...overrides }).solid;
    for (const size of ['M4', 'M8', 'M16']) {
      const nut = build(metricNut, { size }).solid;
      expect(volume(intersection(nut, rod({ size })))).toBeLessThan(1e-6);
      expect(volume(intersection(nut, rod({ size, leftHanded: true })))).toBeGreaterThan(0.05);
    }
    const leftNut = build(metricNut, { leftHanded: true }).solid;
    expect(volume(intersection(leftNut, rod({ leftHanded: true })))).toBeLessThan(1e-6);
    expect(volume(intersection(leftNut, rod({})))).toBeGreaterThan(0.5);
    // the threads really do overlap radially: a wrong pitch collides
    expect(volume(intersection(build(metricNut).solid, rod({ pitch: 1 })))).toBeGreaterThan(0.5);
  });

  it('supports custom height and unchamfered hex', () => {
    const r = evaluate(build(metricNut, { height: 10, chamfer: false }, draft).solid);
    expect(r.stats.max[2]).toBeCloseTo(10, 5);
    const hexArea = 2 * Math.sqrt(3) * 6.5 ** 2;
    expect(r.stats.volume).toBeLessThan((hexArea - Math.PI * 3.4 ** 2) * 10);
    expect(r.stats.volume).toBeGreaterThan((hexArea - Math.PI * 4.25 ** 2) * 10);
    const chamfered = evaluate(build(metricNut, { height: 10 }, draft).solid);
    expect(chamfered.stats.volume).toBeLessThan(r.stats.volume);
    expect(chamfered.stats.volume).toBeGreaterThan(r.stats.volume * 0.9);
  });
});

describe('lead screw', () => {
  it('builds Tr8x8 with the right envelope', () => {
    const result = build(leadScrew, { length: 20 });
    const r = evaluate(result.solid);
    expect(result.warnings).toEqual([]);
    expect(result.info.find((i) => i.label === 'Designation')!.value).toBe('Tr8×8 (P2)');
    expect(info(leadScrew, {}, 'Lead')).toBe(8);
    expect(info(leadScrew, {}, 'Total length')).toBe(60);
    expect(r.stats.min[2]).toBeCloseTo(0, 5);
    expect(r.stats.max[2]).toBeCloseTo(20, 5);
    expect(r.stats.max[0]).toBeLessThanOrEqual(3.9 + 1e-6);
    expect(r.stats.max[0]).toBeGreaterThan(3.89);
    expect(r.stats.volume).toBeGreaterThan(Math.PI * 2.65 ** 2 * 20);
    expect(r.stats.volume).toBeLessThan(Math.PI * 3.9 ** 2 * 20);
    expect(threadTriangles(build(leadScrew, { length: 400 }).solid)).toBeLessThan(160_000);
  });

  it('builds a range of sizes and starts', () => {
    for (const [diameter, pitch, starts] of [
      [8, 2, 1],
      [8, 1.5, 2],
      [10, 2, 1],
      [12, 3, 2],
      [16, 4, 1],
      [20, 4, 3],
    ]) {
      const params = { diameter, pitch, starts, length: 20 };
      const result = build(leadScrew, params, draft);
      const r = evaluate(result.solid);
      expect(result.warnings).toEqual([]);
      expect(r.stats.max[2]).toBeCloseTo(20, 5);
      // (the bounding box only sees the crest where a vertex happens to face +X)
      expect(r.stats.max[0]).toBeLessThanOrEqual(diameter / 2 - 0.1 + 1e-6);
      expect(r.stats.max[0]).toBeGreaterThan((diameter / 2 - 0.1) * 0.98);
      expect(info(leadScrew, params, 'Lead')).toBeCloseTo(pitch * starts, 6);
    }
  });
});

describe('lead screw nut', () => {
  it('builds the T8 flanged nut', () => {
    const result = build(leadScrewNut);
    const r = evaluate(result.solid);
    expect(result.warnings).toEqual([]);
    expect(r.stats.min[2]).toBeCloseTo(0, 5);
    expect(r.stats.max[2]).toBeCloseTo(15, 5);
    expect(r.stats.max[0]).toBeCloseTo(11, 2);
    const solidVolume = Math.PI * (11 ** 2 * 3.5 + 5.1 ** 2 * 11.5);
    expect(r.stats.volume).toBeLessThan(solidVolume - Math.PI * 3.2 ** 2 * 15 - 4 * Math.PI * 1.75 ** 2 * 3.5 + 10);
    expect(r.stats.volume).toBeGreaterThan(solidVolume * 0.4);
  });

  it('works without a flange and warns about thin walls', () => {
    const plain = build(leadScrewNut, { flange: false }, draft);
    expect(evaluate(plain.solid).stats.max[0]).toBeCloseTo(5.1, 2);
    expect(build(leadScrewNut, { bodyDiameter: 9 }).warnings.length).toBe(1);
    expect(build(leadScrewNut, { boltCircle: 21 }).warnings.length).toBe(1);
  });

  it('mates with the matching lead screw only', () => {
    const nut = build(leadScrewNut).solid;
    const screw = (overrides: Params = {}) => build(leadScrew, { length: 30, ...overrides }).solid;
    expect(volume(intersection(nut, screw()))).toBeLessThan(1e-6);
    expect(volume(intersection(nut, screw({ leftHanded: true })))).toBeGreaterThan(0.5);
    expect(volume(intersection(nut, screw({ starts: 2 })))).toBeGreaterThan(0.5);
    // the screw core passes through
    expect(volume(intersection(nut, translate(cylinder(2.75, 40, 96), [0, 0, -10])))).toBeLessThan(1e-6);
    for (const [diameter, pitch, starts] of [
      [10, 2, 1],
      [12, 3, 2],
    ]) {
      const p = { diameter, pitch, starts };
      const n = build(leadScrewNut, { ...p, bodyDiameter: diameter + 6, flange: false }).solid;
      expect(volume(intersection(n, screw(p)))).toBeLessThan(1e-6);
    }
  });
});
