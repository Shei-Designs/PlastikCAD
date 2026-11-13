import { describe, expect, it } from 'vitest';
import { rotation } from '../model/math';
import type { Mat } from '../model/math';
import { FaultWatch, floorFaults, floorLinks, lowestOfPrimitive, lowestPoint } from './collisionCheck';
import type { FloorLink } from './collisionCheck';

/** The eight corners of a box by its size, centered at `at`. */
const corners = (size: number[], at: number[]): Float32Array => {
  const out: number[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) out.push(at[0] + (x * size[0]) / 2, at[1] + (y * size[1]) / 2, at[2] + (z * size[2]) / 2);
  return Float32Array.from(out);
};
const moved = (dz: number): Mat => [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, dz];

describe('the lowest point', () => {
  it('of a box, a cylinder and a ball, as they are turned', () => {
    expect(lowestOfPrimitive({ shape: { box: [10, 20, 30] }, at: [0, 0, 50], rot: [0, 0, 0] }, null)).toBeCloseTo(35);
    // Laid on its side, the box's 10 is its height.
    expect(lowestOfPrimitive({ shape: { box: [10, 20, 30] }, at: [0, 0, 50], rot: [0, 90, 0] }, null)).toBeCloseTo(45);
    expect(lowestOfPrimitive({ shape: { cylinder: { radius: 4, length: 30 } }, at: [0, 0, 50], rot: [0, 0, 0] }, null)).toBeCloseTo(35);
    expect(lowestOfPrimitive({ shape: { cylinder: { radius: 4, length: 30 } }, at: [0, 0, 50], rot: [90, 0, 0] }, null)).toBeCloseTo(46);
    expect(lowestOfPrimitive({ shape: { sphere: { radius: 7 } }, at: [0, 0, 50], rot: [30, 40, 50] }, null)).toBeCloseTo(43);
  });

  it('follows the frame the test drive gives the link', () => {
    const down = moved(-20);
    expect(lowestOfPrimitive({ shape: { sphere: { radius: 7 } }, at: [0, 0, 50], rot: [0, 0, 0] }, down)).toBeCloseTo(23);
    expect(lowestPoint(corners([10, 10, 10], [0, 0, 50]), down)).toBeCloseTo(25);
    // Tipped a quarter turn about X around the origin, what was 50 up is 50 out, and the low corner is 5 under.
    const tipped: Mat = [...rotation([90, 0, 0]).slice(0, 9), 0, 0, 0] as Mat;
    expect(lowestPoint(corners([10, 10, 10], [0, 0, 50]), tipped)).toBeCloseTo(-5);
  });
});

