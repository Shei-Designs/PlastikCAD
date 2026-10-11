import { beforeAll, describe, expect, it } from 'vitest';
import type { PartNode } from '../model/types';
import { evaluate, initKernel } from './evaluate';
import { getGenerator } from './generators';
import { defaultParams, sanitizeParams } from './generators/types';
import { mateKinds, mateOf } from './mates';
import type { MateRequest } from './mates';
import { QUALITY, rotate, translate } from './types';
import type { Solid } from './types';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.normal;
type P = Record<string, number | string | boolean>;

function part(id: string, params: P, rz = 0): PartNode {
  const def = getGenerator(id);
  return { id: 'src', type: 'part', name: def.name, part: id, params: sanitizeParams(def, { ...defaultParams(def), ...params }), natural: [1, 1, 1], pos: [0, 0, 0], rot: [0, 0, rz], size: [1, 1, 1], hole: false, color: '#fff' };
}

/** A part's solid turned about its generator's origin and moved, as the mate's offset and rotation describe. */
function placed(id: string, params: P, rz: number, dx = 0, dy = 0): Solid {
  const def = getGenerator(id);
  const built = def.build(sanitizeParams(def, { ...defaultParams(def), ...params }), q).solid;
  return translate(rotate(built, [0, 0, rz]), [dx, dy, 0]);
}

const volume = (a: Solid): number => evaluate(a).stats.volume;
/** Shared volume of two solids, by inclusion–exclusion so that an empty overlap is a plain zero. */
const overlap = (a: Solid, b: Solid): number => Math.max(0, volume(a) + volume(b) - evaluate({ op: 'union', children: [a, b] }).stats.volume);

function check(sourceId: string, sourceParams: P, rz: number, req: MateRequest) {
  const source = part(sourceId, sourceParams, rz);
  const mate = mateOf(source, req);
  const a = placed(sourceId, sourceParams, rz);
  const b = placed(mate.part, mate.params as P, mate.rotation, mate.offset[0], mate.offset[1]);
  return { mate, a, b };
}

