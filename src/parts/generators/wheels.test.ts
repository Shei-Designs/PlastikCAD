import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { difference, mirror, QUALITY, revolve, translate } from '../types';
import type { Solid } from '../types';
import type { Vec2, Vec3 } from '../types';
import { CATEGORIES, GENERATORS } from './index';
import { defaultParams } from './types';
import type { BuildResult, Params } from './types';
import { MECANUM_SIZES, mecanumRollers, mecanumWheel, rollerOutline, rollerPlace, wheel } from './wheels';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.normal;
const plain = (over: Params = {}): BuildResult => wheel.build({ ...defaultParams(wheel), boreType: 'none', ...over }, q);
const mecanum = (over: Params = {}): BuildResult => mecanumWheel.build({ ...defaultParams(mecanumWheel), boreType: 'none', ...over }, q);
const figures = (over: Params = {}) => mecanumRollers({ ...defaultParams(mecanumWheel), ...over });
const info = (r: BuildResult, label: string): number => parseFloat(r.info.find((i) => i.label === label)?.value ?? '');

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * How far from the axle a roller's surface reaches at each station of its outline: the farthest of the
 * points round the roller there.
 */
function reaches(m: ReturnType<typeof figures>, outline: Vec2[], i = 0): number[] {
  const { center, axis } = rollerPlace(m, i);
  // Two directions square to the roller's axis, to go round it by.
  const u = cross(axis, [0, 0, 1]);
  const ul = Math.hypot(...u);
  const un: Vec3 = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v = cross(axis, un);
  return outline.map(([s, r]) => {
    let far = 0;
    for (let k = 0; k < 720; k++) {
      const a = (Math.PI * k) / 360;
      const x = center[0] + s * axis[0] + r * (Math.cos(a) * un[0] + Math.sin(a) * v[0]);
      const y = center[1] + s * axis[1] + r * (Math.cos(a) * un[1] + Math.sin(a) * v[1]);
      far = Math.max(far, Math.hypot(x, y));
    }
    return far;
  });
}

describe('the wheels family', () => {
  it('holds the plain wheel and the mecanum wheel before anything else', () => {
    expect(CATEGORIES.map((c) => c.id)).toContain('wheels');
    expect(GENERATORS.filter((g) => g.category === 'wheels').slice(0, 2)).toEqual([wheel, mecanumWheel]);
  });
});

describe('plain wheel', () => {
  it('is as wide across as its diameter and as tall as its width, the axle along Z', () => {
    const r = plain();
    expect(r.warnings).toEqual([]);
    const { stats } = evaluate(r.solid);
    expect(stats.max[0] - stats.min[0]).toBeCloseTo(65, 6);
    expect(stats.max[1] - stats.min[1]).toBeCloseTo(65, 6);
    expect(stats.min[2]).toBeCloseTo(0, 6);
    expect(stats.max[2]).toBeCloseTo(26, 6);
    expect(info(r, 'Outside diameter')).toBe(65);
    expect(info(r, 'Travel per turn')).toBeCloseTo(Math.PI * 65, 1);
  });

  it('is a plain cylinder when solid with sharp edges, and lighter dished or rounded', () => {
    const solid = evaluate(plain({ web: 0, edge: 0 }).solid).stats.volume;
    const whole = Math.PI * 32.5 * 32.5 * 26;
    expect(solid / whole).toBeGreaterThan(0.995);
    expect(solid).toBeLessThanOrEqual(whole);
    const rounded = evaluate(plain({ web: 0, edge: 3 }).solid).stats.volume;
    expect(rounded).toBeLessThan(solid);
    // Each rounded edge takes off a ring whose section is a 3 mm square less its quarter circle.
    expect(solid - rounded).toBeCloseTo(2 * (9 - (Math.PI * 9) / 4) * 2 * Math.PI * 31.8, -2);
    const dished = evaluate(plain({ web: 8, edge: 0, rim: 6 }).solid).stats;
    // 9 deep each side, between the boss (15 % of the radius without a bore or a hub) and the rim.
    const recess = 2 * 9 * Math.PI * (26.5 ** 2 - (0.15 * 32.5) ** 2);
    expect((solid - dished.volume) / recess).toBeGreaterThan(0.99);
    expect((solid - dished.volume) / recess).toBeLessThan(1.01);
  });

  it('keeps its width and diameter whatever the edge radius asked for', () => {
    for (const edge of [0, 3, 13, 100]) {
      const { stats } = evaluate(plain({ edge }).solid);
      expect(stats.max[0] - stats.min[0], `edge ${edge}`).toBeCloseTo(65, 6);
      expect(stats.max[2] - stats.min[2], `edge ${edge}`).toBeCloseTo(26, 6);
    }
  });

  it('carries a hub and a bore like the other round parts', () => {
    const r = plain({ hubHeight: 8, hubDiameter: 16, boreType: 'round', boreDiameter: 5 });
    expect(r.warnings).toEqual([]);
    expect(info(r, 'Total height')).toBe(34);
    expect(evaluate(r.solid).stats.max[2]).toBeCloseTo(34, 6);
    expect(r.outline).toHaveLength(2);
  });
});

