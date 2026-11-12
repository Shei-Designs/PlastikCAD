// The reference robots driven in the WebAssembly build of MuJoCo, as the test
// drive in the app does it: the rover rolls and turns, the car steers, the
// arm holds a target, the quadruped stands.
import { beforeAll, describe, expect, it } from 'vitest';
import type { MainModule } from '@mujoco/mujoco';
import { initKernel, robotGeometry } from '../geometry/kernel';
import type { Doc } from '../model/types';
import { buildMjcfModel } from '../robot/export';
import { ROBOTS } from '../robot/fixtures';
import { forward } from '../robot/kinematics';
import { linkNodes, linkOf } from '../robot/model';
import { loadMujoco, Simulation } from './mujoco';

let mj: MainModule;

beforeAll(async () => {
  [mj] = await Promise.all([loadMujoco(), initKernel()]);
});

const make = (file: string): Doc => ROBOTS.find((r) => r.file === file)!.make();

/** The robot's MuJoCo package loaded, as the app loads it: without visual meshes, which the plate draws itself. */
function simulate(doc: Doc, patch: (xml: string) => string = (xml) => xml): { sim: Simulation; base: string } {
  const robot = doc.robot!;
  const nodes = linkNodes(doc.scene);
  const geo = robotGeometry(nodes, Object.fromEntries(nodes.map((n) => [n.id, linkOf(robot, n.id).collision])), false);
  const pkg = buildMjcfModel(doc, new Map(geo.map((g) => [g.id, { ...g, visual: [] }])), robot, robot.world ?? 'flat');
  const xml = patch(new TextDecoder().decode(pkg.files.find((f) => f.name.endsWith('.xml'))!.bytes));
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

  it('sees a wall with its lidar, ray by ray', () => {
    // A wall across the rover's path, a meter ahead along +Y, and nothing behind.
    const wall = (xml: string) => xml.replace(/(<geom name="floor"[^>]*\/>)/, '$1\n    <geom name="wall" type="box" pos="0 1 0.25" size="0.5 0.05 0.25"/>');
    const { sim } = simulate(make('rover'), wall);
    // 36 rays over the full circle from -180°, 10° apart: ray 27 looks along +Y, ray 9 along -Y.
    expect(sim.sensorValue('Lidar_27')[0]).toBeCloseTo(0.95, 2);
    expect(sim.sensorValue('Lidar_9')[0]).toBe(-1);
    expect(sim.sensorValue('Lidar_36')).toEqual([]);
    sim.dispose();
  });

  it('climbs the ramp onto its top, and takes the three steps', () => {
    const ramp = make('rover');
    ramp.robot!.world = 'ramp';
    let { sim, base } = simulate(ramp);
    sim.step(0.5);
    sim.drive(1, 0);
    sim.step(1.5);
    // The slab starts 0.3 m ahead and climbs 104 mm over 0.6 m; by now the rover has rolled over a meter, onto the 0.6 m top and not yet off its end.
    expect(position(sim, base)[1]).toBeGreaterThan(0.9);
    expect(position(sim, base)[2]).toBeGreaterThan(0.08);
    sim.dispose();
    const steps = make('rover');
    steps.robot!.world = 'steps';
    ({ sim, base } = simulate(steps));
    sim.step(0.5);
    sim.drive(1, 0);
    sim.step(1.5);
    // Three 10 mm steps: 100 mm wheels take them, and the rover stands 30 mm up on the landing.
    expect(position(sim, base)[2]).toBeGreaterThan(0.025);
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

  it('steers when its body reaches over the wheels: the robot\'s own shapes pass through each other, as in Gazebo and Isaac Sim', () => {
    const doc = make('car');
    // The body widened into a shell over the front wheels and their knuckles.
    doc.scene[0] = { ...doc.scene[0], size: [380, 440, 80] };
    const { sim, base } = simulate(doc);
    const steer = sim.actuators.filter((a) => a.kind === 'servo');
    sim.step(0.5);
    sim.drive(1, 1);
    sim.step(1.5);
    expect(sim.jointValue(steer[0].joint)).toBeGreaterThan(0.4);
    expect(yaw(sim, base)).toBeGreaterThan(10);
    expect(position(sim, base)[1]).toBeGreaterThan(0.1);
    sim.dispose();
  });

  it('gives a wheel with no speed no motor, and still runs on the other', () => {
    const doc = make('car');
    doc.robot!.joints[0].velocity = 0;
    const { sim, base } = simulate(doc);
    expect(sim.actuators.filter((a) => a.kind === 'motor')).toHaveLength(1);
    sim.drive(1, 0);
    sim.step(1);
    // Every body is somewhere, and every joint at some angle: nothing has become not a number.
    expect([...sim.poses()].every(Number.isFinite)).toBe(true);
    for (const a of sim.actuators) expect(Number.isFinite(sim.jointValue(a.joint))).toBe(true);
    expect(position(sim, base)[1]).toBeGreaterThan(0.02);
    sim.dispose();
  });
});

describe('the arm', () => {
  it('keeps pace with the clock when stepped a frame at a time', () => {
    const { sim } = simulate(make('arm'));
    // Sixty frames of a sixtieth of a second: each is eight time steps and a third, and the thirds add up.
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    expect(sim.time).toBeCloseTo(1, 2);
    sim.reset();
    expect(sim.step(0.0015)).toBe(0);
    expect(sim.step(0.0015)).toBe(1);
    sim.dispose();
  });

  it('moves a follower as far as the pose in the app does: a rack going 0.5 mm for each degree of its pinion', () => {
    const doc = make('arm');
    const [turret, shoulder] = doc.robot!.joints;
    // The upper arm slides sideways off the turret as the turret turns, the way a rack runs on a pinion.
    Object.assign(shoulder, { type: 'prismatic', axis: [1, 0, 0], lower: -60, upper: 60, mimic: { joint: turret.id, multiplier: 0.5, offset: 0 } });
    const { sim } = simulate(doc);
    const servo = sim.actuators.find((a) => a.joint === 'Turret_joint')!;
    sim.setTarget(servo.name, 1);
    sim.step(3);
    const turned = (sim.jointValue('Turret_joint') * 180) / Math.PI;
    expect(turned).toBeGreaterThan(40);
    const posed = forward(doc.robot!, doc.scene, new Map([[turret.id, turned]]));
    // Within half a millimeter of the 28 or so the app shows.
    expect(posed.values.get(shoulder.id)).toBeGreaterThan(20);
    expect(sim.jointValue('Shoulder') * 1000).toBeCloseTo(posed.values.get(shoulder.id)!, 0);
    sim.dispose();
  });

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

/** How high the base link's frame is in the design, in meters: the middle of the base object. */
const bodyHeight = (doc: Doc): number => doc.scene.find((n) => n.id === doc.robot!.root)!.pos[2] / 1000;

describe('the quadruped', () => {
  it('stands on its feet', () => {
    const doc = make('quadruped');
    const { sim, base } = simulate(doc);
    sim.step(2);
    // The base's frame is in the body, as high as the design has it; it stays there as long as the legs hold.
    expect(Math.abs(position(sim, base)[2] - bodyHeight(doc))).toBeLessThan(0.01);
    for (const leg of ['front_left', 'rear_right']) expect(Math.abs(sim.jointValue(`Knee_${leg}`))).toBeLessThan(0.2);
    sim.dispose();
  });

  it('begins with its knees where their start has them, and holds them there', () => {
    const doc = make('quadruped');
    const knees = doc.robot!.joints.filter((j) => j.name.startsWith('Knee'));
    expect(knees).toHaveLength(4);
    // Inside the knee's range, whichever way it bends.
    const start = knees[0].upper > 25 ? 25 : -25;
    doc.robot!.joints = doc.robot!.joints.map((j) => (j.name.startsWith('Knee') ? { ...j, start } : j));
    const { sim, base } = simulate(doc);
    const rad = (start * Math.PI) / 180;
    for (const leg of ['front_left', 'rear_right']) expect(sim.jointValue(`Knee_${leg}`)).toBeCloseTo(rad, 5);
    // Bent knees bring the body down: it begins lower than it was designed, on its feet, and stays there.
    const begun = position(sim, base)[2];
    expect(begun).toBeLessThan(bodyHeight(doc) - 0.002);
    sim.step(2);
    for (const leg of ['front_left', 'rear_right']) expect(Math.abs(sim.jointValue(`Knee_${leg}`) - rad)).toBeLessThan(0.1);
    expect(Math.abs(position(sim, base)[2] - begun)).toBeLessThan(0.01);
    sim.dispose();
  });

  it('stands on the slope as it stands on the flat', () => {
    const doc = make('quadruped');
    doc.robot!.world = 'slope';
    const { sim, base } = simulate(doc);
    sim.step(3);
    const i = sim.bodies.indexOf(base);
    const p = sim.poses();
    const [w, x, y, z] = [p[7 * i + 3], p[7 * i + 4], p[7 * i + 5], p[7 * i + 6]];
    // The body's own up against the floor's, which is tilted 0.14 rad about X: upright on it, and the base's frame still as far from the floor as the design has it.
    const up = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
    const normal = [0, -Math.sin(0.14), Math.cos(0.14)];
    expect(up[0] * normal[0] + up[1] * normal[1] + up[2] * normal[2]).toBeGreaterThan(0.99);
    const [px, py, pz] = position(sim, base);
    expect(Math.abs(px * normal[0] + py * normal[1] + pz * normal[2] - bodyHeight(doc))).toBeLessThan(0.01);
    for (const leg of ['front_left', 'rear_right']) expect(Math.abs(sim.jointValue(`Knee_${leg}`))).toBeLessThan(0.2);
    sim.dispose();
  });

  it('feels the floor under every foot, and nothing under a sensor the model lacks', () => {
    const { sim } = simulate(make('quadruped'));
    sim.step(2);
    const forces = sim.touchForces(['Foot_front_left', 'Foot_rear_left', 'Foot_front_right', 'Foot_rear_right', 'Foot_fifth']);
    // Each foot carries a share of the body: a few newtons; a name the model has no sensor for reads -1.
    for (let i = 0; i < 4; i++) expect(forces[i]).toBeGreaterThan(0.1);
    expect(forces[4]).toBe(-1);
    sim.dispose();
  });
});
