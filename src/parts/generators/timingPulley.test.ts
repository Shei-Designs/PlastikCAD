import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { selfIntersects, signedArea } from '../math2d';
import { QUALITY } from '../types';
import { beltSection, gt2Pulley, htdPulley, mxlPulley, tPulley } from './timingPulley';
import { defaultParams, num } from './types';
import type { BuildResult, GeneratorDef, Params } from './types';
import type { Polygon } from '../types';

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

  it('backs the tooth clearance off when the grooves would overlap', () => {
    const r = tPulley.build({ ...defaultParams(tPulley), profile: 'T2.5', teeth: 10, toothClearance: 0.5 }, q);
    expect(r.warnings.join(' ')).toMatch(/clearance was reduced/);
    expect(evaluate(r.solid).stats.volume).toBeGreaterThan(0);
    expect(selfIntersects(r.outline![0])).toBe(false);
  });
});

/** The half-width of a groove or tooth `depth` below its land, from points (s across it, d below the land) on its s >= 0 side. */
function halfWidthAt(points: [number, number][], depth: number): number {
  const side = points.filter(([s]) => s >= -1e-9).sort((a, b) => a[1] - b[1]);
  for (let i = 1; i < side.length; i++) {
    const [s0, d0] = side[i - 1];
    const [s1, d1] = side[i];
    if (d0 <= depth && d1 >= depth && d1 > d0) return s0 + ((depth - d0) / (d1 - d0)) * (s1 - s0);
  }
  throw new Error(`No point ${depth} deep`);
}

describe('timing belt section', () => {
  const profile = beltSection.groups[0].params.find((d) => d.key === 'profile');
  if (!profile || profile.type !== 'select') throw new Error('profile select missing');

  function section(p: Params) {
    const r = beltSection.build({ ...defaultParams(beltSection), ...p }, q);
    const outline = r.outline![0];
    expect(signedArea(outline)).toBeGreaterThan(0);
    expect(selfIntersects(outline)).toBe(false);
    const e = evaluate(r.solid);
    expect(e.stats.min[0]).toBeCloseTo(0, 6);
    expect(e.stats.max[0]).toBeCloseTo(info(r, 'Length'), 2);
    expect(e.stats.min[1]).toBeCloseTo(0, 6);
    expect(e.stats.max[1]).toBeCloseTo(info(r, 'Thickness'), 2);
    expect(e.stats.min[2]).toBeCloseTo(0, 6);
    expect(e.stats.max[2]).toBeCloseTo(info(r, 'Width'), 2);
    return { r, outline, e };
  }

  for (const option of profile.options) {
    for (const teeth of [1, 10]) {
      for (const clearance of [0, 0.1, 0.3]) {
        it(`${option.value} ${teeth}T clearance ${clearance}`, () => {
          const { r, outline } = section({ profile: option.value, teeth, clearance });
          expect(r.warnings).toEqual([]);
          // A tip at y = 0 in the middle of every pitch, a round tooth's a point and a flat one's a flat centred there.
          const pitch = info(r, 'Belt pitch');
          const tips = new Map<number, number[]>();
          for (const [x, y] of outline) if (Math.abs(y) < 1e-9) tips.set(Math.floor(x / pitch), [...(tips.get(Math.floor(x / pitch)) ?? []), x]);
          expect([...tips.keys()].sort((a, b) => a - b)).toEqual([...Array(teeth).keys()]);
          for (const [i, xs] of tips) expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo((i + 0.5) * pitch, 6);
        });
      }
    }
  }

  it('has the teeth of the pulley grooves, the backing behind them and the clearance on every side', () => {
    const { r } = section({ profile: 'GT2-2', teeth: 10, beltWidth: 6, clearance: 0 });
    expect(info(r, 'Length')).toBeCloseTo(20, 6);
    expect(info(r, 'Thickness')).toBeCloseTo(1.52, 6); // 0.76 tooth + 0.76 backing
    expect(info(r, 'Width')).toBeCloseTo(6, 6);
    const loose = section({ profile: 'GT2-2', teeth: 10, beltWidth: 6, clearance: 0.2 });
    expect(info(loose.r, 'Thickness')).toBeCloseTo(1.92, 6);
    expect(info(loose.r, 'Width')).toBeCloseTo(6.4, 6);
    expect(loose.e.stats.volume).toBeGreaterThan(evaluate(r.solid).stats.volume);
  });

  it('backs the clearance off when neighbouring teeth would meet', () => {
    const r = beltSection.build({ ...defaultParams(beltSection), profile: 'GT2-2', teeth: 4, clearance: 1 }, q);
    expect(r.warnings.join(' ')).toMatch(/clearance was reduced/);
    expect(selfIntersects(r.outline![0])).toBe(false);
    expect(evaluate(r.solid).stats.volume).toBeGreaterThan(0);
  });

  // A section's tooth is the groove of the pulley of the same profile and clearance, unrolled: below the fillet
  // where it meets the land the two are the same shape. Measured on a large pulley, whose rim is nearly straight.
  const pulleys: [GeneratorDef, string, string][] = [
    [gt2Pulley, '2', 'GT2-2'],
    [gt2Pulley, '5', 'GT2-5'],
    [htdPulley, '5M', '5M'],
    [tPulley, 'T5', 'T5'],
    [mxlPulley, 'XL', 'XL'],
  ];
  for (const [def, pulleyProfile, sectionProfile] of pulleys) {
    it(`a ${sectionProfile} tooth matches the ${def.id} ${pulleyProfile} groove`, () => {
      for (const clearance of [0, 0.1]) {
        const pr = def.build({ ...defaultParams(def), profile: pulleyProfile, teeth: 200, toothClearance: clearance, flanges: 'none', hubHeight: 0, boreType: 'none' }, q);
        const ro = Math.max(...pr.outline![0].map(([x, y]) => Math.hypot(x, y)));
        const step = (2 * Math.PI) / 200;
        const groove = pr.outline![0].filter(([x, y]) => Math.abs(Math.atan2(y, x)) < step / 2 && x < ro - 1e-6).map(([x, y]): [number, number] => [y, ro - x]);
        const sr = section({ profile: sectionProfile, teeth: 3, clearance });
        const pitch = info(sr.r, 'Belt pitch');
        const grooveDepth = Math.max(...groove.map(([, d]) => d));
        // The section's land is where its middle tooth meets the backing; its tooth hangs below it.
        const middle = (sr.outline as Polygon).filter(([x]) => x > pitch && x < 2 * pitch);
        const landY = Math.max(...middle.map(([, y]) => y));
        const tooth = middle.map(([x, y]): [number, number] => [x - 1.5 * pitch, landY - y]);
        expect(Math.max(...tooth.map(([, d]) => d))).toBeCloseTo(grooveDepth, 6);
        for (const share of [0.5, 0.8]) {
          expect(Math.abs(halfWidthAt(tooth, share * grooveDepth) - halfWidthAt(groove, share * grooveDepth))).toBeLessThan(0.01);
        }
      }
    });
  }
});
