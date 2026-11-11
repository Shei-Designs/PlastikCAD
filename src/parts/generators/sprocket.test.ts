import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { selfIntersects, signedArea } from '../math2d';
import { QUALITY } from '../types';
import { sprocket } from './sprocket';
import { defaultParams, num } from './types';
import type { BuildResult, Params } from './types';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.normal;
const info = (r: BuildResult, label: string) => {
  const item = r.info.find((i) => i.label === label);
  if (!item) throw new Error(`No info item "${label}"`);
  return parseFloat(item.value);
};
const maxRadius = (positions: Float32Array) => {
  let m = 0;
  for (let i = 0; i < positions.length; i += 3) m = Math.max(m, Math.hypot(positions[i], positions[i + 1]));
  return m;
};

function check(p: Params) {
  const r = sprocket.build(p, q);
  const toothed = r.outline![0];
  expect(signedArea(toothed)).toBeGreaterThan(0);
  expect(selfIntersects(toothed)).toBe(false);

  const od = info(r, 'Outside diameter');
  const radii = toothed.map(([x, y]) => Math.hypot(x, y));
  expect(Math.max(...radii) * 2).toBeCloseTo(od, 1);
  expect(Math.min(...radii) * 2).toBeCloseTo(info(r, 'Root diameter'), 1);

  const e = evaluate(r.solid);
  expect(e.stats.volume).toBeGreaterThan(0);
  expect(e.stats.min[2]).toBeCloseTo(0, 4);
  expect(e.stats.max[2] - e.stats.min[2]).toBeCloseTo(info(r, 'Total height'), 1);
  const hub = num(p, 'hubHeight') > 0 ? num(p, 'hubDiameter') / 2 : 0;
  expect(maxRadius(e.mesh.positions)).toBeCloseTo(Math.max(od / 2, hub), 1);
  return { r, e };
}

describe('chain sprocket', () => {
  const chain = sprocket.groups[0].params.find((d) => d.key === 'chain');
  if (!chain || chain.type !== 'select') throw new Error('chain select missing');
  for (const option of chain.options) {
    for (const teeth of [16, 8, 60]) {
      it(`${option.value} ${teeth}T`, () => {
        check({ ...defaultParams(sprocket), chain: option.value, teeth });
      });
    }
  }

  it('has the standard pitch and outside diameters', () => {
    for (const [chainId, pitch, teeth] of [['25', 6.35, 16], ['40', 12.7, 11], ['05B', 8, 25]] as const) {
      const { r } = check({ ...defaultParams(sprocket), chain: chainId, teeth });
      expect(Math.abs(info(r, 'Pitch diameter') - pitch / Math.sin(Math.PI / teeth))).toBeLessThan(0.006);
      expect(Math.abs(info(r, 'Outside diameter') - pitch * (0.6 + 1 / Math.tan(Math.PI / teeth)))).toBeLessThan(0.006);
    }
  });

  it('seats the rollers on the pitch circle', () => {
    const p = { ...defaultParams(sprocket), chain: '40', teeth: 12, rollerClearance: 0 };
    const r = sprocket.build(p, q);
    const pitchR = 12.7 / (2 * Math.sin(Math.PI / 12));
    const seatR = 0.5025 * 7.92 + 0.04;
    // No outline point lies inside a roller seat circle, and the seat bottom touches it.
    let closest = Infinity;
    for (const [x, y] of r.outline![0]) closest = Math.min(closest, Math.hypot(x - pitchR, y));
    expect(closest).toBeGreaterThan(seatR - 1e-6);
    expect(closest).toBeLessThan(seatR + 1e-6);
  });

  it('thickness and chamfer options', () => {
    const base = { ...defaultParams(sprocket), hubHeight: 0, boreType: 'none' };
    const auto = check({ ...base, chamfer: false });
    expect(info(auto.r, 'Thickness')).toBeCloseTo(0.93 * 3.18, 2);
    const custom = check({ ...base, thickness: 2, chamfer: false });
    expect(info(custom.r, 'Total height')).toBeCloseTo(2, 5);
    const chamfered = check({ ...base, thickness: 2, chamfer: true });
    expect(chamfered.e.stats.volume).toBeLessThan(custom.e.stats.volume);
    expect(chamfered.e.stats.volume).toBeGreaterThan(custom.e.stats.volume * 0.8);
  });
});
