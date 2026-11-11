// Reading a robot against its design: which objects are links, what each
// link's settings are, and how the joints hang the links from the base.
import { apply, eulerOf, frameMatrix, invert, multiply, rotation } from '../model/math';
import type { Bounds, Mat } from '../model/math';
import type { Doc, Scene, SceneNode, Vec3 } from '../model/types';
import { defaultLink, emptyRobot } from './types';
import type { DriveKind, DriveRole, Robot, RobotJoint, RobotLink, RobotSensor } from './types';

/** The objects that are links: every top-level solid that is shown. Holes cut nothing at the top level, and pictures are flat. */
export const linkNodes = (scene: Scene): SceneNode[] => scene.filter((n) => !n.hidden && !n.hole && n.type !== 'picture');

/** The design's robot, or an untouched one named after the design. */
export const robotOf = (doc: Doc): Robot => doc.robot ?? emptyRobot();

/** A link's settings, the defaults for an object nobody has touched. */
export const linkOf = (robot: Robot, node: string): RobotLink => robot.links.find((l) => l.node === node) ?? defaultLink(node);

/** The robot with every link and joint that names an object the scene no longer has left off. The same object when nothing changes. */
export function pruned(robot: Robot, scene: Scene): Robot {
  const ids = new Set(scene.map((n) => n.id));
  const links = robot.links.filter((l) => ids.has(l.node));
  const joints = robot.joints.filter((j) => ids.has(j.parent) && ids.has(j.child));
  const jointIds = new Set(joints.map((j) => j.id));
  const followers = joints.map((j) => (j.mimic && !jointIds.has(j.mimic.joint) ? { ...j, mimic: undefined } : j));
  const root = robot.root && ids.has(robot.root) ? robot.root : null;
  const sensors = robot.sensors.filter((x) => ids.has(x.link));
  const drive = robot.drive && { kind: robot.drive.kind, roles: Object.fromEntries(Object.entries(robot.drive.roles).filter(([id]) => jointIds.has(id))) };
  const sameDrive = !robot.drive || Object.keys(drive!.roles).length === Object.keys(robot.drive.roles).length;
  if (links.length === robot.links.length && joints.length === robot.joints.length && followers.every((j, i) => j === joints[i]) && root === robot.root && sensors.length === robot.sensors.length && sameDrive) return robot;
  return { ...robot, root, links, joints: followers.map((j) => (j.mimic === undefined ? stripMimic(j) : j)), sensors, ...(drive ? { drive } : {}) };
}

/** A sensor's place in the design: its origin and the frame it is turned to (its X looks along the first column), from the link's frame. */
export function sensorInDesign(sensor: RobotSensor, link: SceneNode): { origin: Vec3; matrix: Mat } {
  const frame = frameMatrix(link);
  const turned = multiply(rotation(link.rot), rotation(sensor.rot));
  return { origin: apply(frame, sensor.origin), matrix: [...turned.slice(0, 9), ...apply(frame, sensor.origin)] as Mat };
}

/** The other way: a place in the design and a turn (as Euler degrees in the design), as the link's frame has them. */
export function sensorInLink(origin: Vec3, rot: Vec3, link: SceneNode): { origin: Vec3; rot: Vec3 } {
  const back = invert(frameMatrix(link));
  const local = multiply(invert(rotation(link.rot)), rotation(rot));
  return { origin: apply(back, origin), rot: eulerOf(local) };
}

/**
 * Where two links meet: the center of the overlap of their boxes, or, along
 * an axis where they stand apart, the middle of the gap. A wheel on an axle
 * gives the hub; two parts set end to end give the center of the faces they touch at.
 */
export function meetingPoint(a: Bounds, b: Bounds): Vec3 {
  return [0, 1, 2].map((i) => (Math.max(a.min[i], b.min[i]) + Math.min(a.max[i], b.max[i])) / 2) as Vec3;
}

const stripMimic = ({ mimic: _mimic, ...rest }: RobotJoint): RobotJoint => rest;

/** A joint's place in the design: its origin and axis taken out of the child's frame into the design's (mm). */
export function jointInDesign(joint: RobotJoint, child: SceneNode): { origin: Vec3; axis: Vec3 } {
  const turn = rotation(child.rot);
  const axis = apply(turn, joint.axis);
  const length = Math.hypot(...axis) || 1;
  return { origin: apply(frameMatrix(child), joint.origin), axis: axis.map((x) => x / length) as Vec3 };
}

/** The other way: a place and direction in the design, as the child's frame has them. */
export function jointInChild(origin: Vec3, axis: Vec3, child: SceneNode): { origin: Vec3; axis: Vec3 } {
  const back = invert(frameMatrix(child));
  const turned = apply(invert(rotation(child.rot)), axis);
  const length = Math.hypot(...turned) || 1;
  return { origin: apply(back, origin), axis: turned.map((x) => x / length) as Vec3 };
}

