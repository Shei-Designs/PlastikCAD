import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { intersection, QUALITY, rotate, translate } from '../types';
import type { Solid } from '../types';
import { defaultParams } from './types';
import type { Params } from './types';
import { worm, wormPair, wormTurn, wormWheel } from './worm';
import type { WormPair } from './worm';

const build = (overrides: Params = {}, q = QUALITY.normal) => worm.build({ ...defaultParams(worm), ...overrides }, q);
const item = (overrides: Params, label: string) => build(overrides).info.find((i) => i.label === label)!.value;

beforeAll(async () => {
  await initKernel();
});

describe('worm', () => {
  it('builds with defaults', () => {
    const result = build();
    const r = evaluate(result.solid);
    expect(result.warnings).toEqual([]);
    expect(r.stats.min[2]).toBeCloseTo(0, 5);
    expect(r.stats.max[2]).toBeCloseTo(20, 5);
    // OD = d + 2m
    expect(r.stats.max[0]).toBeLessThanOrEqual(7 + 1e-6);
    expect(r.stats.max[0]).toBeGreaterThan(6.97);
    const bore = Math.PI * 2.6 ** 2 * 20;
    expect(r.stats.volume).toBeGreaterThan(Math.PI * 4.75 ** 2 * 20 * 0.97 - bore);
    expect(r.stats.volume).toBeLessThan(Math.PI * 49 * 20 - bore);
    expect(r.stats.triangles).toBeLessThan(80_000);
  });

  it('reports lead and lead angle', () => {
    expect(parseFloat(item({}, 'Lead'))).toBeCloseTo(Math.PI, 3);
    expect(parseFloat(item({}, 'Lead angle'))).toBeCloseTo((Math.atan(1 / 12) * 180) / Math.PI, 2);
    expect(parseFloat(item({ starts: 3, module: 2, pitchDiameter: 20 }, 'Lead'))).toBeCloseTo(6 * Math.PI, 3);
    expect(parseFloat(item({ starts: 3, module: 2, pitchDiameter: 20 }, 'Lead angle'))).toBeCloseTo(
      (Math.atan(6 / 20) * 180) / Math.PI,
      2,
    );
    expect(item({}, 'Mating gear')).toContain('right-handed');
    expect(item({ hand: 'left' }, 'Mating gear')).toContain('left-handed');
  });

  it('builds across the parameter range', () => {
    for (const overrides of [
      { module: 0.5, pitchDiameter: 8, boreType: 'none' },
      { module: 2, starts: 2, pitchDiameter: 24, length: 40, boreType: 'd', boreDiameter: 8, boreFlat: 7 },
      { module: 1.5, starts: 4, pitchDiameter: 20, pressureAngle: 14.5, hand: 'left', chamfer: false },
      { module: 3, pitchDiameter: 36, pressureAngle: 30, length: 50, boreType: 'hex', boreDiameter: 10 },
    ] as Params[]) {
      const result = build(overrides, QUALITY.draft);
      const r = evaluate(result.solid);
      const m = Number(overrides.module);
      const d = Number(overrides.pitchDiameter);
      expect(result.warnings).toEqual([]);
      expect(r.stats.volume).toBeGreaterThan(0);
      expect(r.stats.max[0]).toBeCloseTo(d / 2 + m, 1);
      expect(r.stats.max[2]).toBeCloseTo(Number(overrides.length ?? 20), 5);
    }
  });

  it('warns when the core is too thin', () => {
    expect(build({ module: 2, pitchDiameter: 5 }).warnings.length).toBe(1);
    expect(build({ module: 1, pitchDiameter: 12, boreDiameter: 8 }).warnings.length).toBe(1);
  });
});

