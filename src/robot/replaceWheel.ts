// A wheel that is not the Mecanum wheel part, made into one where it stands:
// what a mecanum drive on a robot brought in from a file, or on wheels drawn
// by hand, needs before it can slide. The part takes the old wheel's place,
// size and name; its joint, its part in the drive and its link's settings stay.
import { add, apply, cross, dot, eulerOf, invert, normalize, rotation, scale, sub, tidyVec } from '../model/math';
import type { Mat } from '../model/math';
import type { PartNode, Scene, SceneNode, Vec3 } from '../model/types';
import { getGenerator } from '../parts/generators';
import { sanitizeParams } from '../parts/generators/types';
import type { Params } from '../parts/generators/types';
import { MECANUM_LIMITS, MECANUM_PRESETS, mecanumRollers } from '../parts/generators/wheels';
import { ownFrame, turned } from './inertia';
import { jointInChild, jointInDesign, linkNodes, robotForward, sensorInDesign, sensorInLink } from './model';
import type { DriveRole, Robot, RobotJoint, RobotLink } from './types';
import { handFor, leansRight, mecanumOf } from './wheels';

const PART = 'mecanum-wheel';
const clamp = (v: number, { min, max }: { min: number; max: number }) => Math.min(max, Math.max(min, v));
const round = (v: number, step: number) => Math.round(v / step) * step;

/** Whether a wheel of these settings has rollers that take over from one another all the way round. */
const covers = (p: Params): boolean => {
  const m = mecanumRollers(sanitizeParams(getGenerator(PART), p));
  return m.reach >= (2 * Math.PI) / m.count - 1e-9;
};

/**
 * The Mecanum wheel's settings for a wheel this far across and this wide: the size sold under those figures where
 * there is one, else a custom wheel with as many rollers as the nearest size sold, or the nearest count to it that
 * leaves no gaps. A wheel too narrow for any count to cover is made as much wider as it takes: a mecanum wheel
 * cannot be a thin disc.
 */
export function mecanumSettings(diameter: number, width: number): Params {
  const d = round(clamp(diameter, MECANUM_LIMITS.diameter), 0.1);
  const w = round(clamp(width, MECANUM_LIMITS.width), 0.1);
  for (const [size, s] of Object.entries(MECANUM_PRESETS)) if (Math.abs(s.diameter - d) <= 0.5 && Math.abs(s.width - w) <= 0.5) return { size };
  const near = Object.values(MECANUM_PRESETS).reduce((a, b) => (Math.abs(b.diameter - d) < Math.abs(a.diameter - d) ? b : a)).rollers;
  const { min, max } = MECANUM_LIMITS.rollers;
  // The nearest count first, then the ones either side of it, more rollers before fewer.
  const counts = Array.from({ length: max - min + 1 }, (_, i) => min + i).sort((a, b) => Math.abs(a - near) - Math.abs(b - near) || b - a);
  const at = (steps: number) => round(w + 0.5 * steps, 0.1);
  const count = (wide: number) => counts.find((n) => covers({ size: 'custom', diameter: d, width: wide, rollers: n }));
  // A wider wheel has room for longer rollers, so once some count covers, one does at every width above: the
  // least widening, in half millimeters, is found by halving rather than by trying each in turn.
  let most = Math.floor((MECANUM_LIMITS.width.max - w) / 0.5 + 1e-9);
  if (count(at(0)) === undefined && count(at(most)) !== undefined) {
    let none = 0;
    while (most - none > 1) {
      const mid = (none + most) >> 1;
      if (count(at(mid)) === undefined) none = mid;
      else most = mid;
    }
  } else most = 0;
  return { size: 'custom', diameter: d, width: at(most), rollers: count(at(most)) ?? near };
}

/** The side of a wheel's box that is its width: the joint's axis is in the object's own frame, and it is the side most along it. */
const sideAlong = (joint: RobotJoint): number => [0, 1, 2].reduce((a, b) => (Math.abs(joint.axis[b]) > Math.abs(joint.axis[a]) ? b : a));

/**
 * The Mecanum wheel part that takes a wheel's place: as far across and as wide as the old wheel's box is about and
 * along its joint's axis, its axle on that axis, its middle where the old wheel's was along it, and of the hand
 * its corner wants. It keeps the old object's id, name and color, so everything that named the object still does.
 */
