// Wheels made with the Wheels parts, as robot mode reads them. A mecanum
// wheel moves a robot sideways by its rollers, which a simulator must have as
// bodies of their own; they are worked out here from the part's settings and
// where it stands, never from its mesh, so a hole drilled in the wheel or a
// hub glued to it changes nothing. A wheel stretched unevenly, or one whose
// rollers leave gaps, is no longer the wheel its settings describe.
import { apply, multiply, nodeMatrix, translation } from '../model/math';
import type { Mat } from '../model/math';
import type { PartNode, SceneNode, Vec3 } from '../model/types';
import { getGenerator } from '../parts/generators';
import { sanitizeParams } from '../parts/generators/types';
import { mecanumRollers, rollerPlace } from '../parts/generators/wheels';
import type { MecanumRollers } from '../parts/generators/wheels';
import type { DriveRole } from './types';

const WHEEL_PARTS = ['wheel', 'mecanum-wheel'];
const MECANUM = 'mecanum-wheel';

/** Friction of a link that is a wheel from the Wheels parts, until one is typed: rubber on a hard floor. */
export const WHEEL_FRICTION = 1;

/** Every part of the Wheels family in an object, itself or grouped into it (holes aside), with the transform from the part's built shape to the design. */
function wheelParts(node: SceneNode, to: Mat = nodeMatrix(node)): { part: PartNode; to: Mat }[] {
  if (node.hole || node.hidden) return [];
  if (node.type === 'part') return WHEEL_PARTS.includes(node.part) ? [{ part: node, to }] : [];
  if (node.type !== 'group') return [];
  return node.children.flatMap((c) => wheelParts(c, multiply(to, nodeMatrix(c))));
}

/** Whether an object is a wheel from the Wheels parts, or holds one. */
export const isWheel = (node: SceneNode): boolean => wheelParts(node).length > 0;

/** Why an object is not a mecanum wheel a simulator can be given: it is not the part, it holds several, it was stretched unevenly, or its rollers leave gaps. */
export type MecanumFault = 'not-a-part' | 'several' | 'stretched' | 'gaps';

export interface MecanumWheel {
  part: PartNode;
  /** The rollers as the part's settings give them, in the part's own frame and at its own size. */
  figures: MecanumRollers;
  /** From the part's own frame (axle along Z, standing on z = 0) to the design, mm. */
  toDesign: Mat;
  /** How much larger the wheel stands in the design than its settings say. */
  scale: number;
}

/** The mecanum wheel an object is or holds, or why it does not count as one. */
export function mecanumOf(node: SceneNode): MecanumWheel | MecanumFault {
  const found = wheelParts(node).filter((w) => w.part.part === MECANUM);
  if (found.length === 0) return 'not-a-part';
  if (found.length > 1) return 'several';
  const { part, to } = found[0];
  // Evenly scaled: the three axes of the part come out as long as each other, and square to each other.
  const cols: Vec3[] = [0, 1, 2].map((i) => [to[i * 3], to[i * 3 + 1], to[i * 3 + 2]] as Vec3);
  const len = cols.map((c) => Math.hypot(...c));
  const scale = (len[0] + len[1] + len[2]) / 3;
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (!(scale > 0) || len.some((l) => Math.abs(l - scale) > 0.005 * scale)) return 'stretched';
  if ([dot(cols[0], cols[1]), dot(cols[0], cols[2]), dot(cols[1], cols[2])].some((d) => Math.abs(d) > 0.005 * scale * scale)) return 'stretched';
  const figures = mecanumRollers(sanitizeParams(getGenerator(MECANUM), part.params));
  if (figures.reach < (2 * Math.PI) / figures.count - 1e-9) return 'gaps';
  // The part is built standing on z = 0 and then centered on its box, which the hub makes taller than the wheel is wide.
  const toDesign = multiply(to, translation([0, 0, -part.natural[2] / 2]));
  return { part, figures, toDesign, scale };
}

/** The angle about the axle between one ball of a roller and the next, at most: what keeps the wheel round to a few tenths of a millimeter. */
const BALL_STEP = (10 * Math.PI) / 180;
/** Rubber, g/mm³: what a roller weighs. */
const RUBBER = 0.0011;

