import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { QUALITY } from '../types';
import type { Vec2 } from '../types';
import { GENERATORS } from './index';
import { track, trackFigures, trackInPart, trackPoint } from './track';
import type { TrackFigures } from './track';
import { defaultParams } from './types';
import type { BuildResult, Params } from './types';
import { mecanumWheel, wheel } from './wheels';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.normal;
const settings = (over: Params = {}): Params => ({ ...defaultParams(track), boreType: 'none', ...over });
const build = (over: Params = {}): BuildResult => track.build(settings(over), q);
const figures = (over: Params = {}): TrackFigures => trackFigures(settings(over));
const info = (r: BuildResult, label: string): number => parseFloat(r.info.find((i) => i.label === label)?.value ?? '');

/** How many separate pieces a mesh is: triangles reached from one another through shared corners. */
function pieces(mesh: { positions: ArrayLike<number>; triangles: ArrayLike<number> }): number {
  const group = Array.from({ length: mesh.positions.length / 3 }, (_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    group[find(mesh.triangles[t])] = find(mesh.triangles[t + 1]);
    group[find(mesh.triangles[t + 1])] = find(mesh.triangles[t + 2]);
  }
  const used = new Set<number>();
  for (let i = 0; i < mesh.triangles.length; i++) used.add(find(mesh.triangles[i]));
  return used.size;
}

/** The shapes the tests look at: flat, a raised front, a raised rear, both raised, few and many road wheels, unlike wheels. */
const SHAPES: Record<string, Params> = {
  flat: {},
  'idler raised': { idlerRise: 40 },
  'sprocket raised': { sprocketRise: 40 },
  'both raised': { sprocketRise: 30, idlerRise: 50 },
  'no road wheels': { roadWheels: 0 },
  'no road wheels, one end raised': { roadWheels: 0, idlerRise: 25 },
  'one road wheel, both raised': { roadWheels: 1, sprocketRise: 20, idlerRise: 20 },
  'many small road wheels': { length: 400, roadWheels: 9, roadDiameter: 25 },
  'big road wheels': { length: 400, roadWheels: 2, roadDiameter: 90 },
  'small ends': { endDiameter: 30, roadDiameter: 50, idlerRise: 30 },
};

describe('the wheels family', () => {
  it('holds the wheels and the track', () => {
    expect(GENERATORS.filter((g) => g.category === 'wheels')).toEqual([wheel, mecanumWheel, track]);
  });
});

describe("a track's figures", () => {
  it('place the sprocket on the axis, the idler a length along, and the road wheels evenly between them on the floor', () => {
    const f = figures();
    expect(f.wheels.map((w) => w.kind)).toEqual(['sprocket', 'road', 'road', 'road', 'idler']);
    expect(f.wheels[0]).toMatchObject({ center: [0, 0], radius: 30, onFloor: true });
    expect(f.wheels[4]).toMatchObject({ center: [240, 0], radius: 30, onFloor: true });
    expect(f.wheels.slice(1, 4).map((w) => w.center)).toEqual([
      [60, -10],
      [120, -10],
      [180, -10],
    ]);
    expect(f.wheels.every((w) => w.onFloor)).toBe(true);
    expect(f.floor).toMatchObject({ from: 0, to: 240 });
    expect(f.floor.up).toBeCloseTo(-30 - 3 - f.lug.height, 9);
  });

  it('give a flat track a belt of two straight runs and two half turns', () => {
    const f = figures();
    expect(f.path.map((r) => r.kind)).toEqual(['arc', 'line', 'arc', 'line']);
    expect(f.length).toBeCloseTo(2 * 240 + Math.PI * 60, 9);
    for (const r of f.path) if (r.kind === 'arc') expect(r.sweep).toBeCloseTo(Math.PI, 9);
  });

  it('lift an end off the floor by its rise, and tell which wheels stand on the floor', () => {
    const f = figures({ idlerRise: 40 });
    expect(f.wheels[4].center).toEqual([240, 40]);
    expect(f.wheels.map((w) => w.onFloor)).toEqual([true, true, true, true, false]);
    expect(f.floor.from).toBe(0);
    expect(f.floor.to).toBe(180);
    const both = figures({ sprocketRise: 30, idlerRise: 50 });
    // The sprocket stays on the axis: the floor drops under it.
    expect(both.wheels[0].center).toEqual([0, 0]);
    expect(both.wheels[1].center).toEqual([60, -40]);
    expect(both.wheels[4].center).toEqual([240, 20]);
    expect([both.floor.from, both.floor.to]).toEqual([60, 180]);
    expect(both.floor.up).toBeCloseTo(-60 - 3 - both.lug.height, 9);
  });

  it('tell a rise from the lower end where there are no road wheels', () => {
    const f = figures({ roadWheels: 0, sprocketRise: 30, idlerRise: 50 });
    expect(f.wheels.map((w) => w.center)).toEqual([
      [0, 0],
      [240, 20],
    ]);
    expect(f.wheels.map((w) => w.onFloor)).toEqual([true, false]);
    expect([f.floor.from, f.floor.to]).toEqual([0, 0]);
  });

  it('lay the belt tight round the wheels: every stretch begins where the last ended, touches its wheels and has every wheel inside it', () => {
    for (const [name, over] of Object.entries(SHAPES)) {
      const f = figures(over);
      let along = 0;
      f.path.forEach((r, i) => {
        expect(r.start, name).toBeCloseTo(along, 9);
        along += r.length;
        const next = f.path[(i + 1) % f.path.length];
        const end = trackPoint(f, r.start + r.length - 1e-9).at;
        const begin = trackPoint(f, next.start + 1e-9).at;
        expect(Math.hypot(end[0] - begin[0], end[1] - begin[1]), name).toBeLessThan(1e-6);
        if (r.kind === 'line') {
          // Straight runs leave one wheel and meet the next square to their radii.
          const n: Vec2 = [Math.cos(r.normal), Math.sin(r.normal)];
          expect((r.to[0] - r.from[0]) * n[0] + (r.to[1] - r.from[1]) * n[1], name).toBeCloseTo(0, 9);
          for (const w of f.wheels) expect((w.center[0] - r.from[0]) * n[0] + (w.center[1] - r.from[1]) * n[1] + w.radius, name).toBeLessThan(1e-9);
        } else expect(r.sweep, name).toBeGreaterThan(0);
      });
      expect(along, name).toBeCloseTo(f.length, 9);
      expect(f.path.reduce((sum, r) => sum + (r.kind === 'arc' ? r.sweep : 0), 0), name).toBeCloseTo(2 * Math.PI, 9);
      // Both ends carry the belt.
      for (const i of [0, f.wheels.length - 1]) expect(f.path.some((r) => r.kind === 'arc' && r.wheel === i), name).toBe(true);
    }
  });

  it('space the lugs evenly all the way round, a whole number of them', () => {
    for (const [name, over] of Object.entries(SHAPES)) {
      const f = figures(over);
      expect(f.lug.count * f.lug.pitch, name).toBeCloseTo(f.length, 9);
      expect(Number.isInteger(f.lug.count), name).toBe(true);
    }
    expect(figures().lug.pitch).toBeGreaterThan(9);
    expect(figures().lug.pitch).toBeLessThan(15);
  });

  it('give a point along the belt and the way out of it, round and round', () => {
    const f = figures();
    // The path begins on the sprocket where the top run meets it, and goes down round its back to the floor.
    const top = trackPoint(f, 0);
    expect(top.at[0]).toBeCloseTo(0, 9);
    expect(top.at[1]).toBeCloseTo(30, 9);
    const back = trackPoint(f, (Math.PI * 30) / 2, 3);
    expect(back.at[0]).toBeCloseTo(-33, 9);
    expect(back.at[1]).toBeCloseTo(0, 9);
    expect(back.normal[0]).toBeCloseTo(-1, 9);
    const under = trackPoint(f, Math.PI * 30 + 100);
    expect(under.at[0]).toBeCloseTo(100, 9);
    expect(under.at[1]).toBeCloseTo(-30, 9);
    expect(under.normal[1]).toBeCloseTo(-1, 9);
    const again = trackPoint(f, Math.PI * 30 + 100 + 3 * f.length);
    expect(again.at[0]).toBeCloseTo(100, 6);
    expect(trackPoint(f, -10).at[0]).toBeCloseTo(10, 9);
  });
});

describe('track', () => {
  it('is built as long, as tall and as wide as its figures say, to the lugs, whatever its shape', () => {
    for (const [name, over] of Object.entries(SHAPES)) {
      const r = build(over);
      expect(r.warnings, name).toEqual([]);
      const f = figures(over);
      const { stats } = evaluate(r.solid);
      for (let i = 0; i < 3; i++) {
        expect(stats.min[i], `${name} min ${i}`).toBeCloseTo(f.box.min[i], 6);
        expect(stats.max[i], `${name} max ${i}`).toBeCloseTo(f.box.max[i], 6);
      }
      // It stands on its belt: the floor is the lowest of it, and its width lies along Y from the rail's face.
      expect(stats.min[2], name).toBeCloseTo(f.floor.up, 6);
      expect([stats.min[1], stats.max[1]].map((y) => +y.toFixed(6)), name).toEqual([-40, 0]);
      expect(info(r, 'Overall length'), name).toBeCloseTo(f.box.max[0] - f.box.min[0], 2);
      expect(info(r, 'Overall height'), name).toBeCloseTo(f.box.max[2] - f.box.min[2], 2);
      expect(info(r, 'Overall width'), name).toBe(40);
      expect(stats.triangles, name).toBeLessThan(20_000);
    }
  });

  it('is one piece: belt, lugs and every wheel', () => {
    for (const [name, over] of Object.entries(SHAPES)) expect(pieces(evaluate(build(over).solid).mesh), name).toBe(1);
  });

  it('is open between its wheels: a belt round them, not a block', () => {
    const f = figures();
    const { stats } = evaluate(build().solid);
    const block = (f.box.max[0] - f.box.min[0]) * (f.box.max[2] - f.box.min[2]) * f.width;
    expect(stats.volume).toBeLessThan(0.45 * block);
    expect(stats.volume).toBeGreaterThan(0.15 * block);
  });

  it('carries its bore and hub on the sprocket', () => {
    const plain = evaluate(build().solid).stats;
    const bored = evaluate(build({ boreType: 'round', boreDiameter: 6 }).solid).stats;
    expect(plain.volume - bored.volume).toBeGreaterThan(0.9 * Math.PI * 3 * 3 * 40);
    const hubbed = build({ hubHeight: 8 });
    // The hub stands out of the side away from the rail.
    expect(evaluate(hubbed.solid).stats.min[1]).toBeCloseTo(-48, 6);
    expect(evaluate(hubbed.solid).stats.max[1]).toBeCloseTo(0, 6);
    expect(info(hubbed, 'Overall width')).toBe(48);
    expect(figures({ hubHeight: 8 }).box.min[1]).toBe(-48);
  });

  it('holds its axles on a rail inside the belt, on the side away from the hub', () => {
    for (const [name, over] of Object.entries(SHAPES)) {
      const f = figures(over);
      expect(f.rail.along, name).toEqual(f.wheels.map((w) => w.center));
      // No taller than the smallest wheel, so it stays inside the belt all along and off the floor.
      expect(f.rail.half, name).toBeLessThan(Math.min(...f.wheels.map((w) => w.radius)));
      expect(f.rail.half, name).toBeGreaterThan(0.4 * Math.min(...f.wheels.map((w) => w.radius)));
      expect(f.rail.thickness + f.rail.gap, name).toBeLessThan(f.width / 4);
    }
    // The rail's inner face is a plane of its own, `thickness` across: what lies in it is the rail, a bar no farther
    // than its half height from the line through the axles, and it reaches every axle.
    for (const [name, over] of Object.entries(SHAPES)) {
      const f = figures(over);
      const { mesh } = evaluate(build(over).solid);
      const face: Vec2[] = [];
      for (let i = 0; i < mesh.positions.length; i += 3) if (Math.abs(mesh.positions[i + 1] + f.rail.thickness) < 1e-6) face.push([mesh.positions[i], mesh.positions[i + 2]]);
      expect(trackInPart([30, -5], f.rail.thickness), name).toEqual([30, -f.rail.thickness, -5]);
      const off = (p: Vec2, a: Vec2, b: Vec2): number => {
        const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)));
        return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1]));
      };
      expect(face.length, name).toBeGreaterThan(20);
      for (const p of face) expect(Math.min(...f.rail.along.slice(1).map((b, i) => off(p, f.rail.along[i], b))), name).toBeLessThan(f.rail.half + 1e-4);
      for (const c of f.rail.along) expect(face.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) < f.rail.half + 1e-4), name).toBe(true);
    }
  });

  it('says so when its wheels run into each other', () => {
    expect(build({ roadWheels: 5, roadDiameter: 60 }).warnings).toEqual(['The wheels run into each other. Make the track longer or the wheels smaller.']);
    expect(build({ length: 40 }).warnings).toEqual(['The wheels run into each other. Make the track longer or the wheels smaller.']);
    expect(build({ roadWheels: 3, roadDiameter: 59 }).warnings).toEqual([]);
  });

  it('tells how far it lies on the floor and how far a turn of the sprocket takes it', () => {
    expect(info(build(), 'Length on the floor')).toBe(240);
    expect(info(build({ sprocketRise: 30, idlerRise: 50 }), 'Length on the floor')).toBe(120);
    expect(info(build(), 'Travel per turn')).toBeCloseTo(Math.PI * 63, 1);
  });
});
