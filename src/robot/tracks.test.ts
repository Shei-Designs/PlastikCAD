// A track from the Wheels parts as robot mode reads it: which objects count as
// one, the wheels that stand in for its belt, and what each export writes of them.
import { beforeAll, describe, expect, it } from 'vitest';
import { initKernel, robotGeometry } from '../geometry/kernel';
import { boxBounds, unionBounds } from '../model/math';
import { makeGroup } from '../model/ops';
import type { Doc, PartNode, SceneNode } from '../model/types';
import { getGenerator } from '../parts/generators';
import { sanitizeParams } from '../parts/generators/types';
import { trackFigures, trackPoint } from '../parts/generators/track';
import type { TrackFigures } from '../parts/generators/track';
import { checkRobot } from './check';
import { buildIsaacStage, buildMjcfModel, buildRobotPackage, buildSdfModel, RIM_SHARE } from './export';
import { ROBOTS, trackedRover } from './fixtures';
import { jointInDesign, linkNodes, linkOf } from './model';
import { isTrack, MAX_TRACK_WHEELS, standIns, standInsOnFloor, trackAxle, trackMesh, trackOf, trackWheels } from './tracks';
import type { Track } from './tracks';
import { WHEEL_FRICTION } from './wheels';

beforeAll(async () => {
  await initKernel();
});

const text = (pkg: { files: { name: string; bytes: Uint8Array }[] }, name: string): string => new TextDecoder().decode(pkg.files.find((f) => f.name === name || f.name.endsWith(name))!.bytes);

function geometryOf(doc: Doc) {
  const robot = doc.robot!;
  const nodes = linkNodes(doc.scene);
  const geo = robotGeometry(nodes, Object.fromEntries(nodes.map((n) => [n.id, linkOf(robot, n.id).collision])), false);
  return { geometry: new Map(geo.map((g) => [g.id, g])), props: new Map(geo.map((g) => [g.id, g.props])) };
}

const tracksOf = (doc: Doc): PartNode[] => doc.scene.filter((n): n is PartNode => n.type === 'part');
const found = (node: SceneNode): Track => {
  const t = trackOf(node);
  if (typeof t === 'string') throw new Error(t);
  return t;
};
const figuresOf = (settings: Record<string, number>): TrackFigures => trackFigures(sanitizeParams(getGenerator('track'), settings));

/** How far the wheels that stand in for a belt fall short of its outside at their worst, from the sprocket under the track to the idler, and how far they stick out of it at their worst. */
function fit(f: TrackFigures): { short: number; proud: number } {
  const { radius, centers } = standIns(f);
  const out = f.thickness + f.lug.height;
  const idler = f.path.find((r) => r.kind === 'arc' && r.wheel === f.wheels.length - 1)!;
  let short = 0;
  let proud = 0;
  for (let i = 0; i <= 400; i++) {
    const { at, normal } = trackPoint(f, ((idler.start + idler.length) * i) / 400, out);
    // The wheel that reaches farthest the way out of the belt here, against the belt's outside.
    const reach = Math.max(...centers.map((c) => (c[0] - at[0]) * normal[0] + (c[1] - at[1]) * normal[1] + radius));
    short = Math.max(short, -reach);
    proud = Math.max(proud, reach);
  }
  return { short, proud };
}

describe('which objects are tracks', () => {
  it('a Track part is one, alone or grouped, and no other object is', () => {
    const doc = trackedRover();
    const [left] = tracksOf(doc);
    expect(isTrack(left)).toBe(true);
    expect(isTrack(doc.scene[0])).toBe(false);
    expect(trackOf(doc.scene[0])).toBe('not-a-part');
    const boss: SceneNode = { id: 'boss', name: 'Boss', type: 'shape', shape: 'box', params: {}, pos: [left.pos[0], left.pos[1], 90], rot: [0, 0, 0], size: [10, 10, 10], hole: false, color: '#fff' };
    const grouped = makeGroup([left, boss], unionBounds([boxBounds(left), boxBounds(boss)]), 'Track with a boss');
    expect(isTrack(grouped)).toBe(true);
    // Where the wheels stand is the same, grouped or not.
    const [a, b] = [trackWheels(found(left)), trackWheels(found(grouped))];
    a.centers.forEach((c, i) => c.forEach((v, k) => expect(b.centers[i][k]).toBeCloseTo(v, 6)));
  });

  it('one stretched unevenly is not, nor an object that holds two', () => {
    const [left, right] = tracksOf(trackedRover());
    expect(trackOf({ ...left, size: [left.size[0] * 1.2, left.size[1], left.size[2]] })).toBe('stretched');
    expect(isTrack({ ...left, size: left.size.map((v) => v * 1.5) as PartNode['size'] })).toBe(true);
    expect(trackOf(makeGroup([left, right], unionBounds([boxBounds(left), boxBounds(right)]), 'Two tracks'))).toBe('several');
    expect(trackOf({ ...left, hole: true })).toBe('not-a-part');
  });

  it('grips like rubber until a friction is typed', () => {
    const doc = trackedRover();
    const [left] = tracksOf(doc);
    expect(linkOf(doc.robot!, left.id, left).friction).toBe(WHEEL_FRICTION);
  });
});

