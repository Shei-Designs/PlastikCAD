import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { signedArea } from '../math2d';
import { QUALITY } from '../types';
import { CUTOUTS, CUTOUT_LENGTH, PANEL_CONNECTORS, cutoutOutline, panelConnector } from './cutouts';
import { defaultParams } from './types';
import type { GeneratorDef, Params } from './types';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.normal;
const params = (def: GeneratorDef, over: Params = {}): Params => ({ ...defaultParams(def), ...over });
const made = (def: GeneratorDef, over: Params = {}) => {
  const r = def.build(params(def, over), q);
  return { ...r, stats: evaluate(r.solid).stats };
};
const extent = (s: { min: number[]; max: number[] }, axis: number) => s.max[axis] - s.min[axis];
const disc = (d: number) => (Math.PI / 4) * d * d;

describe('panel cutouts', () => {
  it('builds every table entry', () => {
    for (const c of PANEL_CONNECTORS) expect(made(panelConnector, { connector: c.id }).stats.volume, c.id).toBeGreaterThan(0);
    for (const def of CUTOUTS) expect(def.build(defaultParams(def), q).outline?.length).toBeGreaterThan(0);
  });

  it('cuts a panel connector with its screw holes, lying flat and centered on the wall', () => {
    const c14 = PANEL_CONNECTORS.find((c) => c.id === 'iec-c14')!;
    const z = made(panelConnector, { connector: 'iec-c14', clearance: 0.3, holes: true });
    expect(extent(z.stats, 0)).toBeCloseTo(c14.holes!.across! + c14.holes!.d + 0.6, 2);
    expect(extent(z.stats, 1)).toBeCloseTo(c14.cutout.h + 0.6, 2);
    expect(extent(z.stats, 2)).toBeCloseTo(CUTOUT_LENGTH, 6);
    expect(z.stats.min[2]).toBeCloseTo(-CUTOUT_LENGTH / 2, 6);
    const plain = made(panelConnector, { connector: 'iec-c14', clearance: 0.3, holes: false });
    expect(extent(plain.stats, 0)).toBeCloseTo(c14.cutout.w + 0.6, 2);
    expect(z.stats.volume - plain.stats.volume).toBeCloseTo(2 * disc(c14.holes!.d + 0.6) * CUTOUT_LENGTH, -1);
  });

  it('draws the D-sub as a trapezoid, narrower below, and the Neutrik holes above and below', () => {
    const db9 = PANEL_CONNECTORS.find((c) => c.id === 'db9')!;
    const shape = cutoutOutline(db9.cutout, 0, q);
    expect(signedArea(shape)).toBeGreaterThan(0);
    const top = Math.max(...shape.filter(([, y]) => y > 0).map(([x]) => x));
    const bottom = Math.max(...shape.filter(([, y]) => y < 0).map(([x]) => x));
    expect(top).toBeGreaterThan(bottom);
    const neutrik = PANEL_CONNECTORS.find((c) => c.id === 'neutrik-d')!;
    const r = made(panelConnector, { connector: 'neutrik-d', clearance: 0, holes: true });
    expect(extent(r.stats, 1)).toBeCloseTo(Math.max(neutrik.cutout.h, neutrik.holes!.up! + neutrik.holes!.d), 2);
    expect(extent(r.stats, 0)).toBeCloseTo(neutrik.cutout.w, 2);
  });

  it('cuts the C8 inlet as a stepped opening', () => {
    const c8 = PANEL_CONNECTORS.find((c) => c.id === 'iec-c8')!;
    const r = made(panelConnector, { connector: 'iec-c8', clearance: 0 });
    expect(extent(r.stats, 0)).toBeCloseTo(c8.wings!.w, 3);
    expect(extent(r.stats, 1)).toBeCloseTo(c8.cutout.h, 3);
    expect(r.stats.volume).toBeCloseTo((c8.cutout.w * c8.cutout.h + (c8.wings!.w - c8.cutout.w) * c8.wings!.h) * CUTOUT_LENGTH, 3);
  });
});
