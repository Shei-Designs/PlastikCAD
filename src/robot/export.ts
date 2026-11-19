// Puts a robot together for a simulator: as a ROS 2 package (URDF with
// Gazebo blocks, meshes, launch files, bridge and controller settings) or as
// a Gazebo model (SDF, which keeps loops). Pure: the kernel's answers come
// in, files go out.
import { plural, tr } from '../i18n';
import type { MeshData } from '../geometry/mesh';
import { apply, boundsCenter, boundsSize, eulerOf, multiply, ownOrigin, rotation, unionBounds } from '../model/math';
import type { Mat } from '../model/math';
import type { Doc, SceneNode, Vec3 } from '../model/types';
import { encodeText } from '../io/format';
import { driveXml, jointStateXml, PIN, positionXml, rollerXml, sensorTopic, sensorXml, weldXml, worldXml } from '../io/gazebo';
import type { GazeboDrive } from '../io/gazebo';
import type { BridgeTopic } from '../io/rosPackage';
import type { GazeboSensor } from '../io/gazebo';
import { writeObj } from '../io/obj';
import { bridgeYaml, cmakeLists, controllersYaml, displayLaunch, gazeboLaunch, packageXml, readme, rvizConfig, SHARE_PLACEHOLDER } from '../io/rosPackage';
import { drivable, MJCF_NAMES, writeMjcf } from '../io/mjcf';
import type { MjcfBody, MjcfModel } from '../io/mjcf';
import { modelConfig, SDF_NAMES, writeSdf } from '../io/sdf';
import type { SdfJoint, SdfLink } from '../io/sdf';
import { writeStl } from '../io/stl';
import { quatOfMatrix, robotPrim, USD_NAMES, writeUsda } from '../io/usd';
import type { UsdCollision, UsdJoint, UsdModel } from '../io/usd';
import { NameSet, uniqueNames, URDF_NAMES, urdfName, writeUrdf } from '../io/urdf';
import type { Naming, UrdfJoint, UrdfLink, UrdfShape } from '../io/urdf';
import type { LinkGeometry } from '../worker/protocol';
import { inertialOf, toSI } from './inertia';
import { startPose } from './kinematics';
import type { Tensor } from './inertia';
import { followFault, hasMotor, jointInDesign, linkNodes, linkOf, robotForward, robotOf, sensorInDesign, spanningTree } from './model';
import { motorOf } from './motors';
import { drivePy, envPy, trainPy } from '../io/scripts';
import { collisionPrimitive } from './collision';
import { mecanumOf, rollersOf } from './wheels';
import { trackOf, trackWheels } from './tracks';
import type { Track } from './tracks';
import { DRIVE_KINDS, driveJoints, withRole } from './types';
import { APP_NAME } from '../appInfo';
import type { DriveKind, DriveRole, Robot, RobotJoint, World } from './types';
import type { MecanumWheel } from './wheels';
export interface PackageFile {
  /** Path inside the package folder. */
  name: string;
  bytes: Uint8Array;
}

export interface RobotPackage {
  /** The package's name, which is also its folder's. */
  name: string;
  files: PackageFile[];
  warnings: string[];
  /** Those of the warnings that say something was left out of the export: the app tells the user of these. */
  leftOut: string[];
}

const M = 0.001;
const RAD = Math.PI / 180;

/** A mesh moved into a link's frame and into meters. */
function inFrame(mesh: MeshData, frame: Vec3): MeshData {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (mesh.positions[i] - frame[0]) * M;
    positions[i + 1] = (mesh.positions[i + 1] - frame[1]) * M;
    positions[i + 2] = (mesh.positions[i + 2] - frame[2]) * M;
  }
  return { positions, triangles: mesh.triangles };
}

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];

/** The name a robot is exported under, from its design's: a ROS package name, lowercase. */
export const packageName = (designName: string): string => urdfName(designName, 'robot').toLowerCase();

/** The drive measured off the design: joint names by part, and its geometry in meters (the steering reach in radians). Null until every part it needs is filled. */
export interface PreparedDrive {
  kind: DriveKind;
  /** The way the robot faces, read off its wheel labels: a unit vector along ±X or ±Y of the base. */
  forward: Vec3;
  roles: Partial<Record<DriveRole, string[]>>;
  /** The driven wheels' joints, and the steering joints'. */
  wheels: string[];
  steer: string[];
  wheelRadius: number;
  /** Between the left and right wheels. */
  wheelSeparation: number;
  /** Between the front and rear axles. */
  wheelBase?: number;
  /** Between the two steering joints. */
  kingpinWidth?: number;
  steeringLimit?: number;
}

/** What drives what, as drive.json carries it for the scripts and the test drive: the actuators of each role, and the geometry a velocity command needs. */
export interface DriveSpec {
  kind: DriveKind;
  units: string;
  /** The way the robot faces in its base frame: a unit vector along ±X or ±Y. */
  forward: Vec3;
  roles: Partial<Record<DriveRole, string[]>>;
  wheelRadius: number;
  wheelSeparation: number;
  wheelBase?: number;
  kingpinWidth?: number;
  steeringLimit?: number;
}

/** The MuJoCo package, with what the test drive needs to pose the design from the model and name its controls. */
export interface MjcfPackage extends RobotPackage {
  /** Each body's link: the node it is, and where its frame sits in the design, mm. */
  bodies: { body: string; node: string; frame: Vec3 }[];
  /** Each joint's name in the model, and the design joint it is. */
  joints: { name: string; id: string }[];
  drive: DriveSpec | null;
  /** Each lidar's name in the model, the design sensor it is, and how many rays (`<name>_<i>` rangefinders) it casts. */
  lidars: { name: string; id: string; rays: number }[];
  /** Each touch sensor's name in the model and the design sensor it is. */
  touches: { name: string; id: string }[];
}

/** What both outputs share: every link and joint in SI, the meshes written, the sensors, the drive. */
interface Prepared {
  pkg: string;
  robotName: string;
  files: PackageFile[];
  warnings: string[];
  leftOut: string[];
  order: string[];
  /** The names taken in the file so far, and how the writer keys them; a frame added later is drawn against them. */
  names: NameSet;
  naming: Naming;
  linkNames: Map<string, string>;
  jointNames: Map<RobotJoint, string>;
  frames: Map<string, Vec3>;
  links: (UrdfLink & { frame: Vec3; node: SceneNode })[];
  /**
   * How much higher (m) the base stands in the pose the simulation begins in than in the pose it is designed in,
   * for the robot's lowest point to be as far above the floor in both. Zero for a robot that starts as designed.
   */
  lift: number;
  /** Where each link goes in that pose, from where it is designed (by object; mm); null for a robot that starts as designed. */
  posed: Map<string, Mat> | null;
  /** The tree's joints, parents before children. */
  treeJoints: UrdfJoint[];
  /** The joints that close loops: no joint of the tree. Each export closes them its own way. */
  loopJoints: UrdfJoint[];
  sensors: (GazeboSensor & { id: string; link: string; xyz: Vec3; rpy: Vec3; touch: number })[];
  drive: PreparedDrive | null;
  /** The rollers of the mecanum wheels and the wheels that stand in for the tracks' belts: bodies of the export's own, which the robot's lists do not show. */
  rollers: PreparedRoller[];
  /** Joints under ros2_control. */
  controlled: string[];
  /** Those of them a controller sends a torque, not a position. */
  torque: string[];
  /** Joints no motor moves: a loop takes them where they begin, and nothing has to hold them there. */
  passive: string[];
}

/**
 * A mecanum wheel's roller as the files get it: a link on a free hinge to its wheel, its frame parallel to the
 * design's axes like every link's, colliding as a row of balls. Meters, kilograms.
 */
export interface PreparedRoller {
  name: string;
  joint: string;
  /** The wheel link it turns on, and where its middle is in that link's frame. */
  wheel: string;
  at: Vec3;
  axis: Vec3;
  inertial: { mass: number; origin: Vec3; inertia: Tensor };
  /** Each ball's center in the roller's frame, and its radius. */
  balls: { at: Vec3; radius: number }[];
  friction: number;
  /** What a roller's hinge holds still against, N·m: see `ROLLER_BEARING`. Gazebo alone is given it. */
  bearing?: number;
  /** A wheel that stands in for a track's belt collides as a cylinder about its hinge instead: its size, and how it is turned from standing along Z (roll, pitch, yaw). */
  cylinder?: { radius: number; length: number; rpy: Vec3 };
  /** Such a wheel of a track in the drive is turned by the track's motor: its share of the effort (N·m), the speed (rad/s), and what the hinge resists by. */
  driven?: { effort: number; velocity: number; damping: number; friction: number; armature?: number };
}

