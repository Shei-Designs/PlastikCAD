// What a joint starts with: effort, speed and damping that fit what it moves,
// so that a toy's wheel and an arm's segment both get numbers a simulator can
// follow, instead of one size for every robot.
import type { SceneNode } from '../model/types';
import type { Robot, RobotJoint } from './types';

/** A printed part's rough density, g/mm³: PLA at the usual infill and shell. */
const PRINTED_DENSITY = 0.3 * 1.24e-3;
const round3 = (x: number): number => Number(x.toPrecision(3));

/** A part's mass in grams before the kernel has weighed it: its box, printed. */
export const boxMass = (node: SceneNode): number => node.size[0] * node.size[1] * node.size[2] * PRINTED_DENSITY;

/** What a side of a joint weighs when it sticks straight out, N·m: each part's weight at half its length. */
const lever = (side: SceneNode[], grams: (node: SceneNode) => number | null): number => side.reduce((sum, node) => sum + (((grams(node) ?? boxMass(node)) / 1000) * 9.81 * (Math.max(...node.size) / 1000)) / 2, 0);

/**
 * Effort, velocity and damping for a joint between two sides of a robot
 * (`grams` gives a part's mass when known): torque to hold the heavier side
 * straight out five times over (N·m), since a knee carries the body as much
 * as a shoulder carries the arm; a quarter turn a second (90°/s); and damping
 * that costs a twentieth of the effort at full speed (N·m·s). A continuous
 * joint is a wheel, a turret or a spinner: it only ever spins its child side
 * and never holds it up, so it is fitted to that side alone, at a turn a
 * second. Fitting a free wheel to the body it carries gave it damping that
 * braked the whole robot.
 */
export function jointDefaults(childSide: SceneNode[], parentSide: SceneNode[], grams: (node: SceneNode) => number | null = () => null, continuous = false): Pick<RobotJoint, 'effort' | 'velocity' | 'damping'> {
  const load = continuous ? lever(childSide, grams) : Math.max(lever(childSide, grams), lever(parentSide, grams));
  const effort = round3(Math.max(5 * load, 1e-4));
  const velocity = continuous ? 360 : 90;
  const damping = round3((0.05 * effort) / ((velocity * Math.PI) / 180));
  return { effort, velocity, damping };
}

/**
 * The two sides a joint separates: the links reached from its child, and from
 * its parent, without crossing it. Where a loop joins them both sides hold
 * the same links.
 */
export function jointSides(robot: Robot, nodes: SceneNode[], joint: Pick<RobotJoint, 'id' | 'parent' | 'child'>): [SceneNode[], SceneNode[]] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const reach = (from: string): SceneNode[] => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length) {
      const id = queue.shift()!;
      for (const j of robot.joints) {
        if (j.id === joint.id) continue;
        const other = j.parent === id ? j.child : j.child === id ? j.parent : null;
        if (other && byId.has(other) && !seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
      }
    }
    return [...seen].map((id) => byId.get(id)).filter((n): n is SceneNode => Boolean(n));
  };
  return [reach(joint.child), reach(joint.parent)];
}

/** The defaults that fit `joint` in `robot` (which may already hold it, or not yet). */
export function jointFit(robot: Robot, nodes: SceneNode[], joint: RobotJoint, grams: (node: SceneNode) => number | null = () => null): Pick<RobotJoint, 'effort' | 'velocity' | 'damping'> {
  const [childSide, parentSide] = jointSides(robot.joints.some((j) => j.id === joint.id) ? robot : { ...robot, joints: [...robot.joints, joint] }, nodes, joint);
  return jointDefaults(childSide, parentSide, grams, joint.type === 'continuous');
}
