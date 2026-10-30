// Three reference robots built from shapes with the real kernel: a rover, an
// arm and a quadruped. They must pass the checks and export cleanly in every
// format; with ROBOT_FIXTURES_OUT set, their MuJoCo models are written there
// for tools/mujoco_smoke.py to simulate, and the designs themselves are saved
// under fixtures/robots for opening in the app.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initKernel, robotGeometry } from '../geometry/kernel';
import { defaultParams } from '../geometry/shapes';
import { emptyDoc, serializeDoc } from '../model/file';
import type { Doc, SceneNode, ShapeKind, Vec3 } from '../model/types';
import { checkRobot } from './check';
import { jointFit } from './defaults';
import { buildMjcfModel, buildRobotPackage, buildSdfModel } from './export';
import type { RobotPackage } from './export';
import { linkNodes, linkOf } from './model';
import { defaultJoint, defaultLink } from './types';
import type { CollisionKind, Robot, RobotJoint } from './types';

beforeAll(async () => {
  await initKernel();
});

let next = 0;
const id = (): string => `fx${String(++next).padStart(6, '0')}`;

function shape(kind: ShapeKind, name: string, pos: Vec3, size: Vec3, rot: Vec3 = [0, 0, 0], color = '#8fa3bf'): SceneNode {
  return { id: id(), name, type: 'shape', shape: kind, params: defaultParams(kind), pos, rot, size, hole: false, color };
}

/** A joint from `parent` to `child` at `origin` in the child's frame; its motor figures are fitted once the robot is whole. */
function joint(name: string, parent: SceneNode, child: SceneNode, origin: Vec3, over: Partial<RobotJoint>): RobotJoint {
  return { ...defaultJoint(id(), name, parent.id, child.id, origin), ...over };
}

/** The design, with every joint's effort, velocity and damping fitted to the sides it moves. */
function design(name: string, scene: SceneNode[], robot: Robot): Doc {
  const doc = emptyDoc();
  doc.name = name;
  doc.scene = scene;
  const nodes = linkNodes(scene);
  doc.robot = { ...robot, joints: robot.joints.map((j) => ({ ...j, ...jointFit(robot, nodes, j), ...(j.velocity !== 90 ? { velocity: j.velocity } : {}) })) };
  return doc;
}

/** A box on four wheels: the wheels lie along X (cylinders turned 90° about Y), so it drives along Y. */
function rover(): Doc {
  const body = shape('box', 'Body', [0, 0, 25], [80, 120, 30]);
  const wheels = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => shape('cylinder', `Wheel ${sx < 0 ? 'left' : 'right'} ${sy < 0 ? 'back' : 'front'}`, [sx * 46, sy * 40, 20], [40, 40, 12], [0, 90, 0], '#e8853a')));
  const joints = wheels.map((w) => joint(`${w.name} joint`, body, w, [0, 0, 0], { type: 'continuous', velocity: 360 }));
  const sideOf = (w: SceneNode) => (w.pos[0] < 0 ? 'left' : 'right');
  return design('Reference rover', [body, ...wheels], {
    root: body.id,
    base: 'free',
    links: [{ ...defaultLink(body.id), collision: 'box' }, ...wheels.map((w) => ({ ...defaultLink(w.id), collision: 'cylinder' as CollisionKind, friction: 1 }))],
    joints,
    sensors: [],
    drive: { left: joints.filter((_j, i) => sideOf(wheels[i]) === 'left').map((j) => j.id), right: joints.filter((_j, i) => sideOf(wheels[i]) === 'right').map((j) => j.id) },
    control: true,
  });
}