function prepare(doc: Doc, geometry: Map<string, LinkGeometry>, robot: Robot, meshUri: (path: string) => string, naming: Naming): Prepared {
  const warnings: string[] = [];
  const leftOut: string[] = [];
  /** A warning that something is left out of the export, which the user is told as well. */
  const leaveOut = (text: string): void => {
    warnings.push(text);
    leftOut.push(text);
  };
  const nodes = linkNodes(doc.scene);
  const tree = spanningTree(robot, nodes.map((n) => n.id));
  if (tree.order.length === 0) throw new Error('The robot has no base link.');
  const pkg = packageName(doc.name);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // Every name is drawn from one set, seeded with the names the writer uses itself: links first, then joints, then sensors.
  const names = new NameSet(naming.reserved);
  const linkNames = uniqueNames(tree.order, (id) => urdfName(linkOf(robot, id).name ?? nodeById.get(id)!.name), names, naming.link);
  const allJoints = [...tree.order.slice(1).map((id) => tree.parentJoint.get(id)!), ...tree.loops];
  const jointNames = uniqueNames(allJoints, (j) => urdfName(j.name, 'joint'), names, naming.joint);
  // Each joint as it sits in the design, and where each link's frame is there (mm). The base link's frame is at
  // the base object's own origin, wherever in the design the robot was built: what reads the robot's
  // kinematics takes the base frame for the body, not for a point on the floor.
  const placedJoints = new Map(allJoints.map((j) => [j.id, jointInDesign(j, nodeById.get(j.child)!)]));
  const frames = new Map<string, Vec3>();
  for (const id of tree.order) frames.set(id, id === robot.root ? ownOrigin(nodeById.get(id)!) : placedJoints.get(tree.parentJoint.get(id)!.id)!.origin);

  const files: PackageFile[] = [];
  const links: Prepared['links'] = [];
  const wheels: { id: string; wheel: MecanumWheel }[] = [];
  const tracks: { id: string; track: Track; collides: boolean }[] = [];
  for (const id of tree.order) {
    const node = nodeById.get(id)!;
    const link = linkOf(robot, id, node);
    const name = linkNames.get(id)!;
    const frame = frames.get(id)!;
    const geo = geometry.get(id);
    if (!geo) throw new Error(`The geometry of "${node.name}" is missing.`);
    const visual: UrdfLink['visual'] = [];
    const collision: UrdfShape[] = [];
    if (geo.visual.length) {
      const objects = [{ name, parts: geo.visual.map((p) => ({ color: p.color, mesh: inFrame(p.mesh, frame) })) }];
      const written = writeObj(objects, name, 'meters');
      files.push({ name: `meshes/visual/${name}.obj`, bytes: written.obj });
      if (written.mtl) files.push({ name: `meshes/visual/${written.mtlName}`, bytes: written.mtl });
      visual.push({ geometry: { mesh: meshUri(`meshes/visual/${name}.obj`) }, color: rgb(geo.visual[0].color) });
    }
    // A mecanum wheel meets the floor by its rollers, which follow below, and has no shape of its own to collide as.
    const mecanum = link.collision === 'none' ? null : mecanumOf(node);
    const wheel = mecanum && typeof mecanum !== 'string' ? mecanum : null;
    // A track meets the floor by the wheels that stand in for its belt, which follow below.
    const found = wheel ? null : trackOf(node);
    const track = found && typeof found !== 'string' ? found : null;
    if (wheel) {
      wheels.push({ id, wheel });
    } else if (track) {
      tracks.push({ id, track, collides: link.collision !== 'none' });
    } else if (link.collision === 'box' || link.collision === 'cylinder' || link.collision === 'sphere') {
      // The primitive fitted to the object, where it stands and turned as it is (URDF's roll, pitch, yaw are the design's X, Y, Z turns).
      const fitted = collisionPrimitive(node, link);
      const origin = fitted.at.map((x, i) => (x - frame[i]) * M) as Vec3;
      const rpy = fitted.rot.map((d) => d * RAD) as Vec3;
      const s = fitted.shape;
      const geometryOf = 'box' in s ? { box: s.box.map((x) => x * M) as Vec3 } : 'cylinder' in s ? { cylinder: { radius: s.cylinder.radius * M, length: s.cylinder.length * M } } : { sphere: { radius: s.sphere.radius * M } };
      collision.push({ geometry: geometryOf, origin, rpy });
    } else if (link.collision !== 'none' && geo.collision) {
      // One file for each convex piece: a simulator takes a mesh as its hull, which would close the space between them.
      (geo.hulls ?? [geo.collision]).forEach((mesh, i) => {
        const file = `meshes/collision/${name}${i ? `_${i + 1}` : ''}.stl`;
        files.push({ name: file, bytes: writeStl(inFrame(mesh, frame), name, 'm') });
        collision.push({ geometry: { mesh: meshUri(file) } });
      });
    }
    const figures = inertialOf(link.mass, node, geo.props);
    let inertial: UrdfLink['inertial'] = null;
    // A shape with no volume has no inertia of its own to give; one typed for it stands in.
    if (figures.mass > 0 && (geo.props.volume > 0 || figures.typed.inertia)) {
      inertial = { mass: figures.mass / 1000, origin: figures.center.map((x, i) => (x - frame[i]) * M) as Vec3, inertia: figures.inertia.map(toSI) as Tensor };
    } else {
      warnings.push(`"${node.name}" has no mass or volume; it was written without inertia, which a simulator may reject.`);
    }
    if (!geo.props.watertight && !(figures.typed.center && figures.typed.inertia)) warnings.push(`"${node.name}" is not a closed mesh; its inertia is an estimate.`);
    links.push({ name, inertial, visual, collision, friction: link.friction, frame, node });
  }

  // The rollers, named after their wheels once every link has its name. They weigh what rubber ones would, and no
  // more between them than half their wheel, whose own mass and inertia are lessened by as much: the wheel's mesh
  // was weighed rollers and all.
  const rollers: PreparedRoller[] = [];
  // What each mecanum wheel carries, N: the robot's weight shared among them.
  const load = (links.reduce((sum, l) => sum + (l.inertial?.mass ?? 0), 0) * 9.81) / Math.max(1, wheels.length);
  for (const { id, wheel } of wheels) {
    const l = links.find((o) => o.node.id === id)!;
    const made = rollersOf(wheel);
    const whole = l.inertial ? l.inertial.mass * 1000 : Infinity;
    const share = Math.min(1, (0.5 * whole) / made.reduce((sum, r) => sum + r.mass, 0));
    if (l.inertial) {
      const left = 1 - made.reduce((sum, r) => sum + r.mass * share, 0) / whole;
      l.inertial = { mass: l.inertial.mass * left, origin: l.inertial.origin, inertia: l.inertial.inertia.map((x) => x * left) as Tensor };
    }
    made.forEach((r, i) => {
      const rname = names.take(`${l.name}_roller_${i + 1}`, naming.link);
      const [ax, ay, az] = r.axis;
      const [along, across] = [toSI(r.inertia.along * share), toSI(r.inertia.across * share)];
      const d = along - across;
      rollers.push({
        name: rname,
        joint: names.take(`${rname}_joint`, naming.joint),
        wheel: l.name,
        at: r.center.map((x, k) => (x - l.frame[k]) * M) as Vec3,
        axis: r.axis,
        inertial: { mass: (r.mass * share) / 1000, origin: [0, 0, 0], inertia: [across + d * ax * ax, across + d * ay * ay, across + d * az * az, d * ax * ay, d * ax * az, d * ay * az] },
        balls: r.balls.map((b) => ({ at: b.at.map((x) => x * M) as Vec3, radius: b.radius * M })),
        friction: l.friction ?? 1,
        bearing: ROLLER_BEARING * load * Math.max(...r.balls.map((b) => b.radius)) * M,
      });
    });
  }

  // A drive wheel rolls forward on a positive command: its axis is written the way round that a positive
  // turn moves the base the way the robot faces, which its wheel labels tell. (A turn about `axis` moves
  // the base along (axis.y, -axis.x, 0).)
  const forward = robotForward(robot, nodeById);
  const forwardAxis = (j: RobotJoint, axis: Vec3): Vec3 => {
    const role = robot.drive?.roles[j.id];
    return role && !role.startsWith('steer') && axis[1] * forward[0] - axis[0] * forward[1] < 0 ? (axis.map((x) => -x) as Vec3) : axis;
  };
  // A track's belt is stood in for by a row of wheels on hinges to the track, which is itself held still against
  // the link it hangs from: the joint that carries a track with a part in the drive is the track's motor, written
  // fixed, and the wheels are what it turns, each with its share of the motor's effort. A track with no part in
  // the drive keeps its joint, and its wheels turn free. The wheels weigh half the track between them, and the
  // track's own mass and inertia are lessened by as much: its mesh was weighed wheels and all. The belt ties every
  // wheel to the motor, so each carries the whole of its rotor's inertia: a wheel as light as these alone would
  // slip where a geared motor's does not, and the track would hardly turn the robot on the spot. Nor is it ever
  // less than `RIM_SHARE` says, whatever the motor: a joint with figures typed by hand names no rotor at all.
  const trackMotors = new Map<string, { joints: string[]; radius: number; middle: Vec3 }>();
  const motorOfTrack = (id: string) => {
    const carrier = tree.parentJoint.get(id);
    const role = carrier && robot.drive?.roles[carrier.id];
    return carrier && role && !role.startsWith('steer') ? carrier : undefined;
  };
  const rows = tracks.map((t) => ({ ...t, made: trackWheels(t.track), motor: motorOfTrack(t.id) }));
  // What each driven wheel carries of the robot, kg: its whole mass over every wheel its tracks' motors turn.
  const carried = links.reduce((sum, l) => sum + (l.inertial?.mass ?? 0), 0) / Math.max(1, rows.reduce((n, t) => n + (t.motor ? t.made.centers.length : 0), 0));
  for (const { id, collides, made, motor } of rows) {
    const l = links.find((o) => o.node.id === id)!;
    // A positive turn of a driven wheel moves the base the way the robot faces, like any wheel of the drive.
    const axis = motor && made.axis[1] * forward[0] - made.axis[0] * forward[1] < 0 ? (made.axis.map((x) => -x) as Vec3) : made.axis;
    const [ax, ay, az] = axis;
    const n = made.centers.length;
    const each = l.inertial ? (0.5 * l.inertial.mass * 1000) / n : 1;
    if (l.inertial) l.inertial = { mass: l.inertial.mass / 2, origin: l.inertial.origin, inertia: l.inertial.inertia.map((x) => x / 2) as Tensor };
    const [along, across] = [toSI(0.5 * each * made.radius ** 2), toSI((each * (3 * made.radius ** 2 + made.length ** 2)) / 12)];
    const d = along - across;
    // A cylinder stands along Z until it is turned: Z onto the axle.
    const seed: Vec3 = Math.abs(az) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const side: Vec3 = [seed[1] * az - seed[2] * ay, seed[2] * ax - seed[0] * az, seed[0] * ay - seed[1] * ax];
    const sn = Math.hypot(...side) || 1;
    const x = side.map((v) => v / sn) as Vec3;
    const y: Vec3 = [ay * x[2] - az * x[1], az * x[0] - ax * x[2], ax * x[1] - ay * x[0]];
    const rpy = eulerOf([...x, ...y, ...axis, 0, 0, 0]).map((deg) => deg * RAD) as Vec3;
    const joints: string[] = [];
    made.centers.forEach((c, i) => {
      const wname = names.take(`${l.name}_wheel_${i + 1}`, naming.link);
      const joint = names.take(`${wname}_joint`, naming.joint);
      joints.push(joint);
      rollers.push({
        name: wname,
        joint,
        wheel: l.name,
        at: c.map((v, k) => (v - l.frame[k]) * M) as Vec3,
        axis,
        inertial: { mass: each / 1000, origin: [0, 0, 0], inertia: [across + d * ax * ax, across + d * ay * ay, across + d * az * az, d * ax * ay, d * ax * az, d * ay * az] },
        balls: [],
        friction: l.friction ?? 1,
        ...(collides ? { cylinder: { radius: made.radius * M, length: made.length * M, rpy } } : {}),
        ...(motor ? { driven: { effort: motor.effort / n, velocity: motor.velocity * RAD, damping: motor.damping / n, friction: motor.friction / n, armature: Math.max(motorOf(motor.motor)?.armature ?? 0, RIM_SHARE * carried * (made.radius * M) ** 2) } } : {}),
      });
    });
    if (motor) trackMotors.set(motor.id, { joints, radius: made.radius, middle: made.middle });
  }

  // The pose a simulation begins in, where a joint has a start: every joint's value in it, and how far the
  // robot's lowest point moves, which the base is raised or lowered by so that it stands on the floor as designed.
  const begun = startPose(robot, doc.scene);
  let lift = 0;
  if (begun) {
    const lowest = (posed?: Map<string, Mat>): number => {
      let low = Infinity;
      for (const id of tree.order) {
        const to = posed?.get(id);
        const geo = geometry.get(id);
        if (!geo) continue;
        // The shape as it looks; for a model built without its looks (the test drive's), what it collides as, or its box.
        const { min, max } = geo.bounds;
        const corners = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7].flatMap((k) => [k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]]));
        const shapes = geo.visual.length ? geo.visual.map((part) => part.mesh.positions) : [geo.collision?.positions ?? corners];
        for (const at of shapes) for (let i = 0; i < at.length; i += 3) low = Math.min(low, to ? apply(to, [at[i], at[i + 1], at[i + 2]])[2] : at[i + 2]);
      }
      return low;
    };
    const [designed, started] = [lowest(), lowest(begun.frames)];
    // A base bolted to the world stays where it is.
    if (robot.base !== 'fixed' && Number.isFinite(designed) && Number.isFinite(started)) lift = (designed - started) * M;
  }
  const jointOf = (j: RobotJoint): UrdfJoint => {
    const parentFrame = frames.get(j.parent)!;
    const placed = placedJoints.get(j.id)!;
    const scale = j.type === 'prismatic' ? M : RAD;
    // The joint that is a track's motor holds the track still: the wheels it turns are the export's own.
    if (trackMotors.has(j.id)) {
      return { name: jointNames.get(j)!, type: 'fixed', parent: linkNames.get(j.parent)!, child: linkNames.get(j.child)!, origin: placed.origin.map((x, i) => (x - parentFrame[i]) * M) as Vec3, axis: placed.axis, preserve: true };
    }
    const axis = forwardAxis(j, placed.axis);
    // Measured about the axis as it is written: the other way round for a wheel whose axis was turned.
    const start = j.type === 'fixed' ? 0 : (begun?.values.get(j.id) ?? 0) * scale * (axis === placed.axis ? 1 : -1);
    // A follower is written only against a leader the file holds and that moves; the checks stop anything else.
    const leader = j.mimic && j.type !== 'fixed' ? allJoints.find((o) => o.id === j.mimic!.joint) : undefined;
    // The multiplier is follower units per leader unit: mm per degree, for a rack on a pinion, becomes meters per radian.
    const mimic = leader && !followFault(robot, tree, j, leader) ? { joint: jointNames.get(leader)!, multiplier: (j.mimic!.multiplier * scale) / (leader.type === 'prismatic' ? M : RAD), offset: j.mimic!.offset * scale } : undefined;
    return {
      name: jointNames.get(j)!,
      type: j.type,
      parent: linkNames.get(j.parent)!,
      child: linkNames.get(j.child)!,
      origin: placed.origin.map((x, i) => (x - parentFrame[i]) * M) as Vec3,
      axis,
      limit: j.type === 'fixed' ? undefined : { lower: j.lower * scale, upper: j.upper * scale, effort: j.effort, velocity: j.velocity * scale },
      dynamics: j.type === 'fixed' ? undefined : { damping: j.damping, friction: j.friction },
      armature: motorOf(j.motor)?.armature,
      ...(mimic ? { mimic } : {}),
      ...(start ? { start } : {}),
    };
  };
  const treeJoints = tree.order.slice(1).map((id) => jointOf(tree.parentJoint.get(id)!));
  const loopJoints = tree.loops.map(jointOf);

  // Sensors: each in its link, placed from the link's frame, its turn as the design has it (the link frames are parallel to the design's axes).
  const placedSensors = robot.sensors.filter((x) => nodeById.has(x.link) && frames.has(x.link));
  const sensorNames = uniqueNames(placedSensors, (x) => urdfName(x.name, 'sensor'), names, (name, x) => naming.sensor(name, x.kind, Math.min(x.lidar.samples, MAX_LIDAR_RAYS)));
  const sensors: Prepared['sensors'] = placedSensors.map((x) => {
      const node = nodeById.get(x.link)!;
      const placed = sensorInDesign(x, node);
      const frame = frames.get(x.link)!;
      const rpy = eulerOf(multiply(rotation(node.rot), rotation(x.rot))).map((d) => d * RAD) as Vec3;
      const name = sensorNames.get(x)!;
      return {
        id: x.id,
        name,
        // The link it sits in; a URDF gives it a frame of its own instead.
        frame: linkNames.get(x.link)!,
        kind: x.kind,
        rate: x.rate,
        camera: { hfov: x.camera.hfov * RAD, width: x.camera.width, height: x.camera.height, near: x.camera.near * M, far: x.camera.far * M },
        lidar: { samples: x.lidar.samples, hfov: x.lidar.hfov * RAD, min: x.lidar.min * M, max: x.lidar.max * M },
        link: linkNames.get(x.link)!,
        xyz: placed.origin.map((v, i) => (v - frame[i]) * M) as Vec3,
        rpy,
        // A touch sensor feels contacts within half the link's diagonal of where it sits: the whole of the face it is set on,
        // whose corners are where a box meets the floor. (Gazebo's contact sensor covers the whole link.)
        touch: (geometry.get(x.link) ? Math.hypot(...boundsSize(geometry.get(x.link)!.bounds)) / 2 : 5) * M,
        collision: `${linkNames.get(x.link)!}_collision`,
      };
  });

  // The drive: each part's joints by name, the wheels' radius from their boxes, the track and wheelbase from where the joints sit.
  let drive: PreparedDrive | null = null;
  const def = robot.drive && DRIVE_KINDS.find((k) => k.id === robot.drive!.kind);
  if (def) {
    const named = (role: DriveRole) => withRole(robot.drive, role).map((id) => allJoints.find((j) => j.id === id)).filter((j): j is RobotJoint => Boolean(j));
    const parts = Object.fromEntries(def.roles.map((r) => [r.id, named(r.id)])) as Record<DriveRole, RobotJoint[]>;
    const has = (role: DriveRole, n?: number) => (n === undefined ? parts[role].length > 0 : parts[role].length === n);
    const complete =
      def.id === 'differential' ? has('left') && has('right') : def.id === 'ackermann' ? has('left') && has('right') && has('steer-left', 1) && has('steer-right', 1) : (['front-left', 'front-right', 'rear-left', 'rear-right'] as const).every((r) => has(r, 1));
    if (complete) {
      // A track is where the middle of its row of wheels is, and as large as one of them.
      const at = (j: RobotJoint): Vec3 => trackMotors.get(j.id)?.middle ?? placedJoints.get(j.id)!.origin;
      const mean = (js: RobotJoint[]): Vec3 => js.reduce((acc, j) => acc.map((v, i) => v + at(j)[i] / js.length) as Vec3, [0, 0, 0] as Vec3);
      const apart = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * M;
      const wheelJoints = def.roles.filter((r) => !r.id.startsWith('steer')).flatMap((r) => parts[r.id]);
      const steerJoints = def.roles.filter((r) => r.id.startsWith('steer')).flatMap((r) => parts[r.id]);
      const radii = wheelJoints.map((j) => {
        const track = trackMotors.get(j.id);
        if (track) return track.radius;
        const geo = geometry.get(j.child);
        const axis = placedJoints.get(j.id)!.axis;
        if (!geo) return 0;
        const size = boundsSize(geo.bounds);
        const axle = axis.map(Math.abs).indexOf(Math.max(...axis.map(Math.abs)));
        return Math.max(...size.filter((_, i) => i !== axle)) / 2;
      });
      const names = (js: RobotJoint[]) => js.flatMap((j) => trackMotors.get(j.id)?.joints ?? [jointNames.get(j)!]);
      const base = { kind: def.id, forward, roles: Object.fromEntries(def.roles.map((r) => [r.id, names(parts[r.id])])), wheels: names(wheelJoints), steer: names(steerJoints), wheelRadius: (radii.reduce((a, b) => a + b, 0) / radii.length) * M };
      if (def.id === 'mecanum') {
        const [fl, fr, rl, rr] = [parts['front-left'][0], parts['front-right'][0], parts['rear-left'][0], parts['rear-right'][0]];
        drive = { ...base, wheelSeparation: (apart(at(fl), at(fr)) + apart(at(rl), at(rr))) / 2, wheelBase: (apart(at(fl), at(rl)) + apart(at(fr), at(rr))) / 2 };
      } else {
        drive = { ...base, wheelSeparation: apart(mean(parts.left), mean(parts.right)) };
        // A differential drive with more than one wheel on a side turns by sliding them sideways. Gazebo's
        // friction would hold such a rover that is longer than it is wide square to the world, however hard the
        // wheels turned, so each wheel's friction is laid along its own diagonals (see `surfaceXml`): halfway
        // between the axle and the way the wheel rolls, level, in the frame of the link the wheel hangs from, which
        // does not turn with it. A track's wheels, many in a row, turn as they should without.
        if (def.id === 'differential' && Math.max(parts.left.length, parts.right.length) > 1) {
          for (const j of [...parts.left, ...parts.right]) {
            const [x, y] = placedJoints.get(j.id)!.axis;
            const link = links.find((l) => l.node.id === j.child);
            if (link && !trackMotors.has(j.id) && Math.hypot(x, y) > 0.5) link.skid = { frame: linkNames.get(j.parent)!, along: [x + y, y - x, 0] };
          }
        }
        if (def.id === 'ackermann') {
          const [sl, sr] = [parts['steer-left'][0], parts['steer-right'][0]];
          drive.kingpinWidth = apart(at(sl), at(sr));
          drive.wheelBase = apart(mean([...parts.left, ...parts.right]), mean([sl, sr]));
          drive.steeringLimit = (Math.min(...[sl, sr].map((j) => Math.min(Math.abs(j.lower), Math.abs(j.upper)))) * Math.PI) / 180;
        }
      }
    } else {
      // A drive short of a part is not written; the usual cause is a wheel no joint reaches from the base.
      const lost = driveJoints(robot.drive).map((id) => robot.joints.find((j) => j.id === id)).filter((j): j is RobotJoint => Boolean(j) && !allJoints.includes(j!));
      leaveOut(
        lost.length
          ? plural(lost.length, 'Drive: {names} is not joined to the base, so the drive is left out. Join every wheel to the base.', 'Drive: {names} are not joined to the base, so the drive is left out. Join every wheel to the base.', { names: lost.map((j) => j.name).join(', ') })
          : tr('Drive: a wheel or steering joint is missing, so the drive is left out. Give every part of the drive its joint.'),
      );
    }
  }
  // A wheel that slides sideways as the robot turns (see `skid`) has a rim no lighter than `RIM_SHARE` says, as a
  // track's wheels have, whatever its motor. Against a lighter one a simulator's friction pushes the wrong way,
  // more across the wheel than against its slip, since the wheel gives way so easily the way it rolls. A rover
  // 200 mm by 400 mm, where plain friction gives 20 % of the turn asked: Isaac Sim turned it 9 % and walked it off
  // to one side, and turns it 19.5 % about its middle with the rim; MuJoCo turned it 12 %, and 17 % with it.
  const skidding = new Set(links.filter((l) => l.skid).map((l) => l.name));
  if (drive && skidding.size) {
    const rim = RIM_SHARE * (links.reduce((m, l) => m + (l.inertial?.mass ?? 0), 0) / skidding.size) * drive.wheelRadius ** 2;
    for (const j of treeJoints) if (skidding.has(j.child)) j.armature = Math.max(j.armature ?? 0, rim);
  }
  const driven = new Set(driveJoints(robot.drive));
  const controlled = robot.control ? tree.order.slice(1).map((id) => tree.parentJoint.get(id)!).filter((j) => hasMotor(j) && !driven.has(j.id)).map((j) => jointNames.get(j)!) : [];

  const torque = controlled.filter((name) => allJoints.find((j) => jointNames.get(j) === name)?.command === 'torque');
  const passive = allJoints.filter((j) => j.passive).map((j) => jointNames.get(j)!);

  return { pkg, robotName: urdfName(doc.name, 'robot'), files, warnings, leftOut, order: tree.order, names, naming, linkNames, jointNames, frames, links, lift, posed: begun?.frames ?? null, treeJoints, loopJoints, sensors, drive, rollers, controlled, torque, passive };
}

