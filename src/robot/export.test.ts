import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../model/file';
import type { SceneNode } from '../model/types';
import type { LinkGeometry } from '../worker/protocol';
import { checkRobot } from './check';
import { buildRobotPackage } from './export';
import { meshProperties } from './inertia';
import { jointInChild, jointInDesign, spanningTree } from './model';
import { defaultJoint, defaultLink } from './types';
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
    name: 'Test Rover',
    root: body.id,
    links: [{ ...defaultLink(wheel.id), mass: { kind: 'measured', grams: 50 }, collision: 'hull', friction: 1.2 }, { ...defaultLink(arm.id), collision: 'box' }],
    joints: [
      // In the child's frame: the wheel's axle 4 mm inboard of its center, the shoulder at the arm's lower end.
      { ...defaultJoint('j1', 'left wheel joint', body.id, wheel.id, [0, -4, 0]), type: 'continuous', axis: [0, 1, 0], effort: 2, velocity: 720 },
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
    d.robot!.root = null;
    d.robot!.joints[1].lower = 100;
    d.robot!.links[0].mass = { kind: 'measured', grams: 0 };
    const problems = checkRobot(d, props);
    expect(problems.map((p) => p.level)).toEqual(['error', 'error', 'error']);
    expect(problems[0].text).toMatch(/base link/);
    expect(problems[1].joint).toBe('j2');
    expect(problems[2].link).toBe(wheel.id);
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
    // The wheel weighs 50 g, hangs 36 mm out along Y at 10 mm up, and its mesh is written in its own frame: its center is 4 mm further out.
    expect(urdf).toContain('<mass value="0.05"/>');
    expect(urdf).toMatch(/<joint name="left_wheel_joint" type="continuous">\s*<parent link="Body"\/>\s*<child link="Left_wheel"\/>\s*<origin xyz="0 0.036 0.01" rpy="0 0 0"\/>\s*<axis xyz="0 1 0"\/>\s*<limit effort="2" velocity="12.566371"\/>/);
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
    expect(urdf).toMatch(/<collision>\s*<origin xyz="0 0 0.004" rpy="1.570796 0 0"\/>\s*<geometry><cylinder radius="0.01" length="0.02"\/>/);
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
});
