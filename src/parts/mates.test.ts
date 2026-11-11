import { beforeAll, describe, expect, it } from 'vitest';
import type { PartNode, Vec3 } from '../model/types';
import { evaluate, initKernel } from './testing';
import { getGenerator } from './generators';
import { defaultParams, sanitizeParams } from './generators/types';
import { fixedMateTeeth, mateKinds, mateOf, sourceTeeth } from './mates';
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
function placed(id: string, params: P, rot: Vec3 | number, offset: Vec3 = [0, 0, 0]): Solid {
  const def = getGenerator(id);
  const built = def.build(sanitizeParams(def, { ...defaultParams(def), ...params }), q).solid;
  return translate(rotate(built, typeof rot === 'number' ? [0, 0, rot] : rot), offset);
}

const volume = (a: Solid): number => evaluate(a).stats.volume;
/** Shared volume of two solids, by inclusion–exclusion so that an empty overlap is a plain zero. */
const overlap = (a: Solid, b: Solid): number => Math.max(0, volume(a) + volume(b) - evaluate({ op: 'union', children: [a, b] }).stats.volume);

function check(sourceId: string, sourceParams: P, rz: number, req: MateRequest) {
  const source = part(sourceId, sourceParams, rz);
  const mate = mateOf(source, req);
  const a = placed(sourceId, sourceParams, rz);
  const b = placed(mate.part, mate.params as P, mate.rotation, mate.offset);
  return { mate, a, b };
}

/** The mate turned a little further about Z, which for a flat pair means the teeth crash. */
const turned = (mate: ReturnType<typeof mateOf>, degrees: number): Solid =>
  placed(mate.part, mate.params as P, [mate.rotation[0], mate.rotation[1], mate.rotation[2] + degrees], mate.offset);