/**
 * ROS expects a robot's base frame to face +X. A driven robot gets a root frame that does,
 * `base_footprint`, on the floor under the base link, which keeps the design's axes and is turned by `turn`
 * radians about Z in it. Nothing for an arm bolted down, or a robot without wheels to say.
 */
function footprintOf(p: Prepared, robot: Robot, lift = 0): { name: string; joint: string; base: string; turn: number; height: number } | undefined {
  if (!p.drive || robot.base === 'fixed') return undefined;
  // The frame and the joint that holds the base under it are named clear of everything the robot has.
  const name = p.names.take('base_footprint', (n) => [...p.naming.link(n), ...p.naming.joint(`${n}_joint`)]);
  const [fx, fy] = p.drive.forward;
  // On the floor under the base link's frame, as high as that stands in the pose the simulation begins in (`lift`).
  return { name, joint: `${name}_joint`, base: p.linkNames.get(robot.root!)!, turn: -Math.atan2(fy, fx) || 0, height: p.frames.get(robot.root!)![2] * M + lift };
}

/** The prepared drive as the Gazebo plugin wants it. */
function gazeboDrive(d: PreparedDrive, baseFrame: string): GazeboDrive {
  const shared = { baseFrame, wheelRadius: d.wheelRadius, wheelSeparation: d.wheelSeparation };
  if (d.kind === 'mecanum') return { ...shared, kind: 'mecanum', frontLeft: d.roles['front-left']![0], frontRight: d.roles['front-right']![0], rearLeft: d.roles['rear-left']![0], rearRight: d.roles['rear-right']![0], wheelBase: d.wheelBase! };
  if (d.kind === 'ackermann') return { ...shared, kind: 'ackermann', leftJoints: d.roles.left!, rightJoints: d.roles.right!, leftSteer: d.roles['steer-left']![0], rightSteer: d.roles['steer-right']![0], wheelBase: d.wheelBase!, kingpinWidth: d.kingpinWidth!, steeringLimit: d.steeringLimit! };
  return { ...shared, kind: 'differential', leftJoints: d.roles.left!, rightJoints: d.roles.right! };
}

