// Mecanum wheels in robot mode: which objects count as one, the rollers a
// simulator is given for it, the checks, and what each export writes.
import { beforeAll, describe, expect, it } from 'vitest';
import { initKernel, robotGeometry } from '../geometry/kernel';
import { boxBounds, unionBounds } from '../model/math';
import { makeGroup } from '../model/ops';
import type { Doc, PartNode, SceneNode, Vec3 } from '../model/types';
import { checkRobot } from './check';
import { buildIsaacStage, buildMjcfModel, buildRobotPackage, buildSdfModel } from './export';
import { mecanumRover, ROBOTS } from './fixtures';
import { linkNodes, linkOf } from './model';
import type { DriveRole } from './types';
import { gripLine, isWheel, leansRight, mecanumOf, rollersMesh, rollersOf, WHEEL_FRICTION } from './wheels';
import type { MecanumWheel } from './wheels';

beforeAll(async () => {
  await initKernel();
});

const text = (pkg: { files: { name: string; bytes: Uint8Array }[] }, name: string): string => new TextDecoder().decode(pkg.files.find((f) => f.name === name || f.name.endsWith(name))!.bytes);

function geometryOf(doc: Doc) {
  const robot = doc.robot!;
  const nodes = linkNodes(doc.scene);
  const geo = robotGeometry(nodes, Object.fromEntries(nodes.map((n) => [n.id, linkOf(robot, n.id).collision])), false);
  return { geo, geometry: new Map(geo.map((g) => [g.id, g])), props: new Map(geo.map((g) => [g.id, g.props])) };
}

const wheelsOf = (doc: Doc): PartNode[] => doc.scene.filter((n): n is PartNode => n.type === 'part');
const roleOf = (doc: Doc, wheel: SceneNode): DriveRole => doc.robot!.drive!.roles[doc.robot!.joints.find((j) => j.child === wheel.id)!.id];
const found = (node: SceneNode): MecanumWheel => {
  const w = mecanumOf(node);
  if (typeof w === 'string') throw new Error(w);
  return w;
};
/** The rover faces +Y. */
const FORWARD: Vec3 = [0, 1, 0];

describe('which objects are mecanum wheels', () => {
  it('takes the part as it comes, and a shape for no wheel at all', () => {
    const doc = mecanumRover();
    const [body] = doc.scene;
    expect(mecanumOf(body)).toBe('not-a-part');
    expect(isWheel(body)).toBe(false);
    for (const w of wheelsOf(doc)) {
      expect(isWheel(w)).toBe(true);
      expect(found(w).figures.count).toBe(9);
      expect(found(w).scale).toBeCloseTo(1, 9);
    }
    // The plain wheel of the same family is a wheel, and not a mecanum one.
    const plain: SceneNode = { ...wheelsOf(doc)[0], part: 'wheel', params: {} };
    expect(isWheel(plain)).toBe(true);
    expect(mecanumOf(plain)).toBe('not-a-part');
  });

  it('keeps a wheel that is scaled evenly, and one grouped with a hole or a hub', () => {
    const w = wheelsOf(mecanumRover())[0];
    const larger = { ...w, size: w.size.map((x) => x * 1.5) as Vec3 };
    expect(found(larger).scale).toBeCloseTo(1.5, 9);
    const hole: SceneNode = { id: 'hole', name: 'Bore', type: 'shape', shape: 'cylinder', params: {}, pos: [...w.pos] as Vec3, rot: [0, 90, 0], size: [8, 8, 60], hole: true, color: '#888888' };
    const hub: SceneNode = { id: 'hub', name: 'Hub', type: 'shape', shape: 'box', params: {}, pos: [w.pos[0] + 40, w.pos[1], w.pos[2]], rot: [0, 0, 0], size: [30, 20, 20], hole: false, color: '#888888' };
    const group = makeGroup([w, hole, hub], unionBounds([boxBounds(w), boxBounds(hole), boxBounds(hub)]), 'Wheel on its hub');
    const alone = rollersOf(found(w));
    const grouped = rollersOf(found(group));
    expect(grouped.length).toBe(alone.length);
    grouped.forEach((r, i) => {
      r.center.forEach((x, k) => expect(x).toBeCloseTo(alone[i].center[k], 6));
      r.axis.forEach((x, k) => expect(x).toBeCloseTo(alone[i].axis[k], 9));
    });
    // The group stretched along one axis stretches the wheel in it.
    expect(mecanumOf({ ...group, size: [group.size[0] * 1.2, group.size[1], group.size[2]] })).toBe('stretched');
  });

  it('refuses a wheel stretched unevenly, one whose rollers leave gaps, and two in one object', () => {
    const w = wheelsOf(mecanumRover())[0];
    expect(mecanumOf({ ...w, size: [w.size[0], w.size[1], w.size[2] * 1.3] })).toBe('stretched');
    expect(mecanumOf({ ...w, params: { ...w.params, size: 'custom', diameter: 200, width: 20, rollers: 6 } })).toBe('gaps');
    const twin = { ...w, id: 'twin', pos: [w.pos[0] + 80, w.pos[1], w.pos[2]] as Vec3 };
    expect(mecanumOf(makeGroup([w, twin], unionBounds([boxBounds(w), boxBounds(twin)]), 'Two wheels'))).toBe('several');
  });
});