describe('throated worm wheel', () => {
  const built = (over: Params = {}, quality = QUALITY.normal) => {
    const params = { ...defaultParams(wormWheel), ...over };
    const r = wormWheel.build(params, quality);
    return { ...r, params, pair: wormPair(params), stats: evaluate(r.solid).stats };
  };
  /** The worm the wheel is for, where the wheel's builder has it when the wheel has turned by `turn`: across the rim at +X, spun by `spin`. */
  const wormAt = (params: Params, pair: WormPair, turn: number, spin: number): Solid => {
    const length = 8 * pair.pitch;
    const real = worm.build({ ...defaultParams(worm), module: params.module, starts: params.starts, pitchDiameter: params.wormDiameter, hand: params.hand, length, chamfer: false, boreType: 'none' }, QUALITY.normal).solid;
    return rotate(translate(rotate(rotate(translate(real, [0, 0, -length / 2]), [0, 0, spin]), [-90, 0, 0]), [pair.center, 0, pair.faceWidth / 2]), [0, 0, -turn]);
  };
  const shared = (a: Solid, b: Solid): number => {
    try {
      return evaluate(intersection(a, b)).stats.volume;
    } catch (e) {
      if (String(e).includes('empty')) return 0;
      throw e;
    }
  };

  it('has the pitch circle of its teeth and a rim hollowed to the worm', () => {
    const { info, stats, pair, warnings } = built();
    expect(warnings).toEqual([]);
    const figure = (label: string): number => parseFloat(info.find((i) => i.label === label)?.value ?? '');
    // Thirty teeth of module 1 on a worm of 12: 30 across the pitch circle, 21 from axis to axis.
    expect(figure('Pitch diameter')).toBeCloseTo(30, 6);
    expect(figure('Center distance')).toBeCloseTo(21, 6);
    expect(info.find((i) => i.label === 'Ratio')?.value).toBe('30 : 1');
    expect(pair.faceWidth).toBe(10.5);
    expect(stats.max[2] - stats.min[2]).toBeCloseTo(10.5, 6);
    // The rim reaches a module and a half past the pitch circle at its edges, and is hollowed between them.
    expect(stats.max[0]).toBeCloseTo(16.5, 1);
    const disc = Math.PI * 16.5 ** 2 * 10.5;
    expect(stats.volume).toBeLessThan(disc * 0.9);
    expect(stats.volume).toBeGreaterThan(disc * 0.75);
  });

  it('lets its worm turn in it, and takes no other', () => {
    for (const over of [{}, { starts: 2, hand: 'left', teeth: 40, module: 1.5, wormDiameter: 16 }, { teeth: 12 }] as Params[]) {
      const { solid, params, pair } = built(over);
      const label = JSON.stringify(over);
      // The wheel turned and the worm turned with it, teeth to starts: the thread runs between the teeth at every step.
      for (const turn of [0, 3.3, 17.5]) expect(shared(solid, wormAt(params, pair, turn, wormTurn(pair, turn))), `${label} turned ${turn}`).toBeLessThan(0.01);
      // Half a thread out of step, or the worm turned the other way, and they are in each other.
      expect(shared(solid, wormAt(params, pair, 0, 180 / pair.starts)), `${label} out of step`).toBeGreaterThan(10);
      expect(shared(solid, wormAt(params, pair, 3.3, -wormTurn(pair, 3.3))), `${label} the other way`).toBeGreaterThan(10);
    }
  }, 120_000);

  it('stays light enough to draw, at every quality', () => {
    // Every step of the cutting leaves its facets on every tooth: untidied, a wheel like this ran to a quarter of a million triangles.
    expect(built({}, QUALITY.draft).stats.triangles).toBeLessThan(40_000);
    expect(built({}, QUALITY.normal).stats.triangles).toBeLessThan(45_000);
    expect(built({}, QUALITY.fine).stats.triangles).toBeLessThan(60_000);
  }, 120_000);

  it('carries a hub and a bore, and says so when the bore is too wide', () => {
    const plain = built({ boreType: 'none' });
    const bored = built({ boreType: 'round', boreDiameter: 5 });
    // A hole of 5 through the 10.5 of the wheel, a little over for the fit of a shaft.
    expect(plain.stats.volume - bored.stats.volume).toBeGreaterThan(Math.PI * 2.5 ** 2 * 10.5);
    expect(plain.stats.volume - bored.stats.volume).toBeLessThan(Math.PI * 2.7 ** 2 * 10.5);
    const hubbed = built({ hubHeight: 6, hubDiameter: 14 });
    expect(hubbed.stats.max[2] - hubbed.stats.min[2]).toBeCloseTo(16.5, 6);
    expect(built({ boreType: 'round', boreDiameter: 27 }).warnings).toEqual(['The bore leaves very little material below the teeth.']);
  });
});