/**
 * The Gazebo sensor topics a ROS 2 bridge carries across, and the robot's own. A camera's pictures
 * and its calibration are stamped with its optical frame (`optical`, by sensor name), as ROS reads
 * them; a depth camera's cloud keeps the sensor's own frame, which is the one Gazebo's points are in.
 */
function bridgeTopics(p: Prepared, optical: Map<string, string>): BridgeTopic[] {
  const out: BridgeTopic[] = [
    { ros: '/clock', gz: '/clock', rosType: 'rosgraph_msgs/msg/Clock', gzType: 'gz.msgs.Clock', direction: 'GZ_TO_ROS' },
    { ros: '/joint_states', gz: '/joint_states', rosType: 'sensor_msgs/msg/JointState', gzType: 'gz.msgs.Model', direction: 'GZ_TO_ROS' },
  ];
  if (p.drive) {
    out.push(
      { ros: '/cmd_vel', gz: '/cmd_vel', rosType: 'geometry_msgs/msg/Twist', gzType: 'gz.msgs.Twist', direction: 'ROS_TO_GZ' },
      { ros: '/odom', gz: '/odom', rosType: 'nav_msgs/msg/Odometry', gzType: 'gz.msgs.Odometry', direction: 'GZ_TO_ROS' },
      { ros: '/tf', gz: '/tf', rosType: 'tf2_msgs/msg/TFMessage', gzType: 'gz.msgs.Pose_V', direction: 'GZ_TO_ROS' },
    );
  }
  for (const s of p.sensors) {
    const topic = `/${sensorTopic(s)}`;
    if (s.kind === 'camera' || s.kind === 'depth') {
      const frame = optical.get(s.name);
      out.push({ ros: topic, gz: topic, rosType: 'sensor_msgs/msg/Image', gzType: 'gz.msgs.Image', direction: 'GZ_TO_ROS', frame });
      out.push({ ros: `/${s.name}/camera_info`, gz: `/${s.name}/camera_info`, rosType: 'sensor_msgs/msg/CameraInfo', gzType: 'gz.msgs.CameraInfo', direction: 'GZ_TO_ROS', frame });
      if (s.kind === 'depth') out.push({ ros: `${topic}/points`, gz: `${topic}/points`, rosType: 'sensor_msgs/msg/PointCloud2', gzType: 'gz.msgs.PointCloudPacked', direction: 'GZ_TO_ROS' });
    } else if (s.kind === 'lidar') {
      out.push({ ros: topic, gz: topic, rosType: 'sensor_msgs/msg/LaserScan', gzType: 'gz.msgs.LaserScan', direction: 'GZ_TO_ROS' });
      out.push({ ros: `${topic}/points`, gz: `${topic}/points`, rosType: 'sensor_msgs/msg/PointCloud2', gzType: 'gz.msgs.PointCloudPacked', direction: 'GZ_TO_ROS' });
    } else if (s.kind === 'touch') {
      out.push({ ros: topic, gz: topic, rosType: 'ros_gz_interfaces/msg/Contacts', gzType: 'gz.msgs.Contacts', direction: 'GZ_TO_ROS' });
    } else {
      out.push({ ros: topic, gz: topic, rosType: 'sensor_msgs/msg/Imu', gzType: 'gz.msgs.IMU', direction: 'GZ_TO_ROS' });
    }
  }
  return out;
}

const OPTICAL: Vec3 = [-Math.PI / 2, 0, -Math.PI / 2];

/**
 * The names of the tree joints that lie on a loop: those between each end of a closing joint and where the two
 * ways up to the base meet. Where a simulator closes the loop for real, the loop moves them and they follow nothing.
 */
function jointsOnLoops(p: Pick<Prepared, 'treeJoints' | 'loopJoints'>): Set<string> {
  const onLoop = new Set<string>();
  const parentOf = new Map(p.treeJoints.map((j) => [j.child, j]));
  for (const loop of p.loopJoints) {
    const up = (link: string): string[] => {
      const path: string[] = [];
      for (let j = parentOf.get(link); j; j = parentOf.get(j.parent)) path.push(j.name);
      return path;
    };
    const a = up(loop.parent);
    const b = up(loop.child);
    for (const name of [...a.filter((n) => !b.includes(n)), ...b.filter((n) => !a.includes(n))]) onLoop.add(name);
  }
  return onLoop;
}

/**
 * The robot as a ROS 2 package: every link's frame is parallel to the
 * design's axes, so no file carries a rotation but the sensors' frames: the
 * base link's frame is at the base object's own origin and each other link's sits at the
 * joint that carries it, with the link's meshes written in that frame.
 * `geometry` is what the kernel made of each link, by node id.
 */