describe('a collision shape against the floor', () => {
  const calf: FloorLink = { id: 'calf', points: corners([10, 10, 100], [0, 0, 70]), shape: { shape: { box: [60, 60, 140] }, at: [0, 0, 70], rot: [0, 0, 0] } };

  it('is found too large when the link stands on it, clear of the floor', () => {
    // The box reaches the floor; the link itself ends 20 mm up.
    expect(floorFaults([calf], new Map())).toEqual([{ id: 'calf', kind: 'rides', by: 20 }]);
    // In the air nothing stands on anything.
    expect(floorFaults([calf], new Map([['calf', moved(50)]]))).toEqual([]);
  });

  it('is not held against a shape that reaches the floor where another link\'s looks do', () => {
    // A ball under the foot, larger than the foot looks, at the tip the calf's mesh draws.
    const foot: FloorLink = { id: 'foot', points: corners([10, 10, 10], [0, 0, 20]), shape: { shape: { sphere: { radius: 20 } }, at: [0, 0, 20], rot: [0, 0, 0] } };
    expect(floorFaults([foot], new Map())).toEqual([{ id: 'foot', kind: 'rides', by: 15 }]);
    const tip = { id: 'calf', points: corners([20, 20, 60], [0, 0, 31]) };
    expect(floorFaults([foot], new Map(), undefined, [{ id: 'foot', points: foot.points }, tip])).toEqual([]);
    // The calf lifted clear, or standing somewhere else, the foot rides again.
    expect(floorFaults([foot], new Map([['calf', moved(30)]]), undefined, [tip])).toHaveLength(1);
    expect(floorFaults([foot], new Map([['calf', [1, 0, 0, 0, 1, 0, 0, 0, 1, 80, 0, 0] as Mat]]), undefined, [tip])).toHaveLength(1);
  });

  it('is found too small, or missing, when the link sinks into the floor', () => {
    const none: FloorLink = { ...calf, shape: null };
    expect(floorFaults([none], new Map([['calf', moved(-30)]]))).toEqual([{ id: 'calf', kind: 'sinks', by: 10 }]);
    // A ball inside the link lets its corners through.
    const ball: FloorLink = { id: 'b', points: corners([40, 40, 40], [0, 0, 16]), shape: { shape: { sphere: { radius: 16 } }, at: [0, 0, 16], rot: [0, 0, 0] } };
    expect(floorFaults([ball], new Map())).toEqual([{ id: 'b', kind: 'sinks', by: 4 }]);
  });

  it('passes a shape that fits, within the give of the simulation', () => {
    const snug: FloorLink = { id: 's', points: corners([20, 20, 20], [0, 0, 10]), shape: { shape: { box: [20, 20, 20] }, at: [0, 0, 10], rot: [0, 0, 0] } };
    expect(floorFaults([snug], new Map())).toEqual([]);
    expect(floorFaults([snug], new Map([['s', moved(-1.5)]]))).toEqual([]);
    expect(floorFaults([snug], new Map([['s', moved(300)]]))).toEqual([]);
    // A heavy robot presses its feet some millimeters into a soft floor: a foot that fits is not in it, and a
    // link beside it that is deeper still is in it by the difference.
    expect(floorFaults([snug], new Map([['s', moved(-3.5)]]))).toEqual([]);
    const bare: FloorLink = { id: 'c', points: corners([20, 20, 20], [60, 0, 10]), shape: null };
    const pressed = new Map([['s', moved(-3.5)], ['c', moved(-9.5)]]);
    expect(floorFaults([snug, bare], pressed)).toEqual([{ id: 'c', kind: 'sinks', by: 6 }]);
  });
});

describe('the watch over a test drive', () => {
  const calf: FloorLink = { id: 'calf', points: corners([10, 10, 100], [0, 0, 70]), shape: { shape: { box: [60, 60, 140] }, at: [0, 0, 70], rot: [0, 0, 0] } };

  it('says a fault once it has lasted, keeps the most it reached, and forgets a bounce', () => {
    const watch = new FaultWatch([calf]);
    const standing = new Map<string, Mat>();
    const none = watch.see(standing, 0);
    expect(none).toEqual([]);
    // Not yet: it may be a landing.
    expect(watch.see(standing, 0.2)).toBe(none);
    const said = watch.see(standing, 0.31);
    expect(said).toEqual([{ id: 'calf', kind: 'rides', by: 20, bare: false }]);
    // Nothing new, and the list is the very same one.
    expect(watch.see(standing, 0.5)).toBe(said);
    // Lifted, then down again for a moment: the clock starts over, and what was said stays said.
    expect(watch.see(new Map([['calf', moved(40)]]), 0.6)).toBe(said);
    expect(watch.see(standing, 0.7)).toBe(said);
    // A reset forgets it all.
    expect(watch.clear()).toEqual([]);
    expect(watch.see(standing, 0)).toEqual([]);
  });

  it('judges only the links that collide as a plain shape or as nothing', () => {
    const node = (id: string) => ({ id, name: id, type: 'shape' as const, shape: 'box' as const, params: {}, hole: false, color: '#888888', pos: [0, 0, 10] as [number, number, number], rot: [0, 0, 0] as [number, number, number], size: [20, 20, 20] as [number, number, number] });
    const hull = { positions: corners([20, 20, 20], [0, 0, 10]), triangles: new Uint32Array(0) };
    const links = floorLinks([node('a'), node('b'), node('c'), node('d'), node('e')], { a: { collision: 'hull' }, b: { collision: 'mesh' }, c: { collision: 'sphere' }, d: { collision: 'none' }, e: { collision: 'box' } }, [hull, hull, hull, hull, null]);
    expect(links.map((l) => [l.id, l.shape ? Object.keys(l.shape.shape)[0] : null])).toEqual([
      ['c', 'sphere'],
      ['d', null],
    ]);
  });
});
