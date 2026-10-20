// What stands between a robot and a file a simulator will load: errors stop
// the export, warnings are told and let through. Each problem points at the
// link or joint it is about, so the panel can take the user there.
import type { Doc } from '../model/types';
import type { LinkProperties } from '../worker/protocol';
import { massOf, plausibleInertia, tensorOf } from './inertia';
import { linkNodes, linkOf, robotOf, spanningTree } from './model';
import type { Robot } from './types';

export interface Problem {
  level: 'error' | 'warning';
  text: string;
  /** Node id of the link it is about. */
  link?: string;
  /** Id of the joint it is about. */
  joint?: string;
  /** Id of the sensor it is about. */
  sensor?: string;
}

/** The collision mesh past which a simulator slows down noticeably. */
export const HEAVY_COLLISION = 20_000;

/**
 * Checks the robot against its design. `props` are the mass properties the
 * kernel has found so far, by node id; a link without them is not weighed.
 */
export function checkRobot(doc: Doc, props: Map<string, LinkProperties>, robot: Robot = robotOf(doc)): Problem[] {
  const out: Problem[] = [];
  const error = (text: string, at: { link?: string; joint?: string; sensor?: string } = {}) => out.push({ level: 'error', text, ...at });
  const warn = (text: string, at: { link?: string; joint?: string; sensor?: string } = {}) => out.push({ level: 'warning', text, ...at });
  const nodes = linkNodes(doc.scene);
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? 'an object';
  if (nodes.length === 0) {
    error('There is nothing to export: the design has no objects.');
    return out;
  }
  if (!robot.root || !nodes.some((n) => n.id === robot.root)) error('No base link is chosen. Pick the object the rest of the robot hangs from.');
  if (!robot.name.trim()) warn('The robot has no name; it will be called "robot".');

  const ids = new Set(nodes.map((n) => n.id));
  const tree = spanningTree(robot, [...ids]);
  if (robot.root && ids.has(robot.root)) {
    for (const id of tree.unreached) error(`"${nameOf(id)}" is not joined to the base by any chain of joints.`, { link: id });
  }
  for (const j of tree.loops) warn(`"${j.name}" closes a loop. SDF keeps it; URDF cannot, so there it is left out, and the passive joints should follow the driven one (mimic).`, { joint: j.id });

  const jointIds = new Set(robot.joints.map((j) => j.id));
  for (const j of robot.joints) {
    if (!ids.has(j.parent) || !ids.has(j.child)) {
      error(`"${j.name}" joins an object that is hidden, a hole or gone.`, { joint: j.id });
      continue;
    }
    if (j.parent === j.child) error(`"${j.name}" joins "${nameOf(j.child)}" to itself.`, { joint: j.id });
    if (j.type !== 'fixed' && !j.axis.some((x) => x !== 0)) error(`"${j.name}" has no axis.`, { joint: j.id });
    if ((j.type === 'revolute' || j.type === 'prismatic') && !(j.lower < j.upper)) error(`"${j.name}": the lower limit must be below the upper one.`, { joint: j.id });
    if (j.type !== 'fixed' && !(j.effort > 0 && j.velocity > 0)) warn(`"${j.name}" has no effort or no velocity, so a controller cannot move it.`, { joint: j.id });
    if (j.mimic) {
      if (j.mimic.joint === j.id) error(`"${j.name}" follows itself.`, { joint: j.id });
      else if (!jointIds.has(j.mimic.joint)) error(`"${j.name}" follows a joint that is gone.`, { joint: j.id });
    }
  }

  for (const x of robot.sensors) {
    if (!ids.has(x.link)) error(`The sensor "${x.name}" sits on an object that is hidden, a hole or gone.`, { sensor: x.id });
    if ((x.kind === 'camera' || x.kind === 'depth') && !(x.camera.near < x.camera.far)) error(`"${x.name}" sees nothing: its nearest distance must be below its farthest.`, { sensor: x.id });
    if (x.kind === 'lidar' && !(x.lidar.min < x.lidar.max)) error(`"${x.name}" sees nothing: its nearest range must be below its farthest.`, { sensor: x.id });
  }
  if (robot.drive) {
    const wheel = (id: string) => robot.joints.find((j) => j.id === id);
    if (robot.drive.left.length === 0 || robot.drive.right.length === 0) error('The drive needs at least one wheel joint on each side.');
    for (const id of [...robot.drive.left, ...robot.drive.right]) {
      const j = wheel(id);
      if (!j) continue;
      if (j.type !== 'continuous' && j.type !== 'revolute') error(`"${j.name}" drives a wheel but does not turn.`, { joint: j.id });
      if (j.mimic) error(`"${j.name}" drives a wheel and follows another joint; it cannot do both.`, { joint: j.id });
    }
    if (robot.drive.left.some((id) => robot.drive!.right.includes(id))) error('A wheel joint is on both sides of the drive.');
  }

  for (const node of nodes) {
    const link = linkOf(robot, node.id);
    const p = props.get(node.id);
    if (!p) continue;
    if (!p.watertight) warn(`"${node.name}" is not a closed mesh: its volume and inertia are estimates from an open surface.`, { link: node.id });
    const mass = massOf(link.mass, p);
    if (!(mass > 0)) {
      if (link.mass.kind === 'material' && !(p.volume > 0)) error(`"${node.name}" has no volume to weigh; give it a measured mass.`, { link: node.id });
      else error(`"${node.name}" has no mass.`, { link: node.id });
    } else if (!plausibleInertia(tensorOf(mass, p.unit))) {
      error(`"${node.name}" has an inertia no real body could have (is it flat or very thin?).`, { link: node.id });
    }
    if (link.collision === 'mesh' && p.triangles > HEAVY_COLLISION) warn(`"${node.name}" has ${p.triangles.toLocaleString()} triangles as an exact collision mesh, which will be slow; a hull is close.`, { link: node.id });
  }
  return out;
}