export function buildRobotPackage(doc: Doc, geometry: Map<string, LinkGeometry>, robot: Robot = robotOf(doc)): RobotPackage {
  const p = prepare(doc, geometry, robot, (path) => `package://${packageName(doc.name)}/${path}`, URDF_NAMES);
  const { pkg, files, warnings } = p;
  // Where the base link's frame is in the design (m): a base fixed to the world stays there.
  const baseAt = p.frames.get(robot.root!)!.map((x) => x * M) as Vec3;
  const fixedToWorld = robot.base === 'fixed' ? { link: p.linkNames.get(robot.root!)!, at: baseAt } : undefined;
  const base = p.linkNames.get(robot.root!)!;
  // The joints begin at their starts where a controller holds them there; without one they begin as designed.
  const lift = p.controlled.length ? p.lift : 0;
  const footprint = footprintOf(p, robot, lift);
  const links: UrdfLink[] = p.links.map(({ frame: _f, node: _n, ...l }) => l);
  const joints: UrdfJoint[] = [...p.treeJoints];
  // A URDF is a tree, and so is a model to Gazebo's physics: the joint that closes a loop carries a pin, a leaf of
  // the tree, where its child would be, and Gazebo welds the pin to that child. Elsewhere the loop stays open.
  const welds: string[] = [];
  for (const j of p.loopJoints) {
    const pin = p.names.take(`${j.name}_pin`, p.naming.link);
    links.push({ name: pin, inertial: { mass: PIN.mass, origin: [0, 0, 0], inertia: PIN.inertia }, visual: [], collision: [] });
    joints.push({ name: j.name, type: j.type, parent: j.parent, child: pin, origin: j.origin, axis: j.axis, limit: j.limit, dynamics: j.dynamics });
    welds.push(weldXml(j.child, pkg, pin));
  }
  // Gazebo closes the loop, so the loop moves the joints on it: Gazebo is not told what they follow, which its
  // physics would refuse. The URDF keeps it, for where the file is read alone.
  const onLoop = jointsOnLoops(p);
  const unfollowed = p.treeJoints.filter((j) => j.mimic && onLoop.has(j.name)).map((j) => j.name);
  // Each sensor is a frame of its own on a fixed joint; a camera also gets the optical frame ROS expects (Z forward, X right).
  // A touch sensor feels a collision, so it sits on the link that has one; Gazebo must then keep that link
  // as one of its own, since a link folded into its parent across a fixed joint has its collision renamed.
  // The base under a footprint cannot be kept so: the footprint has no mass, and Gazebo drops a massless link
  // with all below it unless the base is folded in. There the sensor names the collision as Gazebo renames it.
  const opticalFrames = new Map<string, string>();
  for (const s of p.sensors) {
    if (s.kind === 'touch') {
      const link = links.find((l) => l.name === s.link);
      const folded = footprint && s.link === base ? { collision: `${footprint.name}_fixed_joint_lump__${base}_collision` } : {};
      if (link) link.sensors = [...(link.sensors ?? []), sensorXml({ ...s, ...folded, ...(link.collision.length > 1 ? { collisions: link.collision.length } : {}) })];
      const carrier = joints.find((j) => j.child === s.link);
      if (carrier?.type === 'fixed') carrier.preserve = true;
      continue;
    }
    // The frames are named after the sensor, clear of the robot's own links and joints.
    const frame = p.names.take(`${s.name}_link`, p.naming.link);
    links.push({ name: frame, inertial: null, visual: [], collision: [], sensors: [sensorXml({ ...s, frame })] });
    joints.push({ name: p.names.take(`${s.name}_joint`, p.naming.joint), type: 'fixed', parent: s.link, child: frame, origin: s.xyz, rpy: s.rpy, axis: [0, 0, 1] });
    if (s.kind === 'camera' || s.kind === 'depth') {
      const optical = p.names.take(`${s.name}_optical_frame`, p.naming.link);
      links.push({ name: optical, inertial: null, visual: [], collision: [] });
      opticalFrames.set(s.name, optical);
      joints.push({ name: p.names.take(`${s.name}_optical_joint`, p.naming.joint), type: 'fixed', parent: frame, child: optical, origin: [0, 0, 0], rpy: OPTICAL, axis: [0, 0, 1] });
    }
  }
  // Gazebo folds a link on a fixed joint into the link above, and the base into its footprint, so a skidding
  // wheel's direction is told in the frame of the first link above it that Gazebo keeps. The link frames are
  // parallel, so the direction is the same in each; the footprint's is turned about Z from them.
  for (const l of links) {
    if (!l.skid) continue;
    let frame = l.skid.frame;
    for (let above = joints.find((j) => j.child === frame); above?.type === 'fixed' && !above.preserve; above = joints.find((j) => j.child === frame)) frame = above.parent;
    const [x, y] = l.skid.along;
    const [c, s] = footprint && frame === base ? [Math.cos(footprint.turn), Math.sin(footprint.turn)] : [1, 0];
    l.skid = { frame: footprint && frame === base ? footprint.name : frame, along: [c * x - s * y, s * x + c * y, 0] };
  }
  // The robot's box, for RViz to look at, as the base link's frame has it.
  const extent = unionBounds(p.links.map((l) => geometry.get(l.node.id)!.bounds));
  // A mecanum wheel's rollers are Gazebo's alone: SDF links and joints beside the plugins, which RViz, the robot's
  // state publisher and a real robot never see. The joint states are then those of the robot's own joints.
  const own = p.rollers.length ? joints.filter((j) => j.type !== 'fixed').map((j) => j.name) : undefined;
  // A robot whose every moving joint is the export's own (a rover on two tracks) has no joint states to tell: the publisher,
  // which tells of every joint when it is named none, is left out.
  const plugins = [...(own?.length === 0 ? [] : [jointStateXml('joint_states', own)]), ...p.rollers.map(rollerXml), ...welds, ...(p.drive ? [driveXml(gazeboDrive(p.drive, footprint?.name ?? base))] : [])];
  // A start is a place the joint is put in as Gazebo loads the robot, before the weld that closes a loop is made:
  // the weld would hold the loop as it then stood, pulled out of shape. So the joints on a loop begin as designed,
  // and the launch sends the controller to every start once it runs, no faster than the slowest of them can go.
  const starts = Object.fromEntries(p.treeJoints.filter((j) => j.start && p.controlled.includes(j.name) && !onLoop.has(j.name)).map((j) => [j.name, j.start!]));
  const looped = p.treeJoints.filter((j) => j.start && p.controlled.includes(j.name) && onLoop.has(j.name));
  const startOf = new Map(p.treeJoints.map((j) => [j.name, j.start ?? 0]));
  const goTo = looped.length ? { joints: p.controlled, positions: p.controlled.map((name) => startOf.get(name) ?? 0), seconds: Math.max(1, ...looped.map((j) => Math.abs(j.start!) / (j.limit?.velocity || 1))) } : undefined;
  // Only a controller can hold a joint at its start in Gazebo.
  const loose = p.treeJoints.filter((j) => j.start && !p.controlled.includes(j.name) && !j.mimic && !p.passive.includes(j.name)).map((j) => j.name);
  if (loose.length) warnings.push(`No controller holds ${loose.map((n) => `"${n}"`).join(', ')}, so ${loose.length > 1 ? 'they begin' : 'it begins'} as designed, not at ${loose.length > 1 ? 'their starts' : 'its start'}.`);
  const control = p.controlled.length ? { joints: p.controlled, controllersYaml: `${SHARE_PLACEHOLDER}/config/controllers.yaml`, starts, torque: p.torque } : undefined;
  const controllers = control ? ['joint_state_broadcaster', 'arm_controller'] : [];
  files.unshift(
    { name: 'package.xml', bytes: encodeText(packageXml(pkg, `${doc.name} robot description`, { gazebo: true, control: Boolean(control) })) },
    { name: 'CMakeLists.txt', bytes: encodeText(cmakeLists(pkg)) },
    { name: 'README.md', bytes: encodeText(readme(pkg, doc.name, footprint)) },
    { name: `urdf/${pkg}.urdf`, bytes: encodeText(writeUrdf(p.robotName, links, joints, { plugins, control, fixedToWorld, footprint })) },
    { name: `urdf/${pkg}.urdf.xacro`, bytes: encodeText(writeUrdf(p.robotName, links, joints, { plugins, control, fixedToWorld, footprint, xacro: { package: pkg } })) },
    { name: 'launch/display.launch.py', bytes: encodeText(displayLaunch(pkg)) },
    { name: 'launch/gazebo.launch.py', bytes: encodeText(gazeboLaunch(pkg, { controllers, height: footprint || fixedToWorld ? 0 : baseAt[2] + (goTo ? Math.max(lift, 0) : lift), unfollowed, goTo })) },
    { name: 'rviz/display.rviz', bytes: encodeText(rvizConfig(base, boundsCenter(extent).map((x, i) => x * M - baseAt[i]) as Vec3, Math.max(...boundsSize(extent)) * M)) },
    { name: `worlds/${pkg}.sdf`, bytes: encodeText(worldXml(pkg, undefined, pkg, p.loopJoints.length > 0)) },
    { name: 'config/bridge.yaml', bytes: encodeText(bridgeYaml(bridgeTopics(p, opticalFrames))) },
    ...(control ? [{ name: 'config/controllers.yaml', bytes: encodeText(controllersYaml(p.controlled, p.torque.length > 0)) }] : []),
  );
  return { name: pkg, files, warnings, leftOut: p.leftOut };
}

/**
 * The robot as a Gazebo model folder: model.sdf with every joint, loops
 * included, the meshes, a world that includes it, and a note on running it.
 */