describe('the wheels that stand in for a belt', () => {
  it('are as large as the sprocket with its belt, stand on the floor in a row from the sprocket to the idler, and are no farther apart than their radius', () => {
    const f = figuresOf({});
    const { radius, centers } = standIns(f);
    expect(radius).toBeCloseTo(30 + f.thickness + f.lug.height, 9);
    expect(centers.length).toBe(8);
    expect(centers[0]).toEqual([0, 0]);
    expect(centers[centers.length - 1][0]).toBeCloseTo(240, 6);
    for (const c of centers) expect(c[1] - radius).toBeCloseTo(f.floor.up, 6);
    centers.slice(1).forEach((c, i) => expect(Math.hypot(c[0] - centers[i][0], c[1] - centers[i][1])).toBeLessThanOrEqual(radius + 1e-6));
  });

  it('follow the belt up a raised end, and round small and large road wheels, staying inside it and within a seventh of their radius of it', () => {
    const shapes: Record<string, number>[] = [
      {},
      { sprocketRise: 40 },
      { idlerRise: 40 },
      { sprocketRise: 60, idlerRise: 25 },
      { sprocketRise: 30, roadWheels: 6, roadDiameter: 20 },
      { roadWheels: 2, roadDiameter: 90 },
      { roadWheels: 0, sprocketRise: 20 },
      { length: 600, endDiameter: 80, roadWheels: 5, roadDiameter: 50, sprocketRise: 50, idlerRise: 50 },
    ];
    for (const settings of shapes) {
      const f = figuresOf(settings);
      const { radius, centers } = standIns(f);
      const { short, proud } = fit(f);
      const label = JSON.stringify(settings);
      // Inside it to within a hundredth of their radius: the corners are found by stepping along the belt.
      expect(proud, label).toBeLessThan(radius / 100);
      expect(short, label).toBeLessThan(radius / 7);
      // The lowest of them stands on the floor the track stands on.
      expect(Math.min(...centers.map((c) => c[1])) - radius, label).toBeCloseTo(f.floor.up, 3);
      expect(centers[0], label).toEqual([0, 0]);
      const idler = f.wheels[f.wheels.length - 1].center;
      expect(Math.hypot(centers[centers.length - 1][0] - idler[0], centers[centers.length - 1][1] - idler[1]), label).toBeLessThan(1e-6);
    }
  });

  it('are told apart: those on the run along the floor, and those up a raised end', () => {
    // A flat track: every wheel is on the floor.
    expect(standInsOnFloor(figuresOf({})).every(Boolean)).toBe(true);
    for (const settings of [{ sprocketRise: 40 }, { idlerRise: 40 }, { sprocketRise: 30, idlerRise: 50 }, { idlerRise: 40, roadWheels: 0 }] as Record<string, number>[]) {
      const f = figuresOf(settings);
      const { radius, centers } = standIns(f);
      const on = standInsOnFloor(f, centers);
      const label = JSON.stringify(settings);
      expect(on.length, label).toBe(centers.length);
      expect(on.some(Boolean), label).toBe(true);
      expect(on.every(Boolean), label).toBe(false);
      centers.forEach((c, i) => {
        // On the floor is touching it; a wheel up the nose stands clear of it.
        if (on[i]) expect(c[1] - radius, label).toBeCloseTo(f.floor.up, 3);
        else expect(c[1] - radius, label).toBeGreaterThan(f.floor.up + 1e-3);
      });
      // The raised end's own wheel is never on it.
      if (settings.sprocketRise) expect(on[0], label).toBe(false);
      if (settings.idlerRise && settings.roadWheels !== 0) expect(on[on.length - 1], label).toBe(false);
    }
  });

  it('are never more than a simulation can bear, however long the track', () => {
    const { centers } = standIns(figuresOf({ length: 1500, endDiameter: 20, roadWheels: 12, roadDiameter: 10 }));
    expect(centers.length).toBe(MAX_TRACK_WHEELS);
    // A track as short as its wheels still has one at each end.
    expect(standIns(figuresOf({ length: 20, endDiameter: 60, roadWheels: 0 })).centers.length).toBe(2);
  });

  it('stand where the track does in the design: on the floor, their axles across the robot, the mirrored track like the other', () => {
    const doc = trackedRover();
    const [left, right] = tracksOf(doc).map((t) => trackWheels(found(t)));
    for (const w of [left, right]) {
      expect(Math.abs(w.axis[0])).toBeCloseTo(1, 9);
      for (const c of w.centers) expect(c[2] - w.radius).toBeCloseTo(0, 6);
      expect(w.length).toBe(40);
    }
    // The left track is the right one mirrored: wheel for wheel across the robot's middle, the sprocket at the same end.
    left.centers.forEach((c, i) => {
      expect(c[0]).toBeCloseTo(-right.centers[i][0], 6);
      expect(c[1]).toBeCloseTo(right.centers[i][1], 6);
    });
    expect(left.middle[0]).toBeCloseTo(-95, 6);
    expect(right.middle[0]).toBeCloseTo(95, 6);
    // The reference rover's joints are on the sprockets' axles, where a new joint is put.
    const robot = doc.robot!;
    tracksOf(doc).forEach((t, i) => {
      const axle = trackAxle(found(t));
      const joint = jointInDesign(robot.joints[i], t);
      joint.origin.forEach((v, k) => expect(v).toBeCloseTo(axle.origin[k], 6));
      expect(Math.abs(joint.axis[0] * axle.axis[0] + joint.axis[1] * axle.axis[1] + joint.axis[2] * axle.axis[2])).toBeCloseTo(1, 9);
    });
  });

  it('are what the plate draws the track colliding as', () => {
    const t = found(tracksOf(trackedRover())[0]);
    const mesh = trackMesh(t);
    const w = trackWheels(t);
    expect(mesh.triangles.length / 3).toBe(w.centers.length * 80);
    let low = Infinity;
    let high = -Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      low = Math.min(low, mesh.positions[i]);
      high = Math.max(high, mesh.positions[i]);
    }
    expect(low).toBeCloseTo(0, 3);
    expect(high).toBeCloseTo(2 * w.radius, 3);
  });
});