export interface Tree {
  /** Links reached from the base, parents before children. */
  order: string[];
  /** The joint each reached link hangs from (the base has none). */
  parentJoint: Map<string, RobotJoint>;
  /** Joints whose child was already reached another way: they close loops. */
  loops: RobotJoint[];
  /** Links no chain of joints reaches from the base. */
  unreached: string[];
}

/**
 * The links as a tree from the base: a breadth-first walk down the joints,
 * taking each link the first time a joint reaches it. Any joint that would
 * reach a link again closes a loop, which URDF cannot hold and SDF can.
 */
export function spanningTree(robot: Robot, links: string[]): Tree {
  const order: string[] = [];
  const parentJoint = new Map<string, RobotJoint>();
  const loops: RobotJoint[] = [];
  const have = new Set(links);
  const reached = new Set<string>();
  if (robot.root && have.has(robot.root)) {
    reached.add(robot.root);
    order.push(robot.root);
    for (let i = 0; i < order.length; i++) {
      for (const j of robot.joints) {
        if (j.parent !== order[i] || !have.has(j.child)) continue;
        if (reached.has(j.child)) {
          loops.push(j);
          continue;
        }
        reached.add(j.child);
        parentJoint.set(j.child, j);
        order.push(j.child);
      }
    }
  }
  // A joint whose parent is never reached cannot be walked over, but still counts as a loop if its child was reached otherwise.
  return { order, parentJoint, loops, unreached: links.filter((id) => !reached.has(id)) };
}

/** Why a joint cannot follow another: the leader never moves, closes a loop, is left out of the robot, or follows the follower in turn. */
export type FollowFault = 'fixed' | 'loop' | 'left-out' | 'ring';

/**
 * What stops `joint` from following `leader`, or null when it can. A follower is written against its leader's
 * name, so the leader must be a joint every export holds and that moves: one of the tree's, not fixed. Followers
 * may follow followers, as long as the chain does not come round again.
 */
export function followFault(robot: Robot, tree: Tree, joint: RobotJoint, leader: RobotJoint): FollowFault | null {
  if (leader.type === 'fixed') return 'fixed';
  if (tree.loops.some((j) => j.id === leader.id)) return 'loop';
  if (tree.parentJoint.get(leader.child)?.id !== leader.id) return 'left-out';
  const seen = new Set<string>();
  for (let at: RobotJoint | undefined = leader; at && !seen.has(at.id); at = at.mimic && robot.joints.find((j) => j.id === at!.mimic!.joint)) {
    if (at.id === joint.id) return 'ring';
    seen.add(at.id);
  }
  return null;
}

/**
 * The way a driven robot faces, read off its wheel labels: a unit vector along ±X or ±Y of the
 * design. Seen from behind, the right wheels stand to the right of the left ones; a mecanum
 * drive's front wheels stand ahead of its rear ones. +Y when the wheels do not say.
 */
export function driveForward(kind: DriveKind, at: Partial<Record<DriveRole, Vec3[]>>): Vec3 {
  const mean = (ps: Vec3[]): Vec3 | null => (ps.length ? ps.reduce((acc, p) => acc.map((v, i) => v + p[i] / ps.length) as Vec3, [0, 0, 0] as Vec3) : null);
  let ahead: Vec3 | null = null;
  if (kind === 'mecanum') {
    const front = mean([...(at['front-left'] ?? []), ...(at['front-right'] ?? [])]);
    const rear = mean([...(at['rear-left'] ?? []), ...(at['rear-right'] ?? [])]);
    if (front && rear) ahead = [front[0] - rear[0], front[1] - rear[1], 0];
  } else {
    const left = mean(at.left ?? []);
    const right = mean(at.right ?? []);
    // Facing forward, the right side lies a quarter turn clockwise from the front.
    if (left && right) ahead = [left[1] - right[1], right[0] - left[0], 0];
  }
  if (!ahead || Math.hypot(ahead[0], ahead[1]) < 1e-6) return [0, 1, 0];
  return Math.abs(ahead[0]) > Math.abs(ahead[1]) ? [ahead[0] > 0 ? 1 : -1, 0, 0] : [0, ahead[1] > 0 ? 1 : -1, 0];
}

/** `driveForward` for a robot as designed, its wheel joints placed in the design. */
export function robotForward(robot: Robot, nodeById: Map<string, SceneNode>): Vec3 {
  if (!robot.drive) return [0, 1, 0];
  const at: Partial<Record<DriveRole, Vec3[]>> = {};
  for (const j of robot.joints) {
    const role = robot.drive.roles[j.id];
    const child = nodeById.get(j.child);
    if (!role || !child) continue;
    (at[role] ??= []).push(jointInDesign(j, child).origin);
  }
  return driveForward(robot.drive.kind, at);
}