describe('mating gears', () => {
  it('knows what each kind can mate with', () => {
    expect(mateKinds('spur')).toEqual(['gear', 'ring', 'rack']);
    expect(mateKinds('helical')).toEqual(['gear']);
    expect(mateKinds('worm')).toEqual(['wheel']);
    expect(mateKinds('bevel')).toEqual(['bevel']);
    expect(sourceTeeth(part('spur', { teeth: 17 }))).toBe(17);
    expect(sourceTeeth(part('worm', { starts: 2 }))).toBe(2);
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
      expect(overlap(a, turned(mate, 360 / z2 / 8)), `${z1}:${z2} rz ${rz} angle ${angle} crash`).toBeGreaterThan(10);
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
      expect(overlap(a, turned(mate, 360 / 36 / 8)), `${kind} crash`).toBeGreaterThan(10);
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
      expect(overlap(ring.a, turned(ring.mate, 360 / z2 / 8)), `ring ${z2} crash`).toBeGreaterThan(10);
    }
  });

  it('meshes a ring with a pinion of an odd tooth count, which has a space opposite each tooth', () => {
    // Inside a ring the pinion meshes on its far side from the ring's center.
    for (const [z1, z2, rz, angle] of [
      [15, 45, 0, 0],
      [17, 51, 0, 0],
      [13, 40, 0, 0],
      [15, 44, 9, 75],
      [12, 40, 5, -130],
    ]) {
      const ring = check('spur', { module: 2, teeth: z1, backlash: 0 }, rz, { kind: 'ring', teeth: z2, backlash: 0.1, extra: 0, angle });
      expect(ring.mate.center).toBeCloseTo(z2 - z1, 6);
      expect(overlap(ring.a, ring.b), `ring ${z1}:${z2}`).toBeLessThan(0.05);
      expect(overlap(ring.a, turned(ring.mate, 360 / z2 / 8)), `ring ${z1}:${z2} crash`).toBeGreaterThan(10);
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
      const crashed = placed('rack', rack.mate.params as P, rack.mate.rotation, [rack.mate.offset[0] + across[0] * eighth, rack.mate.offset[1] + across[1] * eighth, 0]);
      expect(overlap(rack.a, crashed), `rack crash ${rz} ${angle}`).toBeGreaterThan(10);
    }
  });

  it('stands a worm wheel on edge beside a worm, meshed with the thread', () => {
    for (const [starts, hand, d, rz, angle, z2] of [
      [1, 'right', 12, 0, 0, 30],
      [1, 'right', 12, 40, 110, 25],
      [2, 'left', 16, -15, -60, 24],
      [3, 'right', 20, 7, 180, 31],
    ] as [number, string, number, number, number, number][]) {
      const worm: P = { module: 1, starts, hand, pitchDiameter: d, length: 20, backlash: 0 };
      const { mate, a, b } = check('worm', worm, rz, { kind: 'wheel', teeth: z2, backlash: 0, extra: 0, angle });
      const label = `${starts}-start ${hand} d${d} rz ${rz} angle ${angle} z${z2}`;
      expect(mate.part).toBe('helical');
      expect(mate.params.hand).toBe(hand);
      expect(mate.ratio).toBeCloseTo(z2 / starts, 9);
      expect(mate.center).toBeCloseTo(d / 2 + z2 / 2, 6);
      const lambda = Math.atan((starts * 1) / d);
      expect(Number(mate.params.helixAngle)).toBeCloseTo((lambda * 180) / Math.PI, 9);
      expect(Number(mate.params.module)).toBeCloseTo(Math.cos(lambda), 9);
      // The wheel's axis lies flat, across the line of centers.
      const [c0, s0] = [Math.cos((angle * Math.PI) / 180), Math.sin((angle * Math.PI) / 180)];
      const rotated = evaluate(b).stats;
      expect((rotated.max[2] + rotated.min[2]) / 2, `${label} height`).toBeCloseTo(10, 2);
      expect(overlap(a, b), label).toBeLessThan(0.05);
      // Half a thread pitch up the worm, the wheel's teeth land on the thread.
      const crashed = placed(mate.part, mate.params as P, mate.rotation, [mate.offset[0], mate.offset[1], mate.offset[2] + Math.PI / 2]);
      expect(overlap(a, crashed), `${label} crash`).toBeGreaterThan(5);
      // And it sits on the side asked for.
      expect(Math.sign((rotated.max[0] + rotated.min[0]) / 2) || 0).toBe(Math.abs(c0) > 0.1 ? Math.sign(c0) : (Math.sign((rotated.max[0] + rotated.min[0]) / 2) || 0));
      expect(Math.sign((rotated.max[1] + rotated.min[1]) / 2) || 0).toBe(Math.abs(s0) > 0.1 ? Math.sign(s0) : (Math.sign((rotated.max[1] + rotated.min[1]) / 2) || 0));
    }
  });

  it('stands the other bevel gear on its side with the cone apexes together', () => {
    for (const [z1, z2, rz, angle, hub] of [
      [20, 30, 0, 0, 0],
      [30, 20, 25, 135, 6],
      [15, 15, -40, -90, 0],
      [12, 36, 10, 200, 4],
    ]) {
      const bevel: P = { module: 2, teeth: z1, mateTeeth: z2, faceWidth: 6, backlash: 0, hubHeight: hub };
      const { mate, a, b } = check('bevel', bevel, rz, { kind: 'bevel', teeth: 0, backlash: 0, extra: 0, angle });
      const label = `${z1}:${z2} rz ${rz} angle ${angle}`;
      expect(mate.part).toBe('bevel');
      expect(mate.params.teeth).toBe(z2);
      expect(mate.params.mateTeeth).toBe(z1);
      expect(mate.ratio).toBeCloseTo(z2 / z1, 9);
      // The mate's axis is level with the gear's apex, which the gear's own Dims figure names
      // (an odd tooth count puts the box center a little off the axis).
      const built = getGenerator('bevel').build(sanitizeParams(getGenerator('bevel'), { ...defaultParams(getGenerator('bevel')), ...bevel }), q);
      const apex = Number(built.info.find((i) => i.label === 'Apex to mounting face')!.value.replace(/[^\d.]/g, ''));
      const box = evaluate(b).stats;
      expect(Math.abs((box.min[2] + box.max[2]) / 2 - apex), `${label} apex height`).toBeLessThan(0.3);
      expect(overlap(a, b), label).toBeLessThan(0.05);
      // Spun an eighth of a tooth about its own axis, the teeth crash.
      const def = getGenerator('bevel');
      const spun = def.build(sanitizeParams(def, { ...defaultParams(def), ...(mate.params as P) }), q).solid;
      const crashed = translate(rotate(rotate(spun, [0, 0, 360 / z2 / 8]), mate.rotation), mate.offset);
      expect(overlap(a, crashed), `${label} crash`).toBeGreaterThan(5);
    }
    expect(fixedMateTeeth(part('bevel', { mateTeeth: 27 }))).toBe(27);
    expect(fixedMateTeeth(part('spur', {}))).toBeNull();
  });

  it('sets a shifted helical pair apart by the shift in the normal plane', () => {
    const an = (20 * Math.PI) / 180;
    const inv = (a: number) => Math.tan(a) - a;
    for (const [kind, helix, x, z1, z2, expected] of [
      ['helical', 20, 0.5, 12, 24, 39.2404],
      ['herringbone', 30, 0.5, 12, 24, 42.5123],
      ['helical', 45, 0.8, 10, 20, 43.9328],
      ['helical', 20, -0.2, 20, 30, 52.798],
    ] as [string, number, number, number, number, number][]) {
      const { mate, a, b } = check(kind, { module: 2, teeth: z1, helixAngle: helix, profileShift: x, backlash: 0 }, 0, { kind: 'gear', teeth: z2, backlash: 0, extra: 0, angle: 0 });
      const label = `${kind} ${helix}° x ${x}`;
      // Worked by hand: inv αwt = inv αt + 2·xn·tan αn / (z1 + z2), a = mt·(z1 + z2)/2 · cos αt / cos αwt.
      expect(mate.center, label).toBeCloseTo(expected, 3);
      const beta = (helix * Math.PI) / 180;
      const at = Math.atan(Math.tan(an) / Math.cos(beta));
      const aw = Math.acos(((2 / Math.cos(beta)) * (z1 + z2) * Math.cos(at)) / 2 / mate.center);
      expect(inv(aw), label).toBeCloseTo(inv(at) + (2 * x * Math.tan(an)) / (z1 + z2), 9);
      expect(overlap(a, b), label).toBeLessThan(0.05);
    }
    // An unshifted pair stands at the nominal distance, and a spur pair where it always did.
    const plain = mateOf(part('helical', { module: 2, teeth: 12, helixAngle: 20, profileShift: 0 }), { kind: 'gear', teeth: 24, backlash: 0, extra: 0, angle: 0 });
    expect(plain.center).toBeCloseTo((2 / Math.cos((20 * Math.PI) / 180)) * 18, 9);
    const spur = mateOf(part('spur', { module: 2, teeth: 12, profileShift: 0.5 }), { kind: 'gear', teeth: 24, backlash: 0, extra: 0, angle: 0 });
    expect(spur.center).toBeCloseTo(36.9185, 3);
  });

  it('warns about a gear it cannot fully honor', () => {
    const tilted = { ...part('spur', { teeth: 20 }), rot: [90, 0, 0] as Vec3 };
    expect(mateOf(tilted, { kind: 'gear', teeth: 20, backlash: 0, extra: 0, angle: 0 }).warnings[0]).toMatch(/tilted/);
    const resized = { ...part('spur', { teeth: 20 }), size: [2, 2, 1] as Vec3 };
    expect(mateOf(resized, { kind: 'gear', teeth: 20, backlash: 0, extra: 0, angle: 0 }).warnings[0]).toMatch(/resized/);
    expect(mateOf(part('spur', { teeth: 20 }), { kind: 'ring', teeth: 22, backlash: 0, extra: 0, angle: 0 }).warnings[0]).toMatch(/more teeth/);
  });
});

