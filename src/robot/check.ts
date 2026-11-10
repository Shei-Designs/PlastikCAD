// What stands between a robot and a file a simulator will load: errors stop
// the export, warnings are told and let through. Both are for what is broken
// or will misbehave in the file, never for how the robot might be designed
// better. Each problem points at the link or joint it is about, so the panel
// can take the user there.
import type { Doc } from '../model/types';
import type { LinkProperties } from '../worker/protocol';
import { massOf, plausibleInertia, tensorOf } from './inertia';
import { boxBounds } from '../model/math';
import { followFault, jointInDesign, linkNodes, linkOf, robotOf, sensorInDesign, spanningTree } from './model';
import type { FollowFault } from './model';
import { withRole } from './types';
import type { Robot, RobotJoint } from './types';

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

/** Why a follower's leader will not do, as the checks say it after the two joints' names. */
const FOLLOW_FAULTS: Record<FollowFault, string> = {
  fixed: 'which is fixed and never moves. Follow a joint that moves.',
  loop: 'which closes a loop and is not a joint in every export. Follow a joint on the way from the base.',
  'left-out': 'which is left out of the robot. Follow a joint on the way from the base.',
  ring: 'which follows it in turn. Clear Follows on one of them.',
};

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

  const ids = new Set(nodes.map((n) => n.id));
  const tree = spanningTree(robot, [...ids]);
  if (robot.root && ids.has(robot.root)) {
    for (const id of tree.unreached) warn(`${nameOf(id)}: not joined to the base, so it is left out.`, { link: id });
  }
  for (const j of tree.loops) warn(`${j.name}: closes a loop. Kept in SDF and MuJoCo, left out of URDF.`, { joint: j.id });

  const jointById = new Map(robot.joints.map((j) => [j.id, j]));
  for (const j of robot.joints) {
    if (!ids.has(j.parent) || !ids.has(j.child)) {
      error(`"${j.name}" joins an object that is hidden, a hole or gone.`, { joint: j.id });
      continue;
    }
    if (j.parent === j.child) error(`"${j.name}" joins "${nameOf(j.child)}" to itself.`, { joint: j.id });
    if (j.type !== 'fixed' && !j.axis.some((x) => x !== 0)) error(`"${j.name}" has no axis.`, { joint: j.id });
    if ((j.type === 'revolute' || j.type === 'prismatic') && !(j.lower < j.upper)) error(`"${j.name}": the lower limit must be below the upper one.`, { joint: j.id });
    if (j.type !== 'fixed' && !(j.effort > 0 && j.velocity > 0)) warn(`${j.name}: Effort or Velocity is 0, so nothing can move it.`, { joint: j.id });
    if (j.mimic) {
      const leader = jointById.get(j.mimic.joint);
      if (j.mimic.joint === j.id) error(`"${j.name}" follows itself.`, { joint: j.id });
      else if (!leader) error(`"${j.name}" follows a joint that is gone.`, { joint: j.id });
      else if (j.type !== 'fixed') {
        // A fixed joint's Follows is not written. Any other is written against its leader's name, which the file must then hold as a joint that moves.
        const fault = followFault(robot, tree, j, leader);
        if (fault) error(`${j.name}: follows ${leader.name}, ${FOLLOW_FAULTS[fault]}`, { joint: j.id });
      }
    }
  }

  // The floor is where the robot's lowest point rests: the simulators drop it there. A sensor that reads the floor is
  // reading what is there; only a camera whose near plane clips the floor out of its picture gets empty pixels.
  const floor = Math.min(...nodes.map((n) => boxBounds(n).min[2]));
  for (const x of robot.sensors) {
    const host = nodes.find((n) => n.id === x.link);
    if (!host) {
      error(`The sensor "${x.name}" sits on an object that is hidden, a hole or gone.`, { sensor: x.id });
      continue;
    }
    if ((x.kind === 'camera' || x.kind === 'depth') && !(x.camera.near < x.camera.far)) error(`"${x.name}" sees nothing: its nearest distance must be below its farthest.`, { sensor: x.id });
    if (x.kind === 'lidar' && !(x.lidar.min < x.lidar.max)) error(`"${x.name}" sees nothing: its nearest range must be below its farthest.`, { sensor: x.id });
    const { origin, matrix } = sensorInDesign(x, host);
    const height = origin[2] - floor;
    if (x.kind === 'camera' || x.kind === 'depth') {
      // The floor must not come inside the near plane anywhere in the picture, or those pixels read nothing (-inf in a depth
      // picture). The near plane clips on depth along the line of sight, so each ray round the picture's edge is followed to
      // the floor and its depth measured along the camera's X.
      const tx = Math.tan((x.camera.hfov * Math.PI) / 360);
      const ty = (tx * x.camera.height) / x.camera.width;
      const edge = [[tx, ty], [-tx, ty], [tx, -ty], [-tx, -ty], [0, ty], [0, -ty], [tx, 0], [-tx, 0]];
      let nearest = Infinity;
      for (const [sy, sz] of edge) {
        const n = Math.hypot(1, sy, sz);
        // The ray in the design: the camera's X forward, Y left, Z up, as its frame turns them.
        const dz = (matrix[2] + sy * matrix[5] + sz * matrix[8]) / n;
        if (dz >= 0) continue;
        nearest = Math.min(nearest, (height / -dz) * (1 / n));
      }
      if (nearest < x.camera.near) warn(`${x.name}: the floor is ${Math.round(nearest)} mm away at the picture's edge, inside the ${x.camera.near} mm near clip. Raise it, tilt it up or lower Nearest.`, { sensor: x.id });
    }
  }
  if (robot.drive) {
    const drive = robot.drive;
    const joint = (id: string) => robot.joints.find((j) => j.id === id);
    const count = (role: Parameters<typeof withRole>[1]) => withRole(drive, role).filter(joint).length;
    for (const [id, role] of Object.entries(drive.roles)) {
      const j = joint(id);
      if (!j) continue;
      if (role.startsWith('steer')) {
        if (j.type !== 'revolute') error(`"${j.name}" steers, so it must be a revolute joint with limits.`, { joint: j.id });
      } else if (j.type !== 'continuous' && j.type !== 'revolute') error(`"${j.name}" drives a wheel but does not turn.`, { joint: j.id });
      if (j.mimic) error(`"${j.name}" is in the drive and follows another joint; it cannot do both.`, { joint: j.id });
    }
    if (drive.kind === 'differential' && (count('left') === 0 || count('right') === 0)) error('The drive needs at least one wheel joint on each side.');
    if (drive.kind === 'ackermann' && (count('left') === 0 || count('right') === 0 || count('steer-left') !== 1 || count('steer-right') !== 1)) error('An Ackermann drive needs a driven wheel on each side and one steering joint on each side.');
    if (drive.kind === 'mecanum' && (['front-left', 'front-right', 'rear-left', 'rear-right'] as const).some((r) => count(r) !== 1)) error('A mecanum drive needs one wheel at each corner.');
    // The drive controller turns every wheel about one axle direction; a wheel turned another way drags.
    // A wheel whose object is hidden, a hole or gone has no axle to compare; its joint is faulted above.
    const wheels = Object.entries(drive.roles).filter(([, role]) => !role.startsWith('steer')).map(([id]) => joint(id)).filter((j): j is RobotJoint => Boolean(j));
    const axles = wheels.flatMap((j) => {
      const child = nodes.find((n) => n.id === j.child);
      return child ? [jointInDesign(j, child).axis] : [];
    });
    if (axles.some((a) => Math.abs(a[0] * axles[0][0] + a[1] * axles[0][1] + a[2] * axles[0][2]) < Math.cos((5 * Math.PI) / 180))) warn('Drive: the wheel axles do not all run the same way, so a wheel will drag.');
  }
  if (robot.base === 'fixed' && robot.drive) warn('Base: fixed to the world, so the drive cannot move it.');

  for (const node of nodes) {
    const link = linkOf(robot, node.id);
    const p = props.get(node.id);
    if (!p) continue;
    if (!p.watertight) warn(`${node.name}: not a closed mesh, so its mass and inertia are estimates.`, { link: node.id });
    const mass = massOf(link.mass, p);
    if (!(mass > 0)) {
      if (link.mass.kind === 'material' && !(p.volume > 0)) error(`"${node.name}" has no volume to weigh; give it a measured mass.`, { link: node.id });
      else error(`"${node.name}" has no mass.`, { link: node.id });
    } else if (!plausibleInertia(tensorOf(mass, p.unit))) {
      error(`"${node.name}" has an inertia no real body could have (is it flat or very thin?).`, { link: node.id });
    }
    if (link.collision === 'mesh' && p.triangles > HEAVY_COLLISION) warn(`${node.name}: ${p.triangles.toLocaleString()} triangles as an exact collision mesh will be slow. A hull is close.`, { link: node.id });
  }
  return out;
}
