import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../model/file';
import type { SceneNode } from '../model/types';
import type { LinkGeometry } from '../worker/protocol';
import { checkRobot } from './check';
import { buildMjcfModel, buildRobotPackage, buildSdfModel } from './export';
import { meshProperties } from './inertia';
import { jointInChild, jointInDesign, spanningTree } from './model';
import { defaultJoint, defaultLink, defaultSensor } from './types';
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
    sensors: [],
    control: true,
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

describe('sensors, drive and control', () => {
  const rover = () => {
    const d = doc();
    const r = d.robot!;
    r.sensors = [
      { ...defaultSensor('s1', 'front cam', 'camera', body.id, [50, 0, 10]) },
      { ...defaultSensor('s2', 'top lidar', 'lidar', body.id, [0, 0, 10]), rot: [0, 0, 90] },
      { ...defaultSensor('s3', 'imu', 'imu', body.id, [0, 0, 0]) },
    ];
    // The wheel joint drives the left side; a mirrored one would drive the right. Here one joint each side, the arm's shoulder stays under ros2_control.
    r.joints.push({ ...defaultJoint('j3', 'right wheel joint', body.id, arm.id, [0, 0, -20]), type: 'continuous', axis: [0, 1, 0] });
    r.drive = { left: ['j1'], right: ['j3'] };
    return d;
  };

  it('writes sensor frames, Gazebo blocks, the drive and ros2_control into the package', () => {
    const d = rover();
    // The arm is both the right wheel (j3) and on the shoulder (j2): the shoulder is a loop joint then, so only the wheels remain in the tree.
    d.robot!.joints.splice(1, 1);
    const pkg = buildRobotPackage(d, geometry());
    const names = pkg.files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['worlds/test_rover.sdf', 'config/bridge.yaml']));
    expect(names).not.toContain('config/controllers.yaml');
    const urdf = text(pkg.files.find((f) => f.name === 'urdf/test_rover.urdf')!.bytes);
    // The camera's frame hangs from the body by a fixed joint, 50 mm forward of the body's center (which is 10 mm up), with an optical frame under it.
    expect(urdf).toMatch(/<joint name="front_cam_joint" type="fixed">\s*<parent link="Body"\/>\s*<child link="front_cam_link"\/>\s*<origin xyz="0.05 0 0.02" rpy="0 0 0"\/>/);
    expect(urdf).toMatch(/<joint name="front_cam_optical_joint" type="fixed">[\s\S]*?rpy="-1.570796 0 -1.570796"/);
    // The lidar's frame is turned a quarter about Z.
    expect(urdf).toMatch(/<child link="top_lidar_link"\/>\s*<origin xyz="0 0 0.02" rpy="0 0 1.570796"\/>/);
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
    d.robot!.drive = { left: ['j1'], right: [] };
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
    expect(sdf).toMatch(/<sensor name="front_cam" type="camera">\s*<pose>0.05 0 0.02 0 0 0<\/pose>/);
    expect(sdf).toContain('<gz_frame_id>Body</gz_frame_id>');
    expect(sdf).toContain('gz-sim-diff-drive-system');
    const world = text(model.files.find((f) => f.name === 'worlds/test_rover.sdf')!.bytes);
    expect(world).toContain('<uri>model://test_rover</uri>');
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

  it('writes a MuJoCo model: nested bodies, joints, actuators, a loop as a connect, a camera and an IMU', () => {
    const d = doc();
    // Both joints drive (the shoulder standing in for a right wheel), so the base floats.
    d.robot!.drive = { left: ['j1'], right: ['j2'] };
    d.robot!.joints.push({ ...defaultJoint('j4', 'closing', arm.id, wheel.id, [0, 0, 0]) });
    d.robot!.sensors = [defaultSensor('s1', 'cam', 'camera', body.id, [50, 0, 10]), defaultSensor('s2', 'scan', 'lidar', body.id, [0, 0, 10]), defaultSensor('s3', 'imu', 'imu', body.id, [0, 0, 0])];
    const model = buildMjcfModel(d, geometry());
    expect(model.name).toBe('test_rover');
    expect(model.warnings.some((w) => w.includes('lidar'))).toBe(true);
    const names = model.files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['test_rover.xml', 'README.md', 'meshes/visual/Body.obj', 'meshes/collision/Body.stl']));
    const xml = text(model.files.find((f) => f.name === 'test_rover.xml')!.bytes);
    expect(xml).toContain('<mujoco model="Test_Rover">');
    expect(xml).toContain('<compiler angle="radian" meshdir="meshes" autolimits="true"/>');
    expect(xml).toContain('<mesh name="visual_Body_obj" file="visual/Body.obj"/>');
    // The base floats (there is a drive); the wheel hangs from it 36 mm out with a hinge about Y, no range; the arm's shoulder has one in radians.
    expect(xml).toMatch(/<body name="Body" pos="0 0 0">\s*<freejoint name="root"\/>/);
    expect(xml).toMatch(/<body name="Left_wheel" pos="0 0.036 0.01">\s*<joint name="left_wheel_joint" type="hinge" axis="0 1 0" damping="0.1" frictionloss="0"\/>/);
    expect(xml).toMatch(/<joint name="shoulder" type="hinge" axis="0 1 0" range="-1.570796 1.570796" limited="true"/);
    expect(xml).toMatch(/<inertial pos="0 0.004 0" mass="0.05" fullinertia="/);
    expect(xml).toContain('<geom type="mesh" mesh="visual_Body_obj" class="visual" material="color_ff8800"/>');
    expect(xml).toContain('<geom type="box" size="0.005 0.005 0.02" pos="0 0 0.02" class="collision" friction="0.8 0.005 0.0001"/>');
    // Actuators: the wheels velocity motors.
    expect(xml).toContain('<velocity name="left_wheel_joint_motor" joint="left_wheel_joint" kv="1"/>');
    expect(xml).toContain('<velocity name="shoulder_motor" joint="shoulder" kv="1"/>');
    expect(xml).not.toContain('<position');
    // The loop: arm and wheel pinned at the closing joint, given in the arm's frame (the wheel's center, 40 mm out and 10 down from the shoulder).
    expect(xml).toContain('<connect body1="Arm_upper" body2="Left_wheel" anchor="0 0.04 -0.01"/>');
    // The camera 50 mm forward of the body's center, the IMU a site with a gyro and an accelerometer.
    expect(xml).toMatch(/<camera name="cam" pos="0.05 0 0.02" quat="0.5 -0.5 0.5 -0.5" fovy="/);
    expect(xml).toContain('<site name="imu" pos="0 0 0.01"');
    expect(xml).toContain('<gyro name="imu_gyro" site="imu"/>');
  });

  it('welds an arm to the world and gives its joints position servos', () => {
    const xml = text(buildMjcfModel(doc(), geometry()).files.find((f) => f.name === 'test_rover.xml')!.bytes);
    expect(xml).not.toContain('<freejoint');
    expect(xml).toContain('<position name="shoulder_servo" joint="shoulder" kp="50" ctrllimited="false"/>');
    expect(xml).toContain('<position name="left_wheel_joint_servo" joint="left_wheel_joint" kp="50" ctrllimited="false"/>');
  });
});
