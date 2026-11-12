// What stands between a robot and a file a simulator will load: errors stop
// the export, warnings are told and let through. Both are for what is broken
// or will misbehave in the file, never for how the robot might be designed
// better. Each problem points at the link or joint it is about, so the panel
// can take the user there.
import { tr } from '../i18n';
import type { Doc } from '../model/types';
import type { LinkProperties } from '../worker/protocol';
import { inertialOf, plausibleInertia } from './inertia';
import { boxBounds } from '../model/math';
import { followFault, jointInDesign, linkNodes, linkOf, robotOf, sensorInDesign, spanningTree } from './model';
import type { FollowFault } from './model';
import { withRole } from './types';
import type { Robot, RobotJoint } from './types';
import { lengthText, said } from '../units';

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

/** Why a follower's leader will not do, as the checks say it of the two joints by name. */
const FOLLOW_FAULTS: Record<FollowFault, (names: { name: string; leader: string }) => string> = {
  fixed: (names) => tr('{name}: follows {leader}, which is fixed and never moves. Follow a joint that moves.', names),
  loop: (names) => tr('{name}: follows {leader}, which closes a loop and is not a joint in every export. Follow a joint on the way from the base.', names),
  'left-out': (names) => tr('{name}: follows {leader}, which is left out of the robot. Follow a joint on the way from the base.', names),
  ring: (names) => tr('{name}: follows {leader}, which follows it in turn. Clear Follows on one of them.', names),
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
    error(tr('There is nothing to export: the design has no objects.'));
    return out;
  }
  if (!robot.root || !nodes.some((n) => n.id === robot.root)) error(tr('No base link is chosen. Pick the object the rest of the robot hangs from.'));

  const ids = new Set(nodes.map((n) => n.id));
  const tree = spanningTree(robot, [...ids]);
  if (robot.root && ids.has(robot.root)) {
    for (const id of tree.unreached) warn(tr('{name}: not joined to the base, so it is left out.', { name: nameOf(id) }), { link: id });
  }
  for (const j of tree.loops) warn(tr('{name}: closes a loop. Kept in SDF and MuJoCo, left out of URDF.', { name: j.name }), { joint: j.id });

  const jointById = new Map(robot.joints.map((j) => [j.id, j]));
  for (const j of robot.joints) {
    if (!ids.has(j.parent) || !ids.has(j.child)) {
      error(tr('"{name}" joins an object that is hidden, a hole or gone.', { name: j.name }), { joint: j.id });
      continue;
    }
    if (j.parent === j.child) error(tr('"{name}" joins "{link}" to itself.', { name: j.name, link: nameOf(j.child) }), { joint: j.id });
    if (j.type !== 'fixed' && !j.axis.some((x) => x !== 0)) error(tr('"{name}" has no axis.', { name: j.name }), { joint: j.id });
    if ((j.type === 'revolute' || j.type === 'prismatic') && !(j.lower < j.upper)) error(tr('"{name}": the lower limit must be below the upper one.', { name: j.name }), { joint: j.id });
    // A simulator pushes a joint that begins past a limit back inside it at once, hard enough to throw the robot over.
    if ((j.type === 'revolute' || j.type === 'prismatic') && j.lower < j.upper && !j.mimic && ((j.start ?? 0) < j.lower || (j.start ?? 0) > j.upper)) error(j.start === undefined ? tr('"{name}" is outside its limits as designed. Give it a start inside them.', { name: j.name }) : tr('"{name}" starts outside its limits.', { name: j.name }), { joint: j.id });
    if (j.type !== 'fixed' && !(j.effort > 0 && j.velocity > 0)) warn(tr('{name}: Effort or Velocity is 0, so nothing can move it.', { name: j.name }), { joint: j.id });
    if (j.mimic) {
      const leader = jointById.get(j.mimic.joint);
      if (j.mimic.joint === j.id) error(tr('"{name}" follows itself.', { name: j.name }), { joint: j.id });
      else if (!leader) error(tr('"{name}" follows a joint that is gone.', { name: j.name }), { joint: j.id });
      else if (j.type !== 'fixed') {
        // A fixed joint's Follows is not written. Any other is written against its leader's name, which the file must then hold as a joint that moves.
        const fault = followFault(robot, tree, j, leader);
        if (fault) error(FOLLOW_FAULTS[fault]({ name: j.name, leader: leader.name }), { joint: j.id });
      }
    }
  }

  // The floor is where the robot's lowest point rests: the simulators drop it there. A sensor that reads the floor is
  // reading what is there; only a camera whose near plane clips the floor out of its picture gets empty pixels.
  const floor = Math.min(...nodes.map((n) => boxBounds(n).min[2]));
  for (const x of robot.sensors) {
    const host = nodes.find((n) => n.id === x.link);
    if (!host) {
      error(tr('The sensor "{name}" sits on an object that is hidden, a hole or gone.', { name: x.name }), { sensor: x.id });
      continue;
    }
    if ((x.kind === 'camera' || x.kind === 'depth') && !(x.camera.near < x.camera.far)) error(tr('"{name}" sees nothing: its nearest distance must be below its farthest.', { name: x.name }), { sensor: x.id });
    if (x.kind === 'lidar' && !(x.lidar.min < x.lidar.max)) error(tr('"{name}" sees nothing: its nearest range must be below its farthest.', { name: x.name }), { sensor: x.id });
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
      if (nearest < x.camera.near) warn(said((unit) => tr("{name}: the floor is {distance} away at the picture's edge, inside the {near} near clip. Raise it, tilt it up or lower Nearest.", { name: x.name, distance: lengthText(nearest, unit, 0), near: lengthText(x.camera.near, unit, 0) })), { sensor: x.id });
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
        if (j.type !== 'revolute') error(tr('"{name}" steers, so it must be a revolute joint with limits.', { name: j.name }), { joint: j.id });
      } else if (j.type !== 'continuous' && j.type !== 'revolute') error(tr('"{name}" drives a wheel but does not turn.', { name: j.name }), { joint: j.id });
      if (j.mimic) error(tr('"{name}" is in the drive and follows another joint; it cannot do both.', { name: j.name }), { joint: j.id });
    }
    if (drive.kind === 'differential' && (count('left') === 0 || count('right') === 0)) error(tr('The drive needs at least one wheel joint on each side.'));
    if (drive.kind === 'ackermann' && (count('left') === 0 || count('right') === 0 || count('steer-left') !== 1 || count('steer-right') !== 1)) error(tr('An Ackermann drive needs a driven wheel on each side and one steering joint on each side.'));
    if (drive.kind === 'mecanum' && (['front-left', 'front-right', 'rear-left', 'rear-right'] as const).some((r) => count(r) !== 1)) error(tr('A mecanum drive needs one wheel at each corner.'));
    // The drive controller turns every wheel about one axle direction; a wheel turned another way drags.
    // A wheel whose object is hidden, a hole or gone has no axle to compare; its joint is faulted above.
    const wheels = Object.entries(drive.roles).filter(([, role]) => !role.startsWith('steer')).map(([id]) => joint(id)).filter((j): j is RobotJoint => Boolean(j));
    const axles = wheels.flatMap((j) => {
      const child = nodes.find((n) => n.id === j.child);
      return child ? [jointInDesign(j, child).axis] : [];
    });
    if (axles.some((a) => Math.abs(a[0] * axles[0][0] + a[1] * axles[0][1] + a[2] * axles[0][2]) < Math.cos((5 * Math.PI) / 180))) warn(tr('Drive: the wheel axles do not all run the same way, so a wheel will drag.'));
  }
  if (robot.base === 'fixed' && robot.drive) warn(tr('Base: fixed to the world, so the drive cannot move it.'));

  for (const node of nodes) {
    const link = linkOf(robot, node.id);
    const p = props.get(node.id);
    if (!p) continue;
    const { mass, inertia, typed } = inertialOf(link.mass, node, p);
    // Nothing is estimated for a link whose mass, center and inertia were all typed.
    if (!p.watertight && !(link.mass.kind === 'measured' && typed.center && typed.inertia)) warn(tr('{name}: not a closed mesh, so its mass and inertia are estimates.', { name: node.name }), { link: node.id });
    if (!(mass > 0)) {
      if (link.mass.kind === 'material' && !(p.volume > 0)) error(tr('"{name}" has no volume to weigh; give it a measured mass.', { name: node.name }), { link: node.id });
      else error(tr('"{name}" has no mass.', { name: node.name }), { link: node.id });
    } else if (!plausibleInertia(inertia)) {
      if (typed.inertia) error(tr('"{name}" has a typed inertia no real body could have.', { name: node.name }), { link: node.id });
      else error(tr('"{name}" has an inertia no real body could have (is it flat or very thin?).', { name: node.name }), { link: node.id });
    }
    if (link.collision === 'mesh' && p.triangles > HEAVY_COLLISION) warn(tr('{name}: {count} triangles as an exact collision mesh will be slow. A hull is close.', { name: node.name, count: p.triangles }), { link: node.id });
  }
  return out;
}
