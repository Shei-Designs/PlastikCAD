import { describe, expect, it } from 'vitest';
import { apply } from '../model/math';
import type { SceneNode } from '../model/types';
import { fitFollowers, forward, posedScene, solvePose, turnAbout } from './kinematics';
import { jointInChild } from './model';
import { defaultJoint } from './types';
import type { Robot, RobotJoint } from './types';

const node = (id: string, name: string, pos: [number, number, number], size: [number, number, number], rot: [number, number, number] = [0, 0, 0]): SceneNode => ({ id, name, type: 'shape', shape: 'box', params: {}, pos, rot, size, hole: false, color: '#ff8800' });

/** A joint placed at a point in the design, turning about Y, between two links. */
function hinge(id: string, parent: SceneNode, child: SceneNode, at: [number, number, number], type: RobotJoint['type'] = 'revolute'): RobotJoint {
  const local = jointInChild(at, [0, 1, 0], child);
  return { ...defaultJoint(id, id, parent.id, child.id, local.origin), axis: local.axis, type, lower: -75, upper: 75 };
}

// A parallelogram four-bar in the XZ plane: ground along X, crank and rocker standing 50 up at x = 0 and x = 100, coupler across the top.
const ground = node('ground', 'Ground', [50, 0, -5], [120, 10, 10]);
const crank = node('crank', 'Crank', [0, 0, 25], [8, 8, 50]);
const coupler = node('coupler', 'Coupler', [50, 0, 50], [100, 8, 8]);
const rocker = node('rocker', 'Rocker', [100, 0, 25], [8, 8, 50]);
const scene = [ground, crank, coupler, rocker];
const fourBar = (): Robot => ({
  root: ground.id,
  sensors: [],
  control: true,
  links: [],
  joints: [hinge('j1', ground, crank, [0, 0, 0]), hinge('j2', crank, coupler, [0, 0, 50]), hinge('j3', coupler, rocker, [100, 0, 50]), hinge('j4', rocker, ground, [100, 0, 0])],
});

describe('turnAbout', () => {
  it('turns a point about an axis through an origin', () => {
    const m = turnAbout([10, 0, 0], [0, 0, 1], 90);
    expect(apply(m, [20, 0, 0]).map((v) => +v.toFixed(6))).toEqual([10, 10, 0]);
    expect(apply(m, [10, 0, 5]).map((v) => +v.toFixed(6))).toEqual([10, 0, 5]);
  });
});

describe('forward', () => {
  it('carries a child subtree with its parent joint', () => {
    const robot = fourBar();
    robot.joints.pop();
    const posed = forward(robot, scene, new Map([['j1', 90]]));
    // The crank turned 90° about Y at the origin: its top (0, 0, 50) goes to (50, 0, 0); the coupler rides along.
    expect(apply(posed.frames.get('crank')!, [0, 0, 50]).map((v) => +v.toFixed(6))).toEqual([50, 0, 0]);
    expect(apply(posed.frames.get('coupler')!, [0, 0, 50]).map((v) => +v.toFixed(6))).toEqual([50, 0, 0]);
    const moved = posedScene(scene, posed.frames);
    expect(moved[1].pos.map((v) => +v.toFixed(6))).toEqual([25, 0, 0]);
    expect(moved[1].rot).toEqual([0, 90, 0]);
    expect(moved[0]).toBe(ground);
  });

  it('gives a follower the value of its leader', () => {
    const robot = fourBar();
    robot.joints.pop();
    robot.joints[1].mimic = { joint: 'j1', multiplier: -1, offset: 0 };
    const posed = forward(robot, scene, new Map([['j1', 30]]));
    expect(posed.values.get('j2')).toBe(-30);
  });
});

describe('solvePose', () => {
  it('closes a parallelogram: the coupler stays level and the rocker follows the crank', () => {
    const solved = solvePose(fourBar(), scene, new Map([['j1', 30]]));
    expect(solved.closed).toBe(true);
    expect(solved.values.get('j2')).toBeCloseTo(-30, 4);
    expect(solved.values.get('j3')).toBeCloseTo(30, 4);
    // The rocker's top end is where the coupler's far end is.
    const top = apply(solved.frames.get('rocker')!, [100, 0, 50]);
    const far = apply(solved.frames.get('coupler')!, [100, 0, 50]);
    expect(top.map((v) => +v.toFixed(4))).toEqual(far.map((v) => +v.toFixed(4)));
  });

  it('reports a linkage that cannot close', () => {
    const robot = fourBar();
    // A rocker too short for the crank to turn a quarter: the zero pose closes (as designed), 90° cannot.
    const short = node('rocker', 'Rocker', [100, 0, 5], [8, 8, 10]);
    robot.joints[2] = hinge('j3', coupler, short, [100, 0, 10]);
    robot.joints[3] = hinge('j4', short, ground, [100, 0, 0]);
    expect(solvePose(robot, [ground, crank, coupler, short], new Map([['j1', 0]])).closed).toBe(true);
    const solved = solvePose(robot, [ground, crank, coupler, short], new Map([['j1', 90]]));
    expect(solved.closed).toBe(false);
    expect(solved.error).toBeGreaterThan(5);
  });
});

describe('fitFollowers', () => {
  it('finds the parallelogram exactly', () => {
    const fits = fitFollowers(fourBar(), scene, 'j1', 8);
    expect(fits.get('j2')!.multiplier).toBeCloseTo(-1, 5);
    expect(fits.get('j2')!.offset).toBeCloseTo(0, 3);
    expect(fits.get('j2')!.error).toBeLessThan(1e-3);
    expect(fits.get('j3')!.multiplier).toBeCloseTo(1, 5);
    expect(fits.get('j2')!.closed).toBe(true);
  });

  it('fits a line with an error for a four-bar that is not a parallelogram', () => {
    const robot = fourBar();
    // A longer rocker standing on a lower ground point: still closes, but not a parallelogram.
    const tall = node('rocker', 'Rocker', [100, 0, 20], [8, 8, 60]);
    robot.joints[2] = hinge('j3', coupler, tall, [100, 0, 50]);
    robot.joints[3] = hinge('j4', tall, ground, [100, 0, -10]);
    const fits = fitFollowers(robot, [ground, crank, coupler, tall], 'j1', 8);
    expect(fits.get('j3')!.closed).toBe(true);
    expect(fits.get('j3')!.error).toBeGreaterThan(0.5);
    expect(fits.get('j3')!.multiplier).toBeGreaterThan(0.3);
    expect(fits.get('j3')!.multiplier).toBeLessThan(1.5);
  });
});
