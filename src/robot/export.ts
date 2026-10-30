// Puts a robot together for a simulator: as a ROS 2 package (URDF with
// Gazebo blocks, meshes, launch files, bridge and controller settings) or as
// a Gazebo model (SDF, which keeps loops). Pure: the kernel's answers come
// in, files go out.
import type { MeshData } from '../geometry/mesh';
import { boundsSize, eulerOf, multiply, rotation } from '../model/math';
import type { Doc, SceneNode, Vec3 } from '../model/types';
import { encodeText } from '../io/format';
import { driveXml, jointStateXml, sensorTopic, sensorXml, worldXml } from '../io/gazebo';
import type { GazeboDrive } from '../io/gazebo';
import type { BridgeTopic } from '../io/rosPackage';
import type { GazeboSensor } from '../io/gazebo';
import { writeObj } from '../io/obj';
import { bridgeYaml, cmakeLists, controllersYaml, displayLaunch, gazeboLaunch, packageXml, readme, rvizConfig, SHARE_PLACEHOLDER } from '../io/rosPackage';
import { writeMjcf } from '../io/mjcf';
import type { MjcfBody, MjcfModel } from '../io/mjcf';
import { modelConfig, writeSdf } from '../io/sdf';
import type { SdfJoint, SdfLink } from '../io/sdf';
import { writeStl } from '../io/stl';
import { uniqueNames, urdfName, writeUrdf } from '../io/urdf';
import type { UrdfJoint, UrdfLink, UrdfShape } from '../io/urdf';
import type { LinkGeometry } from '../worker/protocol';
import { massOf, tensorOf, toSI } from './inertia';
import type { Tensor } from './inertia';
import { jointInDesign, linkNodes, linkOf, robotForward, robotOf, sensorInDesign, spanningTree } from './model';
import { motorOf } from './motors';
import { drivePy, envPy, trainPy } from '../io/scripts';
import { DRIVE_KINDS, driveJoints, withRole } from './types';
import type { DriveKind, DriveRole, Robot, RobotJoint } from './types';
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
}

/** What both outputs share: every link and joint in SI, the meshes written, the sensors, the drive. */
interface Prepared {
  pkg: string;
  robotName: string;
  files: PackageFile[];
  warnings: string[];
  order: string[];
  linkNames: Map<string, string>;
  jointNames: Map<RobotJoint, string>;
  frames: Map<string, Vec3>;
  links: (UrdfLink & { frame: Vec3; node: SceneNode })[];
  /** The tree's joints, parents before children. */
  treeJoints: UrdfJoint[];
  /** The joints that close loops, which only SDF carries. */
  loopJoints: UrdfJoint[];
  sensors: (GazeboSensor & { link: string; xyz: Vec3; rpy: Vec3; touch: number })[];
  drive: PreparedDrive | null;
  /** Joints under ros2_control. */
  controlled: string[];
}