describe('mating gears', () => {
  it('knows what each kind can mate with', () => {
    expect(mateKinds('spur')).toEqual(['gear', 'ring', 'rack']);
    expect(mateKinds('helical')).toEqual(['gear']);
    expect(mateKinds('worm')).toEqual([]);
  });

  it('places a spur pair at the center distance with the teeth meshed, from any side and any turn of the gear', () => {
    for (const [z1, z2, rz, angle] of [
      [20, 40, 0, 0],
      [20, 40, 0, 37],
      [20, 40, 7, 200],
      [20, 40, 13.5, -90],
      [15, 25, 11, 50],
    ]) {
      const { mate, a, b } = check('spur', { module: 2, teeth: z1, backlash: 0 }, rz, { kind: 'gear', teeth: z2, backlash: 0, extra: 0, angle });
      expect(mate.center).toBeCloseTo(z1 + z2, 6);
      expect(mate.ratio).toBeCloseTo(z2 / z1, 9);
      // Flanks touch at zero backlash, so faceting leaves a trace of overlap; an eighth of a tooth on, they crash.
      expect(overlap(a, b), `${z1}:${z2} rz ${rz} angle ${angle}`).toBeLessThan(0.01);
      const crashed = placed('spur', mate.params as P, mate.rotation + 360 / z2 / 8, mate.offset[0], mate.offset[1]);
      expect(overlap(a, crashed), `${z1}:${z2} rz ${rz} angle ${angle} crash`).toBeGreaterThan(10);
    }
  });

  it('backs the pair off by the extra distance and thins the mate by the backlash', () => {
    const tight = check('spur', { module: 2, teeth: 20, backlash: 0 }, 0, { kind: 'gear', teeth: 30, backlash: 0, extra: 0, angle: 0 });
    const loose = check('spur', { module: 2, teeth: 20, backlash: 0 }, 0, { kind: 'gear', teeth: 30, backlash: 0.2, extra: 0.2, angle: 0 });
    expect(loose.mate.center).toBeCloseTo(tight.mate.center + 0.2, 6);
    expect(volume(loose.b)).toBeLessThan(volume(tight.b));
    expect(overlap(loose.a, loose.b)).toBeLessThan(1e-4);
  });

  it('gives a shifted pinion its working center distance', () => {
    const { mate, a, b } = check('spur', { module: 2, teeth: 12, profileShift: 0.4, backlash: 0 }, 0, { kind: 'gear', teeth: 30, backlash: 0, extra: 0, angle: 0 });
    expect(mate.center).toBeGreaterThan(42);
    expect(mate.center).toBeLessThan(43);
    expect(overlap(a, b)).toBeLessThan(0.01);
  });

  it('mates helical and herringbone gears with the opposite hand', () => {
    for (const kind of ['helical', 'herringbone']) {
      const { mate, a, b } = check(kind, { module: 2, teeth: 24, helixAngle: 20, backlash: 0 }, 0, { kind: 'gear', teeth: 36, backlash: 0, extra: 0, angle: 30 });
      expect(mate.part).toBe(kind);
      expect(mate.params.hand).toBe('left');
      expect(mate.center).toBeCloseTo((2 / Math.cos((20 * Math.PI) / 180)) * 30, 6);
      expect(overlap(a, b), kind).toBeLessThan(0.01);
      const crashed = placed(kind, mate.params as P, mate.rotation + 360 / 36 / 8, mate.offset[0], mate.offset[1]);
      expect(overlap(a, crashed), `${kind} crash`).toBeGreaterThan(10);
    }
  });

  it('puts a pinion inside a ring', () => {
    for (const [z2, rz, angle] of [
      [48, 0, 0],
      [47, 9, 75],
    ]) {
      const ring = check('spur', { module: 2, teeth: 16, backlash: 0 }, rz, { kind: 'ring', teeth: z2, backlash: 0.1, extra: 0, angle });
      expect(ring.mate.part).toBe('ring');
      expect(ring.mate.center).toBeCloseTo(z2 - 16, 6);
      expect(ring.mate.params.sunTeeth).toBe(16);
      expect(overlap(ring.a, ring.b), `ring ${z2}`).toBeLessThan(0.05);
      const crashed = placed('ring', ring.mate.params as P, ring.mate.rotation + 360 / z2 / 8, ring.mate.offset[0], ring.mate.offset[1]);
      expect(overlap(ring.a, crashed), `ring ${z2} crash`).toBeGreaterThan(10);
    }
  });

  it('lays a rack along a gear, centered on it to the nearest tooth', () => {
    for (const [teeth, rz, angle] of [
      [12, 0, -90],
      [12, 5, 0],
      [11, -7, 123],
    ]) {
      const rack = check('spur', { module: 2, teeth: 20, backlash: 0 }, rz, { kind: 'rack', teeth, backlash: 0.1, extra: 0, angle });
      expect(rack.mate.part).toBe('rack');
      expect(rack.mate.center).toBeCloseTo(20, 6);
      expect(overlap(rack.a, rack.b), `rack ${rz} ${angle}`).toBeLessThan(0.05);
      // The rack's middle lies within half a pitch of the line of centers.
      const across = [Math.cos(((angle + 90) * Math.PI) / 180), Math.sin(((angle + 90) * Math.PI) / 180)];
      const middle = rack.mate.offset[0] * across[0] + rack.mate.offset[1] * across[1] + (teeth * Math.PI * 2) / 2;
      expect(Math.abs(middle)).toBeLessThanOrEqual(Math.PI + 1e-9);
      const eighth = (Math.PI * 2) / 8;
      const crashed = placed('rack', rack.mate.params as P, rack.mate.rotation, rack.mate.offset[0] + across[0] * eighth, rack.mate.offset[1] + across[1] * eighth);
      expect(overlap(rack.a, crashed), `rack crash ${rz} ${angle}`).toBeGreaterThan(10);
    }
  });

  it('warns about a gear it cannot fully honor', () => {
    const tilted = { ...part('spur', { teeth: 20 }), rot: [90, 0, 0] as [number, number, number] };
    expect(mateOf(tilted, { kind: 'gear', teeth: 20, backlash: 0, extra: 0, angle: 0 }).warnings[0]).toMatch(/tilted/);
    const resized = { ...part('spur', { teeth: 20 }), size: [2, 2, 1] as [number, number, number] };
    expect(mateOf(resized, { kind: 'gear', teeth: 20, backlash: 0, extra: 0, angle: 0 }).warnings[0]).toMatch(/resized/);
    expect(mateOf(part('spur', { teeth: 20 }), { kind: 'ring', teeth: 22, backlash: 0, extra: 0, angle: 0 }).warnings[0]).toMatch(/more teeth/);
  });
});
