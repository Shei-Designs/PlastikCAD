import { beforeAll, describe, expect, it } from 'vitest';
import type { MainModule } from '@mujoco/mujoco';
import { xmlTree } from '../io/xml';
import type { XmlElement } from '../io/xml';
import { emptyDoc } from '../model/file';
import type { Doc, SceneNode } from '../model/types';
import { loadMujoco, Simulation } from '../sim/mujoco';
import type { LinkGeometry } from '../worker/protocol';
import { checkRobot } from './check';
import { buildIsaacStage, buildMjcfModel, buildRobotPackage, buildSdfModel, exportSummary } from './export';
import type { RobotPackage } from './export';
import { meshProperties } from './inertia';
import { driveForward, jointInChild, jointInDesign, linkNodes, spanningTree } from './model';
import { defaultJoint, defaultLink, defaultSensor, DRIVE_KINDS, SENSOR_KINDS } from './types';
import { ROBOTS } from './fixtures';
import type { Robot } from './types';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

const node = (id: string, name: string, pos: [number, number, number], size: [number, number, number]): SceneNode => ({ id, name, type: 'shape', shape: 'box', params: {}, pos, rot: [0, 0, 0], size, hole: false, color: '#ff8800' });

/** A closed box mesh, placed, as the kernel would hand it over. */
function boxGeometry(n: SceneNode): LinkGeometry {
  const [w, d, h] = n.size;
  const [x, y, z] = [n.pos[0] - w / 2, n.pos[1] - d / 2, n.pos[2] - h / 2];
  const positions = new Float32Array([x, y, z, x + w, y, z, x + w, y + d, z, x, y + d, z, x, y, z + h, x + w, y, z + h, x + w, y + d, z + h, x, y + d, z + h]);
  const triangles = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  const mesh = { positions, triangles };
  return { id: n.id, visual: [{ color: n.color, mesh }], collision: mesh, bounds: { min: [x, y, z], max: [x + w, y + d, z + h] }, props: { id: n.id, ...meshProperties(mesh), watertight: true, triangles: 12 } };
}

const body = node('body0001', 'Body', [0, 0, 10], [100, 60, 20]);
const wheel = node('whel0001', 'Left wheel', [0, 40, 10], [20, 8, 20]);
const arm = node('arm00001', 'Arm (upper)', [0, 0, 40], [10, 10, 40]);

function robot(): Robot {
  return {
    root: body.id,
    base: 'fixed',
    sensors: [],
    control: true,
    links: [{ ...defaultLink(wheel.id), mass: { kind: 'measured', grams: 50 }, collision: 'hull', friction: 1.2 }, { ...defaultLink(arm.id), collision: 'box' }],
    joints: [
      // In the child's frame: the wheel's axle 4 mm inboard of its center, the shoulder at the arm's lower end.
      { ...defaultJoint('j1', 'left wheel joint', body.id, wheel.id, [0, -4, 0]), type: 'continuous', axis: [0, 1, 0], effort: 2, velocity: 720, damping: 0.001 },
      { ...defaultJoint('j2', 'shoulder', body.id, arm.id, [0, 0, -20]), axis: [0, 1, 0], lower: -90, upper: 90 },
    ],
  };
}

function doc() {
  const d = emptyDoc();
  d.name = 'Test Rover';
  d.scene = [body, wheel, arm];
  d.robot = robot();
  return d;
}

const geometry = () => new Map([body, wheel, arm].map((n) => [n.id, boxGeometry(n)]));

describe('spanningTree', () => {
  it('walks from the base and tells loops and strays apart', () => {
    const r = robot();
    r.joints.push({ ...defaultJoint('j3', 'closing', arm.id, wheel.id, [0, 0, 0]) });
    const tree = spanningTree(r, [body.id, wheel.id, arm.id, 'stray001']);
    expect(tree.order).toEqual([body.id, wheel.id, arm.id]);
    expect(tree.loops.map((j) => j.id)).toEqual(['j3']);
    expect(tree.unreached).toEqual(['stray001']);
  });
});

describe('exportSummary', () => {
  it('says what goes out and that the rest is ignored', () => {
    const d = doc();
    expect(exportSummary(d, 'urdf')).toBe('Writes "Test Rover" (ROS 2 package): the base Body and everything joined to it.');
    d.scene.push(node('stray001', 'Spare bracket', [50, 50, 5], [10, 10, 10]));
    expect(exportSummary(d, 'mjcf')).toBe('Writes "Test Rover" (MuJoCo model): the base Body and everything joined to it. One object is not joined to the base and will be ignored.');
    d.scene.push(node('stray002', 'Other bracket', [70, 50, 5], [10, 10, 10]));
    expect(exportSummary(d, 'sdf')).toMatch(/2 objects are not joined to the base and will be ignored\.$/);
  });
});

describe('a joint in the child frame', () => {
  it('turns and moves with the child, and comes back', () => {
    const child = node('c', 'Child', [10, 20, 30], [10, 10, 10]);
    child.rot = [0, 0, 90];
    const placed = jointInDesign({ ...defaultJoint('j', 'j', 'p', 'c', [5, 0, 0]), axis: [1, 0, 0] }, child);
    expect(placed.origin.map((v) => +v.toFixed(6))).toEqual([10, 25, 30]);
    expect(placed.axis.map((v) => +v.toFixed(6))).toEqual([0, 1, 0]);
    const back = jointInChild(placed.origin, placed.axis, child);
    expect(back.origin.map((v) => +v.toFixed(6))).toEqual([5, 0, 0]);
    expect(back.axis.map((v) => +v.toFixed(6))).toEqual([1, 0, 0]);
  });
});

