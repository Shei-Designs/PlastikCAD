import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../evaluate';
import { selfIntersects, signedArea } from '../math2d';
import { QUALITY } from '../types';
import { gt2Pulley, htdPulley, mxlPulley, tPulley } from './timingPulley';
import { defaultParams, num } from './types';
import type { BuildResult, GeneratorDef, Params } from './types';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.normal;
const info = (r: BuildResult, label: string) => {
  const item = r.info.find((i) => i.label === label);
  if (!item) throw new Error(`No info item "${label}"`);
  return parseFloat(item.value);
};
const maxRadius = (positions: Float32Array, zMin = -Infinity, zMax = Infinity) => {
  let m = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] < zMin || positions[i + 2] > zMax) continue;
    m = Math.max(m, Math.hypot(positions[i], positions[i + 1]));
  }
  return m;
};

function check(def: GeneratorDef, p: Params) {
  const r = def.build(p, q);
  const outline = r.outline!;
  const toothed = outline[0];
  expect(signedArea(toothed)).toBeGreaterThan(0);
  expect(selfIntersects(toothed)).toBe(false);

  // The toothed outline reaches exactly the outside diameter and the root diameter.
  const od = info(r, 'Outside diameter');
  const radii = toothed.map(([x, y]) => Math.hypot(x, y));
  expect(Math.max(...radii) * 2).toBeCloseTo(od, 1);
  expect(Math.min(...radii) * 2).toBeCloseTo(info(r, 'Root diameter'), 1);

  const e = evaluate(r.solid);
  expect(e.stats.volume).toBeGreaterThan(0);
  expect(e.stats.min[2]).toBeCloseTo(0, 4);
  expect(e.stats.max[2] - e.stats.min[2]).toBeCloseTo(info(r, 'Total height'), 1);

  const flange = p.flanges === 'none' ? 0 : num(p, 'flangeExtra');
  const hub = num(p, 'hubHeight') > 0 ? num(p, 'hubDiameter') / 2 : 0;
  expect(maxRadius(e.mesh.positions)).toBeCloseTo(Math.max(od / 2 + flange, hub), 1);
  return { r, e };
}

describe('timing pulleys', () => {
  for (const def of [gt2Pulley, htdPulley, tPulley, mxlPulley]) {
    const profile = def.groups[0].params.find((d) => d.key === 'profile');
    if (!profile || profile.type !== 'select') throw new Error('profile select missing');
    for (const option of profile.options) {
      for (const teeth of [20, 10, 80]) {
        it(`${def.id} ${option.value} ${teeth}T`, () => {
          check(def, { ...defaultParams(def), profile: option.value, teeth });
        });
      }
    }
  }

  it('GT2 20T has the standard dimensions', () => {
    const { r } = check(gt2Pulley, defaultParams(gt2Pulley));
    expect(info(r, 'Outside diameter')).toBeCloseTo(12.22, 1);
    expect(Math.abs(info(r, 'Outside diameter') - 12.22)).toBeLessThan(0.02);
    expect(info(r, 'Pitch diameter')).toBeCloseTo(12.73, 2);
    expect(r.warnings).toEqual([]);
    // 20 grooves -> the outline has 20-fold symmetry.
    expect(r.outline![0].length % 20).toBe(0);
  });

  it('flange options change the stack height and width', () => {
    const base = { ...defaultParams(gt2Pulley), hubHeight: 0, boreType: 'none' };
    const both = check(gt2Pulley, { ...base, flanges: 'both' });
    const none = check(gt2Pulley, { ...base, flanges: 'none' });
    const top = check(gt2Pulley, { ...base, flanges: 'top' });
    expect(info(both.r, 'Total height')).toBeCloseTo(9, 5); // 6 belt + 1 margin + 2 × 1 flange
    expect(info(none.r, 'Total height')).toBeCloseTo(7, 5);
    expect(info(top.r, 'Total height')).toBeCloseTo(8, 5);
    // Without a bottom flange nothing below the teeth is wider than the OD.
    const od = info(top.r, 'Outside diameter');
    expect(maxRadius(top.e.mesh.positions, -1, 6)).toBeCloseTo(od / 2, 2);
    expect(both.e.stats.volume).toBeGreaterThan(top.e.stats.volume);
    expect(top.e.stats.volume).toBeGreaterThan(none.e.stats.volume);
  });

  it('tooth clearance deepens the grooves', () => {
    const base = { ...defaultParams(htdPulley), hubHeight: 0, boreType: 'none', flanges: 'none' };
    const tight = check(htdPulley, { ...base, toothClearance: 0 });
    const loose = check(htdPulley, { ...base, toothClearance: 0.2 });
    expect(info(tight.r, 'Root diameter') - info(loose.r, 'Root diameter')).toBeCloseTo(0.4, 5);
    expect(loose.e.stats.volume).toBeLessThan(tight.e.stats.volume);
  });

  it('rejects grooves that cannot fit', () => {
    expect(() => tPulley.build({ ...defaultParams(tPulley), profile: 'T2.5', teeth: 10, toothClearance: 0.5 }, q)).toThrow(
      /overlap/,
    );
  });
});