describe("a mecanum wheel's rollers", () => {
  it('make the circle of the wheel between them, each along the whole of its length', () => {
    for (const size of [...MECANUM_SIZES, 'custom']) {
      const m = figures({ size });
      const outline = rollerOutline(m, 24);
      for (const far of reaches(m, outline)) {
        // The roller touches the wheel's circle at every station and nowhere passes it.
        expect(far, size).toBeLessThanOrEqual(m.radius + 1e-6);
        expect(far, size).toBeGreaterThan(m.radius - 0.01);
      }
    }
  });

  it('are thickest in the middle, as long as the outline says, and sit on the circle the figures give', () => {
    const m = figures();
    expect(m).toMatchObject({ count: 9, radius: 50, width: 50, lean: 1 });
    expect(m.circle + m.rollerRadius).toBeCloseTo(50, 9);
    const outline = rollerOutline(m, 24);
    expect(outline[12][0]).toBeCloseTo(0, 9);
    expect(outline[12][1]).toBeCloseTo(m.rollerRadius, 9);
    expect(outline[24][0] - outline[0][0]).toBeCloseTo(m.rollerLength, 9);
    expect(outline[0][1]).toBeCloseTo(m.endRadius, 9);
    expect(outline[24][1]).toBeCloseTo(m.endRadius, 9);
    expect(m.endRadius).toBeLessThan(m.rollerRadius);
    // Leaning 45°, the roller and its ends stay between the wheel's sides.
    expect(((m.rollerLength / 2 + m.endRadius) * Math.SQRT1_2) * 2).toBeLessThan(m.width);
    const { center } = rollerPlace(m, 0);
    expect(center).toEqual([m.circle, 0, 25]);
  });

  it('lean 45° to the axle, one way on a left wheel and the other on a right one', () => {
    const left = figures({ hand: 'left' });
    const right = figures({ hand: 'right' });
    expect(right.lean).toBe(-1);
    for (const i of [0, 2, 5]) {
      const l = rollerPlace(left, i);
      const r = rollerPlace(right, i);
      expect(Math.hypot(...l.axis)).toBeCloseTo(1, 9);
      // 45° to the axle, and square to the line out from it.
      expect(Math.abs(l.axis[2])).toBeCloseTo(Math.SQRT1_2, 9);
      expect(dot(l.axis, [l.center[0], l.center[1], 0])).toBeCloseTo(0, 9);
      // The other hand is the same wheel seen in a mirror across its middle plane.
      expect(r.center).toEqual(l.center);
      expect(r.axis).toEqual([l.axis[0], l.axis[1], -l.axis[2]]);
    }
    // On a left wheel a roller climbs the axle as it goes round counterclockwise, like a right-handed screw.
    const { axis } = rollerPlace(left, 0);
    expect(axis[1]).toBeGreaterThan(0);
    expect(axis[2]).toBeGreaterThan(0);
  });

  it('cover the whole way round on every size sold, so the wheel never rides on a gap', () => {
    for (const size of MECANUM_SIZES) {
      const m = figures({ size });
      expect(m.reach, size).toBeGreaterThanOrEqual((2 * Math.PI) / m.count);
    }
  });

  it('are fat barrels that nearly touch, as on the wheels sold, and no longer than hands the wheel on', () => {
    for (const size of MECANUM_SIZES) {
      const m = figures({ size });
      // A barrel's ends are well over half as thick as its middle: a long thin roller tapers to a third.
      expect(m.endRadius / m.rollerRadius, size).toBeGreaterThan(0.6);
      // Each takes over from the last with a little to spare, and not much more.
      const share = (2 * Math.PI) / m.count;
      expect(m.reach / share, size).toBeGreaterThan(1.04);
      expect(m.reach / share, size).toBeLessThan(1.25);
      // Middles side by side fill most of the way round the circle they sit on.
      expect((m.count * 2 * m.rollerRadius) / (2 * Math.PI * m.circle * Math.SQRT1_2), size).toBeGreaterThan(0.6);
    }
  });

  it('clear their neighbours', () => {
    for (const size of [...MECANUM_SIZES, 'custom']) {
      const m = figures({ size });
      const L = m.rollerLength;
      const barrel = revolve([[0, -L / 2], ...rollerOutline(m, 12).map(([s, r]): Vec2 => [r, s]), [0, L / 2]], 24);
      const at = (i: number) => ({ op: 'transform' as const, child: { op: 'transform' as const, child: barrel, rotate: [-45 * m.lean, 0, 0] as Vec3, translate: [m.circle, 0, m.width / 2] as Vec3 }, rotate: [0, 0, (360 * i) / m.count] as Vec3 });
      const one = evaluate(at(0)).stats.volume;
      const two = evaluate({ op: 'union', children: [at(0), at(1)] }).stats.volume;
      expect(two / one, size).toBeCloseTo(2, 6);
    }
  });
});