describe('checkRobot', () => {
  it('passes a sound robot and faults a broken one', () => {
    const d = doc();
    const props = new Map([...geometry()].map(([id, g]) => [id, g.props]));
    expect(checkRobot(d, props)).toEqual([]);
    // Figures that only look odd are not faulted: an effort and damping far beyond what the shoulder's sides ask for.
    d.robot!.joints[1].effort = 1000;
    d.robot!.joints[1].damping = 100;
    expect(checkRobot(d, props)).toEqual([]);
    d.robot!.root = null;
    d.robot!.joints[1].lower = 100;
    d.robot!.links[0].mass = { kind: 'measured', grams: 0 };
    // Three errors and nothing else: a weightless wheel is a fault, a motor too strong for it is not.
    const problems = checkRobot(d, props);
    expect(problems.map((p) => p.level)).toEqual(['error', 'error', 'error']);
    expect(problems[0].text).toMatch(/base link/);
    expect(problems[1].joint).toBe('j2');
    expect(problems[2].link).toBe(wheel.id);
  });

  it('warns only when the camera near plane clips the floor; a lidar that reads the floor is reading what is there', () => {
    const d = doc();
    const props = new Map([...geometry()].map(([id, g]) => [id, g.props]));
    // The body spans z 0–20, so a lidar at its top is 20 mm up for a 12 m sweep, and tipped 10° it meets the floor 115 mm out: both read the floor, neither is a fault.
    d.robot!.sensors = [{ ...defaultSensor('s1', 'scanner', 'lidar', body.id, [0, 0, 10]) }];
    expect(checkRobot(d, props)).toEqual([]);
    d.robot!.sensors[0].rot = [0, 10, 0];
    expect(checkRobot(d, props)).toEqual([]);
    // A level camera 20 mm up sees the floor 32 mm deep at the bottom of its picture: inside the 50 mm near plane. Looking up, or a 20 mm near plane, clears it.
    d.robot!.sensors = [{ ...defaultSensor('s2', 'cam', 'camera', body.id, [50, 0, 10]) }];
    const told = checkRobot(d, props);
    expect(told.map((p) => [p.level, p.sensor])).toEqual([['warning', 's2']]);
    expect(told[0].text).toMatch(/the floor is 32 mm away at the picture's edge, inside the 50 mm near clip/);
    d.robot!.sensors[0].rot = [0, -40, 0];
    expect(checkRobot(d, props)).toEqual([]);
    d.robot!.sensors[0].rot = [0, 0, 0];
    d.robot!.sensors[0].camera = { ...d.robot!.sensors[0].camera, near: 20 };
    expect(checkRobot(d, props)).toEqual([]);
  });

  it('never throws, whatever becomes of an object the robot names', () => {
    for (const { make } of ROBOTS) {
      const count = make().scene.length;
      for (let i = 0; i < count; i++) {
        for (const fate of ['hidden', 'hole', 'gone'] as const) {
          for (const kind of DRIVE_KINDS) {
            const d = make();
            const r = d.robot!;
            const lost = d.scene[i];
            // Everything that can point at an object points at this one: a sensor of every kind on it, and its joints in the drive, as wheels and as steering.
            r.sensors.push(...SENSOR_KINDS.map((k) => defaultSensor(`on-${k.id}`, `${k.name} on it`, k.id, lost.id, [0, 0, 0])));
            const joined = r.joints.filter((j) => j.child === lost.id || j.parent === lost.id);
            r.drive = { kind: kind.id, roles: { ...r.drive?.roles, ...Object.fromEntries(joined.map((j, n) => [j.id, kind.roles[n % kind.roles.length].id])) } };
            const props = new Map(linkNodes(d.scene).map((n) => [n.id, boxGeometry(n).props]));
            d.scene = fate === 'gone' ? d.scene.filter((n) => n !== lost) : d.scene.map((n) => (n === lost ? { ...n, hidden: fate === 'hidden', hole: fate === 'hole' } : n));
            let problems: ReturnType<typeof checkRobot> = [];
            expect(() => (problems = checkRobot(d, props))).not.toThrow();
            // The loss is told as an error, which is what stops the export and the test drive.
            expect(problems.some((p) => p.level === 'error')).toBe(true);
          }
        }
      }
    }
  });

  it('faults a follower whose leader is fixed, closes a loop, is left out or follows it back, and nothing else', () => {
    const props = new Map([...geometry()].map(([id, g]) => [id, g.props]));
    const errors = (d: Doc) => checkRobot(d, props).filter((p) => p.level === 'error');
    // A follower of a joint that moves, and a follower of that follower, are sound.
    const sound = doc();
    sound.robot!.joints[1].mimic = { joint: 'j1', multiplier: 2, offset: 10 };
    expect(errors(sound)).toEqual([]);
    const fixed = doc();
    fixed.robot!.joints[0].type = 'fixed';
    fixed.robot!.joints[1].mimic = { joint: 'j1', multiplier: 1, offset: 0 };
    const loop = doc();
    loop.robot!.joints.push({ ...defaultJoint('j3', 'closing', arm.id, wheel.id, [0, 0, 0]) });
    loop.robot!.joints[1].mimic = { joint: 'j3', multiplier: 1, offset: 0 };
    const stray = doc();
    stray.scene.push(node('stray001', 'Spare bracket', [50, 50, 5], [10, 10, 10]), node('stray002', 'Other bracket', [70, 50, 5], [10, 10, 10]));
    stray.robot!.joints.push({ ...defaultJoint('j5', 'spare hinge', 'stray001', 'stray002', [0, 0, 0]) });
    stray.robot!.joints[1].mimic = { joint: 'j5', multiplier: 1, offset: 0 };
    const ring = doc();
    ring.robot!.joints[0].mimic = { joint: 'j2', multiplier: 1, offset: 0 };
    ring.robot!.joints[1].mimic = { joint: 'j1', multiplier: 1, offset: 0 };
    for (const [d, followers] of [[fixed, ['j2']], [loop, ['j2']], [stray, ['j2']], [ring, ['j1', 'j2']]] as const) {
      const told = errors(d);
      expect(told.map((p) => p.joint)).toEqual(followers);
      // One line each, naming the follower first and saying what to do.
      for (const p of told) expect(p.text).toMatch(/^(left wheel joint|shoulder): follows [^.]+\. [A-Z][^.]+\.$/);
    }
    // A fixed joint's Follows is never written, so it is not faulted.
    fixed.robot!.joints[1].type = 'fixed';
    expect(errors(fixed)).toEqual([]);
  });

  it('warns about loops and open meshes', () => {
    const d = doc();
    d.robot!.joints.push({ ...defaultJoint('j3', 'closing', arm.id, wheel.id, [0, 0, 0]) });
    const props = new Map([...geometry()].map(([id, g]) => [id, { ...g.props, watertight: id === arm.id ? false : true }]));
    const problems = checkRobot(d, props);
    expect(problems.every((p) => p.level === 'warning')).toBe(true);
    expect(problems.find((p) => p.joint === 'j3')?.text).toMatch(/loop/);
    expect(problems.find((p) => p.link === arm.id)?.text).toMatch(/not a closed mesh/);
  });
});

describe('a center of mass and an inertia typed for a weighed link', () => {
  // The wheel: 50 g, its center of mass typed 2 mm above the middle of its box, its inertia in g·mm².
  const typed = (inertia: [number, number, number, number, number, number] = [3000, 5000, 3000, 100, -200, 300]) => {
    const d = doc();
    d.robot!.links[0] = { ...d.robot!.links[0], mass: { kind: 'measured', grams: 50, center: [0, 0, 2], inertia } };
    return d;
  };

  it('are what every export writes, in the link\'s frame and SI', () => {
    const urdf = text(buildRobotPackage(typed(), geometry()).files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    // The wheel's frame is its joint, 4 mm inboard of its center.
    expect(urdf).toMatch(/<origin xyz="0 0.004 0.002" rpy="0 0 0"\/>\s*<mass value="0.05"\/>\s*<inertia ixx="0.000003" ixy="0.0000001" ixz="-0.0000002" iyy="0.000005" iyz="0.0000003" izz="0.000003"\/>/);
    const mjcf = text(buildMjcfModel(typed(), geometry()).files.find((f) => f.name.endsWith('.xml'))!.bytes);
    expect(mjcf).toContain('<inertial pos="0 0.004 0.002" mass="0.05" fullinertia="0.000003 0.000005 0.000003 0.0000001 -0.0000002 0.0000003"/>');
  });

  it('turn with the object', () => {
    const d = typed();
    d.scene = d.scene.map((n) => (n.id === wheel.id ? { ...n, rot: [0, 0, 90] } : n));
    const urdf = text(buildRobotPackage(d, geometry()).files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    expect(urdf).toMatch(/<inertia ixx="0.000005" ixy="-0.0000001" ixz="-0.0000003" iyy="0.000003" iyz="-0.0000002" izz="0.000003"\/>/);
  });

  it('leave nothing to estimate on an open mesh, and are refused when no body could have them', () => {
    const open = new Map([...geometry()].map(([id, g]) => [id, { ...g.props, watertight: id !== wheel.id }]));
    expect(checkRobot(doc(), open).map((p) => p.text)).toEqual(['Left wheel: not a closed mesh, so its mass and inertia are estimates.']);
    expect(checkRobot(typed(), open)).toEqual([]);
    // One moment larger than the other two together.
    const wrong = checkRobot(typed([100, 100, 900, 0, 0, 0]), open);
    expect(wrong).toEqual([{ level: 'error', text: '"Left wheel" has a typed inertia no real body could have.', link: wheel.id }]);
  });
});

describe("the base link's frame", () => {
  const files = (d: Doc, geo = new Map(linkNodes(d.scene).map((n) => [n.id, boxGeometry(n)]))) => {
    const pkg = buildRobotPackage(d, geo);
    const file = (name: string) => text(pkg.files.find((f) => f.name === name)!.bytes);
    return { urdf: file('urdf/test_rover.urdf'), launch: file('launch/gazebo.launch.py'), mjcf: text(buildMjcfModel(d, geo).files.find((f) => f.name === 'test_rover.xml')!.bytes), sdf: text(buildSdfModel(d, geo).files.find((f) => f.name === 'model.sdf')!.bytes) };
  };
  const moved = (d: Doc, by: [number, number, number]): Doc => ({ ...d, scene: d.scene.map((n) => ({ ...n, pos: [n.pos[0] + by[0], n.pos[1] + by[1], n.pos[2] + by[2]] as [number, number, number] })) });
  const free = (): Doc => {
    const d = doc();
    d.robot!.base = 'free';
    return d;
  };

  it('is at the base object, so the robot is the same wherever in the design it was built', () => {
    const here = files(free());
    const there = files(moved(free(), [300, -200, 0]));
    expect(there.urdf).toBe(here.urdf);
    // Its meshes are written from the body's middle: the body is 20 mm tall, so they reach 10 mm either way.
    const obj = text(buildRobotPackage(moved(free(), [300, -200, 0]), new Map(linkNodes(moved(free(), [300, -200, 0]).scene).map((n) => [n.id, boxGeometry(n)]))).files.find((f) => f.name === 'meshes/visual/Body.obj')!.bytes);
    expect(obj).toContain('v -0.05 -0.03 -0.01');
    // In a simulator's world it stands where the design had it.
    expect(there.mjcf).toMatch(/<body name="Body" pos="0.3 -0.2 0.01">\s*<freejoint name="root"\/>/);
    expect(there.mjcf).toMatch(/<key name="home" qpos="0.3 -0.2 0.01 1 0 0 0 0 0"\/>/);
    expect(there.sdf).toMatch(/<link name="Body">\s*<pose>0.3 -0.2 0.01 0 0 0<\/pose>/);
  });

  it('is spawned as high as the design has it, and a fixed base is held there', () => {
    // Free, with no drive and so no footprint: the body's middle is 10 mm up, and it settles from 50 mm more.
    expect(files(free()).launch).toContain("'-z', '0.06'");
    // Bolted down, the world holds the base where it is in the design.
    const fixed = files(moved(doc(), [300, -200, 0]));
    expect(fixed.urdf).toMatch(/<joint name="world_joint" type="fixed">\s*<parent link="world"\/>\s*<child link="Body"\/>\s*<origin xyz="0.3 -0.2 0.01" rpy="0 0 0"\/>/);
    expect(fixed.launch).toContain("'-z', '0.05'");
    expect(fixed.mjcf).toContain('<body name="Body" pos="0.3 -0.2 0.01">');
  });

  it("is at the origin of the base object's file when it keeps one", () => {
    const d = free();
    // The body as an imported mesh whose file measured it from its underside.
    d.scene = d.scene.map((n) => (n.id === body.id ? ({ id: n.id, name: n.name, type: 'import', asset: 'mesh-1', natural: n.size, origin: [0, 0, -10], pos: n.pos, rot: n.rot, size: n.size, hole: false, color: n.color } as SceneNode) : n));
    const geo = new Map(d.scene.map((n) => [n.id, boxGeometry(n)]));
    expect(files(d, geo).urdf).toMatch(/<joint name="left_wheel_joint" type="continuous">\s*<parent link="Body"\/>\s*<child link="Left_wheel"\/>\s*<origin xyz="0 0.036 0.01" rpy="0 0 0"\/>/);
    expect(files(d, geo).launch).toContain("'-z', '0.05'");
  });
});

describe('the pose a simulation begins in', () => {
  // A body 40 mm up on one leg that hangs straight down to the plate from a hinge about Y at its top.
  const trunk = node('trunk001', 'Trunk', [0, 0, 50], [100, 60, 20]);
  const leg = node('leg00001', 'Leg', [0, 0, 20], [10, 10, 40]);
  const walker = (start?: number): Doc => {
    const d = emptyDoc();
    d.name = 'Test Rover';
    d.scene = [trunk, leg];
    d.robot = { root: trunk.id, base: 'free', sensors: [], control: true, links: [], joints: [{ ...defaultJoint('j1', 'hip', trunk.id, leg.id, [0, 0, 20]), axis: [0, 1, 0], lower: -120, upper: 120, ...(start === undefined ? {} : { start }) }] };
    return d;
  };
  const geo = (d: Doc) => new Map(linkNodes(d.scene).map((n) => [n.id, boxGeometry(n)]));
  const mjcf = (d: Doc, geometry = geo(d)) => text(buildMjcfModel(d, geometry).files.find((f) => f.name === 'test_rover.xml')!.bytes);

  it('is the pose it was designed in when no joint has a start', () => {
    expect(mjcf(walker())).toMatch(/<key name="home" qpos="0 0 0.05 1 0 0 0 0"\/>/);
  });

  it('puts each joint at its start, the servo holding it there, and the base where the robot stands on the floor', () => {
    // A quarter turn lays the leg level with its hinge, 40 mm up: 10 mm thick, its underside is at 35 mm, where the
    // foot was at 0. The base comes down by those 35 mm, from 50 to 15.
    const xml = mjcf(walker(90));
    expect(xml).toMatch(/<key name="home" qpos="0 0 0.015 1 0 0 0 1.570796" ctrl="1.570796"\/>/);
    // The bodies are still written as designed: a joint's zero is where the design has it.
    expect(xml).toMatch(/<body name="Trunk" pos="0 0 0.05">/);
    expect(xml).toMatch(/<body name="Leg" pos="0 0 -0.01">/);
    // Without its looks (the test drive's model), the lowest point is taken from what the link collides as.
    const bare = new Map([...geo(walker(90))].map(([id, g]) => [id, { ...g, visual: [] }]));
    expect(mjcf(walker(90), bare)).toMatch(/<key name="home" qpos="0 0 0.015 1 0 0 0 1.570796" ctrl="1.570796"\/>/);
  });

  it('is where Gazebo puts the joints a controller holds, and how high it spawns the robot', () => {
    const pkg = buildRobotPackage(walker(90), geo(walker(90)));
    const file = (name: string) => text(pkg.files.find((f) => f.name === name)!.bytes);
    expect(pkg.warnings).toEqual([]);
    expect(file('urdf/test_rover.urdf')).toMatch(/<joint name="hip">\s*<command_interface name="position"\/>\s*<state_interface name="position">\s*<param name="initial_value">1.570796<\/param>\s*<\/state_interface>/);
    // The base begins 15 mm up, and settles from 50 mm more.
    expect(file('launch/gazebo.launch.py')).toContain("'-z', '0.065'");
    // A joint that begins as designed says nothing.
    expect(text(buildRobotPackage(walker(), geo(walker())).files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes)).not.toContain('initial_value');
    // With the controllers off nothing holds the joint: it begins as designed, the robot at its designed height, and the export says so.
    const loose = walker(90);
    loose.robot!.control = false;
    const bare = buildRobotPackage(loose, geo(loose));
    expect(bare.warnings).toEqual(['No controller holds "hip", so it begins as designed, not at its start.']);
    expect(text(bare.files.find((f) => f.name === 'launch/gazebo.launch.py')!.bytes)).toContain("'-z', '0.1'");
  });

  it('gives a joint commanded by torque a plain motor in MuJoCo and an effort interface in ROS, and a servo in the test drive', () => {
    const d = walker(90);
    d.robot!.joints = d.robot!.joints.map((j) => ({ ...j, command: 'torque' as const }));
    // A motor has no gains and holds nothing: the home pose asks it for no torque.
    const xml = mjcf(d);
    expect(xml).toMatch(/<motor name="hip_torque" joint="hip" ctrlrange="-[0-9.]+ [0-9.]+"\/>/);
    expect(xml).not.toContain('<position ');
    expect(xml).toMatch(/<key name="home" qpos="0 0 0.015 1 0 0 0 1.570796"\/>/);
    // The test drive's model holds every joint by position.
    const driven = text(buildMjcfModel(d, geo(d), d.robot!, 'flat', true).files.find((f) => f.name.endsWith('.xml') && !f.name.includes('/'))!.bytes);
    expect(driven).toMatch(/<position name="hip_servo" joint="hip"/);
    expect(driven).not.toContain('<motor ');
    // ROS offers the effort beside the position, which the package's own controller still claims: the robot stands until another takes over.
    const pkg = buildRobotPackage(d, geo(d));
    const file = (name: string) => text(pkg.files.find((f) => f.name === name)!.bytes);
    expect(pkg.warnings).toEqual([]);
    expect(file('urdf/test_rover.urdf')).toMatch(/<joint name="hip">\s*<command_interface name="position"\/>\s*<command_interface name="effort"\/>[\s\S]*?<state_interface name="velocity"\/>\s*<state_interface name="effort"\/>\s*<\/joint>/);
    expect(file('config/controllers.yaml')).toMatch(/command_interfaces:\s*- position\n/);
    // The Isaac stage's drive holds nothing and says why; a joint commanded by position keeps its stiffness.
    const stage = (doc: Doc) => text(buildIsaacStage(doc, geo(doc)).files.find((f) => f.name.endsWith('.usda'))!.bytes);
    expect(stage(d)).toMatch(/float drive:angular:physics:stiffness = 0\n[\s\S]*?custom token robot:command = "effort"/);
    expect(stage(walker(90))).not.toContain('robot:command');
    expect(stage(walker(90))).not.toMatch(/float drive:angular:physics:stiffness = 0\n/);
    // A joint commanded by position says nothing of effort.
    expect(text(buildRobotPackage(walker(90), geo(walker(90))).files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes)).not.toContain('"effort"');
  });

  it('lists the actuators in the order of the joints, so control i drives joint i', () => {
    // The quadruped's joints run hip, knee, hip, knee down each leg in turn; its actuators must run the same way.
    const d = ROBOTS.find((r) => r.file === 'quadruped')!.make();
    d.robot!.joints = d.robot!.joints.map((j) => (j.name.startsWith('Hip') ? { ...j, start: 30 } : j.name.startsWith('Knee') ? { ...j, start: -60 } : j));
    const xml = text(buildMjcfModel(d, geo(d)).files.find((f) => f.name.endsWith('.xml') && !f.name.includes('/'))!.bytes);
    const joints = [...xml.matchAll(/<joint name="([^"]+)" type="hinge"/g)].map((m) => m[1]);
    const actuators = [...xml.matchAll(/<position name="[^"]+" joint="([^"]+)"/g)].map((m) => m[1]);
    expect(joints).toHaveLength(8);
    expect(joints[0]).toMatch(/^Hip/);
    expect(joints[1]).toMatch(/^Knee/);
    expect(actuators).toEqual(joints);
    // And the home pose asks each servo for its own joint's start, in that order.
    expect(xml).toMatch(/<key name="home" qpos="[-0-9. ]+ 1 0 0 0( 0.523599 -1.047198){4}" ctrl="0.523599 -1.047198( 0.523599 -1.047198){3}"\/>/);
  });

  it('is the pose the Isaac stage has the links in, each servo holding its joint there', () => {
    const stage = buildIsaacStage(walker(90), geo(walker(90)));
    expect(stage.warnings).toEqual([]);
    const usda = text(stage.files.find((f) => f.name.endsWith('.usda'))!.bytes);
    const prim = (name: string) => usda.slice(usda.indexOf(`def Xform "${name}" (`)).split('def Mesh')[0];
    // The trunk comes down the 35 mm the level leg leaves under it; it is not turned.
    expect(prim('Trunk')).toContain('double3 xformOp:translate = (0, 0, 0.015)');
    expect(prim('Trunk')).not.toContain('xformOp:orient');
    // The leg's frame is its hinge, 10 mm under the trunk's middle, and the leg is turned a quarter about Y there.
    expect(prim('Leg')).toContain('double3 xformOp:translate = (0, 0, 0.005)');
    expect(prim('Leg')).toContain('quatf xformOp:orient = (0.707107, 0, 0.707107, 0)');
    // The joint is still where the design has it in the trunk: its zero has not moved. It is at 90°, and held there.
    const hip = usda.slice(usda.indexOf('def PhysicsRevoluteJoint "hip"'));
    expect(hip).toMatch(/point3f physics:localPos0 = \(0, 0, -0.01\)/);
    expect(hip).toMatch(/float drive:angular:physics:targetPosition = 90\b/);
    expect(hip).toMatch(/float state:angular:physics:position = 90\b/);
    // A robot that starts as designed is written as it was.
    const plain = text(buildIsaacStage(walker(), geo(walker())).files.find((f) => f.name.endsWith('.usda'))!.bytes);
    expect(plain).not.toContain('state:angular:physics:position');
    expect(plain).toContain('float drive:angular:physics:targetPosition = 0');
  });

  it('is said to be missing from the formats that cannot carry it yet', () => {
    const said = "This format does not carry the joints' starts yet: the robot begins in the pose it is designed in.";
    expect(buildSdfModel(walker(90), geo(walker(90))).warnings).toEqual([said]);
    expect(buildSdfModel(walker(), geo(walker())).warnings).toEqual([]);
  });

  it('must be inside every joint\'s limits', () => {
    const problems = (d: Doc) => checkRobot(d, new Map([...geo(d)].map(([id, g]) => [id, g.props]))).filter((p) => p.level === 'error').map((p) => p.text);
    expect(problems(walker(90))).toEqual([]);
    expect(problems(walker(150))).toEqual(['"hip" starts outside its limits.']);
    // Designed outside its range, as a leg built straight whose knee cannot straighten: it needs a start.
    const straight = walker();
    straight.robot!.joints[0] = { ...straight.robot!.joints[0], lower: 20, upper: 120 };
    expect(problems(straight)).toEqual(['"hip" is outside its limits as designed. Give it a start inside them.']);
    straight.robot!.joints[0] = { ...straight.robot!.joints[0], start: 45 };
    expect(problems(straight)).toEqual([]);
  });
});

describe('buildRobotPackage', () => {
  it('writes a package with the URDF, meshes and launch files, in meters and SI', () => {
    const pkg = buildRobotPackage(doc(), geometry());
    expect(pkg.name).toBe('test_rover');
    expect(pkg.warnings).toEqual([]);
    const names = pkg.files.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(['package.xml', 'CMakeLists.txt', 'README.md', 'urdf/test_rover.urdf', 'launch/display.launch.py', 'launch/gazebo.launch.py', 'rviz/display.rviz', 'meshes/visual/Body.obj', 'meshes/visual/Body.mtl', 'meshes/collision/Body.stl', 'meshes/visual/Left_wheel.obj', 'meshes/collision/Left_wheel.stl', 'meshes/visual/Arm_upper.obj']),
    );
    // The arm's collision is a box, so it has no collision mesh.
    expect(names).not.toContain('meshes/collision/Arm_upper.stl');
    const urdf = text(pkg.files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    expect(urdf).toContain('<robot name="Test_Rover">');
    expect(urdf).toContain('<link name="Body">');
    // The body (100 × 60 × 20 mm of PLA at 20% infill with a 1.2 mm shell) weighs what the estimate says, in kg.
    const bodyMass = 0.00124 * (2 * (6000 + 2000 + 1200) * 1.2 + 0.2 * (120000 - 2 * (6000 + 2000 + 1200) * 1.2)) / 1000;
    expect(urdf).toContain(`<mass value="${Number(bodyMass.toFixed(9))}"/>`);
    // The wheel weighs 50 g, hangs 36 mm out along Y level with the body's middle, where the base frame is, and its mesh is written in its own frame: its center is 4 mm further out.
    expect(urdf).toContain('<mass value="0.05"/>');
    expect(urdf).toMatch(/<joint name="left_wheel_joint" type="continuous">\s*<parent link="Body"\/>\s*<child link="Left_wheel"\/>\s*<origin xyz="0 0.036 0" rpy="0 0 0"\/>\s*<axis xyz="0 1 0"\/>\s*<limit effort="2" velocity="12.566371"\/>/);
    expect(urdf).toContain('<origin xyz="0 0.004 0" rpy="0 0 0"/>');
    // Revolute limits in radians.
    expect(urdf).toMatch(/<limit lower="-1.570796" upper="1.570796" effort="10" velocity="1.570796"\/>/);
    // The arm's box collision: 10 × 10 × 40 mm, centered 20 mm above its joint.
    expect(urdf).toContain('<box size="0.01 0.01 0.04"/>');
    expect(urdf).toMatch(/<collision>\s*<origin xyz="0 0 0.02" rpy="0 0 0"\/>\s*<geometry><box/);
    // Friction goes to Gazebo.
    expect(urdf).toMatch(/<gazebo reference="Left_wheel">\s*<mu1>1.2<\/mu1>/);
    // Meshes refer to the package, and are in meters.
    expect(urdf).toContain('<mesh filename="package://test_rover/meshes/visual/Body.obj"/>');
    const obj = text(pkg.files.find((f) => f.name === 'meshes/visual/Body.obj')!.bytes);
    expect(obj).toContain('units: meters');
    expect(obj).toContain('v -0.05 -0.03 0');
    expect(obj).toContain('mtllib Body.mtl');
    const launch = text(pkg.files.find((f) => f.name === 'launch/display.launch.py')!.bytes);
    expect(launch).toContain("get_package_share_directory('test_rover')");
    expect(text(pkg.files.find((f) => f.name === 'rviz/display.rviz')!.bytes)).toContain('Fixed Frame: Body');
  });

  it('writes a cylinder collision turned as the object is', () => {
    const d = doc();
    const tilted = { ...wheel, rot: [90, 0, 0] as [number, number, number] };
    d.scene = [body, tilted, arm];
    d.robot!.links[0].collision = 'cylinder';
    const geo = geometry();
    geo.set(wheel.id, boxGeometry(tilted));
    const urdf = text(buildRobotPackage(d, geo).files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    // The wheel joint (4 mm inboard, in the wheel's frame) turned with the wheel, so the box center is 4 mm above it.
    // The wheel is round about its own Y, 8 mm long: the cylinder lies along that, a quarter turn on from the wheel's own.
    expect(urdf).toMatch(/<collision>\s*<origin xyz="0 0 0.004" rpy="3.141593 0 0"\/>\s*<geometry><cylinder radius="0.01" length="0.008"\/>/);
  });

  it('leaves a loop-closing joint out with a warning', () => {
    const d = doc();
    d.robot!.joints.push({ ...defaultJoint('j3', 'closing', arm.id, wheel.id, [0, 0, 0]) });
    const pkg = buildRobotPackage(d, geometry());
    expect(pkg.warnings[0]).toMatch(/closes a loop/);
    expect(text(pkg.files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes)).not.toContain('closing');
  });

  it('writes mimic against the followed joint', () => {
    const d = doc();
    d.robot!.joints[1].mimic = { joint: 'j1', multiplier: 2, offset: 10 };
    const urdf = text(buildRobotPackage(d, geometry()).files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    expect(urdf).toContain('<mimic joint="left_wheel_joint" multiplier="2" offset="0.174533"/>');
  });

  it('turns a follower\'s multiplier into the units of both joints: a rack 0.5 mm a degree is 28.6 mm a radian', () => {
    const d = doc();
    d.robot!.joints[1] = { ...d.robot!.joints[1], type: 'prismatic', lower: -20, upper: 20, mimic: { joint: 'j1', multiplier: 0.5, offset: 2 } };
    const expected = 0.5e-3 / (Math.PI / 180);
    const urdf = text(buildRobotPackage(d, geometry()).files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    const sdf = text(buildSdfModel(d, geometry()).files.find((f) => f.name === 'model.sdf')!.bytes);
    const mjcf = text(buildMjcfModel(d, geometry()).files.find((f) => f.name === 'test_rover.xml')!.bytes);
    expect(Number(/<mimic joint="left_wheel_joint" multiplier="([^"]+)" offset="0.002"\/>/.exec(urdf)?.[1])).toBeCloseTo(expected, 5);
    expect(Number(/<mimic joint="left_wheel_joint"><multiplier>([^<]+)<\/multiplier><offset>0.002<\/offset>/.exec(sdf)?.[1])).toBeCloseTo(expected, 5);
    expect(Number(/<joint joint1="shoulder" joint2="left_wheel_joint" polycoef="0.002 (\S+) 0 0 0"\/>/.exec(mjcf)?.[1])).toBeCloseTo(expected, 5);
    // The other way round, a pinion following its rack: degrees a millimeter become radians a meter.
    d.robot!.joints[0].mimic = { joint: 'j2', multiplier: 2, offset: 0 };
    d.robot!.joints[1].mimic = undefined;
    const back = text(buildRobotPackage(d, geometry()).files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    expect(Number(/<mimic joint="shoulder" multiplier="([^"]+)"/.exec(back)?.[1])).toBeCloseTo((2 * Math.PI) / 180 / 1e-3, 3);
  });
});

/** The test robot as a rover: sensors of every kind, one wheel joint each side, the base free. */
const rover = () => {
  const d = doc();
  const r = d.robot!;
  r.sensors = [
    { ...defaultSensor('s1', 'front cam', 'camera', body.id, [50, 0, 10]) },
    { ...defaultSensor('s2', 'top lidar', 'lidar', body.id, [0, 0, 10]), rot: [0, 0, 90] },
    { ...defaultSensor('s3', 'imu', 'imu', body.id, [0, 0, 0]) },
    { ...defaultSensor('s4', 'tread', 'touch', wheel.id, [0, 0, -10]) },
  ];
  // The wheel joint drives the left side; a mirrored one would drive the right. Here one joint each side, the arm's shoulder stays under ros2_control.
  r.joints.push({ ...defaultJoint('j3', 'right wheel joint', body.id, arm.id, [0, 0, -20]), type: 'continuous', axis: [0, 1, 0] });
  r.drive = { kind: 'differential', roles: { j1: 'left', j3: 'right' } };
  r.base = 'free';
  return d;
};

describe('sensors, drive and control', () => {

  it('puts a touch sensor on its link as a contact sensor over the link\'s collision', () => {
    const urdf = text(buildRobotPackage(rover(), geometry()).files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    // Gazebo's Contact system reads the topic from inside <contact>; the sensor's own <topic> is ignored.
    expect(urdf).toMatch(/<gazebo reference="Left_wheel">[\s\S]*?<sensor name="tread" type="contact">[\s\S]*?<contact>\s*<collision>Left_wheel_collision<\/collision>\s*<topic>tread\/contacts<\/topic>\s*<\/contact>/);
    expect(urdf).not.toContain('tread_link');
    expect(urdf).not.toContain('preserveFixedJoint');
    expect(text(buildRobotPackage(rover(), geometry()).files.find((f) => f.name === 'config/bridge.yaml')!.bytes)).toContain('ros_gz_interfaces/msg/Contacts');
  });

  it('names the base\'s collision as Gazebo renames it when a touch sensor sits on the base under a footprint', () => {
    const d = rover();
    d.robot!.sensors.push({ ...defaultSensor('s5', 'belly', 'touch', body.id, [0, 0, -10]) });
    const urdf = text(buildRobotPackage(d, geometry()).files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    // The base is folded into the massless footprint, where its collision gets the footprint's name in front; keeping
    // the joint instead would leave the footprint without mass, and Gazebo drops such a link with all below it.
    expect(/<sensor name="belly" type="contact">[\s\S]*?<collision>([^<]+)<\/collision>/.exec(urdf)?.[1]).toBe('base_footprint_fixed_joint_lump__Body_collision');
    expect(urdf).not.toMatch(/<gazebo reference="base_footprint_joint">/);
    // Bolted down there is no footprint, and the collision keeps its name.
    d.robot!.base = 'fixed';
    const bolted = text(buildRobotPackage(d, geometry()).files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    expect(/<sensor name="belly" type="contact">[\s\S]*?<collision>([^<]+)<\/collision>/.exec(bolted)?.[1]).toBe('Body_collision');
  });

  it('says so when the drive is left out because a wheel is not joined to the base', () => {
    const d = rover();
    // The right wheel's joint hangs from a bracket nothing joins to the base.
    d.scene.push(node('stray001', 'Spare bracket', [50, 50, 5], [10, 10, 10]), node('stray002', 'Loose wheel', [70, 50, 5], [10, 10, 10]));
    d.robot!.joints[2] = { ...d.robot!.joints[2], parent: 'stray001', child: 'stray002' };
    const geo = new Map(linkNodes(d.scene).map((n) => [n.id, boxGeometry(n)]));
    for (const build of [buildRobotPackage, buildSdfModel, buildMjcfModel, buildIsaacStage]) {
      const pkg = build(d, geo);
      expect(pkg.warnings.filter((w) => w.startsWith('Drive: '))).toEqual([expect.stringMatching(/^Drive: right wheel joint is not joined to the base, so the drive is left out\. [A-Z][^.]+\.$/)]);
      expect(pkg.files.some((f) => /drive\.json$/.test(f.name))).toBe(false);
    }
    // A whole drive says nothing.
    expect(buildRobotPackage(rover(), geometry()).warnings.filter((w) => w.startsWith('Drive: '))).toEqual([]);
  });

  it('keeps the fixed joint under a touch sensor, or Gazebo folds the link away and renames its collision', () => {
    const d = rover();
    d.robot!.joints[1].type = 'fixed';
    d.robot!.sensors.push({ ...defaultSensor('s5', 'palm', 'touch', arm.id, [0, 0, 0]) });
    const urdf = text(buildRobotPackage(d, geometry()).files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    expect(urdf).toMatch(/<gazebo reference="Arm_upper">[\s\S]*?<sensor name="palm" type="contact">[\s\S]*?<collision>Arm_upper_collision<\/collision>/);
    expect(urdf).toMatch(/<gazebo reference="shoulder">\s*<preserveFixedJoint>true<\/preserveFixedJoint>\s*<\/gazebo>/);
  });

  it('writes sensor frames, Gazebo blocks, the drive and ros2_control into the package', () => {
    const d = rover();
    // The arm is both the right wheel (j3) and on the shoulder (j2): the shoulder is a loop joint then, so only the wheels remain in the tree.
    d.robot!.joints.splice(1, 1);
    const pkg = buildRobotPackage(d, geometry());
    const names = pkg.files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['worlds/test_rover.sdf', 'config/bridge.yaml']));
    expect(names).not.toContain('config/controllers.yaml');
    const urdf = text(pkg.files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    // The camera's frame hangs from the body by a fixed joint, 50 mm forward of the body's center and 10 mm above it, with an optical frame under it.
    expect(urdf).toMatch(/<joint name="front_cam_joint" type="fixed">\s*<parent link="Body"\/>\s*<child link="front_cam_link"\/>\s*<origin xyz="0.05 0 0.01" rpy="0 0 0"\/>/);
    expect(urdf).toMatch(/<joint name="front_cam_optical_joint" type="fixed">[\s\S]*?rpy="-1.570796 0 -1.570796"/);
    // The lidar's frame is turned a quarter about Z.
    expect(urdf).toMatch(/<child link="top_lidar_link"\/>\s*<origin xyz="0 0 0.01" rpy="0 0 1.570796"\/>/);
    // Each sensor's Gazebo block sits in its own frame.
    expect(urdf).toMatch(/<gazebo reference="front_cam_link">\s*<sensor name="front_cam" type="camera">[\s\S]*?<topic>front_cam\/image<\/topic>[\s\S]*?<horizontal_fov>1.396263<\/horizontal_fov>/);
    expect(urdf).toMatch(/<sensor name="top_lidar" type="gpu_lidar">[\s\S]*?<samples>360<\/samples>[\s\S]*?<min>0.1<\/min><max>12<\/max>/);
    expect(urdf).toMatch(/<sensor name="imu" type="imu">/);
    // The drive: both wheel joints, the track between them (72 mm: 36 out each way), the wheel radius (10 mm).
    // The track is the distance between the two wheel joints (the "right wheel" here is the arm, 36 mm in and 10 mm up from the left: 37.4 mm);
    // the radius the mean of the wheels' half-extents across their axles (10 and 20 mm).
    expect(urdf).toMatch(/<plugin filename="gz-sim-diff-drive-system"[\s\S]*?<left_joint>left_wheel_joint<\/left_joint>\s*<right_joint>right_wheel_joint<\/right_joint>\s*<wheel_separation>0.03736<\/wheel_separation>\s*<wheel_radius>0.015<\/wheel_radius>/);
    expect(urdf).toContain('<plugin filename="gz-sim-joint-state-publisher-system"');
    expect(urdf).not.toContain('<ros2_control');
    const bridge = text(pkg.files.find((f) => f.name === 'config/bridge.yaml')!.bytes);
    expect(bridge).toContain('ros_topic_name: /cmd_vel');
    expect(bridge).toContain('ros_topic_name: /front_cam/image');
    expect(bridge).toContain('ros_topic_name: /top_lidar/scan');
    expect(bridge).toContain('ros_topic_name: /imu/imu');
    const world = text(pkg.files.find((f) => f.name === 'worlds/test_rover.sdf')!.bytes);
    expect(world).toContain('gz-sim-sensors-system');
    expect(world).not.toContain('<include>');
  });

  it('puts the joints that are not wheels under ros2_control', () => {
    const d = rover();
    d.robot!.drive = { kind: 'differential', roles: { j1: 'left' } };
    d.robot!.joints.pop();
    // Left only: the check would stop this, but the writer still writes what it can: no drive, the shoulder controlled.
    const pkg = buildRobotPackage(d, geometry());
    const urdf = text(pkg.files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    expect(urdf).not.toContain('gz-sim-diff-drive-system');
    expect(urdf).toMatch(/<ros2_control name="GazeboSimSystem" type="system">[\s\S]*?<joint name="shoulder">\s*<command_interface name="position"\/>/);
    expect(urdf).toContain('<parameters>__PACKAGE_SHARE__/config/controllers.yaml</parameters>');
    const controllers = text(pkg.files.find((f) => f.name === 'config/controllers.yaml')!.bytes);
    expect(controllers).toContain('      - shoulder');
    const launch = text(pkg.files.find((f) => f.name === 'launch/gazebo.launch.py')!.bytes);
    expect(launch).toContain("arguments=['arm_controller'");
    expect(launch).toContain("replace('__PACKAGE_SHARE__', share)");
  });

  it('writes an SDF model with every joint, loops included, and the sensors in their links', () => {
    const d = rover();
    d.robot!.joints.push({ ...defaultJoint('j4', 'closing', arm.id, wheel.id, [0, 0, 0]) });
    d.robot!.joints[1].mimic = { joint: 'j1', multiplier: 1, offset: 0 };
    const model = buildSdfModel(d, geometry());
    expect(model.name).toBe('test_rover');
    const names = model.files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['model.config', 'model.sdf', 'worlds/test_rover.sdf', 'README.md', 'meshes/visual/Body.obj']));
    const sdf = text(model.files.find((f) => f.name === 'model.sdf')!.bytes);
    expect(sdf).toContain('<model name="Test_Rover">');
    expect(sdf).toMatch(/<link name="Left_wheel">\s*<pose>0 0.036 0.01 0 0 0<\/pose>/);
    expect(sdf).toContain('<uri>model://test_rover/meshes/visual/Body.obj</uri>');
    // The loop joint is there, in its child's frame: the wheel's frame sits at its own joint (0, 36, 10), the closing joint at the wheel's center (0, 40, 10).
    expect(sdf).toMatch(/<joint name="closing" type="revolute">\s*<pose relative_to="Left_wheel">0 0.004 0 0 0 0<\/pose>\s*<parent>Arm_upper<\/parent>\s*<child>Left_wheel<\/child>/);
    // A continuous joint is a revolute one without limits; friction goes on the surface.
    expect(sdf).toMatch(/<joint name="left_wheel_joint" type="revolute">[\s\S]*?<limit><effort>2<\/effort><velocity>12.566371<\/velocity><\/limit>/);
    expect(sdf).toContain('<surface><friction><ode><mu>1.2</mu><mu2>1.2</mu2></ode></friction></surface>');
    // The shoulder lies on the loop, so its mimic is dropped: the loop closes for real.
    expect(sdf).not.toContain('<mimic');
    // Sensors sit in the body at their own pose.
    expect(sdf).toMatch(/<sensor name="front_cam" type="camera">\s*<pose>0.05 0 0.01 0 0 0<\/pose>/);
    expect(sdf).toContain('<gz_frame_id>Body</gz_frame_id>');
    expect(sdf).toContain('gz-sim-diff-drive-system');
    const world = text(model.files.find((f) => f.name === 'worlds/test_rover.sdf')!.bytes);
    expect(world).toContain('<uri>model://test_rover</uri>');
  });
});

describe('Isaac Sim stage', () => {
  it('writes one stage with the articulation, every sensor, the drive graph and a readme', () => {
    const pkg = buildIsaacStage(rover(), geometry());
    expect(pkg.name).toBe('test_rover');
    expect(pkg.warnings).toEqual([]);
    expect(pkg.files.map((f) => f.name)).toEqual(['test_rover.usda', 'README.md']);
    const usda = text(pkg.files[0].bytes);
    expect(usda).toContain('def Xform "Test_Rover" (\n        prepend apiSchemas = ["PhysicsArticulationRootAPI", "PhysxArticulationAPI"]');
    expect(usda).not.toContain('root_joint');
    for (const link of ['Body', 'Left_wheel', 'Arm_upper']) expect(usda).toContain(`def Xform "${link}" (`);
    // The wheel joint sits where the design has it, in meters; the shoulder holds a position, the wheels run at a speed.
    expect(usda).toContain('def PhysicsRevoluteJoint "left_wheel_joint"');
    // The wheel joint sits 4 mm inboard of the wheel's center (y 40, z 10), in the body's frame at its middle (z 10).
    expect(usda).toMatch(/def PhysicsRevoluteJoint "left_wheel_joint"[\s\S]*?point3f physics:localPos0 = \(0, 0.036, 0\)/);
    // The shoulder's servo: 10 N·m a tenth of a radian off is 100 N·m/rad, 1.745 N·m a degree as USD Physics counts it.
    expect(usda).toMatch(/def PhysicsRevoluteJoint "shoulder"[\s\S]*?float physics:lowerLimit = -90[\s\S]*?float physics:upperLimit = 90[\s\S]*?float drive:angular:physics:stiffness = 1\.7453/);
    expect(usda).toContain('def Camera "front_cam"');
    expect(usda).toContain('def OmniLidar "top_lidar"');
    expect(usda).toContain('def IsaacImuSensor "imu"');
    expect(usda).toContain('def IsaacContactSensor "tread"');
    expect(usda).toContain('"PhysxContactReportAPI"');
    expect(usda).toContain('custom token[] inputs:jointNames = ["left_wheel_joint", "right_wheel_joint"]');
    expect(usda).toContain('custom string inputs:topicName = "joint_command"');
    const readme = text(pkg.files[1].bytes);
    expect(readme).toContain('`/cmd_vel` (geometry_msgs/Twist) drives it');
    expect(readme).toContain('`/top_lidar/scan` from the top_lidar sensor');
    expect(readme).toContain('Touch sensors are Isaac contact sensors');
  });

  it('bolts a fixed base down and leaves the drive graph out without a drive', () => {
    const d = rover();
    d.robot!.base = 'fixed';
    d.robot!.drive = undefined;
    const usda = text(buildIsaacStage(d, geometry()).files[0].bytes);
    expect(usda).toContain('def PhysicsFixedJoint "root_joint"');
    expect(usda).not.toContain('ROS2SubscribeTwist');
    expect(usda).not.toContain('IsaacComputeOdometry');
  });
});

describe('xacro and MuJoCo', () => {
  it('writes a xacro beside the URDF with the Gazebo and control blocks behind arguments', () => {
    const d = doc();
    d.robot!.sensors = [defaultSensor('s3', 'imu', 'imu', body.id, [0, 0, 0])];
    const pkg = buildRobotPackage(d, geometry());
    const xacro = text(pkg.files.find((f) => f.name === 'urdf/test_rover.urdf.xacro')!.bytes);
    expect(xacro).toContain('xmlns:xacro="http://www.ros.org/wiki/xacro"');
    expect(xacro).toContain('<xacro:property name="package" value="test_rover"/>');
    expect(xacro).toContain('<mesh filename="package://${package}/meshes/visual/Body.obj"/>');
    expect(xacro).toMatch(/<xacro:if value="\$\(arg use_gazebo\)">\s*<gazebo reference="Body">/);
    expect(xacro).toMatch(/<xacro:if value="\$\(arg use_ros2_control\)">\s*<ros2_control/);
    expect(xacro).toContain('<parameters>$(find ${package})/config/controllers.yaml</parameters>');
    // The plain URDF has no xacro in it.
    const urdf = text(pkg.files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    expect(urdf).not.toContain('xacro');
  });

  it('stands a course of steps or a ramp ahead of the robot for the test drive, never in an export', () => {
    const d = doc();
    d.robot!.drive = { kind: 'differential', roles: { j1: 'left', j2: 'right' } };
    d.robot!.base = 'free';
    const steps = text(buildMjcfModel(d, geometry(), undefined, 'steps').files.find((f) => f.name === 'test_rover.xml')!.bytes);
    // Three boxes from each riser to the end of the course (0.3 m ahead, 3 × 0.12 m of treads, a 0.6 m landing), 10 mm higher each, a meter wide.
    const boxes = [...steps.matchAll(/<geom name="course(\d)" type="box" pos="([^"]+)" size="([^"]+)" quat="([^"]+)" material="floor"/g)];
    expect(boxes.map((m) => m[1])).toEqual(['1', '2', '3']);
    expect(boxes.map((m) => m[3])).toEqual(['0.48 0.5 0.005', '0.42 0.5 0.01', '0.36 0.5 0.015']);
    const along = (pos: string) => Math.hypot(...pos.split(' ').slice(0, 2).map(Number));
    expect(along(boxes[0][2])).toBeCloseTo(0.78, 3);
    expect(boxes[0][2].split(' ')[2]).toBe('0.005');
    const ramp = text(buildMjcfModel(d, geometry(), undefined, 'ramp').files.find((f) => f.name === 'test_rover.xml')!.bytes);
    const slabs = [...ramp.matchAll(/<geom name="course(\d)" type="box" pos="([^"]+)" size="([^"]+)" quat="([^"]+)"/g)];
    // A 0.6 m slab, 20 mm thick, tipped 10°, then a flat top as high as it climbs (0.6 sin 10° = 104 mm).
    expect(slabs[0][3]).toBe('0.3 0.5 0.01');
    expect(slabs[1][3].split(' ').map(Number)).toEqual([0.3, 0.5, expect.closeTo(0.052095, 5)]);
    expect(slabs[0][4]).not.toBe('1 0 0 0');
    expect(Number(slabs[1][2].split(' ')[2])).toBeCloseTo(0.052095, 5);
    expect(steps).toContain('<geom name="floor" type="plane"');
    // The World picked for the test drive does not reach the export: that stands on a flat floor whatever was chosen.
    d.robot!.world = 'steps';
    const exported = text(buildMjcfModel(d, geometry()).files.find((f) => f.name === 'test_rover.xml')!.bytes);
    expect(exported).not.toContain('course');
    expect(exported).toContain('<geom name="floor" type="plane" size="5 5 0.1" material="floor"');
  });

  it('writes a MuJoCo model: nested bodies, joints, actuators, a loop as a connect, a camera and an IMU', () => {
    const d = doc();
    // Both joints drive (the shoulder standing in for a right wheel), and the base stands free, so it floats.
    d.robot!.drive = { kind: 'differential', roles: { j1: 'left', j2: 'right' } };
    d.robot!.base = 'free';
    d.robot!.joints.push({ ...defaultJoint('j4', 'closing', arm.id, wheel.id, [0, 0, 0]) });
    d.robot!.sensors = [defaultSensor('s1', 'cam', 'camera', body.id, [50, 0, 10]), defaultSensor('s2', 'scan', 'lidar', body.id, [0, 0, 10]), defaultSensor('s3', 'imu', 'imu', body.id, [0, 0, 0])];
    const model = buildMjcfModel(d, geometry());
    expect(model.name).toBe('test_rover');
    // The default lidar sweeps 360 rays; MuJoCo gets 90 of them as rangefinders, the first looking back along -X, each reaching the lidar's 12 m.
    expect(model.warnings).toContainEqual(expect.stringContaining('"scan" sweeps 360 rays; MuJoCo gets 90 of them'));
    const names = model.files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['test_rover.xml', 'README.md', 'meshes/visual/Body.obj', 'meshes/collision/Body.stl']));
    const xml = text(model.files.find((f) => f.name === 'test_rover.xml')!.bytes);
    expect(xml).toMatch(/<site name="scan_ray0" pos="0 0 0.01" zaxis="-1 0 0" size="0.002"/);
    expect(xml.match(/<rangefinder /g)).toHaveLength(90);
    expect(xml).toContain('<rangefinder name="scan_89" site="scan_ray89" cutoff="12"/>');
    expect(xml).toContain('<mujoco model="Test_Rover">');
    expect(xml).toContain('<compiler angle="radian" meshdir="meshes" autolimits="true"/>');
    expect(xml).toContain('<mesh name="visual_Body_obj" file="visual/Body.obj"/>');
    // The base floats (there is a drive), its frame at the body's middle, 10 mm up; the wheel hangs from it 36 mm out with a hinge about Y, no range; the arm's shoulder has one in radians.
    expect(xml).toMatch(/<body name="Body" pos="0 0 0.01">\s*<freejoint name="root"\/>/);
    expect(xml).toMatch(/<body name="Left_wheel" pos="0 0.036 0">\s*<joint name="left_wheel_joint" type="hinge" axis="0 1 0" damping="0.001" frictionloss="0"\/>/);
    expect(xml).toMatch(/<joint name="shoulder" type="hinge" axis="0 1 0" range="-1.570796 1.570796" limited="true"/);
    expect(xml).toMatch(/<inertial pos="0 0.004 0" mass="0.05" fullinertia="/);
    expect(xml).toContain('<geom type="mesh" mesh="visual_Body_obj" class="visual" material="color_ff8800"/>');
    expect(xml).toContain('<geom type="box" size="0.005 0.005 0.02" pos="0 0 0.02" class="collision" friction="0.8 0.005 0.0001"/>');
    // Actuators: the wheels velocity motors, with the motor's gain from its effort over its speed and both as limits. The implicit integrator takes the gain and the damping at any size.
    expect(xml).toContain('integrator="implicitfast"');
    // The torque is held to what takes the heavier side to full speed in one step (I·v/dt), and the gain follows.
    expect(xml).toMatch(/<velocity name="left_wheel_joint_motor" joint="left_wheel_joint" kv="[0-9.e-]+" ctrlrange="-12.57 12.57" forcerange="-([0-9.e-]+) \1"\/>/);
    expect(xml).toMatch(/<velocity name="shoulder_motor" joint="shoulder" kv="[0-9.e-]+" ctrlrange="-1.571 1.571" forcerange="-([0-9.e-]+) \1"\/>/);
    expect(xml).not.toContain('<position');
    // The loop: arm and wheel pinned at the closing joint, given in the arm's frame (the wheel's center, 40 mm out and 10 down from the shoulder).
    expect(xml).toContain('<connect body1="Arm_upper" body2="Left_wheel" anchor="0 0.04 -0.01"/>');
    // The camera 50 mm forward of the body's center, the IMU a site with a gyro and an accelerometer.
    expect(xml).toMatch(/<camera name="cam" pos="0.05 0 0.01" quat="0.5 0.5 -0.5 -0.5" fovy="/);
    expect(xml).toContain('<site name="imu" pos="0 0 0"');
    expect(xml).toContain('<gyro name="imu_gyro" site="imu"/>');
    // For a controller: every joint's position and velocity, the free base's orientation, turn rate and velocity, the home pose, and what a foot feels.
    expect(xml).toContain('<jointpos name="left_wheel_joint_pos" joint="left_wheel_joint"/>');
    expect(xml).toContain('<jointvel name="shoulder_vel" joint="shoulder"/>');
    expect(xml).toMatch(/<framequat name="base_quat" objtype="site" objname="base_site"\/>\s*<gyro name="base_gyro" site="base_site"\/>\s*<velocimeter name="base_vel" site="base_site"\/>/);
    expect(xml).toMatch(/<key name="home" qpos="0 0 0.01 1 0 0 0 0 0"\/>/);
    const touchy = buildMjcfModel(rover(), geometry());
    const txml = text(touchy.files.find((f) => f.name === 'test_rover.xml')!.bytes);
    // The touch sphere reaches half the wheel's diagonal: the whole tread face it sits on.
    expect(txml).toMatch(/<site name="tread_site" type="sphere" pos="[-0-9. ]+" size="0.0147"/);
    expect(txml).toContain('<touch name="tread" site="tread_site"/>');
    expect(touchy.touches).toEqual([{ name: 'tread', id: 's4' }]);
    // The scripts ride along, and a rover's drive.py reads drive.json.
    expect(touchy.files.map((f) => f.name)).toEqual(expect.arrayContaining(['drive.py', 'env.py', 'train.py', 'drive.json']));
    expect(text(touchy.files.find((f) => f.name === 'drive.py')!.bytes)).toContain('KIND = "rover"');
  });

  it('puts a rough floor under the test drive and leaves the scripts out when asked', () => {
    const d = rover();
    d.robot!.scripts = false;
    const pkg = buildMjcfModel(d, geometry(), undefined, 'rough');
    const xml = text(pkg.files.find((f) => f.name === 'test_rover.xml')!.bytes);
    expect(xml).toMatch(/<hfield name="terrain" nrow="64" ncol="64" size="3 3 0.03 0.02" elevation="[0-9. ]+"\/>/);
    expect(xml).toContain('<geom name="floor" type="hfield" hfield="terrain"');
    expect(pkg.files.some((f) => f.name.endsWith('.py'))).toBe(false);
  });

  it('welds an arm to the world and gives its joints position servos', () => {
    const xml = text(buildMjcfModel(doc(), geometry()).files.find((f) => f.name === 'test_rover.xml')!.bytes);
    expect(xml).not.toContain('<freejoint');
    // Full effort half a radian off target, damped so as not to overshoot, no more torque than the limit.
    expect(xml).toMatch(/<position name="shoulder_servo" joint="shoulder" kp="[0-9.e-]+" kv="[0-9.e-]+" forcerange="-([0-9.e-]+) \1"\/>/);
    expect(xml).toMatch(/<position name="left_wheel_joint_servo" joint="left_wheel_joint" kp="[0-9.e-]+" kv="[0-9.e-]+" forcerange="-([0-9.e-]+) \1"\/>/);
  });
});

describe('driveForward', () => {
  it('reads the front off the wheel labels, +Y when they do not say', () => {
    expect(driveForward('differential', { left: [[-40, 0, 0]], right: [[40, 0, 0]] })).toEqual([0, 1, 0]);
    // Left wheels at +X: the robot faces -Y.
    expect(driveForward('differential', { left: [[8, 15, 0], [8, -22, 0]], right: [[-20, -22, 0], [-25, 15, 0]] })).toEqual([0, -1, 0]);
    expect(driveForward('ackermann', { left: [[0, 40, 0]], right: [[0, -40, 0]], 'steer-left': [[60, 40, 0]], 'steer-right': [[60, -40, 0]] })).toEqual([1, 0, 0]);
    expect(driveForward('mecanum', { 'front-left': [[-40, -50, 0]], 'front-right': [[40, -50, 0]], 'rear-left': [[-40, 50, 0]], 'rear-right': [[40, 50, 0]] })).toEqual([0, -1, 0]);
    expect(driveForward('differential', { left: [[0, 0, 0]], right: [[0, 0, 0]] })).toEqual([0, 1, 0]);
    expect(driveForward('differential', { left: [[-40, 0, 0]] })).toEqual([0, 1, 0]);
  });
});

describe('the footprint ROS expects', () => {
  const build = (file: string) => {
    const d = ROBOTS.find((r) => r.file === file)!.make();
    const geo = new Map(linkNodes(d.scene).map((n) => [n.id, boxGeometry(n)]));
    return { urdf: text(buildRobotPackage(d, geo).files.find((f) => f.name.endsWith('.urdf'))!.bytes), sdf: text(buildSdfModel(d, geo).files.find((f) => f.name === 'model.sdf')!.bytes) };
  };
  it('puts a base_footprint facing +X on the floor under a rover built facing +Y', () => {
    // The rover's body, and so its base frame, is 80 mm up.
    const { urdf, sdf } = build('rover');
    expect(urdf).toContain('<link name="base_footprint"/>');
    expect(urdf).toMatch(/<joint name="base_footprint_joint" type="fixed">\s*<parent link="base_footprint"\/>\s*<child link="Body"\/>\s*<origin xyz="0 0 0.08" rpy="0 0 -1.570796"\/>/);
    expect(urdf).toContain('<child_frame_id>base_footprint</child_frame_id>');
    expect(sdf).toContain('<frame name="base_footprint" attached_to="Body"><pose>0 0 -0.08 0 0 1.570796</pose></frame>');
    expect(sdf).toContain('<child_frame_id>base_footprint</child_frame_id>');
  });
  it('leaves an arm bolted down alone', () => {
    const { urdf, sdf } = build('arm');
    expect(urdf).not.toContain('base_footprint');
    expect(sdf).not.toContain('base_footprint');
  });
});

/** Every element whose children share a name with a sibling, as "parent > name": what SDF forbids, and so Gazebo in a URDF. (ros2_control lists a joint's interfaces by kind, not by name.) */
function siblingClashes(xml: string): string[] {
  const out: string[] = [];
  const walk = (e: XmlElement) => {
    const seen = new Set<string>();
    for (const c of e.children) {
      const name = c.attrs.name;
      if (name === undefined) continue;
      if (seen.has(name)) out.push(`${e.name} > ${name}`);
      seen.add(name);
    }
    e.children.filter((c) => c.name !== 'ros2_control').forEach(walk);
  };
  walk(xmlTree(new TextEncoder().encode(xml))!);
  return out;
}

/** Every name a MuJoCo model gives twice to one kind of thing: bodies, joints, sites, cameras, sensors, actuators. */
function mjcfClashes(xml: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (e: XmlElement, section: string) => {
    for (const c of e.children) {
      const kind = section || (c.name === 'freejoint' ? 'joint' : c.name);
      const key = `${kind}/${c.attrs.name}`;
      if (c.attrs.name !== undefined) {
        if (seen.has(key)) out.push(key);
        seen.add(key);
      }
      walk(c, section || (c.name === 'sensor' || c.name === 'actuator' ? c.name : ''));
    }
  };
  walk(xmlTree(new TextEncoder().encode(xml))!, '');
  return out;
}

/** Every prim of a USD stage that shares its name with a sibling, as its path. */
function usdClashes(usda: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const path: string[] = [];
  for (const line of usda.split('\n')) {
    const m = /^( *)def \w+ "([^"]+)"/.exec(line);
    if (!m) continue;
    path.length = m[1].length / 4;
    path.push(m[2]);
    const key = path.join('/');
    if (seen.has(key)) out.push(key);
    seen.add(key);
  }
  return out;
}

const file = (pkg: RobotPackage, name: RegExp): string => text(pkg.files.find((f) => name.test(f.name))!.bytes);

describe('names', () => {
  let mj: MainModule;
  beforeAll(async () => {
    mj = await loadMujoco();
  });
  const loads = (pkg: ReturnType<typeof buildMjcfModel>) => Simulation.load(mj, file(pkg, /\.xml$/), pkg.files.filter((f) => f.name.startsWith('meshes/')), pkg.drive).dispose();

  /**
   * Names the writers use themselves, and names they make from a link's, a joint's or a sensor's: the world and its
   * joint, the footprint, MuJoCo's free joint and base readings, the stage's scopes and a link's meshes, and what
   * comes of a sensor or a joint called "camera" (its frame, its optical frame, its readings, its rays).
   */
  const TAKEN = ['world', 'world joint', 'base_footprint', 'base_footprint joint', 'root', 'root joint', 'base', 'base site', 'base quat', 'base gyro', 'base vel', 'base acc', 'Joints', 'visual 0', 'collision 0', 'camera', 'camera joint', 'camera link', 'camera optical frame', 'camera optical joint', 'camera pos', 'camera vel', 'camera gyro', 'camera accel', 'camera site', 'camera 0', 'camera ray0', 'camera servo', 'floor', '__model__'];

  /** A robot that takes every one of those names three times over: for a link, for a joint, and for a sensor of every kind. */
  const hostile = (base: Robot['base']): { d: Doc; geo: Map<string, LinkGeometry> } => {
    const d = emptyDoc();
    d.name = 'Sun';
    const hub = node('hub00000', 'hub', [0, 0, 10], [40, 40, 20]);
    const parts = TAKEN.map((name, i) => node(`part${i}`, name, [60 + 30 * i, 0, 10], [20, 20, 20]));
    d.scene = [hub, ...parts];
    const joints = parts.map((part, i) => ({ ...defaultJoint(`j${i}`, TAKEN[(i + 1) % TAKEN.length], hub.id, part.id, [0, 0, 0]), axis: [0, 1, 0] as [number, number, number], ...(i < 2 ? { type: 'continuous' as const } : {}) }));
    const sensors = parts.flatMap((part, i) => SENSOR_KINDS.map((k) => ({ ...defaultSensor(`s${i}${k.id}`, TAKEN[(i + 2) % TAKEN.length], k.id, part.id, [0, 0, 0]), lidar: { samples: 4, hfov: 360, min: 100, max: 4000 } })));
    d.robot = { root: hub.id, base, links: [], joints, sensors, control: true, ...(base === 'free' ? { drive: { kind: 'differential', roles: { j0: 'left', j1: 'right' } } } : {}) };
    return { d, geo: new Map(d.scene.map((n) => [n.id, boxGeometry(n)])) };
  };

  it.each(['free', 'fixed'] as const)('are all different in every export of a %s robot named after the writers\' own names', (base) => {
    const { d, geo } = hostile(base);
    const ros = buildRobotPackage(d, geo);
    expect(siblingClashes(file(ros, /\.urdf$/))).toEqual([]);
    expect(siblingClashes(file(ros, /\.urdf\.xacro$/))).toEqual([]);
    // The robot is spawned into the world by its package's name.
    expect(siblingClashes(file(ros, /^worlds\//))).toEqual([]);
    expect([...file(ros, /^worlds\//).matchAll(/<(?:light|model)[^>]* name="([^"]+)"/g)].map((m) => m[1])).not.toContain(ros.name);
    const sdf = buildSdfModel(d, geo);
    expect(siblingClashes(file(sdf, /^model\.sdf$/))).toEqual([]);
    expect(siblingClashes(file(sdf, /^worlds\//))).toEqual([]);
    const usd = buildIsaacStage(d, geo);
    expect(usdClashes(file(usd, /\.usda$/))).toEqual([]);
    const mjcf = buildMjcfModel(d, geo);
    expect(mjcfClashes(file(mjcf, /\.xml$/))).toEqual([]);
    expect(() => loads(mjcf)).not.toThrow();
    // Each sensor keeps one name of its own in every format, which its topics and readings go by.
    for (const pkg of [ros, sdf]) {
      const topics = [...file(pkg, /\.urdf$|^model\.sdf$/).matchAll(/<sensor name="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(topics).size).toBe(d.robot!.sensors.length);
    }
  });

  it('keep the stage\'s and the world\'s own clear of a robot named after them', () => {
    for (const name of ['Sun', 'Dome', 'Ground', 'Looks', 'PhysicsMaterials', 'ROS2', 'physicsScene', 'sun', 'ground_plane']) {
      const d = rover();
      d.name = name;
      expect(usdClashes(file(buildIsaacStage(d, geometry()), /\.usda$/))).toEqual([]);
      const sdf = buildSdfModel(d, geometry());
      const world = file(sdf, /^worlds\//);
      // The model is included under its own name, beside the world's light and floor.
      const model = /<model name="([^"]+)"/.exec(file(sdf, /^model\.sdf$/))![1];
      expect([...world.matchAll(/<(?:light|model)[^>]* name="([^"]+)"/g)].map((m) => m[1])).not.toContain(model);
    }
  });

  it('leave a robot with nothing to clash as it was named', () => {
    const d = rover();
    const urdf = file(buildRobotPackage(d, geometry()), /\.urdf$/);
    for (const name of ['Body', 'Left_wheel', 'Arm_upper', 'front_cam_link', 'front_cam_optical_frame', 'top_lidar_link', 'imu_link', 'base_footprint']) expect(urdf).toContain(`<link name="${name}"`);
    // A sensor may share its link's name: they are different things in every format.
    d.robot!.sensors[2] = { ...d.robot!.sensors[2], name: 'Body' };
    for (const build of [buildRobotPackage, buildSdfModel, buildMjcfModel, buildIsaacStage]) {
      const out = file(build(d, geometry()), /\.urdf$|^model\.sdf$|^test_rover\.xml$|\.usda$/);
      expect(out).toMatch(/(<sensor name="Body" type="imu"|<site name="Body" |def IsaacImuSensor "Body")/);
    }
  });

  it('never has a follower name a joint the file does not hold', () => {
    const cases: Doc[] = [];
    // The leader fixed, closing a loop, left out, and following back: the checks stop these, the writers still write what loads.
    const fixed = doc();
    fixed.robot!.joints[0].type = 'fixed';
    fixed.robot!.joints[1].mimic = { joint: 'j1', multiplier: 1, offset: 0 };
    const loop = doc();
    loop.robot!.joints.push({ ...defaultJoint('j3', 'closing', arm.id, wheel.id, [0, 0, 0]) });
    loop.robot!.joints[1].mimic = { joint: 'j3', multiplier: 1, offset: 0 };
    const follower = doc();
    follower.robot!.joints[1] = { ...follower.robot!.joints[1], type: 'fixed', mimic: { joint: 'j1', multiplier: 1, offset: 0 } };
    const ring = doc();
    ring.robot!.joints[0].mimic = { joint: 'j2', multiplier: 1, offset: 0 };
    ring.robot!.joints[1].mimic = { joint: 'j1', multiplier: 1, offset: 0 };
    cases.push(fixed, loop, follower, ring);
    for (const d of cases) {
      const urdf = file(buildRobotPackage(d, geometry()), /\.urdf$/);
      const moving = new Set([...urdf.matchAll(/<joint name="([^"]+)" type="(?!fixed)/g)].map((m) => m[1]));
      for (const m of urdf.matchAll(/<mimic joint="([^"]+)"/g)) expect(moving).toContain(m[1]);
      const usda = file(buildIsaacStage(d, geometry()), /\.usda$/);
      for (const m of usda.matchAll(/referenceJoint = <[^>]*\/([^/>]+)>/g)) expect(usda).toMatch(new RegExp(`def Physics(Revolute|Prismatic)Joint "${m[1]}"`));
      expect(() => loads(buildMjcfModel(d, geometry()))).not.toThrow();
    }
  });
});

describe('odd numbers', () => {
  let mj: MainModule;
  beforeAll(async () => {
    mj = await loadMujoco();
  });

  /** Ways a robot's numbers can be left: each takes a robot and zeroes or upsets one kind of figure in it. */
  const UPSETS: Record<string, (r: Robot) => void> = {
    'no effort': (r) => r.joints.forEach((j) => (j.effort = 0)),
    'no velocity': (r) => r.joints.forEach((j) => (j.velocity = 0)),
    'no damping or friction': (r) => r.joints.forEach((j) => Object.assign(j, { damping: 0, friction: 0 })),
    'limits at zero': (r) => r.joints.forEach((j) => Object.assign(j, { lower: 0, upper: 0 })),
    'limits the wrong way round': (r) => r.joints.forEach((j) => Object.assign(j, { lower: 30, upper: -30 })),
    'negative figures': (r) => r.joints.forEach((j) => Object.assign(j, { effort: -1, velocity: -1, damping: -1, friction: -1 })),
    'no friction on any link': (r) => r.links.forEach((l) => (l.friction = 0)),
    'weightless links': (r) => r.links.forEach((l) => (l.mass = { kind: 'measured', grams: 0 })),
    'empty sensors': (r) => r.sensors.forEach((x) => Object.assign(x, { rate: 0, camera: { hfov: 0, width: 0, height: 0, near: 0, far: 0 }, lidar: { samples: 0, hfov: 0, min: 0, max: 0 } })),
    'one-ray lidars and one-pixel cameras': (r) => r.sensors.forEach((x) => Object.assign(x, { camera: { ...x.camera, width: 1, height: 1, hfov: 180 }, lidar: { ...x.lidar, samples: 1 } })),
    'followers by nothing': (r) => r.joints.slice(1).forEach((j) => (r.drive?.roles[j.id] ? null : (j.mimic = { joint: r.joints[0].id, multiplier: 0, offset: 0 }))),
  };

  it.each(Object.keys(UPSETS))('write no NaN or Infinity into any export: %s', (upset) => {
    for (const { make } of ROBOTS) {
      const d = make();
      UPSETS[upset](d.robot!);
      const geo = new Map(linkNodes(d.scene).map((n) => [n.id, boxGeometry(n)]));
      const mjcf = buildMjcfModel(d, geo);
      for (const pkg of [buildRobotPackage(d, geo), buildSdfModel(d, geo), mjcf, buildIsaacStage(d, geo)]) {
        for (const f of pkg.files.filter((f) => /\.(urdf|xacro|sdf|xml|usda|json|yaml)$/.test(f.name))) {
          const bad = text(f.bytes).split('\n').filter((l) => /NaN|Infinity/.test(l));
          expect(bad, `${d.name}, ${f.name}`).toEqual([]);
        }
      }
      // What the checks let through, MuJoCo takes, and still has numbers after a moment of it.
      const props = new Map([...geo].map(([id, g]) => [id, g.props]));
      if (checkRobot(d, props).some((p) => p.level === 'error')) continue;
      const sim = Simulation.load(mj, file(mjcf, /\.xml$/), mjcf.files.filter((f) => f.name.startsWith('meshes/')), mjcf.drive);
      sim.drive(1, 1);
      sim.step(0.1);
      expect([...sim.poses()].every(Number.isFinite), d.name).toBe(true);
      sim.dispose();
    }
  });
});

describe('what goes beside the robot', () => {
  it('adds the package to Gazebo\'s resource path without dropping what was on it', () => {
    const launch = file(buildRobotPackage(rover(), geometry()), /gazebo\.launch\.py$/);
    expect(launch).not.toMatch(/SetEnvironmentVariable\(\s*'GZ_SIM_RESOURCE_PATH'/);
    expect(launch).toMatch(/AppendEnvironmentVariable\(\s*'GZ_SIM_RESOURCE_PATH'/);
    expect(launch).toMatch(/from launch\.actions import [^\n]*AppendEnvironmentVariable/);
  });

  it('points Isaac Sim users at the stage export, which needs no setting up', () => {
    const readme = file(buildRobotPackage(rover(), geometry()), /README\.md$/);
    expect(readme).toContain('Isaac Sim stage');
    expect(readme).not.toMatch(/drive\s+gains/);
  });

  it('reads where the robot starts only after MuJoCo has worked it out', () => {
    const drive = file(buildMjcfModel(rover(), geometry()), /drive\.py$/);
    expect(drive.indexOf('mj_forward(')).toBeGreaterThan(-1);
    expect(drive.indexOf('mj_forward(')).toBeLessThan(drive.indexOf('subtree_com['));
  });
});