export function buildSdfModel(doc: Doc, geometry: Map<string, LinkGeometry>, robot: Robot = robotOf(doc)): RobotPackage {
  const p = prepare(doc, geometry, robot, (path) => `model://${packageName(doc.name)}/${path}`, SDF_NAMES);
  const { pkg, files, warnings } = p;
  const sensorsByLink = new Map<string, string[]>();
  for (const s of p.sensors) {
    const list = sensorsByLink.get(s.link) ?? [];
    // In SDF the sensor sits in its link at its own pose, and its frame is the link's.
    const pieces = p.links.find((l) => l.name === s.link)?.collision.length ?? 1;
    list.push(sensorXml({ ...s, pose: { xyz: s.xyz, rpy: s.rpy }, ...(pieces > 1 ? { collisions: pieces } : {}) }));
    sensorsByLink.set(s.link, list);
  }
  // Gazebo's own controller holds each joint a ROS controller would, at its start; one commanded by torque is left to whatever sends the torque.
  const held = p.treeJoints.filter((j) => p.controlled.includes(j.name) && !p.torque.includes(j.name));
  const loose = p.treeJoints.filter((j) => j.start && !held.includes(j) && !j.mimic && !p.passive.includes(j.name)).map((j) => j.name);
  if (loose.length) warnings.push(`No controller holds ${loose.map((n) => `"${n}"`).join(', ')}, so ${loose.length > 1 ? 'they begin' : 'it begins'} as designed, not at ${loose.length > 1 ? 'their starts' : 'its start'}.`);
  const links: SdfLink[] = p.links.map(({ frame, node: _n, ...l }) => ({ ...l, pose: frame.map((x) => x * M) as Vec3, sensors: sensorsByLink.get(l.name) }));
  // Loops close for real here, so a joint on a loop does not also follow another.
  const onLoop = jointsOnLoops(p);
  // Gazebo's physics takes the joints as a tree and refuses the one that closes a loop. That joint carries a pin
  // where its child would be, and a weld, which the physics does take, holds the pin to the child.
  const welds: string[] = [];
  const frameOf = (link: string): Vec3 => p.frames.get([...p.linkNames].find(([, n]) => n === link)![0])!;
  const pinned: SdfJoint[] = p.loopJoints.map((j) => {
    const pin = p.names.take(`${j.name}_pin`, p.naming.link);
    links.push({ name: pin, pose: j.origin.map((x, i) => x + frameOf(j.parent)[i] * M) as Vec3, inertial: { mass: PIN.mass, origin: [0, 0, 0], inertia: PIN.inertia }, visual: [], collision: [] });
    welds.push(weldXml(j.child, p.robotName, pin));
    return { name: j.name, type: j.type, parent: j.parent, child: pin, pose: [0, 0, 0], axis: j.axis, limit: j.limit, dynamics: j.dynamics };
  });
  const joints: SdfJoint[] = p.treeJoints.map((j) => {
    const childFrame = p.frames.get([...p.linkNames].find(([, n]) => n === j.child)![0])!;
    const parentFrame = p.frames.get([...p.linkNames].find(([, n]) => n === j.parent)![0])!;
    // The joint in its child's frame: its place in the parent's frame, carried over.
    const pose = j.origin.map((x, i) => x + (parentFrame[i] - childFrame[i]) * M) as Vec3;
    return { name: j.name, type: j.type, parent: j.parent, child: j.child, pose, axis: j.axis, limit: j.limit, dynamics: j.dynamics, ...(j.mimic && !onLoop.has(j.name) ? { mimic: j.mimic } : {}) };
  });
  joints.push(...pinned);
  const base = p.linkNames.get(robot.root!)!;
  const footprint = footprintOf(p, robot);
  const own = p.rollers.length ? joints.filter((j) => j.type !== 'fixed').map((j) => j.name) : undefined;
  const plugins = [...p.rollers.map(rollerXml), ...(own?.length === 0 ? [] : [jointStateXml('joint_states', own)]), ...welds, ...(p.drive ? [driveXml(gazeboDrive(p.drive, footprint?.name ?? base))] : []), ...held.map((j) => positionXml(j.name, j.limit?.velocity ?? 1, j.start ?? 0))];
  files.unshift(
    { name: 'model.config', bytes: encodeText(modelConfig(pkg, `${doc.name}, made with PlastikCAD`)) },
    { name: 'model.sdf', bytes: encodeText(writeSdf(p.robotName, links, joints, plugins, robot.base === 'fixed' ? p.linkNames.get(robot.root!) : undefined, footprint)) },
    { name: `worlds/${pkg}.sdf`, bytes: encodeText(worldXml(pkg, pkg, p.robotName, p.loopJoints.length > 0)) },
    { name: 'README.md', bytes: encodeText(sdfReadme(pkg, doc.name, footprint, held.length ? { model: p.robotName, joint: held[0].name } : undefined)) },
  );
  return { name: pkg, files, warnings, leftOut: p.leftOut };
}

function sdfReadme(name: string, robot: string, footprint: { name: string; base: string } | undefined, held?: { model: string; joint: string }): string {
  return `# ${robot}

A Gazebo model made with PlastikCAD. With this folder's parent on Gazebo's
path, the world in \`worlds\`, a flat floor to stand in for your own, opens
with the robot in it:

    export GZ_SIM_RESOURCE_PATH=$GZ_SIM_RESOURCE_PATH:$(pwd)/..
    gz sim worlds/${name}.sdf

Every joint is in \`model.sdf\`, loops included.${footprint ? ` The drive takes velocity
commands on the \`cmd_vel\` topic and publishes odometry against \`${footprint.name}\`,
a frame on \`${footprint.base}\` facing the robot's forward along +X as ROS expects:

    gz topic -t /cmd_vel -m gz.msgs.Twist -p 'linear: {x: 0.2}'` : ''}${held ? `

Gazebo's own position controller holds each joint that is not a wheel or
commanded by torque: it goes to the joint's start when the world begins, and
then to whatever position its topic is sent, in radians or meters:

    gz topic -t /model/${held.model}/joint/${held.joint}/0/cmd_pos -m gz.msgs.Double -p 'data: 0.3'` : ''}
