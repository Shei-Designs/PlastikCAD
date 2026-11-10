import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { VIEW_DIRECTIONS, fitDistance, poseBetween, poseOf, posePosition, poseToward } from './camera';
import type { Pose } from './camera';

const pose = (theta: number, phi: number, distance = 100, target = new Vector3()): Pose => ({ theta, phi, distance, target });

describe('fitDistance', () => {
  it('stands further back for a bigger design', () => {
    expect(fitDistance(20, 1.5)).toBeCloseTo(2 * fitDistance(10, 1.5));
  });

  it('is set by the narrower way across the view', () => {
    // Wider than tall: the height decides, so more width changes nothing.
    expect(fitDistance(10, 3)).toBeCloseTo(fitDistance(10, 1.5));
    // Taller than wide: the width decides, and the camera has to back off.
    expect(fitDistance(10, 0.5)).toBeGreaterThan(fitDistance(10, 1));
  });

  it('leaves a margin round a sphere seen with a 35° lens', () => {
    expect(fitDistance(10, 1)).toBeCloseTo((10 / Math.sin((35 * Math.PI) / 360)) * 1.25);
  });
});

describe('poses', () => {
  it('reads a pose back from where the camera stands', () => {
    const target = new Vector3(5, -3, 2);
    for (const direction of [VIEW_DIRECTIONS.iso, VIEW_DIRECTIONS.front, VIEW_DIRECTIONS.side]) {
      const made = poseToward(direction, 80, target);
      const read = poseOf(posePosition(made), target);
      expect(read.theta).toBeCloseTo(made.theta);
      expect(read.phi).toBeCloseTo(made.phi);
      expect(read.distance).toBeCloseTo(80);
    }
  });

  it('looks from the front along +Y, level with the target', () => {
    const at = posePosition(poseToward(VIEW_DIRECTIONS.front, 50, new Vector3(1, 2, 3)));
    expect(at.x).toBeCloseTo(1);
    expect(at.y).toBeCloseTo(-48);
    expect(at.z).toBeCloseTo(3);
  });

  it('keeps the camera off the Z axis when looking straight down', () => {
    const at = posePosition(pose(0, 0, 100));
    expect(at.z).toBeCloseTo(100);
    expect(Math.hypot(at.x, at.y)).toBeGreaterThan(0);
  });

  it('never reads a distance of nothing', () => {
    expect(poseOf(new Vector3(1, 1, 1), new Vector3(1, 1, 1)).distance).toBeGreaterThan(0);
  });
});

describe('poseBetween', () => {
  it('starts at one pose and ends at the other', () => {
    const from = pose(0.2, 1, 100, new Vector3(0, 0, 0));
    const to = pose(1.2, 0.5, 40, new Vector3(10, 20, 30));
    expect(poseBetween(from, to, 0)).toMatchObject({ theta: 0.2, phi: 1, distance: 100 });
    const end = poseBetween(from, to, 1);
    expect(end.theta).toBeCloseTo(1.2);
    expect(end.phi).toBeCloseTo(0.5);
    expect(end.distance).toBeCloseTo(40);
    expect(end.target.toArray()).toEqual([10, 20, 30]);
  });

  it('is halfway at a half', () => {
    const mid = poseBetween(pose(0, 1, 100), pose(1, 2, 200, new Vector3(4, 0, 0)), 0.5);
    expect(mid.theta).toBeCloseTo(0.5);
    expect(mid.phi).toBeCloseTo(1.5);
    expect(mid.distance).toBeCloseTo(150);
    expect(mid.target.x).toBeCloseTo(2);
  });

  it('takes the short way round in azimuth', () => {
    // From just short of half a turn one way to just short of it the other: across the back, not all the way round the front.
    const mid = poseBetween(pose(3, 1), pose(-3, 1), 0.5);
    expect(Math.abs(mid.theta)).toBeGreaterThan(3);
  });

  it('leaves the poses it was given alone', () => {
    const from = pose(0, 1, 100, new Vector3(1, 1, 1));
    poseBetween(from, pose(1, 1, 100, new Vector3(9, 9, 9)), 0.5);
    expect(from.target.toArray()).toEqual([1, 1, 1]);
  });
});
