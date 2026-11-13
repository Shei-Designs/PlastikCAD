import { beforeAll, describe, expect, it } from 'vitest';
import { initKernel, robotGeometry, setAssets } from '../geometry/kernel';
import { buildRobotPackage } from '../robot/export';
import { ROBOTS } from '../robot/fixtures';
import { linkNodes, linkOf } from '../robot/model';
import { boundsSize, boxBounds } from '../model/math';
import { decodeFloat32, decodeUint32 } from './base64';
import { encodeText } from './format';
import { meshPath, parseUrdf, urdfMeshFiles } from './importUrdf';
import type { Companion } from './import';
import { writeStl } from './stl';

beforeAll(async () => {
  await initKernel();
});

const close = (a: number[], b: number[], tolerance = 0.5) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(tolerance));

/** The reference robot as a package: its URDF, and every other file as a companion named by its path. */
function packaged(file: string): { urdf: Uint8Array; companions: Companion[]; doc: ReturnType<(typeof ROBOTS)[number]['make']> } {
  const doc = ROBOTS.find((r) => r.file === file)!.make();
  const nodes = linkNodes(doc.scene);
  const geo = robotGeometry(nodes, Object.fromEntries(nodes.map((n) => [n.id, linkOf(doc.robot!, n.id).collision])), true);
  const pkg = buildRobotPackage(doc, new Map(geo.map((g) => [g.id, g])), doc.robot!);
  const urdf = pkg.files.find((f) => f.name.endsWith('.urdf'))!;
  return { urdf: urdf.bytes, companions: pkg.files.filter((f) => f !== urdf).map((f) => ({ name: f.name, bytes: f.bytes })), doc };
}