`;
}

/**
 * The robot as a MuJoCo model: one XML with the bodies nested down the
 * tree, the meshes beside it. Loops are closed by pinning the two links of
 * each loop joint together at its point; followers by joint constraints.
 * A lidar becomes a fan of rangefinders, one ray each, up to MAX_LIDAR_RAYS.
 */
/** The forms a robot is exported in, as the panel offers them. */
export type ExportFormat = 'urdf' | 'sdf' | 'mjcf' | 'usd';
export const EXPORT_FORMATS: { id: ExportFormat; label: string; description: string }[] = [
  { id: 'urdf', label: tr('ROS 2 package'), description: tr('URDF and xacro with meshes, launch files, bridge and controllers') },
  { id: 'sdf', label: tr('Gazebo model'), description: tr('SDF with every joint, loops included, and a flat world') },
  { id: 'mjcf', label: tr('MuJoCo model'), description: tr('MJCF with actuators, loops as constraints') },
  { id: 'usd', label: tr('Isaac Sim stage'), description: tr('USD with the articulation, drives, sensors and a ROS 2 graph; opens and runs as it is') },
];

/**
 * What an export of the robot holds, in a sentence: everything a chain of
 * joints reaches from the base, and a word that the rest is ignored when
 * there is a rest. The dialog before an export shows it.
 */
export function exportSummary(doc: Doc, format: ExportFormat, robot: Robot = robotOf(doc)): string {
  const nodes = linkNodes(doc.scene);
  const tree = spanningTree(robot, nodes.map((n) => n.id));
  const base = nodes.find((n) => n.id === robot.root)?.name ?? 'the base';
  const label = EXPORT_FORMATS.find((f) => f.id === format)!.label;
  const strays = tree.unreached.length;
  const holds = tr('Writes "{name}" ({format}): the base {base} and everything joined to it.', { name: doc.name, format: label, base });
  return strays ? `${holds} ${plural(strays, 'One object is not joined to the base and will be ignored.', '{n} objects are not joined to the base and will be ignored.')}` : holds;
}

/**
 * The robot as a USD stage for Isaac Sim: one .usda holding the articulation,
 * its meshes, drives, sensors, a floor, lights and a ROS 2 graph, and a note
 * on running it. Opens and plays as it is.
 */
export function buildIsaacStage(doc: Doc, geometry: Map<string, LinkGeometry>, robot: Robot = robotOf(doc)): RobotPackage {
  const p = prepare(doc, geometry, robot, (path) => path, USD_NAMES);
  const { pkg, warnings } = p;
  const velocity = new Set(p.drive?.wheels ?? []);
  // A joint commanded by torque has no servo: its drive holds nothing, and `/joint_command` carries its efforts.
  const torque = new Set(p.torque);
  const position = new Set([...p.controlled.filter((j) => !torque.has(j)), ...(p.drive?.steer ?? [])]);
  // An Ackermann car in Isaac: the controller speaks for all four wheels, front left, front right, rear left, rear right,
  // so the front wheels, which turn free on their knuckles in the design, get velocity drives too.
  let ackermannWheels: string[] | undefined;
  if (p.drive?.kind === 'ackermann') {
    const r = p.drive.roles;
    const frontOf = (steer?: string) => p.treeJoints.find((j) => j.type === 'continuous' && j.parent === p.treeJoints.find((s) => s.name === steer)?.child)?.name;
    const fronts = [frontOf(r['steer-left']?.[0]), frontOf(r['steer-right']?.[0])];
    ackermannWheels = [...fronts, r.left?.[0], r.right?.[0]].filter((n): n is string => Boolean(n));
    for (const n of ackermannWheels) velocity.add(n);
    if (ackermannWheels.length !== 4) warnings.push('Isaac Sim steers a car by four wheels, two on the knuckles and two behind; this one has another layout, so cmd_vel will not drive it there.');
  }
  const frameOf = (link: string): Vec3 => p.frames.get([...p.linkNames].find(([, n]) => n === link)![0])!;
  const jointOf = (j: UrdfJoint, loop: boolean): UsdJoint => ({
    name: j.name,
    type: j.type,
    parent: j.parent,
    child: j.child,
    origin: j.origin,
    axis: j.axis,
    limit: j.limit,
    dynamics: j.dynamics,
    // A joint that closes a loop stands outside the articulation, where PhysX has no followers.
    mimic: loop ? undefined : j.mimic,
    armature: j.armature,
    loop,
    // A loop joint's child hangs from another joint, and has its frame there: the joint is where its parent has it, as the child's frame sees that.
    ...(loop ? { inChild: j.origin.map((x, i) => x + (frameOf(j.parent)[i] - frameOf(j.child)[i]) * M) as Vec3 } : {}),
    drive: velocity.has(j.name) ? 'velocity' : position.has(j.name) ? 'position' : torque.has(j.name) ? 'effort' : null,
    ...(j.start ? { start: j.start } : {}),
  });
  const links: UsdModel['links'] = p.links.map((l) => {
    const geo = geometry.get(l.node.id)!;
    const kind = linkOf(robot, l.node.id).collision;
    const collision: UsdCollision[] = [];
    const meshes = geo.hulls ?? (geo.collision ? [geo.collision] : []);
    l.collision.forEach((c, i) => {
      if ('mesh' in c.geometry) {
        if (meshes[i]) collision.push({ mesh: inFrame(meshes[i], l.frame), convex: kind !== 'mesh' });
      } else collision.push({ ...c.geometry, origin: c.origin ?? [0, 0, 0], rpy: c.rpy ?? [0, 0, 0], ...(l.skid && 'cylinder' in c.geometry ? { crowned: true } : {}) } as UsdCollision);
    });
    // In the pose the simulation begins in, a link stands where that pose puts it, turned as it turns it, the whole
    // robot raised or lowered to stand on the floor. A joint's zero stays where the design has it: the joint's
    // frames are fixed in its two links, so links written posed are joints at their starts.
    const to = p.posed?.get(l.node.id);
    const at = (to ? apply(to, l.frame) : l.frame).map((x) => x * M) as Vec3;
    const turn = to ? quatOfMatrix(to) : undefined;
    return { name: l.name, pos: [at[0], at[1], at[2] + p.lift], ...(turn && Math.abs(turn[0]) < 1 - 1e-9 ? { rot: turn } : {}), inertial: l.inertial, visual: geo.visual.map((v) => ({ mesh: inFrame(v.mesh, l.frame), color: rgb(v.color) })), collision, friction: l.friction ?? 0.5 };
  });
  // A mecanum wheel's rollers: bodies on free hinges, standing with their wheels in the pose the simulation begins in. Their
  // hinges are kept out of the articulation, so the joint states and the transform tree, which tell of it, hold the robot's own alone.
  const rollerJoints: UsdJoint[] = [];
  for (const r of p.rollers) {
    const wheel = p.links.find((l) => l.name === r.wheel)!;
    const to = p.posed?.get(wheel.node.id);
    const designed = wheel.frame.map((x, i) => x + r.at[i] / M) as Vec3;
    const at = (to ? apply(to, designed) : designed).map((x) => x * M) as Vec3;
    const turn = to ? quatOfMatrix(to) : undefined;
    const collision: UsdCollision[] = r.cylinder ? [{ cylinder: { radius: r.cylinder.radius, length: r.cylinder.length }, origin: [0, 0, 0], rpy: r.cylinder.rpy }] : r.balls.map((b) => ({ sphere: { radius: b.radius }, origin: b.at, rpy: [0, 0, 0] as Vec3 }));
    // A joint outside the articulation has no rotor inertia of its own to give: the wheel's body carries it, about its axle.
    const rotor = r.driven?.armature ?? 0;
    const [ax, ay, az] = r.axis;
    const inertial = rotor ? { ...r.inertial, inertia: r.inertial.inertia.map((x, i) => x + rotor * [ax * ax, ay * ay, az * az, ax * ay, ax * az, ay * az][i]) as Tensor } : r.inertial;
    links.push({ name: r.name, pos: [at[0], at[1], at[2] + p.lift], ...(turn && Math.abs(turn[0]) < 1 - 1e-9 ? { rot: turn } : {}), inertial, visual: [], collision, friction: r.friction, ...(r.cylinder ? { standIn: true } : {}) });
    // A wheel the drive turns is kept out of the articulation like one that turns free: the stage's graph tells its joint's drive the speed.
    if (r.driven) rollerJoints.push({ name: r.joint, type: 'continuous', parent: r.wheel, child: r.name, origin: r.at, axis: r.axis, limit: { lower: 0, upper: 0, effort: r.driven.effort, velocity: r.driven.velocity }, dynamics: { damping: r.driven.damping, friction: r.driven.friction }, loop: false, outside: true, drive: 'velocity' });
    else rollerJoints.push({ name: r.joint, type: 'continuous', parent: r.wheel, child: r.name, origin: r.at, axis: r.axis, dynamics: { damping: ROLLER_DAMPING, friction: 0 }, loop: false, outside: true, drive: null });
  }
  let drive: UsdModel['drive'] = null;
  if (p.drive) {
    const r = p.drive.roles;
    const left = r.left ?? [...(r['front-left'] ?? []), ...(r['rear-left'] ?? [])];
    const right = r.right ?? [...(r['front-right'] ?? []), ...(r['rear-right'] ?? [])];
    const speeds = [...p.treeJoints.filter((j) => p.drive!.wheels.includes(j.name) && j.limit?.velocity).map((j) => j.limit!.velocity), ...p.rollers.filter((r) => r.driven && r.driven.velocity > 0 && p.drive!.wheels.includes(r.joint)).map((r) => r.driven!.velocity)];
    const steer = p.drive.kind === 'ackermann' ? [r['steer-left']?.[0], r['steer-right']?.[0]].filter((n): n is string => Boolean(n)) : p.drive.steer;
    // A mecanum drive's wheels by corner: front left, front right, rear left, rear right.
    const corners = p.drive.kind === 'mecanum' ? [r['front-left']![0], r['front-right']![0], r['rear-left']![0], r['rear-right']![0]] : undefined;
    drive = { kind: p.drive.kind, left, right, steer, ackermannWheels, corners, wheelRadius: p.drive.wheelRadius, wheelSeparation: p.drive.wheelSeparation, wheelBase: p.drive.wheelBase, maxWheelSpeed: speeds.length ? Math.min(...speeds) : 10, steeringLimit: p.drive.steeringLimit };
  }
  // The frames the readings are stamped with are named as the ROS package names them, clear of the links.
  const sensors: UsdModel['sensors'] = p.sensors.map((s) => {
    const frame = s.kind === 'touch' ? undefined : p.names.take(`${s.name}_link`, p.naming.link);
    const optical = s.kind === 'camera' || s.kind === 'depth' ? p.names.take(`${s.name}_optical_frame`, p.naming.link) : undefined;
    return { name: s.name, ...(frame ? { frame } : {}), ...(optical ? { optical } : {}), kind: s.kind, link: s.link, xyz: s.xyz, rpy: s.rpy, rate: s.rate, camera: s.camera, lidar: s.lidar, touch: s.touch };
  });
  const footprint = footprintOf(p, robot);
  const model: UsdModel = {
    name: p.robotName,
    root: p.linkNames.get(robot.root!)!,
    fixedBase: robot.base === 'fixed',
    ...(footprint ? { footprint: { name: footprint.name, joint: footprint.joint, yaw: -footprint.turn } } : {}),
    links,
    joints: [...p.treeJoints.map((j) => jointOf(j, false)), ...rollerJoints, ...p.loopJoints.map((j) => jointOf(j, true))],
    sensors,
    drive,
    controlled: p.controlled,
    // Rollers pass the floor from one to the next many times a second: PhysX keeps them true at twice its usual step rate.
    ...(p.rollers.length ? { stepsPerSecond: ROLLER_STEPS } : {}),
  };
  const files: PackageFile[] = [{ name: `${pkg}.usda`, bytes: encodeText(writeUsda(model)) }, { name: 'README.md', bytes: encodeText(usdReadme(pkg, doc.name, model)) }];
  return { name: pkg, files, warnings, leftOut: p.leftOut };
}

function usdReadme(name: string, robot: string, model: UsdModel): string {
  const d = model.drive;
  const topics = [
    '`/joint_states`, `/tf` and `/clock`',
    ...(model.fixedBase ? [] : ['`/odom`, with the odom → base transform']),
    ...(d && d.kind !== 'ackermann' ? ['`/cmd_vel` (geometry_msgs/Twist) drives it'] : []),
    ...(d && d.kind === 'ackermann' ? ['`/ackermann_cmd` (ackermann_msgs/AckermannDriveStamped) drives it: speed and steering angle'] : []),
    ...(model.controlled.length ? [`\`/joint_command\` (sensor_msgs/JointState) positions the joints by name${model.joints.some((j) => j.drive === 'effort') ? ', and carries the efforts of those commanded by torque, which nothing holds until it does' : ''}`] : []),
    ...model.sensors.filter((s) => s.kind !== 'touch').map((s) => `\`/${s.name}/${s.kind === 'camera' ? 'image` and `/' + s.name + '/camera_info' : s.kind === 'depth' ? 'depth` and `/' + s.name + '/camera_info' : s.kind === 'lidar' ? 'scan' : 'imu'}\` from the ${s.name} sensor`),
  ];
  return `# ${robot}

A stage for Isaac Sim made with ${APP_NAME}: \`${name}.usda\`, meters, Z up.
Open it (File > Open) and press Play. The robot is a PhysX articulation
standing on a flat floor, with its masses, collision shapes and joint drives
written in; nothing needs importing or setting up.

The ROS 2 graph in the stage starts with the ROS 2 bridge extension, which
Isaac Sim loads when a ROS 2 environment is sourced before launch (Jazzy or
Humble; without one, Isaac's bundled libraries serve). It publishes:

${topics.map((t) => `- ${t}`).join('\n')}

Each sensor's readings are in its own frame, \`<sensor>_link\`, and a camera's
pictures in \`<sensor>_optical_frame\`, as in the ROS package. ${model.footprint && !model.fixedBase ? `The base frame is \`${model.footprint.name}\`, on the floor under \`${model.root}\`\nand facing the robot's forward along +X; the odometry is given for it.` : `The base frame is \`${model.root}\`.`}${model.sensors.some((s) => s.kind === 'lidar') ? ' A lidar\nscans the whole circle in Isaac Sim, at the angular step of the design.' : ''}
${model.sensors.some((s) => s.kind === 'touch') ? '\nTouch sensors are Isaac contact sensors on their links; read them from a\nscript or the Contact Sensor window, as the ROS 2 bridge has no publisher\nfor them.\n' : ''}
The floor is a stand-in: place the robot in a world of your own by
referencing this stage, or copy the \`${robotPrim(model.name)}\` prim into it.
`;
}

/**
 * The least a driven wheel of a track, or one that slides sideways as its rover turns (see `skid`), weighs at its
 * rim, as a multiple of what it carries of the robot: its rotor
 * inertia is never less than this times that mass times its radius squared. A rim lighter than its load is
 * brought to the floor's speed by friction within a step, whatever its motor asks, and lets go again the next:
 * the track chatters where it should skid, and hardly turns the robot. Measured on the reference rover turning on
 * the spot in MuJoCo, at two robot masses and three motor gains: 1 gives about four fifths of the turn that 4
 * does, 8 a tenth more than 4, and much more makes the robot slow to start.
 */
export const RIM_SHARE = 4;

/** Physics steps a second for an Isaac Sim stage whose robot has rollers. */
const ROLLER_STEPS = 120;

/**
 * What a roller's hinge holds still against, as a share of the load its wheel carries, taken at the roller's rim:
 * a plain bearing's drag. Gazebo needs it. A robot on four wheels that are held still rests, at some angles of the
 * wheels, on the two of a diagonal, whose rollers lean the same way; on hinges with no drag at all it then rolls
 * along that diagonal for good. With this much it stops within a few centimeters, and slides about a hundredth less far.
 */