function prepare(doc: Doc, geometry: Map<string, LinkGeometry>, robot: Robot, meshUri: (path: string) => string): Prepared {
  const warnings: string[] = [];
  const nodes = linkNodes(doc.scene);
  const tree = spanningTree(robot, nodes.map((n) => n.id));
  if (tree.order.length === 0) throw new Error('The robot has no base link.');
  const pkg = packageName(doc.name);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const linkNames = uniqueNames(tree.order, (id) => urdfName(linkOf(robot, id).name ?? nodeById.get(id)!.name));
  const allJoints = [...tree.order.slice(1).map((id) => tree.parentJoint.get(id)!), ...tree.loops];
  const jointNames = uniqueNames(allJoints, (j) => urdfName(j.name, 'joint'));
  // Each joint as it sits in the design, and where each link's frame is there (mm).
  const placedJoints = new Map(allJoints.map((j) => [j.id, jointInDesign(j, nodeById.get(j.child)!)]));
  const frames = new Map<string, Vec3>();
  for (const id of tree.order) frames.set(id, id === robot.root ? [0, 0, 0] : placedJoints.get(tree.parentJoint.get(id)!.id)!.origin);

  const files: PackageFile[] = [];
  const links: Prepared['links'] = [];
  for (const id of tree.order) {
    const node = nodeById.get(id)!;
    const link = linkOf(robot, id);
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
    if (link.collision === 'box' || link.collision === 'cylinder' || link.collision === 'sphere') {
      // The object's own box, where it stands and turned as it is (URDF's roll, pitch, yaw are the design's X, Y, Z turns).
      const origin = node.pos.map((x, i) => (x - frame[i]) * M) as Vec3;
      const rpy = node.rot.map((d) => d * RAD) as Vec3;
      const size = node.size.map((x) => x * M) as Vec3;
      const geometryOf =
        link.collision === 'box' ? { box: size } : link.collision === 'cylinder' ? { cylinder: { radius: Math.max(size[0], size[1]) / 2, length: size[2] } } : { sphere: { radius: Math.max(...size) / 2 } };
      collision.push({ geometry: geometryOf, origin, rpy });
    } else if (link.collision !== 'none' && geo.collision) {
      files.push({ name: `meshes/collision/${name}.stl`, bytes: writeStl(inFrame(geo.collision, frame), name, 'm') });
      collision.push({ geometry: { mesh: meshUri(`meshes/collision/${name}.stl`) } });
    }
    const mass = massOf(link.mass, geo.props);
    let inertial: UrdfLink['inertial'] = null;
    if (mass > 0 && geo.props.volume > 0) {
      inertial = { mass: mass / 1000, origin: geo.props.centroid.map((x, i) => (x - frame[i]) * M) as Vec3, inertia: tensorOf(mass, geo.props.unit).map(toSI) as Tensor };
    } else {
      warnings.push(`"${node.name}" has no mass or volume; it was written without inertia, which a simulator may reject.`);
    }
    if (!geo.props.watertight) warnings.push(`"${node.name}" is not a closed mesh; its inertia is an estimate.`);
    links.push({ name, inertial, visual, collision, friction: link.friction, frame, node });
  }

  // A drive wheel rolls forward on a positive command: its axis is written the way round that a positive
  // turn moves the base the way the robot faces, which its wheel labels tell. (A turn about `axis` moves
  // the base along (axis.y, -axis.x, 0).)
  const forward = robotForward(robot, nodeById);
  const forwardAxis = (j: RobotJoint, axis: Vec3): Vec3 => {
    const role = robot.drive?.roles[j.id];
    return role && !role.startsWith('steer') && axis[1] * forward[0] - axis[0] * forward[1] < 0 ? (axis.map((x) => -x) as Vec3) : axis;
  };
  const jointOf = (j: RobotJoint): UrdfJoint => {
    const parentFrame = frames.get(j.parent)!;
    const placed = placedJoints.get(j.id)!;
    const scale = j.type === 'prismatic' ? M : RAD;
    const leader = j.mimic && allJoints.find((o) => o.id === j.mimic!.joint);
    const mimic = leader && jointNames.has(leader) ? { joint: jointNames.get(leader)!, multiplier: j.mimic!.multiplier, offset: j.mimic!.offset * scale } : undefined;
    return {
      name: jointNames.get(j)!,
      type: j.type,
      parent: linkNames.get(j.parent)!,
      child: linkNames.get(j.child)!,
      origin: placed.origin.map((x, i) => (x - parentFrame[i]) * M) as Vec3,
      axis: forwardAxis(j, placed.axis),
      limit: j.type === 'fixed' ? undefined : { lower: j.lower * scale, upper: j.upper * scale, effort: j.effort, velocity: j.velocity * scale },
      dynamics: j.type === 'fixed' ? undefined : { damping: j.damping, friction: j.friction },
      armature: motorOf(j.motor)?.armature,
      ...(mimic ? { mimic } : {}),
    };
  };
  const treeJoints = tree.order.slice(1).map((id) => jointOf(tree.parentJoint.get(id)!));
  const loopJoints = tree.loops.map(jointOf);

  // Sensors: each in its link, placed from the link's frame, its turn as the design has it (the link frames are parallel to the design's axes).
  const sensorNames = uniqueNames(robot.sensors, (x) => urdfName(x.name, 'sensor'));
  const sensors: Prepared['sensors'] = robot.sensors
    .filter((x) => nodeById.has(x.link) && frames.has(x.link))
    .map((x) => {
      const node = nodeById.get(x.link)!;
      const placed = sensorInDesign(x, node);
      const frame = frames.get(x.link)!;
      const rpy = eulerOf(multiply(rotation(node.rot), rotation(x.rot))).map((d) => d * RAD) as Vec3;
      const name = sensorNames.get(x)!;
      return {
        name,
        frame: `${name}_link`,
        kind: x.kind,
        rate: x.rate,
        camera: { hfov: x.camera.hfov * RAD, width: x.camera.width, height: x.camera.height, near: x.camera.near * M, far: x.camera.far * M },
        lidar: { samples: x.lidar.samples, hfov: x.lidar.hfov * RAD, min: x.lidar.min * M, max: x.lidar.max * M },
        link: linkNames.get(x.link)!,
        xyz: placed.origin.map((v, i) => (v - frame[i]) * M) as Vec3,
        rpy,
        // A touch sensor feels within a quarter of the link's smallest side.
        touch: (geometry.get(x.link) ? Math.min(...boundsSize(geometry.get(x.link)!.bounds)) / 4 : 5) * M,
        collision: `${linkNames.get(x.link)!}_collision`,
      };
    });

  // The drive: each part's joints by name, the wheels' radius from their boxes, the track and wheelbase from where the joints sit.
  let drive: PreparedDrive | null = null;
  if (robot.drive) {
    const def = DRIVE_KINDS.find((k) => k.id === robot.drive!.kind)!;
    const named = (role: DriveRole) => withRole(robot.drive, role).map((id) => allJoints.find((j) => j.id === id)).filter((j): j is RobotJoint => Boolean(j));
    const parts = Object.fromEntries(def.roles.map((r) => [r.id, named(r.id)])) as Record<DriveRole, RobotJoint[]>;
    const has = (role: DriveRole, n?: number) => (n === undefined ? parts[role].length > 0 : parts[role].length === n);
    const complete =
      def.id === 'differential' ? has('left') && has('right') : def.id === 'ackermann' ? has('left') && has('right') && has('steer-left', 1) && has('steer-right', 1) : (['front-left', 'front-right', 'rear-left', 'rear-right'] as const).every((r) => has(r, 1));
    if (complete) {
      const at = (j: RobotJoint): Vec3 => placedJoints.get(j.id)!.origin;
      const mean = (js: RobotJoint[]): Vec3 => js.reduce((acc, j) => acc.map((v, i) => v + at(j)[i] / js.length) as Vec3, [0, 0, 0] as Vec3);
      const apart = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * M;
      const wheelJoints = def.roles.filter((r) => !r.id.startsWith('steer')).flatMap((r) => parts[r.id]);
      const steerJoints = def.roles.filter((r) => r.id.startsWith('steer')).flatMap((r) => parts[r.id]);
      const radii = wheelJoints.map((j) => {
        const geo = geometry.get(j.child);
        const axis = placedJoints.get(j.id)!.axis;
        if (!geo) return 0;
        const size = boundsSize(geo.bounds);
        const axle = axis.map(Math.abs).indexOf(Math.max(...axis.map(Math.abs)));
        return Math.max(...size.filter((_, i) => i !== axle)) / 2;
      });
      const names = (js: RobotJoint[]) => js.map((j) => jointNames.get(j)!);
      const base = { kind: def.id, forward, roles: Object.fromEntries(def.roles.map((r) => [r.id, names(parts[r.id])])), wheels: names(wheelJoints), steer: names(steerJoints), wheelRadius: (radii.reduce((a, b) => a + b, 0) / radii.length) * M };
      if (def.id === 'mecanum') {
        const [fl, fr, rl, rr] = [parts['front-left'][0], parts['front-right'][0], parts['rear-left'][0], parts['rear-right'][0]];
        drive = { ...base, wheelSeparation: (apart(at(fl), at(fr)) + apart(at(rl), at(rr))) / 2, wheelBase: (apart(at(fl), at(rl)) + apart(at(fr), at(rr))) / 2 };
      } else {
        drive = { ...base, wheelSeparation: apart(mean(parts.left), mean(parts.right)) };
        if (def.id === 'ackermann') {
          const [sl, sr] = [parts['steer-left'][0], parts['steer-right'][0]];
          drive.kingpinWidth = apart(at(sl), at(sr));
          drive.wheelBase = apart(mean([...parts.left, ...parts.right]), mean([sl, sr]));
          drive.steeringLimit = (Math.min(...[sl, sr].map((j) => Math.min(Math.abs(j.lower), Math.abs(j.upper)))) * Math.PI) / 180;
        }
      }
    }
  }
  const driven = new Set(driveJoints(robot.drive));
  const controlled = robot.control ? tree.order.slice(1).map((id) => tree.parentJoint.get(id)!).filter((j) => j.type !== 'fixed' && !j.mimic && !driven.has(j.id)).map((j) => jointNames.get(j)!) : [];

  return { pkg, robotName: urdfName(doc.name, 'robot'), files, warnings, order: tree.order, linkNames, jointNames, frames, links, treeJoints, loopJoints, sensors, drive, controlled };
}