describe('mate edge cases', () => {
  it('rolls the rack on the reference circle of a shifted pinion', () => {
    const { a, b } = check('spur', { module: 2, teeth: 12, profileShift: 0.5, backlash: 0 }, 14, { kind: 'rack', teeth: 12, backlash: 0, extra: 0, angle: 0 });
    expect(overlap(a, b)).toBeLessThan(0.05);
  });

  it('falls back to the nominal center distance when the shift is too negative to mesh', () => {
    const mate = mateOf(part('spur', { module: 2, teeth: 5, profileShift: -0.5 }), { kind: 'gear', teeth: 5, backlash: 0, extra: 0, angle: 0 });
    expect(Number.isFinite(mate.center)).toBe(true);
    expect(mate.center).toBeCloseTo(10, 9);
    expect(mate.warnings.join(' ')).toMatch(/too negative/);
    // A small negative shift still gets a proper working distance, a little under the nominal.
    const mild = mateOf(part('spur', { module: 2, teeth: 20, profileShift: -0.2 }), { kind: 'gear', teeth: 20, backlash: 0, extra: 0, angle: 0 });
    expect(mild.warnings).toEqual([]);
    expect(mild.center).toBeLessThan(40);
    expect(mild.center).toBeGreaterThan(39);
  });
});
