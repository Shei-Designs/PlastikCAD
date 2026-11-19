import { describe, expect, it } from 'vitest';
import { writeMjcf } from './mjcf';
import type { MjcfBody, MjcfModel } from './mjcf';

/** A 2 kg body with one wheel on an axle along Y: the wheel's inertia about it and its motor's rotor are given. */
function rover(wheelInertia: number, armature: number, effort: number, velocity: number, skids = false): string {
  const wheel: MjcfBody = {
    name: 'wheel',
    pos: [0, 0.1, 0],
    inertial: { mass: 0.1, origin: [0, 0, 0], inertia: [wheelInertia, wheelInertia, wheelInertia, 0, 0, 0] },
    visual: [],
    collision: [],
    joint: { name: 'axle', type: 'continuous', axis: [0, 1, 0], limit: { lower: 0, upper: 0, effort, velocity }, armature },
    children: [],
  };
  const base: MjcfBody = { name: 'body', pos: [0, 0, 0.05], inertial: { mass: 2, origin: [0, 0, 0], inertia: [0.01, 0.01, 0.01, 0, 0, 0] }, visual: [], collision: [], children: [wheel] };
  const model: MjcfModel = { name: 'rover', base, floating: true, connects: [], followers: [], servos: [], wheels: ['axle'], world: 'flat', forward: [1, 0, 0], ...(skids ? { skids: true } : {}) };
  return writeMjcf(model);
}
const gain = (xml: string): number => Number(xml.match(/<velocity name="axle_motor" joint="axle" kv="([^"]+)" ctrlrange="-10 10" forcerange="-2 2"\/>/)![1]);

describe("a wheel's motor in the MuJoCo model", () => {
  // 2 N·m and 10 rad/s: the motor's own line is a gain of 0.2, and the whole torque a hundredth of the top speed off is one of 20.
  it('holds the speed it is told as stiffly as the time step follows', () => {
    // A wheel and rotor of 0.0006 kg·m² together: five times that over the 2 ms step.
    expect(gain(rover(0.0001, 0.0005, 2, 10))).toBeCloseTo((5 * 0.0006) / 0.002, 6);
  });

  it('gives its whole torque a hundredth of its top speed off, where the wheel is heavy enough', () => {
    expect(gain(rover(0.05, 0, 2, 10))).toBe(20);
  });

  it("is never softer than the motor's own torque over its top speed", () => {
    expect(gain(rover(0.00001, 0, 2, 10))).toBe(0.2);
  });
});

describe('the friction cone of the MuJoCo model', () => {
  it('is the elliptic one for a robot whose wheels skid, and MuJoCo\'s own otherwise', () => {
    expect(rover(0.0001, 0, 2, 10, true)).toContain('<option timestep="0.002" gravity="0 0 -9.81" integrator="implicitfast" cone="elliptic"/>');
    expect(rover(0.0001, 0, 2, 10)).toContain('<option timestep="0.002" gravity="0 0 -9.81" integrator="implicitfast"/>');
  });
});