describe('the rollers of a mecanum wheel', () => {
  it('are balls that touch the circle of the wheel from inside, wherever the wheel stands', () => {
    const doc = mecanumRover('152');
    for (const w of wheelsOf(doc)) {
      const wheel = found(w);
      const rollers = rollersOf(wheel);
      expect(rollers.length).toBe(15);
      for (const r of rollers) {
        expect(Math.hypot(...r.axis)).toBeCloseTo(1, 9);
        for (const b of r.balls) {
          // The axle runs along X through the wheel's middle: a ball's far side is on the wheel's circle, and it stays between the wheel's sides.
          const at = b.at.map((x, k) => x + r.center[k] - w.pos[k]);
          expect(Math.hypot(at[1], at[2]) + b.radius).toBeCloseTo(76, 6);
          expect(Math.abs(at[0]) + b.radius).toBeLessThan(55.5 / 2);
          expect(b.radius).toBeGreaterThan(1);
        }
      }
    }
  });

  it('stand where the wheel the kernel builds has its rollers: on the floor under it', () => {
    const doc = mecanumRover();
    const { geometry } = geometryOf(doc);
    for (const w of wheelsOf(doc)) {
      const box = geometry.get(w.id)!.bounds;
      const balls = rollersOf(found(w)).flatMap((r) => r.balls.map((b) => ({ at: b.at.map((x, k) => x + r.center[k]) as Vec3, radius: b.radius })));
      for (const k of [0, 1, 2]) {
        expect(Math.min(...balls.map((b) => b.at[k] - b.radius))).toBeGreaterThan(box.min[k] - 0.05);
        expect(Math.max(...balls.map((b) => b.at[k] + b.radius))).toBeLessThan(box.max[k] + 0.05);
      }
      // The lowest ball is within a few tenths of a millimeter of the floor the wheel stands on, and so all round the wheel.
      expect(Math.min(...balls.map((b) => b.at[2] - b.radius))).toBeLessThan(box.min[2] + 0.3);
      expect(Math.max(...balls.map((b) => b.at[1] + b.radius))).toBeGreaterThan(box.max[1] - 0.3);
    }
  });

  it('lean as the corner wants on the reference rover, and the other way with the other hand', () => {
    const doc = mecanumRover();
    for (const w of wheelsOf(doc)) {
      const role = roleOf(doc, w);
      expect(leansRight(found(w), role, FORWARD)).toBe(true);
      const g = gripLine(found(w));
      // Front left and rear right grip along forward-and-right (+X is the rover's right), the other two along forward-and-left.
      expect(Math.sign(g[0] * g[1])).toBe(role === 'front-left' || role === 'rear-right' ? 1 : -1);
      const other = { ...w, params: { ...w.params, hand: w.params.hand === 'left' ? 'right' : 'left' } };
      expect(leansRight(found(other), role, FORWARD)).toBe(false);
      // Turned half way round on its axle's side, a wheel is the same wheel.
      expect(leansRight(found({ ...w, rot: [0, -90, 0] }), role, FORWARD)).toBe(true);
    }
  });

  it('take the hand from the shape and not the setting alone: a mirrored wheel is the other hand', () => {
    const doc = mecanumRover();
    const w = wheelsOf(doc)[0];
    const role = roleOf(doc, w);
    for (const flip of [[true, false, false], [false, true, false], [false, false, true]] as [boolean, boolean, boolean][]) {
      expect(leansRight(found({ ...w, flip }), role, FORWARD)).toBe(false);
      expect(leansRight(found({ ...w, flip, params: { ...w.params, hand: w.params.hand === 'left' ? 'right' : 'left' } }), role, FORWARD)).toBe(true);
    }
    // Mirrored twice it is itself again.
    expect(leansRight(found({ ...w, flip: [true, true, false] }), role, FORWARD)).toBe(true);
  });
});

