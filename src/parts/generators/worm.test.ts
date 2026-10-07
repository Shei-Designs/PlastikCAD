import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../evaluate';
import { QUALITY } from '../types';
import { defaultParams } from './types';
import type { Params } from './types';
import { worm } from './worm';

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
    expect(item({ leftHanded: true }, 'Mating gear')).toContain('left-handed');
  });

  it('builds across the parameter range', () => {
    for (const overrides of [
      { module: 0.5, pitchDiameter: 8, boreType: 'none' },
      { module: 2, starts: 2, pitchDiameter: 24, length: 40, boreType: 'd', boreDiameter: 8, boreFlat: 7 },
      { module: 1.5, starts: 4, pitchDiameter: 20, pressureAngle: 14.5, leftHanded: true, chamfer: false },
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
