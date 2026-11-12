import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { cylinder, intersection, QUALITY, translate } from '../types';
import type { Quality, Solid } from '../types';
import { HOLE_SIZES, inchBolt, inchNut, inchScrewHole, leadScrew, leadScrewNut, METRIC_SIZES, metricBolt, metricNut, screwHole, UNIFIED_SIZES } from './screws';
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

  it('honors a custom pitch and limits silly ones', () => {
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
      expect(volume(intersection(nut, rod({ size, hand: 'left' })))).toBeGreaterThan(0.05);
    }
    const leftNut = build(metricNut, { hand: 'left' }).solid;
    expect(volume(intersection(leftNut, rod({ hand: 'left' })))).toBeLessThan(1e-6);
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
    expect(volume(intersection(nut, screw({ hand: 'left' })))).toBeGreaterThan(0.5);
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

describe('screw hole', () => {
  /** The volume of a cylinder approximated by the facets of the given quality, near enough to the round one. */
  const round = (d: number, h: number) => (Math.PI * d * d * h) / 4;
  const figure = (overrides: Params, label: string) => info(screwHole, overrides, label);

  it('is a cutter, and offers M2 and M2.5 beside the sizes of the bolts', () => {
    expect(screwHole.cutter).toBe(true);
    expect(HOLE_SIZES.slice(0, 3)).toEqual(['M2', 'M2.5', 'M3']);
    expect(METRIC_SIZES[0]).toBe('M3');
    expect(HOLE_SIZES.slice(2)).toEqual(METRIC_SIZES);
  });

  it('makes a clearance hole of the ISO 273 diameter for the fit, as deep as asked, in every size', () => {
    expect(figure({ size: 'M3' }, 'Hole diameter')).toBe(3.4);
    expect(figure({ size: 'M3', fit: 'close' }, 'Hole diameter')).toBe(3.2);
    expect(figure({ size: 'M8', fit: 'loose' }, 'Hole diameter')).toBe(10);
    expect(figure({ size: 'M2.5' }, 'Hole diameter')).toBe(2.9);
    for (const size of HOLE_SIZES) {
      const built = build(screwHole, { size, depth: 12 });
      expect(built.warnings).toEqual([]);
      const { stats } = evaluate(built.solid);
      const d = parseFloat(built.info[0].value);
      expect(stats.min[2]).toBeCloseTo(0, 6);
      expect(stats.max[2]).toBeCloseTo(12, 6);
      expect(stats.max[0]).toBeCloseTo(d / 2, 2);
      // A faceted circle is a little smaller than the round one.
      expect(stats.volume).toBeGreaterThan(round(d, 12) * 0.97);
      expect(stats.volume).toBeLessThanOrEqual(round(d, 12));
    }
  });

  it('seats a socket cap in a counterbore as wide as the head plus the play of the hole, a head deep', () => {
    const built = build(screwHole, { size: 'M4', recess: 'counterbore', depth: 10 });
    expect(built.info.map((i) => [i.label, i.value])).toEqual([
      ['Hole diameter', '4.5 mm'],
      ['Recess diameter', '7.5 mm'],
      ['Recess depth', '4.0 mm'],
    ]);
    const { stats } = evaluate(built.solid);
    expect(stats.max[0]).toBeCloseTo(3.75, 2);
    expect(stats.volume).toBeGreaterThan((round(4.5, 6) + round(7.5, 4)) * 0.97);
    expect(stats.volume).toBeLessThanOrEqual(round(4.5, 6) + round(7.5, 4));
    // A depth of its own, and never deeper than the hole.
    expect(figure({ size: 'M4', recess: 'counterbore', recessDepth: 6 }, 'Recess depth')).toBe(6);
    const shallow = build(screwHole, { size: 'M4', recess: 'counterbore', depth: 3 });
    expect(shallow.warnings).toEqual(['The recess was limited to the depth of the hole.']);
    expect(evaluate(shallow.solid).stats.max[2]).toBeCloseTo(3, 6);
  });

  it('cuts a 90° countersink from the sharp edge of the head down to the hole', () => {
    const built = build(screwHole, { size: 'M3', recess: 'countersink', depth: 8 });
    // ISO 10642: 6.72 across, plus the 0.4 of play; the cone is as deep as it narrows on each side.
    expect(built.info.map((i) => [i.label, i.value])).toEqual([
      ['Hole diameter', '3.4 mm'],
      ['Recess diameter', '7.1 mm'],
      ['Recess depth', '1.9 mm'],
    ]);
    const { stats } = evaluate(built.solid);
    expect(stats.max[0]).toBeCloseTo(3.56, 2);
    expect(stats.max[2]).toBeCloseTo(8, 6);
  });

  it('traps a nut in a hexagon as wide across the flats as the nut plus the play, a nut deep', () => {
    const built = build(screwHole, { size: 'M3', recess: 'nut', depth: 10 });
    expect(built.info.map((i) => [i.label, i.value])).toEqual([
      ['Hole diameter', '3.4 mm'],
      ['Across flats', '5.9 mm'],
      ['Recess depth', '2.4 mm'],
    ]);
    const { stats } = evaluate(built.solid);
    // Across the flats along X, across the corners along Y.
    expect(stats.max[0]).toBeCloseTo(2.95, 3);
    expect(stats.max[1]).toBeCloseTo(2.95 / Math.cos(Math.PI / 6), 3);
    const hexagon = 2 * Math.sqrt(3) * 2.95 * 2.95 * 2.4;
    expect(stats.volume).toBeGreaterThan(hexagon + round(3.4, 7.6) * 0.97);
    expect(stats.volume).toBeLessThanOrEqual(hexagon + round(3.4, 7.6));
  });

  it('cuts a thread that a bolt of the same size and clearance turns in', () => {
    const hole = build(screwHole, { size: 'M8', kind: 'tapped', depth: 10 });
    expect(hole.warnings).toEqual([]);
    const nut = build(metricNut, { size: 'M8' });
    // The same thread as the nut's: its figures are the nut's.
    for (const label of ['Thread major diameter', 'Thread minor diameter', 'Pitch']) {
      expect(hole.info.find((i) => i.label === label)?.value).toBe(nut.info.find((i) => i.label === label)?.value);
    }
    const { stats } = evaluate(hole.solid);
    expect(stats.min[2]).toBeCloseTo(0, 6);
    expect(stats.max[2]).toBeCloseTo(10, 6);
    // More than its bore, less than a hole of its full width.
    const major = parseFloat(hole.info[0].value);
    const minor = parseFloat(hole.info[1].value);
    expect(stats.volume).toBeGreaterThan(round(minor, 10) * 0.97);
    expect(stats.volume).toBeLessThan(round(major + 1, 10));
    // Too fine to print in M2: said, not refused.
    expect(build(screwHole, { size: 'M2', kind: 'tapped' }).warnings[0]).toMatch(/of the thread depth engages/);
  });

  it('bores for a heat-set insert at the usual diameter, or the one given', () => {
    expect(figure({ size: 'M3', kind: 'insert' }, 'Bore')).toBe(4);
    expect(figure({ size: 'M2.5', kind: 'insert' }, 'Bore')).toBe(4);
    expect(figure({ size: 'M5', kind: 'insert' }, 'Bore')).toBe(6.4);
    expect(figure({ size: 'M5', kind: 'insert', bore: 7 }, 'Bore')).toBe(7);
    // No usual bore above M6: said, and a clearance hole meanwhile.
    const large = build(screwHole, { size: 'M10', kind: 'insert' });
    expect(large.warnings).toEqual(['M10 inserts have no usual bore. Set the diameter.']);
    expect(build(screwHole, { size: 'M10', kind: 'insert', bore: 12.5 }).warnings).toEqual([]);
  });
});

describe('inch bolt and nut', () => {
  const figure = (r: ReturnType<typeof build>, label: string): string => r.info.find((i) => i.label === label)?.value ?? '';

  it('cuts a 1/4-20 thread under a 7/16 hex head', () => {
    const r = build(inchBolt);
    expect(r.warnings).toEqual([]);
    expect(figure(r, 'Thread')).toBe('1/4-20 UNC');
    // Twenty threads to the inch; a quarter inch less the clearance on either side.
    expect(parseFloat(figure(r, 'Pitch'))).toBeCloseTo(25.4 / 20, 2);
    expect(parseFloat(figure(r, 'Major diameter'))).toBeCloseTo(6.35 - 2 * 0.15, 2);
    expect(parseFloat(figure(r, 'Across flats'))).toBeCloseTo(11.1, 1);
    expect(parseFloat(figure(r, 'Head height'))).toBeCloseTo(4, 1);
    const { stats } = evaluate(r.solid);
    // Across the flats of the hexagon and across its corners, and from under the head to the tip.
    expect(stats.max[0] - stats.min[0]).toBeCloseTo((7 / 16) * 25.4, 1);
    expect(stats.max[1] - stats.min[1]).toBeCloseTo(((7 / 16) * 25.4) / Math.cos(Math.PI / 6), 1);
    expect(stats.max[2] - stats.min[2]).toBeCloseTo((5 / 32) * 25.4 + 30, 1);
  });

  it('takes the fine series, and the numbered sizes', () => {
    expect(figure(build(inchBolt, { series: 'fine' }), 'Thread')).toBe('1/4-28 UNF');
    const small = build(inchNut, { size: '#10', series: 'fine' });
    expect(figure(small, 'Thread')).toBe('#10-32 UNF');
    expect(parseFloat(figure(small, 'Pitch'))).toBeCloseTo(25.4 / 32, 2);
    // A machine screw nut: 3/8 across the flats, 1/8 thick.
    expect(parseFloat(figure(small, 'Across flats'))).toBeCloseTo(9.5, 1);
    expect(parseFloat(figure(small, 'Height'))).toBeCloseTo(3.2, 1);
    // From 7/16 the nut is wider across the flats than the bolt's head.
    expect(parseFloat(figure(build(inchNut, { size: '7/16"' }), 'Across flats'))).toBeCloseTo(17.5, 1);
    expect(parseFloat(figure(build(inchBolt, { size: '7/16"' }), 'Across flats'))).toBeCloseTo(15.9, 1);
  });

  it('builds every size in both series, with either head or none', () => {
    for (const size of UNIFIED_SIZES) {
      for (const series of ['coarse', 'fine']) {
        expect(volume(build(inchNut, { size, series }, draft).solid), `${size} ${series} nut`).toBeGreaterThan(0);
        expect(volume(build(inchBolt, { size, series, length: 12 }, draft).solid), `${size} ${series} bolt`).toBeGreaterThan(0);
      }
    }
    for (const head of ['hex', 'socket', 'none']) expect(volume(build(inchBolt, { head, length: 12 }, draft).solid), head).toBeGreaterThan(0);
  });

  it('mates with a bolt of the same size and series only', () => {
    const nut = build(inchNut, {}, draft).solid;
    const through = (overrides: Params) => volume(intersection(nut, translate(build(inchBolt, { head: 'none', length: 20, chamfer: false, ...overrides }, draft).solid, [0, 0, -5])));
    // The same thread turns in with nothing in the way; the fine one, and a left-handed one, cut into it.
    expect(through({})).toBeLessThan(0.5);
    expect(through({ series: 'fine' })).toBeGreaterThan(2);
    expect(through({ hand: 'left' })).toBeGreaterThan(2);
  });
});

describe('the figures of a screw in inches', () => {
  const rows = (def: GeneratorDef, overrides: Params) => new Map(build(def, overrides, draft).info.map((i) => [i.label, i.inches]));

  it('give a metric size\'s figures in inches as well: only its name stays as the standard writes it', () => {
    const bolt = rows(metricBolt, { size: 'M8', head: 'socket', length: 25.4 });
    // M8 × 1.25 under a 13 mm cap head with a 6 mm key.
    expect(bolt.get('Pitch')).toBe('0.0492 in');
    expect(bolt.get('Head diameter')).toBe('0.512 in');
    expect(bolt.get('Hex key')).toBe('0.236 in');
    expect(rows(metricBolt, { size: 'M8', head: 'hex' }).get('Across flats')).toBe('0.512 in');
    // What the user sized: a 25.4 mm thread under an 8 mm head.
    expect(bolt.get('Total length')).toBe('1.315 in');
    expect(bolt.get('Major diameter')).toMatch(/^0\.\d{4} in$/);
    expect(rows(screwHole, { size: 'M3' }).get('Hole diameter')).toMatch(/^0\.\d{3} in$/);
    const screw = rows(leadScrew, {});
    for (const label of ['Pitch', 'Lead']) expect(screw.get(label), label).toMatch(/ in/);
    expect(rows(leadScrewNut, {}).get('Crest clearance')).toMatch(/^0\.\d{4} in$/);
  });

  it('give what the inch standard lays down in inches', () => {
    // 1/2-20 UNF under a 3/4 hex head.
    const bolt = rows(inchBolt, { size: '1/2"', series: 'fine', head: 'hex', length: 25.4 });
    expect(bolt.get('Across flats')).toBe('0.750 in');
    expect(bolt.get('Pitch')).toBe('0.0500 in');
    expect(bolt.get('Thread')).toBeUndefined();
    expect(rows(inchBolt, { size: '5/16"', head: 'socket' }).get('Hex key')).toBe('0.250 in');
    expect(rows(inchNut, { size: '1/2"' }).get('Across flats')).toBe('0.750 in');
    expect(rows(inchScrewHole, { size: '1/4"' }).get('Hole diameter')).toBe('0.281 in');
  });
});

describe('inch screw hole', () => {
  const figure = (overrides: Params, label: string) => info(inchScrewHole, overrides, label);
  /** A readout is given to a tenth of a millimeter: near enough to that. */
  const near = (shown: number, exact: number) => expect(Math.abs(shown - exact)).toBeLessThan(0.06);
  const IN = 25.4;

  it('is a cutter with the settings of the metric hole, the series in place of the pitch', () => {
    expect(inchScrewHole.cutter).toBe(true);
    const keys = (def: typeof screwHole) => def.groups[0].params.map((param) => param.key);
    expect(keys(inchScrewHole)).toEqual(keys(screwHole).map((key) => (key === 'pitch' ? 'series' : key)));
  });

  it('makes a clearance hole of the drill ASME B18.2.8 names for the fit, in every size', () => {
    near(figure({ size: '1/4"' }, 'Hole diameter'), (9 / 32) * IN);
    near(figure({ size: '1/4"', fit: 'close' }, 'Hole diameter'), (17 / 64) * IN);
    near(figure({ size: '1/4"', fit: 'loose' }, 'Hole diameter'), (19 / 64) * IN);
    near(figure({ size: '#10' }, 'Hole diameter'), 0.2055 * IN);
    for (const size of UNIFIED_SIZES) {
      let last = 0;
      for (const fit of ['close', 'normal', 'loose']) {
        const built = build(inchScrewHole, { size, fit, depth: 12 });
        expect(built.warnings, `${size} ${fit}`).toEqual([]);
        const d = parseFloat(built.info[0].value);
        // Wider than the screw, and wider with each looser fit.
        expect(d, `${size} ${fit}`).toBeGreaterThan(last);
        last = d;
        const { stats } = evaluate(built.solid);
        expect(stats.max[2]).toBeCloseTo(12, 6);
        near(stats.max[0] * 2, d);
      }
      const bolt = info(inchBolt, { size, clearance: 0 }, 'Major diameter');
      expect(figure({ size, fit: 'close' }, 'Hole diameter'), size).toBeGreaterThan(bolt);
    }
  });

  it('countersinks at 82°: shallower than the metric 90° cone would be for the same widths', () => {
    const built = build(inchScrewHole, { size: '1/4"', recess: 'countersink', depth: 12 });
    const hole = parseFloat(built.info[0].value);
    const wide = parseFloat(built.info[1].value);
    const deep = parseFloat(built.info[2].value);
    // The sharp edge of a 1/4" flat head, plus the play of the hole.
    near(wide, 0.507 * IN + ((9 / 32) * IN - 0.25 * IN));
    near(deep, (0.507 * IN + (9 / 32) * IN - 0.25 * IN - (9 / 32) * IN) / 2 / Math.tan((41 * Math.PI) / 180));
    expect(deep).toBeGreaterThan((wide - hole) / 2);
    const { stats } = evaluate(built.solid);
    near(stats.max[0] * 2, wide);
  });

  it('seats a socket cap or a nut of the inch size, and cuts a Unified thread', () => {
    const bored = build(inchScrewHole, { size: '1/4"', recess: 'counterbore', depth: 12 });
    // A 3/8" head and the play of a 9/32" hole round a 1/4" screw, a diameter deep.
    near(parseFloat(bored.info[1].value), (3 / 8 + 9 / 32 - 1 / 4) * IN);
    near(parseFloat(bored.info[2].value), 0.25 * IN);
    const trap = build(inchScrewHole, { size: '1/4"', recess: 'nut', depth: 12 });
    near(figure({ size: '1/4"', recess: 'nut', depth: 12 }, 'Across flats'), (7 / 16 + 9 / 32 - 1 / 4) * IN);
    expect(evaluate(trap.solid).stats.volume).toBeGreaterThan(evaluate(build(inchScrewHole, { size: '1/4"', depth: 12 }).solid).stats.volume);
    const tapped = build(inchScrewHole, { size: '1/4"', kind: 'tapped', series: 'fine', depth: 10 }, draft);
    expect(tapped.info.find((i) => i.label === 'Thread')?.value).toBe('1/4-28 UNF');
    expect(parseFloat(tapped.info.find((i) => i.label === 'Pitch')!.value)).toBeCloseTo(IN / 28, 2);
    expect(volume(tapped.solid)).toBeGreaterThan(0);
  });

  it('asks for the bore of a heat-set insert, as no inch size has a usual one', () => {
    const built = build(inchScrewHole, { size: '#8', kind: 'insert' });
    expect(built.warnings).toEqual(['#8 inserts have no usual bore. Set the diameter.']);
    expect(build(inchScrewHole, { size: '#8', kind: 'insert', bore: 5.5 }).warnings).toEqual([]);
  });
});