describe('mecanum wheel', () => {
  it('builds every size sold as wide across as its diameter and as tall as its width', () => {
    for (const size of MECANUM_SIZES) {
      const r = mecanum({ size });
      expect(r.warnings, size).toEqual([]);
      const m = figures({ size });
      expect(info(r, 'Outside diameter'), size).toBe(Number(size));
      expect(info(r, 'Rollers'), size).toBe(m.count);
      const { stats } = evaluate(r.solid);
      // The rollers are cut to the wheel's circle, so the wheel measures its diameter both ways across.
      for (const axis of [0, 1]) expect(stats.max[axis] - stats.min[axis], size).toBeCloseTo(2 * m.radius, 3);
      expect(stats.min[2], size).toBeCloseTo(0, 6);
      expect(stats.max[2], size).toBeCloseTo(m.width, 5);
      expect(stats.triangles, size).toBeLessThan(20_000);
    }
  });

  it('is one piece on every size and hand: hub, plates, arms, tabs, axles and rollers', () => {
    for (const size of MECANUM_SIZES) {
      for (const hand of ['left', 'right']) {
        const { mesh } = evaluate(mecanum({ size, hand }).solid);
        // Every triangle is reached from the first through shared corners.
        const corners = mesh.positions.length / 3;
        const group = Array.from({ length: corners }, (_, i) => i);
        const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
        for (let t = 0; t < mesh.triangles.length; t += 3) {
          group[find(mesh.triangles[t])] = find(mesh.triangles[t + 1]);
          group[find(mesh.triangles[t + 1])] = find(mesh.triangles[t + 2]);
        }
        const used = new Set<number>();
        for (const i of mesh.triangles) used.add(find(i));
        expect(used.size, `${size} ${hand}`).toBe(1);
      }
    }
  });

  it('is a stout frame with the rollers standing proud of it: neither a drum nor a spindly star', () => {
    for (const size of MECANUM_SIZES) {
      const m = figures({ size });
      const { stats, mesh } = evaluate(mecanum({ size }).solid);
      // A drum with lids filled two thirds of the wheel's cylinder, and thin plates full of holes a third of it;
      // stout plates and tabs round a hub, with fat rollers, fill between the two.
      const filled = stats.volume / (Math.PI * m.radius ** 2 * m.width);
      expect(filled, size).toBeLessThan(0.55);
      expect(filled, size).toBeGreaterThan(0.4);
      // On the wheel's two faces nothing reaches the wheel's circle: the plates and their arms stop short of the floor.
      let far = 0;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const z = mesh.positions[i + 2];
        if (z < 1e-6 || z > m.width - 1e-6) far = Math.max(far, Math.hypot(mesh.positions[i], mesh.positions[i + 1]));
      }
      expect(far, size).toBeLessThan(m.radius - 0.5);
    }
  });

  it('takes a diameter, a width and a count of its own, and the other hand', () => {
    const r = mecanum({ size: 'custom', diameter: 127, width: 56, rollers: 10 });
    expect(r.warnings).toEqual([]);
    expect(info(r, 'Outside diameter')).toBe(127);
    expect(info(r, 'Width')).toBe(56);
    expect(info(r, 'Rollers')).toBe(10);
    const left = evaluate(mecanum({ hand: 'left' }).solid).stats;
    const right = evaluate(mecanum({ hand: 'right' }).solid).stats;
    // Mirror images of each other: the same amount of material in the same box.
    expect(right.volume).toBeCloseTo(left.volume, 3);
    expect(right.max[2]).toBeCloseTo(left.max[2], 6);
  });

  it('says so when the rollers leave gaps, or the bore takes the plates', () => {
    const gapped = mecanum({ size: 'custom', diameter: 200, width: 20, rollers: 6 });
    expect(gapped.warnings).toEqual(['The rollers leave gaps between them. Add rollers or make the wheel wider.']);
    // It is still a wheel of that size, with what rollers fit.
    const { stats } = evaluate(gapped.solid);
    expect(stats.max[2] - stats.min[2]).toBeCloseTo(20, 5);
    expect(stats.max[0] - stats.min[0]).toBeGreaterThan(190);
    // Every width and count a wheel can be given leaves a roller of some length to build.
    for (const [diameter, width, rollers] of [[30, 150, 6], [300, 10, 20], [300, 10, 6], [30, 10, 20], [300, 150, 6]]) {
      const m = figures({ size: 'custom', diameter, width, rollers });
      expect(m.rollerLength, `${diameter} × ${width}, ${rollers}`).toBeGreaterThan(0.5);
      expect(m.endRadius, `${diameter} × ${width}, ${rollers}`).toBeGreaterThan(0.1);
      expect(evaluate(mecanum({ size: 'custom', diameter, width, rollers }).solid).stats.volume).toBeGreaterThan(0);
    }
    expect(mecanum({ boreType: 'round', boreDiameter: 6 }).warnings).toEqual([]);
    expect(mecanum({ boreType: 'round', boreDiameter: 67 }).warnings).toEqual(['The bore is as wide as the plates that hold the rollers.']);
  });
  it('shows the figures of the size chosen in the settings the size holds', () => {
    const settings = mecanumWheel.groups[0].params;
    const shown = (key: string, p: Params) => settings.find((d) => d.key === key)!.shown!({ ...defaultParams(mecanumWheel), ...p });
    // The wheel's own figures are 100, 50 and 9; a size reads its own, and Custom the wheel's.
    expect([shown('diameter', { size: '152' }), shown('width', { size: '152' }), shown('rollers', { size: '152' })]).toEqual([152, 55.5, 15]);
    expect([shown('diameter', { size: '203' }), shown('width', { size: '203' }), shown('rollers', { size: '203' })]).toEqual([203, 78, 12]);
    expect([shown('diameter', { size: 'custom', diameter: 120 }), shown('width', { size: 'custom' }), shown('rollers', { size: 'custom' })]).toEqual([120, 50, 9]);
  });

  it("is its other hand's mirror image in Y, whatever its rollers, bore and hub", () => {
    const apart = (a: Solid, b: Solid) => evaluate(difference(a, b)).stats.volume;
    for (const over of [{}, { size: '60' }, { size: '152' }, { boreType: 'd', boreDiameter: 8, boreFlat: 6 }, { boreType: 'keyway', boreDiameter: 10 }, { hubHeight: 10, setScrews: 1 }] as Params[]) {
      const left = mecanum({ hand: 'left', ...over }).solid;
      const right = mirror(mecanum({ ...mecanumWheel.mirrored!({ ...defaultParams(mecanumWheel), hand: 'left' }), boreType: 'none', ...over }).solid, [0, 1, 0]);
      const whole = evaluate(left).stats.volume;
      // Flat-sided rounds meet their mirror images to within a sliver.
      expect(apart(left, right) / whole, JSON.stringify(over)).toBeLessThan(1e-3);
      expect(apart(right, left) / whole, JSON.stringify(over)).toBeLessThan(1e-3);
    }
    // Mirrored along any of its own axes through the middle of its box, a wheel is its other hand flipped in that axis and in Y.
    const hubbed = { hubHeight: 10, setScrews: 1 };
    const left = mecanum({ hand: 'left', ...hubbed }).solid;
    const other = mecanum({ hand: 'right', ...hubbed }).solid;
    const top = evaluate(left).stats.max[2];
    const flipped = (s: Solid, axes: number[]) =>
      axes.reduce((out, k) => (k === 2 ? translate(mirror(out, [0, 0, 1]), [0, 0, top]) : mirror(out, k === 0 ? [1, 0, 0] : [0, 1, 0])), s);
    const whole = evaluate(left).stats.volume;
    for (const [axis, flips] of [[0, [0, 1]], [1, []], [2, [2, 1]]] as [number, number[]][]) {
      expect(apart(flipped(left, [axis]), flipped(other, flips)) / whole, `axis ${axis}`).toBeLessThan(1e-3);
      expect(apart(flipped(other, flips), flipped(left, [axis])) / whole, `axis ${axis}`).toBeLessThan(1e-3);
    }
    // The same hand in its place would not do.
    expect(apart(flipped(left, [0]), left) / whole).toBeGreaterThan(0.02);
  });
});