/** A three-joint arm on a plate bolted to the bench: a turret turning about Z, then two segments turning about X. */
function arm(): Doc {
  const plate = shape('box', 'Base plate', [0, 0, 5], [80, 80, 10]);
  const turret = shape('cylinder', 'Turret', [0, 0, 25], [50, 50, 30], [0, 0, 0], '#e8853a');
  const upper = shape('box', 'Upper arm', [0, 0, 100], [20, 20, 120]);
  const fore = shape('box', 'Forearm', [0, 0, 210], [16, 16, 100]);
  return design('Reference arm', [plate, turret, upper, fore], {
    root: plate.id,
    base: 'fixed',
    links: [{ ...defaultLink(plate.id), collision: 'box' }, { ...defaultLink(turret.id), collision: 'cylinder' }, { ...defaultLink(upper.id), collision: 'box' }, { ...defaultLink(fore.id), collision: 'box' }],
    joints: [
      joint('Turret joint', plate, turret, [0, 0, -15], { axis: [0, 0, 1], lower: -170, upper: 170 }),
      joint('Shoulder', turret, upper, [0, 0, -60], { axis: [1, 0, 0], lower: -90, upper: 90 }),
      joint('Elbow', upper, fore, [0, 0, -50], { axis: [1, 0, 0], lower: -120, upper: 120 }),
    ],
    sensors: [],
    control: true,
  });
}

/** A body on four two-segment legs, hips and knees turning about Y, feet on the floor. */
function quadruped(): Doc {
  const body = shape('box', 'Body', [0, 0, 90], [120, 60, 30]);
  const scene = [body];
  const joints: RobotJoint[] = [];
  const links = [{ ...defaultLink(body.id), collision: 'box' as CollisionKind }];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const leg = `${sy < 0 ? 'rear' : 'front'} ${sx < 0 ? 'left' : 'right'}`;
      const upper = shape('box', `Upper leg ${leg}`, [sx * 50, sy * 36, 55], [12, 12, 40], [0, 0, 0], '#e8853a');
      const lower = shape('box', `Lower leg ${leg}`, [sx * 50, sy * 36, 17.5], [10, 10, 35]);
      scene.push(upper, lower);
      links.push({ ...defaultLink(upper.id), collision: 'box' }, { ...defaultLink(lower.id), collision: 'box', friction: 1 });
      joints.push(joint(`Hip ${leg}`, body, upper, [0, 0, 20], { axis: [0, 1, 0], lower: -60, upper: 60 }), joint(`Knee ${leg}`, upper, lower, [0, 0, 17.5], { axis: [0, 1, 0], lower: -90, upper: 90 }));
    }
  }
  return design('Reference quadruped', scene, { root: body.id, base: 'free', links, joints, sensors: [], control: true });
}

const ROBOTS: { file: string; make: () => Doc }[] = [
  { file: 'rover', make: rover },
  { file: 'arm', make: arm },
  { file: 'quadruped', make: quadruped },
];

function write(pkg: RobotPackage, out: string): void {
  for (const f of pkg.files) {
    const path = join(out, pkg.name, f.name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, f.bytes);
  }
}

describe.each(ROBOTS)('the reference $file', ({ file, make }) => {
  it('passes the checks and exports in every format', () => {
    const doc = make();
    const robot = doc.robot!;
    const nodes = linkNodes(doc.scene);
    const geo = robotGeometry(nodes, Object.fromEntries(nodes.map((n) => [n.id, linkOf(robot, n.id).collision])), true);
    const geometry = new Map(geo.map((g) => [g.id, g]));
    expect(checkRobot(doc, new Map(geo.map((g) => [g.id, g.props])), robot)).toEqual([]);
    const packages = [buildRobotPackage(doc, geometry, robot), buildSdfModel(doc, geometry, robot), buildMjcfModel(doc, geometry, robot)];
    for (const pkg of packages) expect(pkg.warnings).toEqual([]);
    const out = process.env.ROBOT_FIXTURES_OUT;
    if (out) {
      write(packages[2], out);
      writeFileSync(join('fixtures', 'robots', `${file}.plastikcad`), serializeDoc(doc));
    }
  });
});