/** A roller as a simulator gets it: a body on a free hinge to its wheel, colliding as a row of balls along its axis. */
export interface Roller {
  /** The roller's middle in the design, mm. */
  center: Vec3;
  /** Its axis in the design, a unit vector: the hinge it turns on. */
  axis: Vec3;
  /** The balls it collides as: each one's center from the roller's middle (mm, design axes) and its radius. Each touches the wheel's circle from inside. */
  balls: { at: Vec3; radius: number }[];
  /** g, and g·mm² about the axis and across it. */
  mass: number;
  inertia: { along: number; across: number };
}

/**
 * The rollers of a mecanum wheel, placed in the design. A roller's true shape is the barrel that touches the
 * wheel's circle all along; a ball centered on its axis that touches that circle from inside lies wholly within
 * the barrel and touches where the barrel does, so a row of such balls is the barrel to within the gap between
 * two of them. A ball is the one shape every simulator has, and it looks the same however the roller has turned.
 */
export function rollersOf(w: MecanumWheel): Roller[] {
  const m = w.figures;
  const k = w.scale;
  const linear = (v: Vec3): Vec3 => {
    const o = apply(w.toDesign, [0, 0, 0]);
    const p = apply(w.toDesign, v);
    return [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  };
  // Along the axis, `s` from the middle is seen from the axle at atan(s / √2 / circle): the balls are spread evenly in that angle.
  const steps = Math.max(2, Math.ceil(m.reach / BALL_STEP));
  const places = Array.from({ length: steps + 1 }, (_, i) => Math.SQRT2 * m.circle * Math.tan(m.reach * (i / steps - 0.5)));
  // A barrel is near enough an ellipsoid as long as the roller and as thick as its middle.
  const mass = Math.max(1, RUBBER * (4 / 3) * Math.PI * m.rollerRadius * m.rollerRadius * (m.rollerLength / 2) * k ** 3);
  const along = 0.4 * mass * (m.rollerRadius * k) ** 2;
  const across = 0.2 * mass * ((m.rollerRadius * k) ** 2 + ((m.rollerLength / 2) * k) ** 2);
  return Array.from({ length: m.count }, (_, i) => {
    const place = rollerPlace(m, i);
    const dir = linear(place.axis);
    const n = Math.hypot(...dir) || 1;
    const axis = dir.map((x) => x / n) as Vec3;
    return {
      center: apply(w.toDesign, place.center),
      axis,
      balls: places.map((s) => ({ at: axis.map((x) => x * s * k) as Vec3, radius: (m.radius - Math.hypot(m.circle, s * Math.SQRT1_2)) * k })),
      mass,
      inertia: { along, across },
    };
  });
}

/** The line on the floor a wheel grips along where it touches it: the axis of its lowest roller, flattened. A unit vector in the design. */
export function gripLine(w: MecanumWheel): Vec3 {
  const lowest = rollersOf(w).reduce((a, b) => (b.center[2] < a.center[2] ? b : a));
  const n = Math.hypot(lowest.axis[0], lowest.axis[1]) || 1;
  return [lowest.axis[0] / n, lowest.axis[1] / n, 0];
}

/**
 * Whether a mecanum wheel's rollers lean the right way for its corner, the robot facing `forward`: seen from
 * above, the lines the four wheels grip along make a diamond round the robot's middle. Front left and rear right
 * grip along forward-and-right, the other two along forward-and-left; the mixing every controller uses counts on it.
 */
export function leansRight(w: MecanumWheel, role: DriveRole, forward: Vec3): boolean {
  const left: Vec3 = [-forward[1], forward[0], 0];
  const sign = role === 'front-left' || role === 'rear-right' ? -1 : 1;
  const want: Vec3 = [(forward[0] + sign * left[0]) * Math.SQRT1_2, (forward[1] + sign * left[1]) * Math.SQRT1_2, 0];
  const g = gripLine(w);
  return Math.abs(g[0] * want[0] + g[1] * want[1]) > Math.SQRT1_2;
}

/** The hand that suits a corner. */
export const handFor = (role: DriveRole): 'left' | 'right' => (role === 'front-left' || role === 'rear-right' ? 'left' : 'right');