/**
 * ROS expects a robot's base frame to face +X. A driven robot gets a root frame that does,
 * `base_footprint`, over the base link, which keeps the design's axes and is turned by `turn`
 * radians about Z in it. Nothing for an arm bolted down, or a robot without wheels to say.
 */
function footprintOf(p: Prepared, robot: Robot, taken: Iterable<string>): { name: string; base: string; turn: number } | undefined {
  if (!p.drive || robot.base === 'fixed') return undefined;
  const used = new Set(taken);
  let name = 'base_footprint';
  for (let n = 2; used.has(name); n++) name = `base_footprint_${n}`;
  const [fx, fy] = p.drive.forward;
  return { name, base: p.linkNames.get(robot.root!)!, turn: -Math.atan2(fy, fx) || 0 };
}

/** The prepared drive as the Gazebo plugin wants it. */
function gazeboDrive(d: PreparedDrive, baseFrame: string): GazeboDrive {
  const shared = { baseFrame, wheelRadius: d.wheelRadius, wheelSeparation: d.wheelSeparation };
  if (d.kind === 'mecanum') return { ...shared, kind: 'mecanum', frontLeft: d.roles['front-left']![0], frontRight: d.roles['front-right']![0], rearLeft: d.roles['rear-left']![0], rearRight: d.roles['rear-right']![0], wheelBase: d.wheelBase! };
  if (d.kind === 'ackermann') return { ...shared, kind: 'ackermann', leftJoints: d.roles.left!, rightJoints: d.roles.right!, leftSteer: d.roles['steer-left']![0], rightSteer: d.roles['steer-right']![0], wheelBase: d.wheelBase!, kingpinWidth: d.kingpinWidth!, steeringLimit: d.steeringLimit! };
  return { ...shared, kind: 'differential', leftJoints: d.roles.left!, rightJoints: d.roles.right! };
}

