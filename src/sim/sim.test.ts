// The reference robots driven in the WebAssembly build of MuJoCo, as the test
// drive in the app does it: the rover rolls and turns, the car steers, the
// arm holds a target, the quadruped stands.
import { beforeAll, describe, expect, it } from 'vitest';
import type { MainModule } from '@mujoco/mujoco';
import { initKernel, robotGeometry } from '../geometry/kernel';
import type { Doc } from '../model/types';
import { buildMjcfModel } from '../robot/export';
import { ROBOTS } from '../robot/fixtures';
import { linkNodes, linkOf } from '../robot/model';
import { loadMujoco, Simulation } from './mujoco';

let mj: MainModule;

beforeAll(async () => {
  [mj] = await Promise.all([loadMujoco(), initKernel()]);
});

const make = (file: string): Doc => ROBOTS.find((r) => r.file === file)!.make();

/** The robot's MuJoCo package loaded, as the app loads it: without visual meshes, which the plate draws itself. */
function simulate(doc: Doc): { sim: Simulation; base: string } {
  const robot = doc.robot!;
  const nodes = linkNodes(doc.scene);
  const geo = robotGeometry(nodes, Object.fromEntries(nodes.map((n) => [n.id, linkOf(robot, n.id).collision])), false);
  const pkg = buildMjcfModel(doc, new Map(geo.map((g) => [g.id, { ...g, visual: [] }])), robot);
  const xml = new TextDecoder().decode(pkg.files.find((f) => f.name.endsWith('.xml'))!.bytes);
  const files = pkg.files.filter((f) => f.name.startsWith('meshes/'));
  const sim = Simulation.load(mj, xml, files, pkg.drive);
  return { sim, base: pkg.bodies[0].body };
}

const position = (sim: Simulation, body: string): [number, number, number] => {
  const i = sim.bodies.indexOf(body);
  const p = sim.poses();
  return [p[7 * i], p[7 * i + 1], p[7 * i + 2]];
};

/** The turn about Z of a body, degrees. */
const yaw = (sim: Simulation, body: string): number => {
  const i = sim.bodies.indexOf(body);
  const p = sim.poses();
  const [w, x, y, z] = [p[7 * i + 3], p[7 * i + 4], p[7 * i + 5], p[7 * i + 6]];
  return (Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 180) / Math.PI;
};

describe('the rover', () => {
  it('names its wheel motors and drives forward along +Y', () => {
    const { sim, base } = simulate(make('rover'));
    expect(sim.bodies[0]).toBe('world');
    expect(sim.actuators.map((a) => a.kind)).toEqual(['motor', 'motor', 'motor', 'motor']);
    expect(sim.actuators[0].max).toBeGreaterThan(1);
    sim.step(0.5);
    const start = position(sim, base);
    sim.drive(1, 0);
    sim.step(2);
    const end = position(sim, base);
    // A TT motor turns a 40 mm wheel at about 0.4 m/s; slip and the motor's torque limit take some.
    expect(end[1] - start[1]).toBeGreaterThan(0.3);
    expect(Math.abs(end[0] - start[0])).toBeLessThan(0.05);
    expect(Math.abs(yaw(sim, base))).toBeLessThan(10);
    sim.dispose();
  });

  it('turns on the spot to the left', () => {
    const { sim, base } = simulate(make('rover'));
    sim.step(0.5);
    const start = position(sim, base);
    sim.drive(0, 1);
    // Half a second: at full turn the rover spins at about 100° a second.
    sim.step(0.5);
    expect(yaw(sim, base)).toBeGreaterThan(30);
    expect(yaw(sim, base)).toBeLessThan(170);
    const end = position(sim, base);
    expect(Math.hypot(end[0] - start[0], end[1] - start[1])).toBeLessThan(0.05);
    sim.dispose();
  });

  it('faces the way its wheels are labelled: left and right swapped, it drives -Y and still turns left', () => {
    const doc = make('rover');
    const drive = doc.robot!.drive!;
    drive.roles = Object.fromEntries(Object.entries(drive.roles).map(([id, r]) => [id, r === 'left' ? 'right' : 'left'])) as typeof drive.roles;
    const { sim, base } = simulate(doc);
    sim.step(0.5);
    const start = position(sim, base);
    sim.drive(1, 0);
    sim.step(2);
    expect(position(sim, base)[1] - start[1]).toBeLessThan(-0.3);
    expect(Math.abs(yaw(sim, base))).toBeLessThan(10);
    // Left is still a turn to the robot's own left: counter-clockwise seen from above.
    sim.drive(0, 1);
    sim.step(0.5);
    expect(yaw(sim, base)).toBeGreaterThan(30);
    sim.dispose();
  });

  it('goes back to the start on reset', () => {
    const { sim, base } = simulate(make('rover'));
    sim.drive(1, 0);
    sim.step(1);
    expect(position(sim, base)[1]).toBeGreaterThan(0.1);
    sim.reset();
    expect(sim.time).toBe(0);
    expect(Math.abs(position(sim, base)[1])).toBeLessThan(1e-6);
    sim.step(0.5);
    // The controls were let go of too.
    expect(Math.abs(position(sim, base)[1])).toBeLessThan(0.01);
    sim.dispose();
  });
});

describe('the car', () => {
  it('steers its front wheels and curves', () => {
    const { sim, base } = simulate(make('car'));
    const steer = sim.actuators.filter((a) => a.kind === 'servo');
    expect(steer).toHaveLength(2);
    sim.step(0.5);
    sim.drive(1, 1);
    sim.step(1.5);
    // The steering servos reach their 30° limit.
    expect(sim.jointValue(steer[0].joint)).toBeGreaterThan(0.4);
    expect(yaw(sim, base)).toBeGreaterThan(10);
    expect(position(sim, base)[1]).toBeGreaterThan(0.1);
    sim.dispose();
  });
});

describe('the arm', () => {
  it('holds a servo at its target within its range', () => {
    const { sim } = simulate(make('arm'));
    const shoulder = sim.actuators.find((a) => a.joint === 'Shoulder')!;
    expect(shoulder.kind).toBe('servo');
    expect(shoulder.min).toBeCloseTo(-Math.PI / 2, 3);
    expect(shoulder.max).toBeCloseTo(Math.PI / 2, 3);
    sim.setTarget(shoulder.name, 0.5);
    sim.step(2);
    expect(sim.jointValue('Shoulder')).toBeCloseTo(0.5, 1);
    // A target past the range is held at the range.
    sim.setTarget(shoulder.name, 9);
    sim.step(2);
    expect(sim.jointValue('Shoulder')).toBeCloseTo(Math.PI / 2, 1);
    expect(sim.jointValue('Nope')).toBeNaN();
    sim.dispose();
  });
});

describe('the quadruped', () => {
  it('stands on its feet', () => {
    const { sim, base } = simulate(make('quadruped'));
    sim.step(2);
    // The base's frame sits on the floor under the body; it stays there as long as the legs hold.
    expect(Math.abs(position(sim, base)[2])).toBeLessThan(0.01);
    for (const leg of ['front_left', 'rear_right']) expect(Math.abs(sim.jointValue(`Knee_${leg}`))).toBeLessThan(0.2);
    sim.dispose();
  });
});
