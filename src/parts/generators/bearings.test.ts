import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { QUALITY } from '../types';
import { BEARING_IDS, bearingSeat } from './bearings';
import { CATEGORIES, GENERATORS } from './index';
import { defaultParams } from './types';
import type { Params } from './types';

beforeAll(async () => {
  await initKernel();
});

const build = (overrides: Params = {}) => bearingSeat.build({ ...defaultParams(bearingSeat), ...overrides }, QUALITY.normal);
const figure = (overrides: Params, label: string): number => parseFloat(build(overrides).info.find((i) => i.label === label)!.value);
/** The volume of a round bore, which one of many flat sides falls a little short of. */
const round = (d: number, h: number) => (Math.PI * d * d * h) / 4;

describe('bearing seat', () => {
  it('is a cutter in a family of its own', () => {
    expect(bearingSeat.cutter).toBe(true);
    expect(GENERATORS).toContain(bearingSeat);
    expect(CATEGORIES.map((c) => c.id)).toContain('bearings');
    expect(GENERATORS.filter((g) => g.category === 'bearings')).toEqual([bearingSeat]);
  });

  it('seats a 608 in a bore of 22 mm plus the clearance, 7 mm deep, over a hole half way between its rings', () => {
    const built = build();
    expect(built.warnings).toEqual([]);
    expect(built.info.map((i) => [i.label, i.value])).toEqual([
      ['Seat diameter', '22.20 mm'],
      ['Seat depth', '7.0 mm'],
      ['Hole diameter', '15.0 mm'],
    ]);
    const { stats } = evaluate(built.solid);
    // The hole below, 10 long, then the seat, its mouth at the top.
    expect(stats.min[2]).toBeCloseTo(0, 6);
    expect(stats.max[2]).toBeCloseTo(17, 6);
    expect(stats.max[0]).toBeCloseTo(11.1, 2);
    const whole = round(22.2, 7) + round(15, 10);
    expect(stats.volume).toBeGreaterThan(whole * 0.97);
    expect(stats.volume).toBeLessThanOrEqual(whole);
  });

  it('takes a depth and a clearance of its own, and goes without the hole', () => {
    expect(figure({ clearance: 0 }, 'Seat diameter')).toBe(22);
    expect(figure({ depth: 4 }, 'Seat depth')).toBe(4);
    const blind = build({ through: false });
    expect(blind.info.map((i) => i.label)).toEqual(['Seat diameter', 'Seat depth']);
    expect(evaluate(blind.solid).stats.max[2]).toBeCloseTo(7, 6);
  });

  it('builds every bearing it lists, each hole narrower than its seat and wider than its bore', () => {
    for (const bearing of BEARING_IDS) {
      const built = build({ bearing });
      expect(built.warnings).toEqual([]);
      const seat = parseFloat(built.info[0].value);
      const hole = parseFloat(built.info[2].value);
      const bore = Number(/\((\d+(?:\.\d+)?) ×/.exec(bearingSeat.groups[0].params[0].type === 'select' ? bearingSeat.groups[0].params[0].options.find((o) => o.value === bearing)!.label : '')![1]);
      expect(hole).toBeLessThan(seat);
      expect(hole).toBeGreaterThan(bore);
      expect(evaluate(built.solid).stats.volume).toBeGreaterThan(0);
    }
    // A linear bearing is as deep as it is long.
    expect(figure({ bearing: 'LM8UU' }, 'Seat depth')).toBe(24);
    expect(figure({ bearing: 'LM8UU' }, 'Seat diameter')).toBe(15.2);
  });

  it('takes a bearing by its own sizes, and mends a bore as wide as the bearing', () => {
    const custom = build({ bearing: 'custom', outer: 30, width: 9, bore: 10 });
    expect(custom.info.map((i) => i.value)).toEqual(['30.20 mm', '9.0 mm', '20.0 mm']);
    const wrong = build({ bearing: 'custom', outer: 10, width: 4, bore: 12 });
    expect(wrong.warnings).toEqual(['The bore is as wide as the bearing; it was made half as wide.']);
    expect(wrong.info[2].value).toBe('7.5 mm');
  });
});