/** The Gazebo sensor topics a ROS 2 bridge carries across, and the robot's own. */
function bridgeTopics(p: Prepared): BridgeTopic[] {
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
      out.push({ ros: topic, gz: topic, rosType: 'sensor_msgs/msg/Image', gzType: 'gz.msgs.Image', direction: 'GZ_TO_ROS' });
      out.push({ ros: `/${s.name}/camera_info`, gz: `/${s.name}/camera_info`, rosType: 'sensor_msgs/msg/CameraInfo', gzType: 'gz.msgs.CameraInfo', direction: 'GZ_TO_ROS' });
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
 * The robot as a ROS 2 package: every link's frame is parallel to the
 * design's axes, so no file carries a rotation but the sensors' frames: the
 * base link's frame is the design's origin and each other link's sits at the
 * joint that carries it, with the link's meshes written in that frame.
 * `geometry` is what the kernel made of each link, by node id.
 */
export function buildRobotPackage(doc: Doc, geometry: Map<string, LinkGeometry>, robot: Robot = robotOf(doc)): RobotPackage {
  const p = prepare(doc, geometry, robot, (path) => `package://${packageName(doc.name)}/${path}`);
  const { pkg, files, warnings } = p;
  const fixedToWorld = robot.base === 'fixed' ? p.linkNames.get(robot.root!) : undefined;
  for (const j of p.loopJoints) warnings.push(`"${j.name}" closes a loop and was left out of the URDF (the SDF export keeps it).`);
  const links: UrdfLink[] = p.links.map(({ frame: _f, node: _n, ...l }) => l);
  const joints: UrdfJoint[] = [...p.treeJoints];
  // Each sensor is a frame of its own on a fixed joint; a camera also gets the optical frame ROS expects (Z forward, X right).
  // A touch sensor feels a collision, so it sits on the link that has one.
  for (const s of p.sensors) {
    if (s.kind === 'touch') {
      const link = links.find((l) => l.name === s.link);
      if (link) link.sensors = [...(link.sensors ?? []), sensorXml({ ...s, frame: s.link })];
      continue;
    }
    links.push({ name: s.frame, inertial: null, visual: [], collision: [], sensors: [sensorXml(s)] });
    joints.push({ name: `${s.name}_joint`, type: 'fixed', parent: s.link, child: s.frame, origin: s.xyz, rpy: s.rpy, axis: [0, 0, 1] });
    if (s.kind === 'camera' || s.kind === 'depth') {
      links.push({ name: `${s.name}_optical_frame`, inertial: null, visual: [], collision: [] });
      joints.push({ name: `${s.name}_optical_joint`, type: 'fixed', parent: s.frame, child: `${s.name}_optical_frame`, origin: [0, 0, 0], rpy: OPTICAL, axis: [0, 0, 1] });
    }
  }
  const base = p.linkNames.get(robot.root!)!;
  const footprint = footprintOf(p, robot, links.map((l) => l.name));
  const plugins = [jointStateXml(), ...(p.drive ? [driveXml(gazeboDrive(p.drive, footprint?.name ?? base))] : [])];
  const control = p.controlled.length ? { joints: p.controlled, controllersYaml: `${SHARE_PLACEHOLDER}/config/controllers.yaml` } : undefined;
  const controllers = control ? ['joint_state_broadcaster', 'arm_controller'] : [];
  files.unshift(
    { name: 'package.xml', bytes: encodeText(packageXml(pkg, `${doc.name} robot description`, { gazebo: true, control: Boolean(control) })) },
    { name: 'CMakeLists.txt', bytes: encodeText(cmakeLists(pkg)) },
    { name: 'README.md', bytes: encodeText(readme(pkg, doc.name, footprint)) },
    { name: `urdf/${pkg}.urdf`, bytes: encodeText(writeUrdf(p.robotName, links, joints, { plugins, control, fixedToWorld, footprint })) },
    { name: `urdf/${pkg}.urdf.xacro`, bytes: encodeText(writeUrdf(p.robotName, links, joints, { plugins, control, fixedToWorld, footprint, xacro: { package: pkg } })) },
    { name: 'launch/display.launch.py', bytes: encodeText(displayLaunch(pkg)) },
    { name: 'launch/gazebo.launch.py', bytes: encodeText(gazeboLaunch(pkg, { controllers })) },
    { name: 'rviz/display.rviz', bytes: encodeText(rvizConfig(base)) },
    { name: `worlds/${pkg}.sdf`, bytes: encodeText(worldXml(pkg)) },
    { name: 'config/bridge.yaml', bytes: encodeText(bridgeYaml(bridgeTopics(p))) },
    ...(control ? [{ name: 'config/controllers.yaml', bytes: encodeText(controllersYaml(p.controlled)) }] : []),
  );
  return { name: pkg, files, warnings };
}

/**
 * The robot as a Gazebo model folder: model.sdf with every joint, loops
 * included, the meshes, a world that includes it, and a note on running it.
 */
export function buildSdfModel(doc: Doc, geometry: Map<string, LinkGeometry>, robot: Robot = robotOf(doc)): RobotPackage {
  const p = prepare(doc, geometry, robot, (path) => `model://${packageName(doc.name)}/${path}`);
  const { pkg, files, warnings } = p;
  const sensorsByLink = new Map<string, string[]>();
  for (const s of p.sensors) {
    const list = sensorsByLink.get(s.link) ?? [];
    // In SDF the sensor sits in its link at its own pose, and its frame is the link's.
    list.push(sensorXml({ ...s, frame: s.link, pose: { xyz: s.xyz, rpy: s.rpy } }));
    sensorsByLink.set(s.link, list);
  }
  const links: SdfLink[] = p.links.map(({ frame, node: _n, ...l }) => ({ ...l, pose: frame.map((x) => x * M) as Vec3, sensors: sensorsByLink.get(l.name) }));
  // Loops close for real here, so a joint on a loop does not also follow another.
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
  const joints: SdfJoint[] = [...p.treeJoints, ...p.loopJoints].map((j) => {
    const childFrame = p.frames.get([...p.linkNames].find(([, n]) => n === j.child)![0])!;
    const parentFrame = p.frames.get([...p.linkNames].find(([, n]) => n === j.parent)![0])!;
    // The joint in its child's frame: its place in the parent's frame, carried over.
    const pose = j.origin.map((x, i) => x + (parentFrame[i] - childFrame[i]) * M) as Vec3;
    return { name: j.name, type: j.type, parent: j.parent, child: j.child, pose, axis: j.axis, limit: j.limit, dynamics: j.dynamics, ...(j.mimic && !onLoop.has(j.name) ? { mimic: j.mimic } : {}) };
  });
  const base = p.linkNames.get(robot.root!)!;
  const footprint = footprintOf(p, robot, links.map((l) => l.name));
  const plugins = [jointStateXml(), ...(p.drive ? [driveXml(gazeboDrive(p.drive, footprint?.name ?? base))] : [])];
  files.unshift(
    { name: 'model.config', bytes: encodeText(modelConfig(pkg, `${doc.name}, made with PlastikCAD`)) },
    { name: 'model.sdf', bytes: encodeText(writeSdf(p.robotName, links, joints, plugins, robot.base === 'fixed' ? p.linkNames.get(robot.root!) : undefined, footprint)) },
    { name: `worlds/${pkg}.sdf`, bytes: encodeText(worldXml(pkg, pkg)) },
    { name: 'README.md', bytes: encodeText(sdfReadme(pkg, doc.name, footprint)) },
  );
  return { name: pkg, files, warnings };
}

function sdfReadme(name: string, robot: string, footprint: { name: string; base: string } | undefined): string {
  return `# ${robot}

A Gazebo model made with PlastikCAD. With this folder's parent on Gazebo's
path, the world in \`worlds\` opens with the robot in it:

    export GZ_SIM_RESOURCE_PATH=$GZ_SIM_RESOURCE_PATH:$(pwd)/..
    gz sim worlds/${name}.sdf

Every joint is in \`model.sdf\`, loops included.${footprint ? ` The drive takes velocity
commands on the \`cmd_vel\` topic and publishes odometry against \`${footprint.name}\`,
a frame on \`${footprint.base}\` facing the robot's forward along +X as ROS expects:

    gz topic -t /cmd_vel -m gz.msgs.Twist -p 'linear: {x: 0.2}'` : ''}
`;
}

/**
 * The robot as a MuJoCo model: one XML with the bodies nested down the
 * tree, the meshes beside it. Loops are closed by pinning the two links of
 * each loop joint together at its point; followers by joint constraints.
 * A lidar becomes a fan of rangefinders, one ray each, up to MAX_LIDAR_RAYS.
 */
/** A lidar's rays in MuJoCo, at most: each is a ray cast every step, and a policy wants a coarse scan anyway. */
export const MAX_LIDAR_RAYS = 90;

export function buildMjcfModel(doc: Doc, geometry: Map<string, LinkGeometry>, robot: Robot = robotOf(doc)): MjcfPackage {
  const p = prepare(doc, geometry, robot, (path) => path);
  const { pkg, files, warnings } = p;
  const byName = new Map(p.links.map((l) => [l.name, l]));
  const childrenOf = new Map<string, UrdfJoint[]>();
  for (const j of p.treeJoints) childrenOf.set(j.parent, [...(childrenOf.get(j.parent) ?? []), j]);
  const sensorsOf = (link: string) => p.sensors.filter((s) => s.link === link);
  for (const s of p.sensors) if (s.kind === 'lidar' && s.lidar.samples > MAX_LIDAR_RAYS) warnings.push(`"${s.name}" sweeps ${s.lidar.samples} rays; MuJoCo gets ${MAX_LIDAR_RAYS} of them, spread over the same sweep, to keep it quick.`);
  const body = (name: string, joint: UrdfJoint | undefined): MjcfBody => {
    const l = byName.get(name)!;
    const cams = sensorsOf(name).filter((s) => s.kind === 'camera' || s.kind === 'depth');
    const imus = sensorsOf(name).filter((s) => s.kind === 'imu');
    const touches = sensorsOf(name).filter((s) => s.kind === 'touch');
    const lidars = sensorsOf(name).filter((s) => s.kind === 'lidar');
    return {
      name,
      pos: joint ? joint.origin : [0, 0, 0],
      inertial: l.inertial,
      visual: l.visual,
      collision: l.collision,
      friction: l.friction,
      joint: joint ? { name: joint.name, type: joint.type, axis: joint.axis, limit: joint.limit, dynamics: joint.dynamics, armature: joint.armature } : undefined,
      children: (childrenOf.get(name) ?? []).map((j) => body(j.child, j)),
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
    world: robot.world ?? 'flat',
    // A loop joint's origin is given in its parent's frame; the connect anchor is in the first body's frame.
    connects: p.loopJoints.map((j) => ({ body1: j.parent, body2: j.child, anchor: j.origin })),
    followers: [...p.treeJoints, ...p.loopJoints].filter((j) => j.mimic && p.treeJoints.some((t) => t.name === j.name)).map((j) => ({ joint: j.name, leader: j.mimic!.joint, multiplier: j.mimic!.multiplier, offset: j.mimic!.offset })),
    servos: [...p.controlled, ...(p.drive?.steer ?? [])],
    // The wheels get velocity motors; steering joints position servos, as the simulator has no plugin to turn them.
    wheels: p.drive?.wheels ?? [],
  };
  const collisions = p.links.map((l) => `${l.name}: ${linkOf(robot, l.node.id).collision}`);
  files.unshift({ name: `${pkg}.xml`, bytes: encodeText(writeMjcf(model)) }, { name: 'README.md', bytes: encodeText(mjcfReadme(pkg, doc.name, collisions, robot.scripts !== false, p.sensors.some((s) => s.kind === 'lidar'))) });
  if (robot.scripts !== false) {
    const kind = p.drive ? 'rover' : robot.base === 'fixed' ? 'arm' : 'walker';
    files.push({ name: 'drive.py', bytes: encodeText(drivePy(`${pkg}.xml`, kind)) }, { name: 'env.py', bytes: encodeText(envPy(`${pkg}.xml`)) }, { name: 'train.py', bytes: encodeText(trainPy()) });
  }
  // What drives what, for a script: the actuator of each part, and the geometry a velocity command needs.
  let drive: DriveSpec | null = null;
  if (p.drive) {
    const actuator = (joint: string) => (p.drive!.steer.includes(joint) ? `${joint}_servo` : `${joint}_motor`);
    const roles = Object.fromEntries(Object.entries(p.drive.roles).map(([role, joints]) => [role, (joints ?? []).map(actuator)]));
    const { kind, forward, wheelRadius, wheelSeparation, wheelBase, kingpinWidth, steeringLimit } = p.drive;
    drive = { kind, units: 'meters, radians', forward, roles, wheelRadius, wheelSeparation, wheelBase, kingpinWidth, steeringLimit };
    files.push({ name: 'drive.json', bytes: encodeText(JSON.stringify(drive, null, 2) + '\n') });
  }
  return {
    name: pkg,
    files,
    warnings,
    bodies: p.links.map((l) => ({ body: l.name, node: l.node.id, frame: l.frame })),
    joints: [...p.jointNames].map(([j, name]) => ({ name, id: j.id })),
    drive,
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