describe('parseUrdf', () => {
  it('keeps a plain collision shape as the file has it where it is not the one fitted to the link', () => {
    const link = (name: string, collision: string) => `<link name="${name}"><visual><geometry><box size="0.02 0.02 0.2"/></geometry></visual><collision>${collision}</collision></link>`;
    const urdf = encodeText(`<robot name="t">
      ${link('trunk', '<geometry><box size="0.02 0.02 0.2"/></geometry>')}
      ${link('calf', '<origin xyz="0 0 0.05" rpy="0 0 1.5707963267948966"/><geometry><box size="0.01 0.012 0.06"/></geometry>')}
      ${link('foot', '<origin xyz="0 0 -0.1"/><geometry><sphere radius="0.02"/></geometry>')}
      <joint name="a" type="fixed"><parent link="trunk"/><child link="calf"/><origin xyz="0.1 0 0"/></joint>
      <joint name="b" type="fixed"><parent link="trunk"/><child link="foot"/><origin xyz="0.2 0 0"/></joint>
    </robot>`);
    const imported = parseUrdf(urdf);
    expect(imported.warnings).toEqual([]);
    const [trunk, calf, foot] = imported.robot.links;
    // The trunk's box is its own: nothing to keep.
    expect([trunk.collision, trunk.shape]).toEqual(['box', undefined]);
    // The calf's is smaller, higher and turned a quarter; the foot's a ball under its end, wider than the foot.
    expect(calf.collision).toBe('box');
    expect(calf.shape).toEqual({ size: [10, 12, 60], center: [0, 0, 50], rot: [0, 0, 90] });
    expect(foot.collision).toBe('sphere');
    expect(foot.shape).toEqual({ size: [40, 40, 40], center: [0, 0, -100], rot: [0, 0, 0] });
    // And they go out again as they came in.
    const doc = { ...ROBOTS[0].make(), scene: imported.scene, assets: imported.assets, robot: imported.robot };
    const nodes = linkNodes(doc.scene);
    setAssets(imported.assets);
    const geo = robotGeometry(nodes, Object.fromEntries(nodes.map((n) => [n.id, linkOf(doc.robot, n.id).collision])), true);
    const out = new TextDecoder().decode(buildRobotPackage(doc, new Map(geo.map((g) => [g.id, g])), doc.robot).files.find((f) => f.name.endsWith('.urdf'))!.bytes);
    expect(out).toMatch(/<collision[^>]*>\s*<origin xyz="0 0 0.05" rpy="0 0 1.570796"\/>\s*<geometry>\s*<box size="0.01 0.012 0.06"\/>/);
    expect(out).toMatch(/<collision[^>]*>\s*<origin xyz="0 0 -0.1"[^>]*\/>\s*<geometry>\s*<sphere radius="0.02"\/>/);
  });

  it('turns an inertia given in a turned frame into the link\'s own, and leaves out one no body could have', () => {
    const link = (name: string, inertial: string) => `<link name="${name}"><inertial>${inertial}</inertial><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link>`;
    const urdf = encodeText(`<robot name="t">
      ${link('a', '<origin xyz="0.01 0 0.02" rpy="0 0 1.5707963267948966"/><mass value="1"/><inertia ixx="1e-4" iyy="2e-4" izz="3e-4" ixy="0" ixz="0" iyz="0"/>')}
      ${link('b', '<mass value="1"/><inertia ixx="1e-4" iyy="1e-4" izz="9e-4" ixy="0" ixz="0" iyz="0"/>')}
      <joint name="j" type="fixed"><parent link="a"/><child link="b"/><origin xyz="0.2 0 0"/></joint>
    </robot>`);
    const imported = parseUrdf(urdf);
    const [a, b] = imported.robot.links.map((l) => l.mass);
    if (a.kind !== 'measured' || b.kind !== 'measured') throw new Error('not weighed');
    close(a.center!, [10, 0, 20], 1e-6);
    // A quarter turn about Z swaps the moments about X and Y.
    close(a.inertia!, [2e5, 1e5, 3e5, 0, 0, 0], 1e-3);
    expect(b.center).toEqual([0, 0, 0]);
    expect(b.inertia).toBeUndefined();
    expect(imported.warnings).toEqual(['"b" has an inertia no real body could have; its shape gives it one.']);
  });

  it.each(ROBOTS.map((r) => r.file))('keeps the masses, centers and inertias of %s through an import', (file) => {
    const { urdf, companions } = packaged(file);
    const imported = parseUrdf(urdf, companions);
    const doc = { ...ROBOTS.find((r) => r.file === file)!.make(), scene: imported.scene, assets: imported.assets, robot: imported.robot };
    const nodes = linkNodes(doc.scene);
    setAssets(imported.assets);
    const geo = robotGeometry(nodes, Object.fromEntries(nodes.map((n) => [n.id, linkOf(doc.robot, n.id).collision])), true);
    const again = buildRobotPackage(doc, new Map(geo.map((g) => [g.id, g])), doc.robot).files.find((f) => f.name.endsWith('.urdf'))!;
    /** Every link's inertial figures by its name: mass, where its center is, and the six of its tensor. */
    const inertials = (bytes: Uint8Array): Map<string, number[]> => {
      const found = new Map<string, number[]>();
      for (const [, name, body] of new TextDecoder().decode(bytes).matchAll(/<link name="([^"]+)">\s*<inertial>([\s\S]*?)<\/inertial>/g)) {
        found.set(name, [...body.matchAll(/(?:value|xyz|ixx|iyy|izz|ixy|ixz|iyz)="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/).map(Number)));
      }
      return found;
    };
    const before = inertials(urdf);
    const after = inertials(again.bytes);
    expect(before.size).toBeGreaterThan(1);
    for (const [name, figures] of before) {
      const back = after.get(name);
      expect(back, name).toBeDefined();
      const scale = Math.max(...figures.slice(4).map(Math.abs));
      figures.forEach((v, i) => expect(Math.abs(back![i] - v), `${name} figure ${i}`).toBeLessThan(i < 4 ? 1e-4 : 1e-3 * scale));
    }
  });

  it('brings the reference rover back: links where they were, wheels on continuous joints, the lidar and the drive', () => {
    const { urdf, companions, doc } = packaged('rover');
    const imported = parseUrdf(urdf, companions);
    expect(imported.warnings).toEqual([]);
    expect(imported.missing).toEqual([]);
    expect(imported.name).toBe('Reference rover');
    expect(imported.scene.map((n) => n.name)).toEqual(['Body', 'Wheel left back', 'Wheel left front', 'Wheel right back', 'Wheel right front']);
    // Every object stands where the design had it, filling the same box (a turn is baked into the mesh, so no object is turned).
    for (const node of imported.scene) {
      const was = doc.scene.find((n) => n.name === node.name)!;
      close(node.pos, was.pos);
      close(boundsSize(boxBounds(node)), boundsSize(boxBounds(was)));
      expect(node.rot).toEqual([0, 0, 0]);
      expect(node.type).toBe('import');
    }
    const robot = imported.robot;
    expect(robot.root).toBe(imported.scene[0].id);
    expect(robot.base).toBe('free');
    expect(robot.links.map((l) => l.collision)).toEqual(['box', 'cylinder', 'cylinder', 'cylinder', 'cylinder']);
    // A wheel comes in as a mesh lying on its side; the cylinder fitted to it lies along the axis it is round about, as the file's does, so nothing is kept.
    expect(robot.links.map((l) => Boolean(l.shape))).toEqual([false, false, false, false, false]);
    expect(robot.links[1].friction).toBe(1);
    expect(robot.links[1].mass.kind).toBe('measured');
    expect(robot.joints).toHaveLength(4);
    for (const j of robot.joints) {
      expect(j.type).toBe('continuous');
      expect(j.parent).toBe(robot.root);
      // The axle runs along the design's X, the wheel's own Z after its quarter turn; the hub is at the wheel's center.
      const wheel = imported.scene.find((n) => n.id === j.child)!;
      close(j.origin, [0, 0, 0], 0.01);
      expect(Math.abs(j.axis[0])).toBeCloseTo(1, 3);
      expect(wheel.name.startsWith('Wheel')).toBe(true);
      const was = doc.robot!.joints.find((o) => o.name === j.name)!;
      expect(j.effort).toBeCloseTo(was.effort, 3);
      expect(j.velocity).toBeCloseTo(was.velocity, 1);
      expect(j.damping).toBeCloseTo(was.damping, 4);
    }
    expect(robot.drive?.kind).toBe('differential');
    expect(Object.values(robot.drive!.roles).sort()).toEqual(['left', 'left', 'right', 'right']);
    expect(robot.sensors).toHaveLength(3);
    // The camera on the body's top comes back turned to look along +Y and tilted 20° down, with its picture size and reach.
    const sensor = (kind: string) => doc.robot!.sensors.find((s) => s.kind === kind)!;
    const camera = robot.sensors.find((s) => s.kind === 'camera')!;
    expect(camera.name).toBe('Camera');
    expect(camera.link).toBe(robot.root);
    close(camera.origin, sensor('camera').origin, 0.01);
    close(camera.rot, [0, 20, 90], 0.01);
    expect(camera.rate).toBe(30);
    expect(camera.camera).toEqual(sensor('camera').camera);
    const imu = robot.sensors.find((s) => s.kind === 'imu')!;
    expect(imu.name).toBe('IMU');
    expect(imu.link).toBe(robot.root);
    close(imu.origin, [0, 0, 0], 0.01);
    expect(imu.rate).toBe(100);
    const lidar = robot.sensors.find((s) => s.kind === 'lidar')!;
    expect(lidar.kind).toBe('lidar');
    expect(lidar.name).toBe('Lidar');
    expect(lidar.link).toBe(robot.root);
    close(lidar.origin, sensor('lidar').origin, 0.01);
    expect(lidar.lidar).toEqual({ samples: 36, hfov: 360, min: 100, max: 4000 });
    expect(lidar.rate).toBe(10);
    // Every joint is a wheel, so the package had no ros2_control to bring back.
    expect(robot.control).toBe(false);
  });

  it('brings back what the controllers send each joint and where it begins', () => {
    const doc = ROBOTS.find((r) => r.file === 'arm')!.make();
    const moving = doc.robot!.joints.filter((j) => j.type !== 'fixed' && !j.mimic);
    moving[0].command = 'torque';
    moving[1].start = 25;
    const nodes = linkNodes(doc.scene);
    const geo = robotGeometry(nodes, Object.fromEntries(nodes.map((n) => [n.id, linkOf(doc.robot!, n.id).collision])), true);
    const pkg = buildRobotPackage(doc, new Map(geo.map((g) => [g.id, g])), doc.robot!);
    const urdf = pkg.files.find((f) => f.name.endsWith('.urdf'))!;
    const { robot } = parseUrdf(urdf.bytes, pkg.files.filter((f) => f !== urdf).map((f) => ({ name: f.name, bytes: f.bytes })));
    const back = (name: string) => robot.joints.find((j) => j.name === name)!;
    expect(robot.control).toBe(true);
    expect(back(moving[0].name).command).toBe('torque');
    expect(back(moving[0].name).start).toBeUndefined();
    expect(back(moving[1].name).command).toBeUndefined();
    expect(back(moving[1].name).start).toBeCloseTo(25, 3);
    for (const j of moving.slice(2)) expect(back(j.name).command).toBeUndefined();
  });

  it('takes a joint with only an effort interface as commanded by torque', () => {
    const urdf = `<robot name="r"><link name="a"><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link><link name="b"><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link>
      <joint name="knee" type="revolute"><parent link="a"/><child link="b"/><axis xyz="0 1 0"/><limit lower="-1" upper="1" effort="5" velocity="2"/></joint>
      <ros2_control name="s" type="system"><joint name="knee"><command_interface name="effort"/><state_interface name="position"><param name="initial_value">-0.5</param></state_interface></joint></ros2_control></robot>`;
    const { robot } = parseUrdf(encodeText(urdf), []);
    expect(robot.joints[0].command).toBe('torque');
    expect(robot.joints[0].start).toBeCloseTo(-28.6479, 3);
  });

  it('reads a link drawn with a Collada mesh, in the units the file declares', () => {
    const dae = `<?xml version="1.0"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
      <asset><unit meter="1"/><up_axis>Z_UP</up_axis></asset>
      <library_geometries><geometry id="box"><mesh>
        <source id="p"><float_array id="pa" count="24">-0.05 -0.05 0 0.05 -0.05 0 0.05 0.05 0 -0.05 0.05 0 -0.05 -0.05 0.1 0.05 -0.05 0.1 0.05 0.05 0.1 -0.05 0.05 0.1</float_array>
          <technique_common><accessor source="#pa" count="8" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
        <vertices id="v"><input semantic="POSITION" source="#p"/></vertices>
        <polylist count="6"><input semantic="VERTEX" source="#v" offset="0"/><vcount>4 4 4 4 4 4</vcount><p>0 3 2 1 4 5 6 7 0 1 5 4 1 2 6 5 2 3 7 6 3 0 4 7</p></polylist>
      </mesh></geometry></library_geometries>
      <library_visual_scenes><visual_scene id="s"><node id="n"><instance_geometry url="#box"/></node></visual_scene></library_visual_scenes>
      <scene><instance_visual_scene url="#s"/></scene></COLLADA>`;
    const urdf = `<robot name="t"><link name="Base">
      <inertial><mass value="0.1"/><inertia ixx="1e-4" iyy="1e-4" izz="1e-4" ixy="0" ixz="0" iyz="0"/></inertial>
      <visual><geometry><mesh filename="package://t/meshes/box.dae" scale="2 1 1"/></geometry></visual>
    </link></robot>`;
    const encode = (s: string) => new TextEncoder().encode(s);
    const imported = parseUrdf(encode(urdf), [{ name: 'meshes/box.dae', bytes: encode(dae) }]);
    expect(imported.warnings).toEqual([]);
    expect(imported.missing).toEqual([]);
    expect(imported.scene).toHaveLength(1);
    // A 100 mm cube, stretched to 200 along X by the URDF's scale, standing on the floor.
    close(boundsSize(boxBounds(imported.scene[0])), [200, 100, 100]);
    close([boxBounds(imported.scene[0]).min[2]], [0]);
  });

  it('brings the arm back bolted to the world, with its joints turning where they did', () => {
    const { urdf, companions, doc } = packaged('arm');
    const imported = parseUrdf(urdf, companions);
    expect(imported.warnings).toEqual([]);
    expect(imported.robot.base).toBe('fixed');
    expect(imported.robot.control).toBe(true);
    expect(imported.scene).toHaveLength(4);
    for (const j of imported.robot.joints) {
      const was = doc.robot!.joints.find((o) => o.name === j.name)!;
      expect(j.type).toBe(was.type);
      close(j.origin, was.origin, 0.01);
      close(j.axis, was.axis, 1e-3);
      expect(j.lower).toBeCloseTo(was.lower, 2);
      expect(j.upper).toBeCloseTo(was.upper, 2);
    }
  });

  it('brings the car back with its steering knuckles and the Ackermann drive', () => {
    const { urdf, companions } = packaged('car');
    const imported = parseUrdf(urdf, companions);
    expect(imported.warnings).toEqual([]);
    expect(imported.robot.drive?.kind).toBe('ackermann');
    expect(Object.values(imported.robot.drive!.roles).sort()).toEqual(['left', 'right', 'steer-left', 'steer-right']);
    const steer = imported.robot.joints.filter((j) => imported.robot.drive!.roles[j.id]?.startsWith('steer'));
    expect(steer.map((j) => [j.type, j.lower, j.upper])).toEqual([
      ['revolute', -30, 30],
      ['revolute', -30, 30],
    ]);
  });

  it('reads a hand-written URDF: primitives, a world link, turned frames, a mimic, a collision fallback and a missing mesh', () => {
    const urdf = encodeText(`<?xml version="1.0"?>
<robot name="test_bot">
  <material name="red"><color rgba="1 0 0 1"/></material>
  <link name="world"/>
  <link name="base_link">
    <inertial><mass value="0.5"/><inertia ixx="1" iyy="1" izz="1" ixy="0" ixz="0" iyz="0"/></inertial>
    <visual><geometry><box size="0.2 0.1 0.05"/></geometry><material name="red"/></visual>
    <collision><geometry><box size="0.2 0.1 0.05"/></geometry></collision>
  </link>
  <link name="arm">
    <visual><origin xyz="0 0 0.1" rpy="0 0 0"/><geometry><cylinder radius="0.01" length="0.2"/></geometry></visual>
  </link>
  <link name="finger">
    <visual><geometry><mesh filename="package://test_bot/meshes/finger.mesh"/></geometry></visual>
    <collision><geometry><sphere radius="0.01"/></geometry></collision>
  </link>
  <link name="finger2">
    <visual><geometry><mesh filename="package://test_bot/meshes/finger2.stl"/></geometry></visual>
  </link>
  <link name="camera_link"/>
  <joint name="world_joint" type="fixed"><parent link="world"/><child link="base_link"/><origin xyz="0 0 0.025"/></joint>
  <joint name="shoulder" type="revolute">
    <parent link="base_link"/><child link="arm"/>
    <origin xyz="0.1 0 0.025" rpy="0 1.5707963 0"/>
    <axis xyz="0 1 0"/>
    <limit lower="-1.5707963" upper="1.5707963" effort="2" velocity="3.1415927"/>
    <dynamics damping="0.05" friction="0.01"/>
  </joint>
  <joint name="pinch" type="revolute">
    <parent link="arm"/><child link="finger"/>
    <origin xyz="0 0 0.2"/><axis xyz="1 0 0"/>
    <limit lower="0" upper="0.5" effort="1" velocity="1"/>
  </joint>
  <joint name="pinch2" type="revolute">
    <parent link="arm"/><child link="finger2"/>
    <origin xyz="0 0.02 0.2"/><axis xyz="1 0 0"/>
    <limit lower="0" upper="0.5" effort="1" velocity="1"/>
    <mimic joint="pinch" multiplier="-1" offset="0"/>
  </joint>
  <joint name="camera_joint" type="fixed"><parent link="base_link"/><child link="camera_link"/><origin xyz="0.1 0 0.05" rpy="0 0 0"/></joint>
  <gazebo reference="base_link"><mu1>1.5</mu1><mu2>1.5</mu2></gazebo>
  <gazebo reference="camera_link">
    <sensor name="front_camera" type="camera"><update_rate>15</update_rate><camera><horizontal_fov>1.2</horizontal_fov><image><width>320</width><height>240</height></image><clip><near>0.1</near><far>5</far></clip></camera></sensor>
  </gazebo>
</robot>`);
    const imported = parseUrdf(urdf, []);
    expect(imported.name).toBe('test bot');
    expect(imported.missing).toEqual(['package://test_bot/meshes/finger2.stl']);
    expect(imported.warnings).toEqual([
      '"finger" is drawn with "finger.mesh", a kind of mesh file that cannot be read.',
      '"finger" is shown by its collision shape, as its visual could not be read.',
      '"finger2" moves but has no shape; a small box stands for it.',
    ]);
    // The world link is folded away; the base stands on the plate as a red box.
    expect(imported.robot.base).toBe('fixed');
    const [base, arm, finger, finger2] = imported.scene;
    expect(imported.scene.map((n) => n.name)).toEqual(['base link', 'arm', 'finger', 'finger2']);
    expect(base.type).toBe('shape');
    expect(base.color).toBe('#ff0000');
    close(base.size, [200, 100, 50]);
    close(base.pos, [0, 0, 25]);
    // The arm's frame is turned a quarter about Y, so its cylinder lies along +X, 100 mm out from the shoulder.
    expect(arm.type).toBe('shape');
    close(arm.size, [20, 20, 200]);
    close(arm.pos, [200, 0, 50]);
    expect(arm.rot[1]).toBeCloseTo(90, 3);
    // The finger has its collision sphere for a shape, at the arm's end.
    expect(finger.type).toBe('shape');
    close(finger.pos, [300, 0, 50]);
    const links = imported.robot.links;
    // The file's inertia comes with the mass: 1 kg·m² about each axis, at the link's frame (the middle of this box).
    expect(links[0].mass).toEqual({ kind: 'measured', grams: 500, center: [0, 0, 0], inertia: [1e9, 1e9, 1e9, 0, 0, 0] });
    expect(links[0].friction).toBe(1.5);
    expect(links[0].collision).toBe('box');
    // "base link" writes back as base_link by itself, so no other name is kept for it.
    expect(links[0].name).toBeUndefined();
    expect(links[1].collision).toBe('none');
    const [shoulder, pinch] = imported.robot.joints;
    expect(shoulder.name).toBe('shoulder');
    expect(shoulder.type).toBe('revolute');
    expect(shoulder.parent).toBe(base.id);
    expect(shoulder.child).toBe(arm.id);
    // In the arm's own frame: the joint at its lower end, turning about its Y.
    close(shoulder.origin, [0, 0, -100], 0.01);
    close(shoulder.axis, [0, 1, 0], 1e-3);
    expect(shoulder.lower).toBeCloseTo(-90, 3);
    expect(shoulder.upper).toBeCloseTo(90, 3);
    expect(shoulder.effort).toBe(2);
    expect(shoulder.velocity).toBeCloseTo(180, 3);
    expect(shoulder.damping).toBe(0.05);
    expect(shoulder.friction).toBe(0.01);
    expect(pinch.name).toBe('pinch');
    expect(pinch.upper).toBeCloseTo(28.6479, 3);
    // The second finger stands in for its missing mesh and follows the first.
    expect(imported.robot.joints).toHaveLength(3);
    expect(finger2.size).toEqual([10, 10, 10]);
    expect(imported.robot.joints[2].mimic).toEqual({ joint: pinch.id, multiplier: -1, offset: 0 });
    // The camera frame is folded into the base; the camera sits where the frame was.
    expect(imported.robot.sensors).toHaveLength(1);
    const camera = imported.robot.sensors[0];
    expect(camera.kind).toBe('camera');
    expect(camera.name).toBe('front camera');
    expect(camera.link).toBe(base.id);
    close(camera.origin, [100, 0, 50], 0.01);
    expect(camera.rate).toBe(15);
    expect(camera.camera).toEqual({ hfov: 68.8, width: 320, height: 240, near: 100, far: 5000 });
    expect(imported.robot.control).toBe(false);
  });

  it('keeps a follower once its leader is in', () => {
    const urdf = encodeText(`<robot name="g">
  <link name="a"><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link>
  <link name="b"><visual><geometry><box size="0.05 0.05 0.05"/></geometry></visual></link>
  <link name="c"><visual><geometry><box size="0.05 0.05 0.05"/></geometry></visual></link>
  <joint name="j1" type="prismatic"><parent link="a"/><child link="b"/><origin xyz="0.1 0 0"/><axis xyz="1 0 0"/><limit lower="0" upper="0.02" effort="5" velocity="0.1"/></joint>
  <joint name="j2" type="prismatic"><parent link="a"/><child link="c"/><origin xyz="-0.1 0 0"/><axis xyz="-1 0 0"/><limit lower="0" upper="0.02" effort="5" velocity="0.1"/><mimic joint="j1" multiplier="1" offset="0.005"/></joint>
</robot>`);
    const imported = parseUrdf(urdf, []);
    const [j1, j2] = imported.robot.joints;
    expect(j1.type).toBe('prismatic');
    expect(j1.upper).toBe(20);
    expect(j1.velocity).toBe(100);
    expect(j2.mimic).toEqual({ joint: j1.id, multiplier: 1, offset: 5 });
  });

  it('refuses what is not a URDF', () => {
    expect(() => parseUrdf(encodeText('<model name="x"/>'))).toThrow('not a URDF');
    expect(() => parseUrdf(encodeText('<robot name="x" xmlns:xacro="http://www.ros.org/wiki/xacro"><xacro:property name="a" value="1"/></robot>'))).toThrow('xacro');
    expect(() => parseUrdf(encodeText('<robot name="x"><link name="a"/></robot>'))).toThrow('No link');
  });

  it('refuses a file nested deeper than any robot is, or one that trips the reader up, in words fit to show', () => {
    const deep = encodeText(`<robot name="x"><link name="a"/>${'<a>'.repeat(200_000)}${'</a>'.repeat(200_000)}</robot>`);
    expect(() => parseUrdf(deep)).toThrow(/nested too deeply/);
    expect(() => urdfMeshFiles(deep)).toThrow(/nested too deeply/);
  });

  it('lists the mesh files a URDF names and finds the path inside the package', () => {
    const urdf = encodeText('<robot name="x"><link name="a"><visual><geometry><mesh filename="package://pkg/meshes/visual/a.obj"/></geometry></visual><collision><geometry><mesh filename="file:///tmp/a.stl"/></geometry></collision></link></robot>');
    expect(urdfMeshFiles(urdf)).toEqual(['package://pkg/meshes/visual/a.obj', 'file:///tmp/a.stl']);
    expect(meshPath('package://pkg/meshes/visual/a.obj')).toBe('meshes/visual/a.obj');
    expect(meshPath('file:///tmp/a.stl')).toBe('tmp/a.stl');
    expect(meshPath('meshes\\a.stl')).toBe('meshes/a.stl');
  });

  it('never points outside the robot\'s folder, whatever a mesh reference says', () => {
    // A package path that climbs out of its package, and an address on the network, are refused.
    expect(meshPath('package://p/../../../../etc/passwd')).toBe('');
    expect(meshPath('package://p/meshes/../../../secret.stl')).toBe('');
    expect(meshPath('https://example.com/a.stl')).toBe('');
    // What is left of any other reference has no way up in it, nor a root or a drive to start from.
    expect(meshPath('package://p/meshes/./visual/../a.stl')).toBe('meshes/a.stl');
    expect(meshPath('../../../../../dev/zero')).toBe('dev/zero');
    expect(meshPath('../meshes/a.stl')).toBe('meshes/a.stl');
    expect(meshPath('meshes/../../../a.stl')).toBe('a.stl');
    expect(meshPath('C:\\Users\\x\\a.stl')).toBe('Users/x/a.stl');
    expect(meshPath('file:///C:/Users/x/a.stl')).toBe('Users/x/a.stl');
    // Only meshes that can be read, at a path that is allowed, are asked for.
    const mesh = (filename: string) => `<visual><geometry><mesh filename="${filename}"/></geometry></visual>`;
    const urdf = encodeText(
      `<robot name="x"><link name="base">${mesh('package://p/../../../../etc/passwd')}${mesh('../../../../../../dev/zero')}${mesh('package://p/../../home/me/secret.stl')}${mesh('../meshes/a.STL')}<collision><geometry><box size="1 1 1"/></geometry></collision></link></robot>`,
    );
    expect(urdfMeshFiles(urdf)).toEqual(['../meshes/a.STL']);
    // The refused ones are dropped with a word about each, and not asked for afterwards.
    const imported = parseUrdf(urdf, [{ name: 'secret.stl', bytes: new Uint8Array(84) }]);
    expect(imported.missing).toEqual(['../meshes/a.STL']);
    expect(imported.warnings.filter((w) => w.includes('etc/passwd') || w.includes('secret.stl'))).toHaveLength(2);
    expect(imported.scene).toHaveLength(1);
  });

  it('drops the corners a mesh scale throws out of range, and keeps a sound mesh', () => {
    const tetra = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), triangles: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) };
    const urdf = encodeText(
      '<robot name="r"><link name="base"><visual><geometry><mesh filename="package://p/meshes/a.stl"/></geometry></visual><visual><origin xyz="1 0 0"/><geometry><mesh filename="package://p/meshes/a.stl" scale="1e40 1 1"/></geometry></visual></link></robot>',
    );
    const imported = parseUrdf(urdf, [{ name: 'meshes/a.stl', bytes: writeStl(tetra, 't') }]);
    const asset = Object.values(imported.assets)[0];
    if (asset.kind !== 'mesh') throw new Error('expected a mesh');
    const positions = decodeFloat32(asset.positions);
    const triangles = decodeUint32(asset.triangles);
    expect(Array.from(positions).every(Number.isFinite)).toBe(true);
    expect(Math.max(...triangles)).toBeLessThan(positions.length / 3);
    // The first visual whole, and the one face of the second that the scale left where it was.
    expect(triangles.length / 3).toBe(5);
  });

  it('knows a material by its name once a visual has defined it', () => {
    const box = '<geometry><box size="1 1 1"/></geometry>';
    const urdf = encodeText(
      `<robot name="r"><link name="a"><visual>${box}<material name="red"><color rgba="1 0 0 1"/></material></visual></link><link name="b"><visual>${box}<material name="red"/></visual></link><link name="c"><visual>${box}<material name="late"/></visual></link><link name="d"><visual>${box}<material name="late"><color rgba="0 0 1 1"/></material></visual></link>` +
        '<joint name="j" type="fixed"><parent link="a"/><child link="b"/><origin xyz="2 0 0"/></joint><joint name="k" type="fixed"><parent link="a"/><child link="c"/><origin xyz="4 0 0"/></joint><joint name="l" type="fixed"><parent link="a"/><child link="d"/><origin xyz="6 0 0"/></joint></robot>',
    );
    // By name, wherever the visual that gives the color stands in the file.
    expect(parseUrdf(urdf).scene.map((n) => n.color)).toEqual(['#ff0000', '#ff0000', '#0000ff', '#0000ff']);
  });
});
