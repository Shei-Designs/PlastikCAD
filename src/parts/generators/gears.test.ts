import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { selfIntersects, signedArea } from '../math2d';
import { QUALITY, extrude } from '../types';
import { bevelGear } from './bevel';
import { helicalGear, herringboneGear, rack, ringGear, spurGear } from './gears';
import { defaultParams } from './types';
import type { GeneratorDef, Params } from './types';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.normal;
const run = (def: GeneratorDef, overrides: Params = {}) => {
  const result = def.build({ ...defaultParams(def), ...overrides }, q);
  return { result, mesh: evaluate(result.solid) };
};
const radius = (s: { min: number[]; max: number[] }) => Math.max(s.max[0], s.max[1], -s.min[0], -s.min[1]);

describe('spur gear', () => {
  it('has the expected size and a clean outline', () => {
    const { result, mesh } = run(spurGear, { boreType: 'none' });
    expect(result.warnings).toEqual([]);
    expect(radius(mesh.stats)).toBeCloseTo(22, 1);
    expect(mesh.stats.max[2]).toBeCloseTo(10);
    expect(mesh.stats.min[2]).toBeCloseTo(0);
    const outline = result.outline![0];
    expect(selfIntersects(outline)).toBe(false);
    expect(mesh.stats.volume).toBeCloseTo(signedArea(outline) * 10, 0);
  });

  it('cuts bore, hub and set screws', () => {
    const solid = run(spurGear, { boreType: 'none' }).mesh.stats.volume;
    const { result, mesh } = run(spurGear, { boreType: 'd', hubHeight: 8, setScrews: 2 });
    expect(result.warnings).toEqual([]);
    expect(mesh.stats.max[2]).toBeCloseTo(18);
    expect(mesh.stats.volume).toBeGreaterThan(solid);
    expect(result.outline!.length).toBe(2);
  });

  it('warns about undercut and oversized bores', () => {
    expect(run(spurGear, { teeth: 9 }).result.warnings.join(' ')).toMatch(/undercut/);
    expect(run(spurGear, { teeth: 9, profileShift: 0.5 }).result.warnings).toEqual([]);
    expect(run(spurGear, { boreDiameter: 34 }).result.warnings.join(' ')).toMatch(/bore/);
  });

  it('builds across the parameter range', () => {
    for (const teeth of [5, 8, 12, 33, 150])
      for (const module of [0.5, 3]) {
        const { mesh } = run(spurGear, { teeth, module, boreType: 'none' });
        expect(mesh.stats.volume).toBeGreaterThan(0);
      }
  });
});

describe('helical and herringbone gears', () => {
  it('keeps the volume of the transverse section and twists the right way', () => {
    for (const hand of ['right', 'left']) {
      const { result, mesh } = run(helicalGear, { boreType: 'none', hand });
      expect(mesh.stats.volume / (signedArea(result.outline![0]) * 10)).toBeCloseTo(1, 2);
      expect(mesh.stats.max[2]).toBeCloseTo(10);
    }
    const right = run(helicalGear, { boreType: 'none', hand: 'right' }).result.solid;
    const left = run(helicalGear, { boreType: 'none', hand: 'left' }).result.solid;
    expect(right.op === 'extrude' && right.twist! > 0).toBe(true);
    expect(left.op === 'extrude' && left.twist! < 0).toBe(true);
  });

  it('herringbone is symmetric about its mid plane', () => {
    const { result, mesh } = run(herringboneGear, { boreType: 'none' });
    expect(mesh.stats.volume / (signedArea(result.outline![0]) * 10)).toBeCloseTo(1, 2);
    expect(mesh.stats.max[2]).toBeCloseTo(10);
    expect(result.warnings).toEqual([]);
  });
});

describe('ring gear', () => {
  it('is an annulus with teeth inside', () => {
    const { result, mesh } = run(ringGear);
    expect(result.warnings).toEqual([]);
    expect(radius(mesh.stats)).toBeCloseTo(40 + 2.5 + 4, 2);
    const full = Math.PI * 46.5 ** 2 * 10;
    expect(mesh.stats.volume).toBeLessThan(full - Math.PI * 38 ** 2 * 10);
    expect(mesh.stats.volume).toBeGreaterThan(full - Math.PI * 42.5 ** 2 * 10);
    expect(result.info.find((i) => i.label.startsWith('Planet'))!.value).toBe('12');
    expect(result.info.find((i) => i.label.startsWith('Evenly'))!.value).toBe('2, 4');
  });
});

