import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../evaluate';
import { signedArea } from '../math2d';
import { QUALITY } from '../types';
import { CUTOUTS, FANS, PANEL_CONNECTORS, cutoutOutline, fan, panelConnector } from './cutouts';
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
  it('builds every kind, every table entry, each way through', () => {
    for (const c of PANEL_CONNECTORS) for (const through of ['x', 'y', 'z']) expect(made(panelConnector, { connector: c.id, through }).stats.volume, `${c.id} ${through}`).toBeGreaterThan(0);
    for (const f of FANS) for (const opening of ['round', 'guard', 'none']) expect(made(fan, { size: String(f.size), opening }).stats.volume, `${f.size} ${opening}`).toBeGreaterThan(0);
    for (const def of CUTOUTS) expect(def.build(defaultParams(def), q).outline?.length).toBeGreaterThan(0);
  });

  it('cuts a panel connector with its screw holes, laid through the chosen wall', () => {
    const c14 = PANEL_CONNECTORS.find((c) => c.id === 'iec-c14')!;
    const z = made(panelConnector, { connector: 'iec-c14', clearance: 0.3, depth: 20, through: 'z', holes: true });
    expect(extent(z.stats, 0)).toBeCloseTo(c14.holes!.across! + c14.holes!.d + 0.6, 2);
    expect(extent(z.stats, 1)).toBeCloseTo(c14.cutout.h + 0.6, 2);
    expect(extent(z.stats, 2)).toBeCloseTo(20, 6);
    const plain = made(panelConnector, { connector: 'iec-c14', clearance: 0.3, depth: 20, through: 'z', holes: false });
    expect(extent(plain.stats, 0)).toBeCloseTo(c14.cutout.w + 0.6, 2);
    expect(z.stats.volume - plain.stats.volume).toBeCloseTo(2 * disc(c14.holes!.d + 0.6) * 20, -1);
    // Through a front wall the height stands up Z and the cut runs along Y; a side wall swaps X and Y.
    const y = made(panelConnector, { connector: 'iec-c14', clearance: 0.3, depth: 20, through: 'y', holes: false });
    expect(extent(y.stats, 2)).toBeCloseTo(c14.cutout.h + 0.6, 2);
    expect(extent(y.stats, 1)).toBeCloseTo(20, 6);
    const x = made(panelConnector, { connector: 'iec-c14', clearance: 0.3, depth: 20, through: 'x', holes: false });
    expect(extent(x.stats, 1)).toBeCloseTo(c14.cutout.w + 0.6, 2);
    expect(extent(x.stats, 0)).toBeCloseTo(20, 6);
  });

  it('draws the D-sub as a trapezoid, narrower below, and the Neutrik holes above and below', () => {
    const db9 = PANEL_CONNECTORS.find((c) => c.id === 'db9')!;
    const shape = cutoutOutline(db9.cutout, 0, q);
    expect(signedArea(shape)).toBeGreaterThan(0);
    const top = Math.max(...shape.filter(([, y]) => y > 0).map(([x]) => x));
    const bottom = Math.max(...shape.filter(([, y]) => y < 0).map(([x]) => x));
    expect(top).toBeGreaterThan(bottom);
    const neutrik = PANEL_CONNECTORS.find((c) => c.id === 'neutrik-d')!;
    const r = made(panelConnector, { connector: 'neutrik-d', clearance: 0, through: 'z', holes: true });
    expect(extent(r.stats, 1)).toBeCloseTo(Math.max(neutrik.cutout.h, neutrik.holes!.up! + neutrik.holes!.d), 2);
    expect(extent(r.stats, 0)).toBeCloseTo(neutrik.cutout.w, 2);
  });

  it('makes a fan opening with four holes, and a guard that leaves rings and spokes in the wall', () => {
    const f80 = FANS.find((f) => f.size === 80)!;
    const round = made(fan, { size: '80', opening: 'round', clearance: 0, through: 'z', depth: 10 });
    expect(extent(round.stats, 0)).toBeCloseTo(Math.max(f80.opening, f80.spacing + f80.hole), 2);
    expect(round.stats.volume).toBeCloseTo((disc(f80.opening) + 4 * disc(f80.hole)) * 10, -2);
    const holesOnly = made(fan, { size: '80', opening: 'none', clearance: 0, through: 'z', depth: 10 });
    expect(holesOnly.stats.volume).toBeCloseTo(4 * disc(f80.hole) * 10, 0);
    const guard = made(fan, { size: '80', opening: 'guard', clearance: 0, through: 'z', depth: 10, bar: 2, gap: 6 });
    expect(guard.stats.volume).toBeLessThan(round.stats.volume * 0.8);
    expect(guard.stats.volume).toBeGreaterThan(holesOnly.stats.volume);
  });

  it('cuts the C8 inlet as a stepped opening', () => {
    const c8 = PANEL_CONNECTORS.find((c) => c.id === 'iec-c8')!;
    const r = made(panelConnector, { connector: 'iec-c8', clearance: 0, through: 'z', depth: 10 });
    expect(extent(r.stats, 0)).toBeCloseTo(c8.wings!.w, 3);
    expect(extent(r.stats, 1)).toBeCloseTo(c8.cutout.h, 3);
    expect(r.stats.volume).toBeCloseTo((c8.cutout.w * c8.cutout.h + (c8.wings!.w - c8.cutout.w) * c8.wings!.h) * 10, 3);
  });
});