describe('the checks on a track in the drive', () => {
  it('pass the reference rover, and fault a track stretched unevenly', () => {
    const doc = trackedRover();
    expect(checkRobot(doc, geometryOf(doc).props)).toEqual([]);
    const [left] = tracksOf(doc);
    const stretched = { ...doc, scene: doc.scene.map((n) => (n.id === left.id ? { ...n, size: [n.size[0], n.size[1], n.size[2] * 1.3] as PartNode['size'] } : n)) };
    const errors = checkRobot(stretched, geometryOf(stretched).props).filter((p) => p.level === 'error');
    expect(errors.map((p) => p.text)).toEqual(['Track left: stretched unevenly, so it cannot drive as a track. Scale it the same on every side.']);
    expect(errors[0].link).toBe(left.id);
  });

  it('fault a track too long for its sprocket: the row has only so many wheels, and they come to stand clear of one another', () => {
    // 24 wheels 30.8 mm across, on a row 1500 mm long.
    const long = trackedRover({ length: 1500, endDiameter: 20, roadWheels: 12, roadDiameter: 10 });
    const errors = checkRobot(long, new Map()).filter((p) => p.level === 'error');
    expect(errors.map((p) => p.text)).toEqual([
      'Track left: its 24 wheels stand 65.2 mm apart, more than the 30.8 mm each is across. Make the track shorter or its sprocket larger.',
      'Track right: its 24 wheels stand 65.2 mm apart, more than the 30.8 mm each is across. Make the track shorter or its sprocket larger.',
    ]);
    expect(errors.map((p) => p.link).sort()).toEqual(tracksOf(long).map((t) => t.id).sort());
    // As long as the wheels still reach one another, the row stands in for the belt and nothing is said.
    const { radius, centers } = standIns(figuresOf({ length: 600, endDiameter: 20, roadWheels: 12, roadDiameter: 10 }));
    expect(centers.length).toBe(MAX_TRACK_WHEELS);
    expect(Math.hypot(centers[1][0] - centers[0][0], centers[1][1] - centers[0][1])).toBeLessThan(2 * radius);
    expect(checkRobot(trackedRover({ length: 600, endDiameter: 20, roadWheels: 12, roadDiameter: 10 }), new Map()).filter((p) => p.level === 'error')).toEqual([]);
  });

  it('take a track to turn about its axles, wherever its joint points', () => {
    const doc = trackedRover();
    const robot = { ...doc.robot!, joints: doc.robot!.joints.map((j, i) => (i === 0 ? { ...j, axis: [0, 0, 1] as PartNode['pos'] } : j)) };
    expect(checkRobot(doc, geometryOf(doc).props, robot)).toEqual([]);
  });
});