export function mecanumFor(old: SceneNode, joint: RobotJoint, role: DriveRole, forward: Vec3): PartNode {
  const { origin, axis } = jointInDesign(joint, old);
  const along = sideAlong(joint);
  const across = [0, 1, 2].filter((i) => i !== along);
  const def = getGenerator(PART);
  const settings = mecanumSettings(Math.max(old.size[across[0]], old.size[across[1]]), old.size[along]);
  const figures = mecanumRollers(sanitizeParams(def, settings));
  // On the axle, at the middle of the old wheel's box along it.
  const pos = add(origin, scale(axis, dot(sub(old.pos, origin), axis)));
  // Z along the axle; X as near as may be to where one of the old wheel's own sides pointed.
  const frame = rotation(old.rot);
  const side = [frame[across[0] * 3], frame[across[0] * 3 + 1], frame[across[0] * 3 + 2]] as Vec3;
  let x = sub(side, scale(axis, dot(side, axis)));
  if (Math.hypot(...x) < 1e-6) x = cross(Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], axis);
  x = normalize(x);
  const y = cross(axis, x);
  const turn: Mat = [...x, ...y, ...axis, 0, 0, 0];
  const size: Vec3 = [2 * figures.radius, 2 * figures.radius, figures.width];
  const made = (hand: 'left' | 'right'): PartNode => ({
    id: old.id,
    name: old.name,
    type: 'part',
    part: PART,
    params: sanitizeParams(def, { ...settings, hand }),
    natural: size,
    size,
    pos: tidyVec(pos),
    rot: tidyVec(eulerOf(turn)),
    hole: false,
    color: old.color,
    ...(old.note ? { note: old.note } : {}),
    ...(old.locked ? { locked: true } : {}),
  });
  const node = made(handFor(role));
  const found = mecanumOf(node);
  // The hand follows from the corner however the axle points; were it ever not so, the other hand is the one.
  return typeof found !== 'string' && !leansRight(found, role, forward) ? made(handFor(role) === 'left' ? 'right' : 'left') : node;
}

/**
 * The design with the link's object made a Mecanum wheel, or null where the link is no wheel of a mecanum drive.
 * The joints that hang it and the sensors on it stay where they are in the design, told anew from the part's
 * frame. Its link keeps its name, its friction and its mass: a weighed mass with the center and inertia typed
 * for it, turned to the part's axes; a mass figured from a material is figured from the part's shape from now on.
 * A collision box or pieces fitted to the old object go: a mecanum wheel collides as its rollers, and one that
 * collided with nothing now does. `widened` tells the old width and the new of a wheel that was too thin for
 * rollers and so came out wider than it was, by more than the half millimeter a size sold may differ by.
 */
export function withMecanumWheel(scene: Scene, robot: Robot, link: string): { scene: Scene; robot: Robot; widened?: { was: number; now: number } } | null {
  const old = scene.find((n) => n.id === link);
  const joint = robot.joints.find((j) => j.child === link && robot.drive?.roles[j.id] !== undefined);
  const role = joint && robot.drive?.roles[joint.id];
  if (!old || !joint || !role || robot.drive?.kind !== 'mecanum' || role.startsWith('steer')) return null;
  const forward = robotForward(robot, new Map(linkNodes(scene).map((n) => [n.id, n])));
  const node = mecanumFor(old, joint, role, forward);
  const joints = robot.joints.map((j) => {
    if (j.child !== link) return j;
    const at = jointInDesign(j, old);
    const local = jointInChild(at.origin, at.axis, node);
    return { ...j, origin: tidyVec(local.origin), axis: tidyVec(local.axis) };
  });
  const sensors = robot.sensors.map((x) => {
    if (x.link !== link) return x;
    const at = sensorInDesign(x, old);
    const local = sensorInLink(at.origin, eulerOf([...at.matrix.slice(0, 9), 0, 0, 0] as Mat), node);
    return { ...x, origin: tidyVec(local.origin), rot: tidyVec(local.rot) };
  });
  const links = robot.links.map((l): RobotLink => {
    if (l.node !== link) return l;
    const { shape: _shape, pieces: _pieces, ...rest } = l;
    // A wheel that collided with nothing (one a file gave no collision shape) could not carry the robot, let alone slide it.
    const kept: RobotLink = rest.collision === 'none' ? { ...rest, collision: 'hull' } : rest;
    if (l.mass.kind !== 'measured' || (!l.mass.center && !l.mass.inertia)) return kept;
    // Typed figures are in the old object's own frame: out to the design, and back into the part's.
    const out = ownFrame(old);
    const back = invert(ownFrame(node));
    return { ...kept, mass: { ...l.mass, ...(l.mass.center ? { center: tidyVec(apply(back, apply(out, l.mass.center))) } : {}), ...(l.mass.inertia ? { inertia: turned(turned(l.mass.inertia, out), back) } : {}) } };
  });
  const was = old.size[sideAlong(joint)];
  const now = node.size[2];
  return { scene: scene.map((n) => (n.id === link ? node : n)), robot: { ...robot, joints, sensors, links }, ...(now - was > 0.5 + 1e-6 ? { widened: { was, now } } : {}) };
}
