// How far a belt has run, read from the poses of the wheels that stand in for it.
import { describe, expect, it } from 'vitest';
import type { Mat } from '../model/math';
import type { Vec3 } from '../model/types';
import { BeltWatch, beltAxis, beltWheels } from './belts';

type Quat = [number, number, number, number];
const about = (axis: Vec3, angle: number): Quat => [Math.cos(angle / 2), ...(axis.map((v) => v * Math.sin(angle / 2)) as Vec3)];
const times = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const poses = (...quats: Quat[]): Float64Array => Float64Array.from(quats.flatMap((q) => [0, 0, 0, ...q]));

describe("a track's wheels among a model's bodies", () => {
  it('are those named after the track, in their order, and no link of the robot', () => {
    const bodies = ['world', 'body', 'track_left', 'track_left_wheel_2', 'track_left_wheel_10', 'track_left_wheel_1', 'track_left_wheel_x', 'track_left_wheel_3', 'track_right', 'track_right_wheel_1'];
    expect(beltWheels(bodies, 'track_left', () => false)).toEqual([5, 3, 7, 4]);
    expect(beltWheels(bodies, 'track_right', () => false)).toEqual([9]);
    // An object of the user's that happens to be named so is a link, not a wheel of the export's.
    expect(beltWheels(bodies, 'track_left', (name) => name === 'track_left_wheel_3')).toEqual([5, 3, 4]);
    expect(beltWheels(bodies, 'body', () => false)).toEqual([]);
  });
});

describe('the axis a belt goes round', () => {
  it("is the part's -Y where it stands, and the other way for a mirrored part", () => {
    const standing: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7];
    expect(beltAxis(standing)).toEqual({ axis: [-0, -1, -0], mirrored: false });
    // Turned a quarter about Z and twice the size.
    const turned: Mat = [0, 2, 0, -2, 0, 0, 0, 0, 2, 0, 0, 0];
    expect(beltAxis(turned).axis.map((v) => +v.toFixed(9))).toEqual([1, 0, 0]);
    const mirrored: Mat = [1, 0, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0];
    expect(beltAxis(mirrored)).toMatchObject({ mirrored: true });
    expect(beltAxis(mirrored).axis.map((v) => +v.toFixed(9))).toEqual([0, -1, 0]);
  });
});

describe('how far a belt has run', () => {
  const axis: Vec3 = [0, -1, 0];
  const track = { node: 't', body: 1, wheels: [2, 3], axis, radius: 30 };

  it('is its wheels\' turn times their radius, added up over the frames, past any number of turns and back', () => {
    const watch = new BeltWatch([track]);
    watch.clear();
    // The robot turns about Z as it goes: only the wheels' turn against their track counts.
    let travel = 0;
    let angle = 0;
    const step = (by: number, yaw: number): number => {
      angle += by;
      const body = about([0, 0, 1], yaw);
      const wheel = times(body, about(axis, angle));
      travel = watch.see(poses([1, 0, 0, 0], body, wheel, wheel)).get('t')!;
      return travel;
    };
    expect(step(0, 0)).toBe(0);
    for (let i = 1; i <= 200; i++) step(0.1, 0.03 * i);
    // Twenty radians: more than three turns.
    expect(travel).toBeCloseTo(20 * 30, 6);
    for (let i = 1; i <= 300; i++) step(-0.1, 6 - 0.01 * i);
    expect(travel).toBeCloseTo(-10 * 30, 6);
  });

  it('is the average of its wheels where they turn unlike', () => {
    const watch = new BeltWatch([track]);
    watch.see(poses([1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]));
    expect(watch.see(poses([1, 0, 0, 0], [1, 0, 0, 0], about(axis, 0.2), about(axis, 0.4))).get('t')).toBeCloseTo(0.3 * 30, 9);
  });

  it('is read from the wheels on the floor alone, where some are in the air; from all where none is told to be on it', () => {
    const still: [number, number, number, number] = [1, 0, 0, 0];
    // The second wheel is up a raised nose and spins freely; the first carries the robot and slips.
    const raised = new BeltWatch([{ ...track, floor: [true, false] }]);
    raised.see(poses(still, still, still, still));
    expect(raised.see(poses(still, still, about(axis, 0.2), about(axis, 0.9))).get('t')).toBeCloseTo(0.2 * 30, 9);
    expect(raised.see(poses(still, still, about(axis, 0.1), about(axis, 1.9))).get('t')).toBeCloseTo(0.1 * 30, 9);
    // None on the floor, or a list that is not one for each wheel: every wheel counts, as before.
    for (const floor of [[false, false], [true]]) {
      const all = new BeltWatch([{ ...track, floor }]);
      all.see(poses(still, still, still, still));
      expect(all.see(poses(still, still, about(axis, 0.2), about(axis, 0.4))).get('t')).toBeCloseTo(0.3 * 30, 9);
    }
  });

  it('starts again from nothing at the start pose, wherever the wheels then are', () => {
    const watch = new BeltWatch([track]);
    watch.see(poses([1, 0, 0, 0], [1, 0, 0, 0], about(axis, 1), about(axis, 1)));
    watch.see(poses([1, 0, 0, 0], [1, 0, 0, 0], about(axis, 1.5), about(axis, 1.5)));
    expect([...watch.clear()]).toEqual([['t', 0]]);
    // The first frame after only says where the wheels are.
    expect(watch.see(poses([1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0])).get('t')).toBe(0);
    expect(watch.see(poses([1, 0, 0, 0], [1, 0, 0, 0], about(axis, -0.1), about(axis, -0.1))).get('t')).toBeCloseTo(-3, 9);
  });

  it('follows no track when there is none', () => {
    expect(new BeltWatch().see(poses([1, 0, 0, 0])).size).toBe(0);
  });
});