describe('the checks on a mecanum drive', () => {
  it('pass the reference rover, and stop a wheel on the wrong corner by name', () => {
    const doc = mecanumRover();
    const { props } = geometryOf(doc);
    expect(checkRobot(doc, props)).toEqual([]);
    const w = wheelsOf(doc)[0];
    w.params = { ...w.params, hand: w.params.hand === 'left' ? 'right' : 'left' };
    const problems = checkRobot(doc, props);
    expect(problems).toEqual([{ level: 'error', text: `${w.name}: its rollers lean the wrong way for the corner Rear left. Set its Hand to Right.`, link: w.id }]);
  });

  it('stop the export for a wheel that is not the part, is stretched or has gaps, since the robot will not slide', () => {
    const rover = ROBOTS.find((r) => r.file === 'rover')!.make();
    const byId = new Map(rover.scene.map((n) => [n.id, n]));
    rover.robot!.drive = { kind: 'mecanum', roles: Object.fromEntries(rover.robot!.joints.map((j) => [j.id, `${byId.get(j.child)!.pos[1] > 0 ? 'front' : 'rear'}-${byId.get(j.child)!.pos[0] < 0 ? 'left' : 'right'}` as DriveRole])) };
    const plain = checkRobot(rover, new Map());
    expect(plain.map((p) => p.level)).toEqual(['error', 'error', 'error', 'error']);
    expect(plain[0].text).toMatch(/^Wheel left back: not a Mecanum wheel part, so it cannot slide sideways\. Use a Mecanum wheel from the parts\.$/);

    const doc = mecanumRover();
    const [a, b] = wheelsOf(doc);
    a.size = [a.size[0], a.size[1], a.size[2] * 1.5];
    b.params = { ...b.params, size: 'custom', diameter: 100, width: 12, rollers: 6 };
    const texts = checkRobot(doc, new Map()).map((p) => `${p.level} ${p.text}`);
    expect(texts).toEqual([`error ${a.name}: stretched unevenly, so it cannot slide sideways. Scale it the same on every side.`, `error ${b.name}: its rollers leave gaps, so it cannot slide sideways. Add rollers or make the wheel wider.`]);
  });
});

describe('the shape the plate draws a mecanum wheel colliding as', () => {
  it('is its balls, none reaching past the wheel\'s box', () => {
    const [w] = wheelsOf(mecanumRover());
    const wheel = mecanumOf(w) as MecanumWheel;
    const mesh = rollersMesh(wheel);
    const balls = rollersOf(wheel).reduce((n, r) => n + r.balls.length, 0);
    expect(mesh.positions.length / 3).toBe(balls * 26);
    expect(mesh.triangles.length / 3).toBe(balls * 48);
    expect(Math.max(...mesh.triangles)).toBe(mesh.positions.length / 3 - 1);
    const box = boxBounds(w);
    for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) {
      expect(mesh.positions[i + k]).toBeGreaterThan(box.min[k] - 0.01);
      expect(mesh.positions[i + k]).toBeLessThan(box.max[k] + 0.01);
    }
  });
});

describe('a link that is a wheel part', () => {
  it('grips like rubber until a friction is typed', () => {
    const doc = mecanumRover();
    const w = wheelsOf(doc)[0];
    const robot = doc.robot!;
    expect(linkOf(robot, w.id, w).friction).toBe(WHEEL_FRICTION);
    expect(linkOf(robot, doc.scene[0].id, doc.scene[0]).friction).toBe(0.8);
    const typed = { ...robot, links: [...robot.links, { ...linkOf(robot, w.id, w), friction: 0.4 }] };
    expect(linkOf(typed, w.id, w).friction).toBe(0.4);
    const { geometry } = geometryOf(doc);
    expect(text(buildMjcfModel(doc, geometry, typed), '.xml')).toContain('friction="0.4 0.005 0.0001"');
  });
});

