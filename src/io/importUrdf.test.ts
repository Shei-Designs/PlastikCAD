import { beforeAll, describe, expect, it } from 'vitest';
import { initKernel, robotGeometry } from '../geometry/kernel';
import { buildRobotPackage } from '../robot/export';
import { ROBOTS } from '../robot/fixtures';
import { linkNodes, linkOf } from '../robot/model';
import { boundsSize, boxBounds } from '../model/math';
import { encodeText } from './format';
import { meshPath, parseUrdf, urdfMeshFiles } from './importUrdf';
import type { Companion } from './import';

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
    expect(robot.sensors).toHaveLength(1);
    const lidar = robot.sensors[0];
    expect(lidar.kind).toBe('lidar');
    expect(lidar.name).toBe('Lidar');
    expect(lidar.link).toBe(robot.root);
    close(lidar.origin, [0, 0, 20], 0.01);
    expect(lidar.lidar).toEqual({ samples: 36, hfov: 360, min: 100, max: 6000 });
    expect(lidar.rate).toBe(10);
    // Every joint is a wheel, so the package had no ros2_control to bring back.
    expect(robot.control).toBe(false);
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
    <visual><geometry><mesh filename="package://test_bot/meshes/finger.dae"/></geometry></visual>
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
      '"finger" is drawn with "finger.dae", a kind of mesh file that cannot be read.',
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
    expect(links[0].mass).toEqual({ kind: 'measured', grams: 500 });
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

  it('lists the mesh files a URDF names and finds the path inside the package', () => {
    const urdf = encodeText('<robot name="x"><link name="a"><visual><geometry><mesh filename="package://pkg/meshes/visual/a.obj"/></geometry></visual><collision><geometry><mesh filename="file:///tmp/a.stl"/></geometry></collision></link></robot>');
    expect(urdfMeshFiles(urdf)).toEqual(['package://pkg/meshes/visual/a.obj', 'file:///tmp/a.stl']);
    expect(meshPath('package://pkg/meshes/visual/a.obj')).toBe('meshes/visual/a.obj');
    expect(meshPath('file:///tmp/a.stl')).toBe('tmp/a.stl');
    expect(meshPath('meshes\\a.stl')).toBe('meshes/a.stl');
  });
});