describe('rack', () => {
  it('builds straight, helical and herringbone racks of the same size', () => {
    const straight = run(rack);
    const length = 12 * Math.PI * 2;
    expect(straight.mesh.stats.max[0]).toBeCloseTo(length, 3);
    expect(straight.mesh.stats.max[1]).toBeCloseTo(6 + 2.5 + 2, 3);
    expect(straight.mesh.stats.max[2]).toBeCloseTo(10);
    expect(selfIntersects(straight.result.outline![0])).toBe(false);
    expect(straight.mesh.stats.volume).toBeCloseTo(signedArea(straight.result.outline![0]) * 10, 1);

    for (const herringbone of [false, true]) {
      const slanted = run(rack, { helixAngle: 20, herringbone });
      const l = length / Math.cos((20 * Math.PI) / 180);
      expect(slanted.mesh.stats.min[0]).toBeCloseTo(0, 3);
      expect(slanted.mesh.stats.max[0]).toBeCloseTo(l, 3);
      expect(slanted.mesh.stats.max[2]).toBeCloseTo(10, 3);
      expect(slanted.mesh.stats.volume / l).toBeCloseTo(straight.mesh.stats.volume / length, 0);
    }
  });
});

describe('bevel gear', () => {
  it('builds a mitre gear with the expected envelope', () => {
    const { result, mesh } = run(bevelGear, { boreType: 'none' });
    expect(result.warnings).toEqual([]);
    const cos45 = Math.SQRT1_2;
    expect(radius(mesh.stats)).toBeCloseTo(20 + 2 * cos45, 1);
    expect(mesh.stats.min[2]).toBeCloseTo(0, 3);
    expect(mesh.stats.volume).toBeGreaterThan(0);
    const total = Number(result.info.find((i) => i.label === 'Total height')!.value.replace(' mm', ''));
    // The tooth tips at the large end rise above the flat front face.
    expect(mesh.stats.max[2]).toBeGreaterThan(total - 0.01);
  });

  it('builds pinion / wheel pairs, with hub and bore', () => {
    for (const [teeth, mateTeeth] of [[10, 30], [30, 10], [16, 24], [45, 15], [12, 12]]) {
      const { mesh, result } = run(bevelGear, { teeth, mateTeeth, hubHeight: 6, setScrews: 1, faceWidth: 6 });
      expect(mesh.stats.volume, `${teeth}:${mateTeeth}`).toBeGreaterThan(0);
      expect(mesh.stats.min[2]).toBeCloseTo(0, 3);
      expect(result.info.find((i) => i.label === 'Pitch diameter')!.value).toBe(`${(2 * teeth).toFixed(2)} mm`);
    }
  });
});

describe('small modules with large backlash', () => {
  it('limits the backlash so the teeth keep two flanks', () => {
    const helicalRack = run(rack, { module: 0.3, backlash: 1, helixAngle: 20 });
    expect(helicalRack.mesh.stats.volume).toBeGreaterThan(0);
    expect(helicalRack.result.warnings.join(' ')).toMatch(/Backlash/);
    expect(run(rack, { module: 0.3, backlash: 1, helixAngle: 20, herringbone: true }).mesh.stats.volume).toBeGreaterThan(0);
    const straight = run(rack, { module: 0.3, backlash: 1 });
    expect(selfIntersects(straight.result.outline![0])).toBe(false);
    expect(straight.mesh.stats.volume).toBeCloseTo(signedArea(straight.result.outline![0]) * 10, 1);

    const bevel = run(bevelGear, { module: 0.3, backlash: 1, pressureAngle: 20 });
    expect(bevel.mesh.stats.volume).toBeGreaterThan(0);
    expect(bevel.result.warnings.join(' ')).toMatch(/Backlash/);

    const spur = run(spurGear, { module: 0.3, backlash: 1 });
    expect(selfIntersects(spur.result.outline![0])).toBe(false);
    expect(spur.mesh.stats.volume).toBeGreaterThan(0);
    expect(run(ringGear, { module: 0.3, backlash: 1 }).mesh.stats.volume).toBeGreaterThan(0);
    // Ordinary backlash is untouched.
    expect(run(spurGear, { backlash: 0.2 }).result.warnings).toEqual([]);
  });
});

describe('bevel gear details', () => {
  it('reports the height the part actually reaches', () => {
    for (const over of [{}, { hubHeight: 6 }, { teeth: 12, mateTeeth: 36, faceWidth: 5 }] as Params[]) {
      const { result, mesh } = run(bevelGear, over);
      const total = Number(result.info.find((i) => i.label === 'Total height')!.value.replace(' mm', ''));
      expect(Math.abs(mesh.stats.max[2] - total), JSON.stringify(over)).toBeLessThan(0.05);
      expect(mesh.stats.min[2]).toBeCloseTo(0, 3);
    }
  });

  it('puts the second set screw on +Y like every other hub', () => {
    const { result } = run(bevelGear, { hubHeight: 6, setScrews: 2, boreType: 'none' });
    const half = (y0: number, y1: number) => evaluate({ op: 'intersection', children: [result.solid, extrude([[[-30, y0], [30, y0], [30, y1], [-30, y1]]], 6)] }).stats.volume;
    // The set screw hole takes material out of the side it is on.
    expect(half(0, 30)).toBeLessThan(half(-30, 0) - 5);
  });

  it('leaves out a bore wider than the gear', () => {
    const { result, mesh } = run(bevelGear, { boreDiameter: 100 });
    expect(mesh.stats.volume).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toMatch(/bore is wider/);
  });
});