describe('what the exports write for a mecanum wheel', () => {
  it('MuJoCo: rollers as bodies on free hinges, no shape for the wheel itself, no motor or reading for a roller', () => {
    const doc = mecanumRover();
    const { geometry } = geometryOf(doc);
    const pkg = buildMjcfModel(doc, geometry);
    const xml = text(pkg, '.xml');
    expect(xml.match(/<body name="Wheel_\w+_roller_\d+"/g)?.length).toBe(36);
    expect(xml.match(/<joint name="Wheel_\w+_roller_\d+_joint" type="hinge"/g)?.length).toBe(36);
    // Only balls collide, beside the body's box.
    expect(xml.match(/<geom type="(\w+)"[^>]*class="collision"/g)?.every((g) => g.includes('type="sphere"') || g.includes('type="box"'))).toBe(true);
    expect(xml.match(/<geom type="box"[^>]*class="collision"/g)?.length).toBe(1);
    expect(xml).not.toMatch(/roller_\d+_joint_(pos|vel|motor|servo)/);
    expect(xml.match(/<velocity /g)?.length).toBe(4);
    // The robot's own lists know nothing of them.
    expect(pkg.bodies.length).toBe(5);
    expect(pkg.joints.length).toBe(4);
    // The home pose has a place for every joint, rollers included: the base's seven and forty hinges.
    expect(xml.match(/<key name="home" qpos="([^"]+)"/)![1].split(' ').length).toBe(7 + 40);
  });

  it('weighs the wheel and its rollers together what the wheel weighed', () => {
    const doc = mecanumRover();
    const { geometry } = geometryOf(doc);
    const xml = text(buildMjcfModel(doc, geometry), '.xml');
    const off = text(buildMjcfModel(doc, geometry, { ...doc.robot!, links: [...doc.robot!.links, ...wheelsOf(doc).map((w) => ({ ...linkOf(doc.robot!, w.id, w), collision: 'none' as const }))] }), '.xml');
    const masses = (x: string) => [...x.matchAll(/mass="([-0-9.e]+)"/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    // With its collision off a wheel gets no rollers, and keeps its whole weight.
    expect(off).not.toContain('_roller_');
    expect(masses(xml)).toBeCloseTo(masses(off), 6);
  });

  it('Gazebo: the rollers are links of the SDF model, and the joint states are those of the robot own joints', () => {
    const doc = mecanumRover();
    const { geometry } = geometryOf(doc);
    const sdf = text(buildSdfModel(doc, geometry), 'model.sdf');
    expect(sdf.match(/<link name="Wheel_\w+_roller_\d+">/g)?.length).toBe(36);
    expect(sdf).toContain('<pose relative_to="Wheel_rear_left">');
    expect(sdf).toContain('<xyz expressed_in="Wheel_rear_left">');
    expect(sdf).not.toContain('<collision name="Wheel_rear_left_collision">');
    expect(sdf.match(/<joint_name>/g)?.length).toBe(4);
    expect(sdf).toContain('gz::sim::systems::MecanumDrive');
  });

  it("Gazebo: a roller grips along its axle, whichever way the robot faces", () => {
    // Gazebo's friction is a square it lays along the world's axes unless told a direction: each ball of a roller
    // tells its roller's axle, in the roller's own frame (which the axle does not turn in), with the grip whole.
    const doc = mecanumRover();
    const { geometry } = geometryOf(doc);
    for (const xml of [text(buildSdfModel(doc, geometry), 'model.sdf'), text(buildRobotPackage(doc, geometry), '.urdf')]) {
      expect(xml).toContain('xmlns:gz="http://gazebosim.org/schema"');
      const rollers = [...xml.matchAll(/<link name="(Wheel_\w+_roller_\d+)">([\s\S]*?)<\/link>\s*<joint name="\1_joint" type="revolute">[\s\S]*?<xyz expressed_in="Wheel_\w+">([^<]+)<\/xyz>/g)];
      expect(rollers.length).toBe(36);
      for (const [, name, link, axle] of rollers) {
        const balls = link.match(/<collision /g)!.length;
        expect(balls).toBeGreaterThan(0);
        expect(link.split(`<surface><friction><ode><mu>1</mu><mu2>1</mu2><fdir1 gz:expressed_in="${name}">${axle}</fdir1></ode></friction></surface>`).length - 1).toBe(balls);
      }
    }
  });

  it('Gazebo: a roller hinge holds still against a bearing drag that follows the load, so a stopped robot does not roll on', () => {
    const drag = (x: string) => [...x.matchAll(/<xyz expressed_in="Wheel_\w+">[^<]+<\/xyz><dynamics><friction>([-0-9.e]+)<\/friction><\/dynamics><\/axis>/g)].map((m) => Number(m[1]));
    const doc = mecanumRover();
    const { geometry } = geometryOf(doc);
    const light = drag(text(buildSdfModel(doc, geometry), 'model.sdf'));
    expect(light.length).toBe(36);
    // A fiftieth of what a wheel carries (about 5 N of a 2 kg robot's weight), at the roller's rim (about 10 mm).
    expect(new Set(light).size).toBe(1);
    expect(light[0]).toBeGreaterThan(0.0009);
    expect(light[0]).toBeLessThan(0.0013);
    // The ROS package hands Gazebo the same hinges.
    expect(drag(text(buildRobotPackage(doc, geometry), '.urdf'))).toEqual(light);
    // A heavier robot's rollers drag more, in step with its weight.
    const body = doc.scene[0];
    const heavy = { ...doc.robot!, links: [...doc.robot!.links.filter((l) => l.node !== body.id), { ...linkOf(doc.robot!, body.id, body), mass: { kind: 'measured' as const, grams: 10000 } }] };
    const loaded = drag(text(buildSdfModel(doc, geometry, heavy), 'model.sdf'));
    expect(loaded[0] / light[0]).toBeGreaterThan(4);
    expect(loaded[0] / light[0]).toBeLessThan(6);
  });

  it('ROS: the URDF keeps to the robot own links and joints, and hands Gazebo the rollers in its own blocks', () => {
    const doc = mecanumRover();
    const { geometry } = geometryOf(doc);
    const pkg = buildRobotPackage(doc, geometry);
    for (const file of ['.urdf', '.urdf.xacro']) {
      const urdf = text(pkg, file);
      const [robot, gazebo] = [urdf.slice(0, urdf.indexOf('<gazebo')), urdf.slice(urdf.indexOf('<gazebo'))];
      expect(robot.match(/<link name=/g)?.length).toBe(7);
      expect(robot).not.toContain('_roller_');
      expect(robot).not.toContain('<collision>\n      <geometry><mesh');
      expect(gazebo.match(/<link name="Wheel_\w+_roller_\d+">/g)?.length).toBe(36);
      expect(gazebo.match(/<joint_name>/g)?.length).toBe(4);
    }
    expect(pkg.warnings).toEqual([]);
  });

  it('Isaac Sim: rollers in the articulation, finer steps, and a speed mixed for each wheel from cmd_vel', () => {
    const doc = mecanumRover();
    const { geometry } = geometryOf(doc);
    const pkg = buildIsaacStage(doc, geometry);
    const usda = text(pkg, '.usda');
    expect(usda.match(/def Xform "Wheel_\w+_roller_\d+"/g)?.length).toBe(36);
    expect(usda.match(/def PhysicsRevoluteJoint "Wheel_\w+_roller_\d+_joint"/g)?.length).toBe(36);
    // The rollers' hinges are outside the articulation, whose joint states and transforms are then the robot's own.
    expect(usda.match(/bool physics:excludeFromArticulation = 1/g)?.length).toBe(36);
    expect(usda).toContain('uint physxScene:timeStepsPerSecond = 120');
    expect(usda).not.toContain('DifferentialController');
    // Front left: forward less sideways, less the turn; the wheel is 50 mm in radius, so 20 a meter.
    expect(usda).toMatch(/def OmniGraphNode "wheel0_linear"[^}]*?double3 attrValue = \(20, -20, 0\)\s+string resolvedType = "vectord\[3\]"/);
    expect(usda).toContain('custom token[] inputs:jointNames = ["Wheel_front_left_joint", "Wheel_front_right_joint", "Wheel_rear_left_joint", "Wheel_rear_right_joint"]');
    expect(pkg.warnings).toEqual([]);
    // A rover without rollers is stepped as Isaac Sim steps anything.
    const rover = ROBOTS.find((r) => r.file === 'rover')!.make();
    expect(text(buildIsaacStage(rover, geometryOf(rover).geometry), '.usda')).not.toContain('timeStepsPerSecond');
  });

  it('the starter script slides a mecanum drive sideways', () => {
    const doc = mecanumRover();
    const py = text(buildMjcfModel(doc, geometryOf(doc).geometry), 'drive.py');
    expect(py).toContain('v, w, vy = self.plan(t)');
    expect(py).not.toContain('vy = 0.0');
  });
});