const ROLLER_BEARING = 0.02;

/** What a roller's hinge resists its turning by, N·m·s/rad: next to nothing, and enough to keep it from ringing. */
const ROLLER_DAMPING = 1e-5;

/** A lidar's rays in MuJoCo, at most: each is a ray cast every step, and a policy wants a coarse scan anyway. */
export const MAX_LIDAR_RAYS = 90;

/**
 * `world` is the floor the model stands on. An export gets the flat one: a
 * world is the simulator's business, not the robot's. The test drive passes
 * the floor the user picked for it.
 */
export function buildMjcfModel(doc: Doc, geometry: Map<string, LinkGeometry>, robot: Robot = robotOf(doc), world: World = 'flat', servosOnly = false): MjcfPackage {
  const p = prepare(doc, geometry, robot, (path) => path, MJCF_NAMES);
  const { pkg, files, warnings } = p;
  const byName = new Map(p.links.map((l) => [l.name, l]));
  // A joint with no effort or speed gets no actuator, and the drive does not name one for it.
  const actuated = new Set([...p.treeJoints.filter(drivable).map((j) => j.name), ...p.rollers.filter((r) => r.driven && r.driven.effort > 0 && r.driven.velocity > 0).map((r) => r.joint)]);
  const childrenOf = new Map<string, UrdfJoint[]>();
  for (const j of p.treeJoints) childrenOf.set(j.parent, [...(childrenOf.get(j.parent) ?? []), j]);
  const sensorsOf = (link: string) => p.sensors.filter((s) => s.link === link);
  for (const s of p.sensors) if (s.kind === 'lidar' && s.lidar.samples > MAX_LIDAR_RAYS) warnings.push(`"${s.name}" sweeps ${s.lidar.samples} rays; MuJoCo gets ${MAX_LIDAR_RAYS} of them, spread over the same sweep, to keep it quick.`);
  // A mecanum wheel's roller: a body in its wheel on a free hinge, a row of balls to meet the floor. A trace of
  // damping keeps the hinge of so light a body steady.
  const roller = (r: PreparedRoller): MjcfBody => ({
    name: r.name,
    pos: r.at,
    inertial: r.inertial,
    visual: [],
    collision: r.cylinder ? [{ geometry: { cylinder: { radius: r.cylinder.radius, length: r.cylinder.length } }, rpy: r.cylinder.rpy }] : r.balls.map((b) => ({ geometry: { sphere: { radius: b.radius } }, origin: b.at })),
    friction: r.friction,
    // A wheel that stands in for a track's belt is turned by the track's motor; a roller, and a wheel of a track nothing drives, turns free.
    joint: r.driven
      ? { name: r.joint, type: 'continuous', axis: r.axis, limit: { lower: 0, upper: 0, effort: r.driven.effort, velocity: r.driven.velocity }, dynamics: { damping: r.driven.damping, friction: r.driven.friction }, armature: r.driven.armature, internal: true }
      : { name: r.joint, type: 'continuous', axis: r.axis, dynamics: { damping: ROLLER_DAMPING, friction: 0 }, internal: true },
    children: [],
  });
  const body = (name: string, joint: UrdfJoint | undefined): MjcfBody => {
    const l = byName.get(name)!;
    const cams = sensorsOf(name).filter((s) => s.kind === 'camera' || s.kind === 'depth');
    const imus = sensorsOf(name).filter((s) => s.kind === 'imu');
    const touches = sensorsOf(name).filter((s) => s.kind === 'touch');
    const lidars = sensorsOf(name).filter((s) => s.kind === 'lidar');
    return {
      name,
      // The base stands where its frame is in the design; every other body hangs from its parent's.
      pos: joint ? joint.origin : (l.frame.map((x) => x * M) as Vec3),
      inertial: l.inertial,
      visual: l.visual,
      collision: l.collision,
      friction: l.friction,
      joint: joint ? { name: joint.name, type: joint.type, axis: joint.axis, limit: joint.limit, dynamics: joint.dynamics, armature: joint.armature, start: joint.start } : undefined,
      children: [...(childrenOf.get(name) ?? []).map((j) => body(j.child, j)), ...p.rollers.filter((r) => r.wheel === name).map(roller)],
      ...(cams.length ? { cameras: cams.map((s) => ({ name: s.name, pos: s.xyz, rpy: s.rpy, hfov: s.camera.hfov, aspect: s.camera.width / s.camera.height })) } : {}),
      ...(imus.length ? { imus: imus.map((s) => ({ name: s.name, pos: s.xyz, rpy: s.rpy })) } : {}),
      ...(touches.length ? { touches: touches.map((s) => ({ name: s.name, pos: s.xyz, size: s.touch })) } : {}),
      ...(lidars.length ? { lidars: lidars.map((s) => ({ name: s.name, pos: s.xyz, rpy: s.rpy, rays: Math.min(s.lidar.samples, MAX_LIDAR_RAYS), hfov: s.lidar.hfov, max: s.lidar.max })) } : {}),
    };
  };
  const base = p.linkNames.get(robot.root!)!;
  const model: MjcfModel = {
    name: p.robotName,
    base: body(base, undefined),
    floating: robot.base === 'free',
    lift: p.lift,
    world,
    forward: robotForward(robot, new Map(p.links.map((l) => [l.node.id, l.node]))),
    // A loop joint's origin is given in its parent's frame; the connect anchor is in the first body's frame.
    connects: p.loopJoints.map((j) => ({ body1: j.parent, body2: j.child, anchor: j.origin })),
    followers: [...p.treeJoints, ...p.loopJoints].filter((j) => j.mimic && p.treeJoints.some((t) => t.name === j.name)).map((j) => ({ joint: j.name, leader: j.mimic!.joint, multiplier: j.mimic!.multiplier, offset: j.mimic!.offset })),
    servos: [...p.controlled, ...(p.drive?.steer ?? [])].filter((j) => actuated.has(j)),
    // The test drive holds every joint by position, whatever its controller will send it.
    torques: servosOnly ? [] : p.torque,
    // The wheels get velocity motors; steering joints position servos, as the simulator has no plugin to turn them.
    wheels: (p.drive?.wheels ?? []).filter((j) => actuated.has(j)),
  };
  const collisions = p.links.map((l) => `${l.name}: ${linkOf(robot, l.node.id).collision}`);
  files.unshift({ name: `${pkg}.xml`, bytes: encodeText(writeMjcf(model)) }, { name: 'README.md', bytes: encodeText(mjcfReadme(pkg, doc.name, collisions, robot.scripts !== false, p.sensors.some((s) => s.kind === 'lidar'))) });
  if (robot.scripts !== false) {
    const kind = p.drive ? 'rover' : robot.base === 'fixed' ? 'arm' : 'walker';
    files.push({ name: 'drive.py', bytes: encodeText(drivePy(`${pkg}.xml`, kind)) }, { name: 'env.py', bytes: encodeText(envPy(`${pkg}.xml`, model.forward)) }, { name: 'train.py', bytes: encodeText(trainPy()) });
  }
  // What drives what, for a script: the actuator of each part, and the geometry a velocity command needs.
  let drive: DriveSpec | null = null;
  if (p.drive) {
    const actuator = (joint: string) => (p.drive!.steer.includes(joint) ? `${joint}_servo` : `${joint}_motor`);
    const roles = Object.fromEntries(Object.entries(p.drive.roles).map(([role, joints]) => [role, (joints ?? []).filter((j) => actuated.has(j)).map(actuator)]));
    const { kind, forward, wheelRadius, wheelSeparation, wheelBase, kingpinWidth, steeringLimit } = p.drive;
    drive = { kind, units: 'meters, radians', forward, roles, wheelRadius, wheelSeparation, wheelBase, kingpinWidth, steeringLimit };
    files.push({ name: 'drive.json', bytes: encodeText(JSON.stringify(drive, null, 2) + '\n') });
  }
  return {
    name: pkg,
    files,
    warnings,
    leftOut: p.leftOut,
    bodies: p.links.map((l) => ({ body: l.name, node: l.node.id, frame: l.frame })),
    joints: [...p.jointNames].map(([j, name]) => ({ name, id: j.id })),
    drive,
    lidars: p.sensors.filter((s) => s.kind === 'lidar').map((s) => ({ name: s.name, id: s.id, rays: Math.min(s.lidar.samples, MAX_LIDAR_RAYS) })),
    touches: p.sensors.filter((s) => s.kind === 'touch').map((s) => ({ name: s.name, id: s.id })),
  };
}

function mjcfReadme(name: string, robot: string, collisions: string[], scripts: boolean, lidars: boolean): string {
  return `# ${robot}

A MuJoCo model made with PlastikCAD. Open it with the viewer:

    python -m mujoco.viewer --mjcf ${name}.xml

Visual meshes are OBJ files with their colors, collision meshes STL (MuJoCo
makes a convex hull of each), all in meters with Z up. Joints under control
have position servos, wheels velocity motors; the Control tab of the viewer
drives them. Loops are closed by connect constraints at their joints.

The \`home\` keyframe is the design's pose. Every joint has a position and a
velocity sensor; a free base has its orientation, turn rate, velocity and
acceleration at \`base_site\`; touch sensors sum the contact force in their site.${
    lidars
      ? ` A lidar
is a fan of rangefinders, one per ray about its Z from its right-hand end round
to its left: each reads the distance to the nearest surface, the lidar's range
when nothing is nearer, and -1 when nothing is hit at all. The nearest it can
see is not modelled.`
      : ''
  }

Collisions (box, cylinder and sphere are fast in MJX; hull and mesh are not):
${collisions.map((c) => `- ${c}`).join('\n')}
${
  scripts
    ? `
Scripts (\`pip install mujoco imageio imageio-ffmpeg gymnasium stable-baselines3\`):

- \`drive.py\` moves the robot: a rover from velocity commands, an arm by
  sweeping its servos, a walker with a simple gait. Opens the viewer, or
  renders a video with \`--video out.mp4\`.
- \`env.py\` is a Gymnasium environment over the model, with the observation
  and action spaces wired and a reward to replace.
- \`train.py\` trains a PPO policy on it and saves \`policy.zip\`.
`
    : ''
}`;
}
