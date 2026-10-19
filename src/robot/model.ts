// Reading a robot against its design: which objects are links, what each
// link's settings are, and how the joints hang the links from the base.
import { apply, frameMatrix, invert, rotation } from '../model/math';
import type { Doc, Scene, SceneNode, Vec3 } from '../model/types';
import { defaultLink, emptyRobot } from './types';
import type { Robot, RobotJoint, RobotLink } from './types';

/** The objects that are links: every top-level solid that is shown. Holes cut nothing at the top level, and pictures are flat. */
export const linkNodes = (scene: Scene): SceneNode[] => scene.filter((n) => !n.hidden && !n.hole && n.type !== 'picture');

/** The design's robot, or an untouched one named after the design. */
export const robotOf = (doc: Doc): Robot => doc.robot ?? emptyRobot(doc.name);

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
  if (links.length === robot.links.length && joints.length === robot.joints.length && followers.every((j, i) => j === joints[i]) && root === robot.root) return robot;
  return { ...robot, root, links, joints: followers.map((j) => (j.mimic === undefined ? stripMimic(j) : j)) };
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
