// What stands between a robot and a file a simulator will load: errors stop
// the export, warnings are told and let through. Each problem points at the
// link or joint it is about, so the panel can take the user there.
import type { Doc } from '../model/types';
import type { LinkProperties } from '../worker/protocol';
import { jointFit } from './defaults';
import { massOf, plausibleInertia, tensorOf } from './inertia';
import { boxBounds } from '../model/math';
import { jointInDesign, linkNodes, linkOf, robotOf, sensorInDesign, spanningTree } from './model';
import { motorOf } from './motors';
import { DRIVE_KINDS, withRole } from './types';
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

/** The collision mesh past which a simulator slows down noticeably. */
export const HEAVY_COLLISION = 20_000;
/** A level lidar lower than this share of its range grazes the floor at the far end (the reference rover's 360° lidar 45 mm up read the floor at 5.8 m of 6). */
export const LOW_LIDAR = 0.01;

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
    // A motor a hundred times stronger, or damping a hundred times stiffer, than the parts ask for: a simulator blows up or stalls.
    if (j.type === 'revolute' || j.type === 'continuous') {
      const child = nodes.find((n) => n.id === j.child)!;
      const fit = jointFit(robot, nodes, j, (n) => {
        const p = props.get(n.id);
        return p ? massOf(linkOf(robot, n.id).mass, p) : null;
      });
      const about = (x: number) => Number(x.toPrecision(2));
      if (j.effort > 100 * fit.effort) warn(`"${j.name}" is far stronger than "${child.name}" needs (${about(j.effort)} N·m where about ${about(fit.effort)} would do): simulators will misbehave or hold it back. Set the motor's real torque.`, { joint: j.id });
      if (j.damping > 100 * fit.damping) warn(`"${j.name}" is damped far too stiffly for "${child.name}" (${about(j.damping)} N·m·s where about ${about(fit.damping)} would do): it will barely move.`, { joint: j.id });
    }
    if (j.mimic) {
      if (j.mimic.joint === j.id) error(`"${j.name}" follows itself.`, { joint: j.id });
      else if (!jointIds.has(j.mimic.joint)) error(`"${j.name}" follows a joint that is gone.`, { joint: j.id });
    }
  }

  // The floor is where the robot's lowest point rests: the simulators drop it there.
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
      if (nearest < x.camera.near) warn(`"${x.name}" sits ${Math.round(height)} mm above the floor and sees it ${Math.round(nearest)} mm deep at the edge of its picture, inside its ${x.camera.near} mm near distance, so those pixels read nothing. Raise it, look up, or bring the near distance in.`, { sensor: x.id });
    } else if (x.kind === 'lidar' && x.lidar.min < x.lidar.max) {
      // A sweep tipped toward the floor meets it within range; a level sweep grazes it when mounted very low.
      const axis = [matrix[6], matrix[7], matrix[8]];
      const tilt = Math.acos(Math.max(-1, Math.min(1, Math.abs(axis[2]))));
      if (tilt < Math.PI / 4) {
        const ahead = tilt > 1e-6 ? height / Math.sin(tilt) : Infinity;
        if (ahead < x.lidar.max) warn(`"${x.name}" is tipped ${Math.round((tilt * 180) / Math.PI)}°, so its sweep meets the floor ${Math.round(ahead)} mm out, inside its ${x.lidar.max} mm range; those rays read the floor, not the room. Level it or shorten the range.`, { sensor: x.id });
        else if (height < x.lidar.max * LOW_LIDAR) warn(`"${x.name}" sits only ${Math.round(height)} mm above the floor for a ${x.lidar.max} mm range; a level sweep that low grazes the floor at the far end. Raise it or shorten the range.`, { sensor: x.id });
      }
    }
  }
  if (robot.drive) {
    const drive = robot.drive;
    const kind = DRIVE_KINDS.find((k) => k.id === drive.kind)!;
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
    if (kind.id === 'differential' && (count('left') === 0 || count('right') === 0)) error('The drive needs at least one wheel joint on each side.');
    if (kind.id === 'ackermann' && (count('left') === 0 || count('right') === 0 || count('steer-left') !== 1 || count('steer-right') !== 1)) error('An Ackermann drive needs a driven wheel on each side and one steering joint on each side.');
    if (kind.id === 'mecanum' && (['front-left', 'front-right', 'rear-left', 'rear-right'] as const).some((r) => count(r) !== 1)) error('A mecanum drive needs one wheel at each corner.');
    // The wheels' axles should run the same way; a wheel turned another way drags.
    const wheels = Object.entries(drive.roles).filter(([, role]) => !role.startsWith('steer')).map(([id]) => joint(id)).filter((j): j is RobotJoint => Boolean(j));
    const axles = wheels.map((j) => jointInDesign(j, nodes.find((n) => n.id === j.child)!).axis);
    if (axles.some((a) => Math.abs(a[0] * axles[0][0] + a[1] * axles[0][1] + a[2] * axles[0][2]) < Math.cos((5 * Math.PI) / 180))) warn("The drive wheels' axles do not all run the same way; a wheel turned differently will drag.");
    // The wheels of one drive should be set alike: a wheel that drags more, or is driven differently, pulls the robot to one side.
    const unlike = (what: string, pick: (j: RobotJoint) => string | number | undefined, show: (v: string | number | undefined) => string) => {
      const first = wheels[0];
      const odd = wheels.find((j) => pick(j) !== pick(first));
      if (odd) warn(`"${odd.name}" is not set like the other drive wheels: its ${what} is ${show(pick(odd))} where "${first.name}" has ${show(pick(first))}, so the robot will pull to one side.`, { joint: odd.id });
    };
    if (wheels.length > 1) {
      unlike('motor', (j) => j.motor ?? `${j.effort} N·m at ${j.velocity}°/s`, (v) => (typeof v === 'string' ? (motorOf(v)?.name ?? v) : String(v)));
      unlike('joint friction', (j) => j.friction, (v) => `${v} N·m`);
      unlike('damping', (j) => j.damping, (v) => `${v} N·m·s`);
    }
  }
  if (robot.base === 'free' && !robot.drive && robot.joints.some((j) => j.type === 'continuous')) warn('The base is free to move but nothing drives it: give the wheel joints their parts under Drive, or fix the base for an arm.');
  if (robot.base === 'fixed' && robot.drive) warn('The base is fixed to the world, so the wheels cannot move it.');

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
