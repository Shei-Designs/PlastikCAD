// Puts a robot together as a ROS 2 package: the URDF, a mesh file per link
// for looks and one for collisions, and the files that make the folder a
// package with launch files. Pure: the kernel's answers come in, files go out.
import type { MeshData } from '../geometry/mesh';
import type { Doc, Vec3 } from '../model/types';
import { encodeText } from '../io/format';
import { writeObj } from '../io/obj';
import { cmakeLists, displayLaunch, gazeboLaunch, packageXml, readme, rvizConfig } from '../io/rosPackage';
import { writeStl } from '../io/stl';
import { uniqueNames, urdfName, writeUrdf } from '../io/urdf';
import type { UrdfJoint, UrdfLink, UrdfShape } from '../io/urdf';
import type { LinkGeometry } from '../worker/protocol';
import { massOf, tensorOf, toSI } from './inertia';
import type { Tensor } from './inertia';
import { jointInDesign, linkNodes, linkOf, robotOf, spanningTree } from './model';
import type { Robot } from './types';

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

/** The name a robot is exported under: a ROS package name, lowercase. */
export const packageName = (robot: Robot): string => urdfName(robot.name, 'robot').toLowerCase();

/**
 * Every link's frame is parallel to the design's axes, so no file carries a
 * rotation: the base link's frame is the design's origin and each other link's
 * sits at the joint that carries it, with the link's meshes written in that
 * frame. `geometry` is what the kernel made of each link, by node id.
 */
export function buildRobotPackage(doc: Doc, geometry: Map<string, LinkGeometry>, robot: Robot = robotOf(doc)): RobotPackage {
  const warnings: string[] = [];
  const nodes = linkNodes(doc.scene);
  const tree = spanningTree(robot, nodes.map((n) => n.id));
  if (tree.order.length === 0) throw new Error('The robot has no base link.');
  const pkg = packageName(robot);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const linkNames = uniqueNames(tree.order, (id) => urdfName(linkOf(robot, id).name ?? nodeById.get(id)!.name));
  const treeJoints = tree.order.slice(1).map((id) => tree.parentJoint.get(id)!);
  const jointNames = uniqueNames(treeJoints, (j) => urdfName(j.name, 'joint'));
  // Each joint as it sits in the design, and where each link's frame is there (mm).
  const placedJoints = new Map(treeJoints.map((j) => [j.id, jointInDesign(j, nodeById.get(j.child)!)]));
  const frames = new Map<string, Vec3>();
  for (const id of tree.order) frames.set(id, id === robot.root ? [0, 0, 0] : placedJoints.get(tree.parentJoint.get(id)!.id)!.origin);
  for (const j of tree.loops) warnings.push(`"${j.name}" closes a loop and was left out of the URDF.`);

  const files: PackageFile[] = [];
  const links: UrdfLink[] = [];
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
      visual.push({ geometry: { mesh: `package://${pkg}/meshes/visual/${name}.obj` }, color: rgb(geo.visual[0].color) });
    }
    if (link.collision === 'box' || link.collision === 'cylinder' || link.collision === 'sphere') {
      // The object's own box, where it stands and turned as it is (URDF's roll, pitch, yaw are the design's X, Y, Z turns).
      const origin = node.pos.map((x, i) => (x - frame[i]) * M) as Vec3;
      const rpy = node.rot.map((d) => (d * Math.PI) / 180) as Vec3;
      const size = node.size.map((x) => x * M) as Vec3;
      const geometry =
        link.collision === 'box' ? { box: size } : link.collision === 'cylinder' ? { cylinder: { radius: Math.max(size[0], size[1]) / 2, length: size[2] } } : { sphere: { radius: Math.max(...size) / 2 } };
      collision.push({ geometry, origin, rpy });
    } else if (link.collision !== 'none' && geo.collision) {
      files.push({ name: `meshes/collision/${name}.stl`, bytes: writeStl(inFrame(geo.collision, frame), name, 'm') });
      collision.push({ geometry: { mesh: `package://${pkg}/meshes/collision/${name}.stl` } });
    }
    const mass = massOf(link.mass, geo.props);
    let inertial: UrdfLink['inertial'] = null;
    if (mass > 0 && geo.props.volume > 0) {
      inertial = { mass: mass / 1000, origin: geo.props.centroid.map((x, i) => (x - frame[i]) * M) as Vec3, inertia: tensorOf(mass, geo.props.unit).map(toSI) as Tensor };
    } else {
      warnings.push(`"${node.name}" has no mass or volume; it was written without inertia, which a simulator may reject.`);
    }
    if (!geo.props.watertight) warnings.push(`"${node.name}" is not a closed mesh; its inertia is an estimate.`);
    links.push({ name, inertial, visual, collision, friction: link.friction });
  }

  const joints: UrdfJoint[] = treeJoints.map((j) => {
    const parentFrame = frames.get(j.parent)!;
    const placed = placedJoints.get(j.id)!;
    const scale = j.type === 'prismatic' ? M : RAD;
    const mimic = j.mimic && jointNames.has(robot.joints.find((o) => o.id === j.mimic!.joint)!) ? { joint: jointNames.get(robot.joints.find((o) => o.id === j.mimic!.joint)!)!, multiplier: j.mimic.multiplier, offset: j.mimic.offset * scale } : undefined;
    return {
      name: jointNames.get(j)!,
      type: j.type,
      parent: linkNames.get(j.parent)!,
      child: linkNames.get(j.child)!,
      origin: placed.origin.map((x, i) => (x - parentFrame[i]) * M) as Vec3,
      axis: placed.axis,
      limit: j.type === 'fixed' ? undefined : { lower: j.lower * scale, upper: j.upper * scale, effort: j.effort, velocity: j.velocity * scale },
      dynamics: j.type === 'fixed' ? undefined : { damping: j.damping, friction: j.friction },
      ...(mimic ? { mimic } : {}),
    };
  });

  const robotName = urdfName(robot.name, 'robot');
  files.unshift(
    { name: 'package.xml', bytes: encodeText(packageXml(pkg, `${robot.name} robot description`)) },
    { name: 'CMakeLists.txt', bytes: encodeText(cmakeLists(pkg)) },
    { name: 'README.md', bytes: encodeText(readme(pkg, robot.name)) },
    { name: `urdf/${pkg}.urdf`, bytes: encodeText(writeUrdf(robotName, links, joints)) },
    { name: 'launch/display.launch.py', bytes: encodeText(displayLaunch(pkg)) },
    { name: 'launch/gazebo.launch.py', bytes: encodeText(gazeboLaunch(pkg)) },
    { name: 'rviz/display.rviz', bytes: encodeText(rvizConfig(linkNames.get(robot.root!)!)) },
  );
  return { name: pkg, files, warnings };
}