describe('what the exports write for a track', () => {
  it('MuJoCo: the track held still on the body, its wheels on hinges to it with a motor each, and the drive measured from the tracks', () => {
    const doc = trackedRover();
    const { geometry } = geometryOf(doc);
    const pkg = buildMjcfModel(doc, geometry);
    const xml = text(pkg, '.xml');
    expect(xml.match(/<body name="Track_\w+_wheel_\d+"/g)?.length).toBe(16);
    expect(xml.match(/<joint name="Track_\w+_wheel_\d+_joint" type="hinge"/g)?.length).toBe(16);
    // The tracks have no joint of their own, and nothing collides but the wheels and the body's box.
    expect(xml).not.toContain('<joint name="Track_left_joint"');
    expect(xml.match(/<geom type="cylinder"[^>]*class="collision"/g)?.length).toBe(16);
    expect(xml.match(/<geom type="\w+"[^>]*class="collision"/g)?.length).toBe(17);
    expect(xml.match(/<velocity name="Track_\w+_wheel_\d+_joint_motor"/g)?.length).toBe(16);
    // One motor a track: eight wheels share its 2.6 N·m, and each carries its rotor.
    expect(xml).toContain('forcerange="-0.325 0.325"');
    expect(xml.match(/armature="0.0005"/g)?.length).toBe(16);
    expect(xml).not.toMatch(/wheel_\d+_joint_(pos|vel)"/);
    // The robot's own lists know nothing of the wheels.
    expect(pkg.bodies.length).toBe(3);
    expect(pkg.joints.length).toBe(2);
    expect(pkg.drive!.roles.left!.length).toBe(8);
    expect(pkg.drive!.roles.right!.length).toBe(8);
    expect(pkg.drive!.wheelRadius).toBeCloseTo(0.0354, 6);
    expect(pkg.drive!.wheelSeparation).toBeCloseTo(0.19, 6);
    expect(pkg.warnings).toEqual([]);
  });

  it('turns every wheel forward on a positive command, on the mirrored track too', () => {
    const doc = trackedRover();
    const xml = text(buildMjcfModel(doc, geometryOf(doc).geometry), '.xml');
    // The rover faces +Y: a wheel that rolls it that way turns about -X.
    expect(xml.match(/<joint name="Track_\w+_wheel_\d+_joint" type="hinge" axis="-1 0 0"/g)?.length).toBe(16);
  });

  it('weighs the track and its wheels together what the track weighed', () => {
    const doc = trackedRover();
    const { geometry } = geometryOf(doc);
    const off = { ...doc.robot!, links: [...doc.robot!.links, ...tracksOf(doc).map((t) => ({ ...linkOf(doc.robot!, t.id, t), collision: 'none' as const }))] };
    const masses = (x: string) => [...x.matchAll(/mass="([-0-9.e]+)"/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    const [xml, none] = [text(buildMjcfModel(doc, geometry), '.xml'), text(buildMjcfModel(doc, geometry, off), '.xml')];
    expect(masses(xml)).toBeCloseTo(masses(none), 6);
    // A track that collides with nothing keeps its wheels and its motors, and they touch nothing.
    expect(none.match(/<velocity /g)?.length).toBe(16);
    expect(none).not.toContain('type="cylinder"');
  });

  it('a track with no part in the drive keeps its joint, and its wheels turn free', () => {
    const doc = trackedRover();
    const robot = { ...doc.robot!, drive: undefined, joints: doc.robot!.joints.map((j) => ({ ...j, type: 'fixed' as const })) };
    const pkg = buildMjcfModel(doc, geometryOf(doc).geometry, robot);
    const xml = text(pkg, '.xml');
    expect(xml.match(/<body name="Track_\w+_wheel_\d+"/g)?.length).toBe(16);
    expect(xml).not.toContain('<velocity ');
    expect(pkg.drive).toBeNull();
  });

  it('Gazebo: the wheels are links of the SDF model that the drive turns, and no joint state tells of them', () => {
    const doc = trackedRover();
    const sdf = text(buildSdfModel(doc, geometryOf(doc).geometry), 'model.sdf');
    expect(sdf.match(/<link name="Track_\w+_wheel_\d+">/g)?.length).toBe(16);
    expect(sdf).toContain('<pose relative_to="Track_left">');
    expect(sdf).toContain('<joint name="Track_left_joint" type="fixed">');
    expect(sdf.match(/<left_joint>Track_left_wheel_\d+_joint<\/left_joint>/g)?.length).toBe(8);
    expect(sdf.match(/<right_joint>Track_right_wheel_\d+_joint<\/right_joint>/g)?.length).toBe(8);
    expect(sdf).toContain('<limit><effort>0.325</effort><velocity>15.707963</velocity></limit>');
    expect(sdf).toContain('<wheel_radius>0.0354</wheel_radius>');
    // Every moving joint is a wheel of a track: there is no joint state of the robot's own to publish.
    expect(sdf).not.toContain('JointStatePublisher');
  });

  it('ROS: the URDF holds the tracks on fixed joints Gazebo keeps, and hands Gazebo the wheels in its own blocks', () => {
    const doc = trackedRover();
    const pkg = buildRobotPackage(doc, geometryOf(doc).geometry);
    for (const file of ['.urdf', '.urdf.xacro']) {
      const urdf = text(pkg, file);
      const [robot, gazebo] = [urdf.slice(0, urdf.indexOf('<gazebo')), urdf.slice(urdf.indexOf('<gazebo'))];
      expect(robot).not.toContain('_wheel_');
      expect(robot.match(/<joint name="Track_\w+_joint" type="fixed">/g)?.length).toBe(2);
      expect(robot).not.toMatch(/type="(continuous|revolute)"/);
      expect(gazebo.match(/<preserveFixedJoint>true<\/preserveFixedJoint>/g)?.length).toBe(2);
      expect(gazebo.match(/<link name="Track_\w+_wheel_\d+">/g)?.length).toBe(16);
      expect(gazebo.match(/<left_joint>/g)?.length).toBe(8);
      expect(gazebo).not.toContain('JointStatePublisher');
    }
    expect(pkg.warnings).toEqual([]);
  });

  it('Isaac Sim: the wheels are bodies outside the articulation, each joint told its speed by the graph, and they meet neither each other nor the links', () => {
    const doc = trackedRover();
    const pkg = buildIsaacStage(doc, geometryOf(doc).geometry);
    const usda = text(pkg, '.usda');
    expect(usda.match(/def Xform "Track_\w+_wheel_\d+"/g)?.length).toBe(16);
    expect(usda.match(/def PhysicsRevoluteJoint "Track_\w+_wheel_\d+_joint"/g)?.length).toBe(16);
    // No joint state and no transform tells of a wheel: every one is kept out of the articulation, with its drive.
    expect(usda.match(/bool physics:excludeFromArticulation = 1/g)?.length).toBe(16);
    expect(usda.match(/float drive:angular:physics:maxForce = 0.325/g)?.length).toBe(16);
    expect(usda).toContain('def PhysicsFixedJoint "Track_left_joint"');
    expect(usda).toContain('uint physxScene:timeStepsPerSecond = 120');
    // cmd_vel becomes a speed for each side, in degrees a second, written to each wheel's joint; the articulation has nothing to be told.
    expect(usda).toContain('DifferentialController');
    expect(usda).not.toContain('IsaacArticulationController');
    // Nor a joint of its own to tell of: no joint states are published, as in the other exports.
    expect(usda).not.toContain('ROS2PublishJointState');
    expect(usda).toContain('ROS2PublishTransformTree');
    expect(usda.match(/token node:type = "omni.graph.nodes.WritePrimAttribute"/g)?.length).toBe(16);
    expect(usda.match(/custom token inputs:name = "drive:angular:physics:targetVelocity"/g)?.length).toBe(16);
    for (const side of ['left', 'right']) {
      expect(usda.match(new RegExp(`custom rel inputs:prim = </World/Reference_tracked_rover/Joints/Track_${side}_wheel_\\d+_joint>`, 'g'))?.length).toBe(8);
      expect(usda).toContain(`def OmniGraphNode "${side}_degrees"`);
    }
    // The wheels overlap along the row: one group keeps them from one another and from the robot's links.
    const groups = usda.slice(usda.indexOf('def Scope "CollisionGroups"'), usda.indexOf('def Scope "Joints"'));
    expect(groups.match(/Track_\w+_wheel_\d+>/g)?.length).toBe(16);
    expect(groups).toContain('rel physics:filteredGroups = [</World/Reference_tracked_rover/CollisionGroups/stand_ins>, </World/Reference_tracked_rover/CollisionGroups/links>]');
    expect(groups).toContain('</World/Reference_tracked_rover/Body>');
    expect(pkg.warnings).toEqual([]);
    // A rover on plain wheels has no such groups, and its controller commands the articulation.
    const wheeled = ROBOTS.find((r) => r.file === 'rover')!.make();
    const plain = text(buildIsaacStage(wheeled, geometryOf(wheeled).geometry), '.usda');
    expect(plain).not.toContain('CollisionGroups');
    expect(plain).not.toContain('WritePrimAttribute');
    expect(plain).toContain('IsaacArticulationController');
    expect(plain).toContain('ROS2PublishJointState');
  });

  it("a track's wheels are never lighter at the rim than four times what they carry, whatever the motor", () => {
    const doc = trackedRover();
    const { geometry } = geometryOf(doc);
    const armatures = (robot: Doc['robot']) => [...text(buildMjcfModel(doc, geometry, robot), '.xml').matchAll(/wheel_\d+_joint" type="hinge"[^>]*?(?: armature="([-0-9.e]+)")?\/>/g)].map((m) => Number(m[1] ?? 0));
    const withMotor = (patch: Record<string, unknown>) => ({ ...doc.robot!, joints: doc.robot!.joints.map((j) => ({ ...j, ...patch })) }) as Doc['robot'];
    // The rover's mass over its sixteen wheels, at the wheels' rim.
    const xml = text(buildMjcfModel(doc, geometry), '.xml');
    const mass = [...xml.matchAll(/mass="([-0-9.e]+)"/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    const least = RIM_SHARE * (mass / 16) * 0.0354 ** 2;
    expect(least).toBeGreaterThan(2e-4);
    expect(least).toBeLessThan(5e-4);
    // A motor from the list with a heavier rotor keeps its own; one with a lighter rotor, and figures typed by hand, get the least.
    expect(armatures(doc.robot)).toEqual(Array(16).fill(0.0005));
    for (const patch of [{ motor: 'tt-48' }, { motor: undefined }]) {
      const got = armatures(withMotor(patch));
      expect(got.length).toBe(16);
      for (const a of got) expect(a).toBeCloseTo(least, 6);
    }
  });

  it('a raised nose has wheels up its slope', () => {
    const doc = trackedRover({ sprocketRise: 40 });
    const { geometry, props } = geometryOf(doc);
    expect(checkRobot(doc, props)).toEqual([]);
    const pkg = buildMjcfModel(doc, geometry);
    const xml = text(pkg, '.xml');
    // Each wheel's place in its track: the first is on the sprocket's axle, 40 mm above the ones on the floor.
    const at = [...xml.matchAll(/<body name="Track_right_wheel_\d+" pos="([^"]+)"/g)].map((m) => m[1].split(' ').map(Number));
    expect(at.length).toBeGreaterThan(8);
    expect(at[0][2]).toBeCloseTo(0, 6);
    expect(Math.min(...at.map((p) => p[2]))).toBeCloseTo(-0.04, 6);
    expect(at.filter((p) => p[2] > -0.04 + 1e-6).length).toBeGreaterThanOrEqual(3);
  });
});
