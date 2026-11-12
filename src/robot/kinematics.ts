// Posing the robot: where every link goes when the joints are set to given
// values, with any loop closed by solving for the passive joints. Nothing
// here changes the design; the viewer draws the posed links, the mimic fit
// reads the joint values off a posed sweep.
import { apply, eulerOf, frameMatrix, multiply } from '../model/math';
import type { Mat } from '../model/math';
import type { Scene, SceneNode, Vec3 } from '../model/types';
import { jointInDesign, linkNodes, spanningTree } from './model';
import type { Tree } from './model';
import type { Robot, RobotJoint } from './types';

/** Joint values by joint id: degrees for turning joints, mm for sliding ones. */
export type Pose = Map<string, number>;

/** Rotation by `degrees` about a unit `axis` through `origin` (Rodrigues), as an affine matrix. */
export function turnAbout(origin: Vec3, axis: Vec3, degrees: number): Mat {
  const t = (degrees * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const [x, y, z] = axis;
  const k = 1 - c;
  const r: Mat = [c + x * x * k, y * x * k + z * s, z * x * k - y * s, x * y * k - z * s, c + y * y * k, z * y * k + x * s, x * z * k + y * s, y * z * k - x * s, c + z * z * k, 0, 0, 0];
  const moved = apply(r, origin);
  r[9] = origin[0] - moved[0];
  r[10] = origin[1] - moved[1];
  r[11] = origin[2] - moved[2];
  return r;
}

const slideAlong = (axis: Vec3, mm: number): Mat => [1, 0, 0, 0, 1, 0, 0, 0, 1, axis[0] * mm, axis[1] * mm, axis[2] * mm];
const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** A joint's motion by `value`, in the design's zero pose. */
function jointMotion(joint: RobotJoint, child: SceneNode, value: number): Mat {
  if (joint.type === 'fixed' || value === 0) return IDENTITY;
  const { origin, axis } = jointInDesign(joint, child);
  return joint.type === 'prismatic' ? slideAlong(axis, value) : turnAbout(origin, axis, value);
}

export interface Posed {
  /** The transform each reached link gets, from where it is designed to where it is posed. */
  frames: Map<string, Mat>;
  /** Every joint's value, the followers' included. */
  values: Pose;
  tree: Tree;
}

/** Followers take their value from the joint they follow, however many deep. */
function resolveFollowers(robot: Robot, values: Pose): Pose {
  const out = new Map(values);
  const byId = new Map(robot.joints.map((j) => [j.id, j]));
  const valueOf = (j: RobotJoint, depth: number): number => {
    if (!j.mimic || depth > 16) return out.get(j.id) ?? 0;
    const leader = byId.get(j.mimic.joint);
    return leader ? j.mimic.multiplier * valueOf(leader, depth + 1) + j.mimic.offset : out.get(j.id) ?? 0;
  };
  for (const j of robot.joints) if (j.mimic) out.set(j.id, valueOf(j, 0));
  return out;
}

/** Where the links go for the given joint values, down the tree from the base; loops are not closed here. */
export function forward(robot: Robot, scene: Scene, values: Pose): Posed {
  const nodes = linkNodes(scene);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const tree = spanningTree(robot, nodes.map((n) => n.id));
  const all = resolveFollowers(robot, values);
  const frames = new Map<string, Mat>();
  for (const id of tree.order) {
    const joint = tree.parentJoint.get(id);
    if (!joint) {
      frames.set(id, IDENTITY);
      continue;
    }
    const parent = frames.get(joint.parent) ?? IDENTITY;
    frames.set(id, multiply(parent, jointMotion(joint, byId.get(id)!, all.get(joint.id) ?? 0)));
  }
  return { frames, values: all, tree };
}

/** How far the loop joints are from closed: for each, where its two links put it, as position (mm) and axis (scaled to mm). */
function loopResiduals(scene: Scene, posed: Posed): number[] {
  const byId = new Map(linkNodes(scene).map((n) => [n.id, n]));
  const out: number[] = [];
  for (const j of posed.tree.loops) {
    const child = byId.get(j.child);
    const parentFrame = posed.frames.get(j.parent);
    const childFrame = posed.frames.get(j.child);
    if (!child || !parentFrame || !childFrame) continue;
    const { origin, axis } = jointInDesign(j, child);
    const a = apply(childFrame, origin);
    const b = apply(parentFrame, origin);
    const ra = apply(childFrame, [origin[0] + axis[0] * AXIS_REACH, origin[1] + axis[1] * AXIS_REACH, origin[2] + axis[2] * AXIS_REACH]);
    const rb = apply(parentFrame, [origin[0] + axis[0] * AXIS_REACH, origin[1] + axis[1] * AXIS_REACH, origin[2] + axis[2] * AXIS_REACH]);
    out.push(a[0] - b[0], a[1] - b[1], a[2] - b[2], ra[0] - rb[0] - (a[0] - b[0]), ra[1] - rb[1] - (a[1] - b[1]), ra[2] - rb[2] - (a[2] - b[2]));
  }
  return out;
}

/** mm along a loop joint's axis that its direction is checked at. */
const AXIS_REACH = 30;
/** A loop counts as closed when its joints meet within this. */
export const CLOSED_WITHIN = 0.05;

export interface Solved extends Posed {
  /** Whether every loop came together. */
  closed: boolean;
  /** The worst distance a loop joint is from closed, mm. */
  error: number;
}

/**
 * Poses the robot with `driven` set as given and every other free joint
 * (not fixed, not a follower) found so that the loops close, starting from
 * `start` (the last pose, so a sweep follows one branch of the linkage).
 * Levenberg–Marquardt on the loop residuals, with numeric derivatives.
 */
export function solvePose(robot: Robot, scene: Scene, driven: Pose, start: Pose = new Map()): Solved {
  const base = new Map(start);
  for (const [id, v] of driven) base.set(id, v);
  let posed = forward(robot, scene, base);
  if (posed.tree.loops.length === 0) return { ...posed, closed: true, error: 0 };
  const treeJoints = new Set([...posed.tree.parentJoint.values()].map((j) => j.id));
  const free = robot.joints.filter((j) => treeJoints.has(j.id) && j.type !== 'fixed' && !j.mimic && !driven.has(j.id));
  let x = free.map((j) => base.get(j.id) ?? 0);
  const evaluate = (v: number[]): number[] => {
    const values = new Map(base);
    free.forEach((j, i) => values.set(j.id, v[i]));
    posed = forward(robot, scene, values);
    return loopResiduals(scene, posed);
  };
  const norm = (r: number[]) => Math.sqrt(r.reduce((s, v) => s + v * v, 0));
  let r = evaluate(x);
  let lambda = 1e-3;
  for (let iteration = 0; iteration < 60 && norm(r) > 1e-7 && free.length > 0; iteration++) {
    // Jacobian by forward differences, a column per free joint.
    const h = 1e-3;
    const columns = x.map((_, i) => {
      const bumped = x.slice();
      bumped[i] += h;
      const rb = evaluate(bumped);
      return rb.map((v, k) => (v - r[k]) / h);
    });
    const n = free.length;
    // Normal equations (JᵀJ + λ diag) δ = −Jᵀr.
    const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const g = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++) A[i][k] = columns[i].reduce((s, v, m) => s + v * columns[k][m], 0);
      g[i] = -columns[i].reduce((s, v, m) => s + v * r[m], 0);
    }
    let improved = false;
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const M = A.map((row, i) => row.map((v, k) => (i === k ? v + lambda * (v + 1e-9) : v)));
      const delta = solveLinear(M, g);
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const next = x.map((v, i) => v + delta[i]);
      const rn = evaluate(next);
      if (norm(rn) < norm(r)) {
        x = next;
        r = rn;
        lambda = Math.max(lambda / 3, 1e-9);
        improved = true;
      } else lambda *= 10;
    }
    if (!improved) break;
  }
  evaluate(x);
  const error = Math.max(0, ...r.map(Math.abs));
  return { ...posed, closed: error <= CLOSED_WITHIN, error };
}

/** Gaussian elimination with partial pivoting; null for a singular system. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    if (Math.abs(M[pivot][c]) < 1e-12) return null;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** The scene with every reached link moved to its posed place: the same nodes, with new positions and turns. */
export function posedScene(scene: Scene, frames: Map<string, Mat>): Scene {
  return scene.map((node) => {
    const frame = frames.get(node.id);
    if (!frame || frame === IDENTITY) return node;
    const m = multiply(frame, frameMatrix(node));
    return { ...node, pos: [m[9], m[10], m[11]], rot: eulerOf(m) };
  });
}

/**
 * The pose a simulation begins in: every joint at its start, the followers where their leaders put them and the
 * passive joints of a loop where the loop closes. Null for a robot that starts as it is designed.
 */
export function startPose(robot: Robot, scene: Scene): Solved | null {
  const driven: Pose = new Map(robot.joints.filter((j) => j.type !== 'fixed' && !j.mimic && j.start).map((j) => [j.id, j.start!]));
  return driven.size ? solvePose(robot, scene, driven) : null;
}

/** How far a joint can go, for sweeps and sliders: its limits, or a turn for a continuous joint. */
export function rangeOf(joint: RobotJoint): [number, number] {
  if (joint.type === 'continuous') return [-180, 180];
  if (joint.type === 'fixed') return [0, 0];
  return joint.lower < joint.upper ? [joint.lower, joint.upper] : [-90, 90];
}

export interface MimicFit {
  multiplier: number;
  offset: number;
  /** The worst the line misses the solved value by over the sweep, in the joint's units. */
  error: number;
  /** Whether every step of the sweep closed the loops. */
  closed: boolean;
}

/**
 * Sweeps `driven` over its range, closing the loops at each step, and fits
 * each free joint's value as a line in the driven one: what URDF's mimic
 * can hold. A parallelogram comes out exact; another four-bar, close.
 */
export function fitFollowers(robot: Robot, scene: Scene, drivenId: string, steps = 25): Map<string, MimicFit> {
  const driven = robot.joints.find((j) => j.id === drivenId);
  const out = new Map<string, MimicFit>();
  if (!driven) return out;
  const [lo, hi] = rangeOf(driven);
  const samples = new Map<string, { x: number; y: number }[]>();
  let closedAll = true;
  const free = robot.joints.filter((j) => j.id !== drivenId && j.type !== 'fixed' && !j.mimic);
  // Out from the zero pose both ways, so that the solver follows the branch the design is in: each step
  // starts from the last pose, and a step after which a passive joint leapt is taken again in halves,
  // since a leap means the solver landed on the linkage's other branch.
  const sweep = (end: number) => {
    let start: Pose = new Map();
    let last = new Map(free.map((j) => [j.id, 0]));
    const take = (from: number, to: number, depth: number): void => {
      const solved = solvePose(robot, scene, new Map([[drivenId, to]]), start);
      const leap = free.some((j) => Math.abs((solved.values.get(j.id) ?? 0) - last.get(j.id)!) > 2 * Math.abs(to - from) + 1);
      if (leap && depth < 5) {
        take(from, (from + to) / 2, depth + 1);
        take((from + to) / 2, to, depth + 1);
        return;
      }
      start = solved.values;
      last = new Map(free.map((j) => [j.id, solved.values.get(j.id) ?? 0]));
      if (!solved.closed) closedAll = false;
      for (const j of free) {
        if (!samples.has(j.id)) samples.set(j.id, []);
        samples.get(j.id)!.push({ x: to, y: solved.values.get(j.id) ?? 0 });
      }
    };
    take(0, 0, 0);
    for (let i = 1; i <= steps; i++) take((end * (i - 1)) / steps, (end * i) / steps, 0);
  };
  if (hi > 0) sweep(hi);
  if (lo < 0) sweep(lo);
  for (const [id, points] of samples) {
    const n = points.length;
    const sx = points.reduce((s, p) => s + p.x, 0);
    const sy = points.reduce((s, p) => s + p.y, 0);
    const sxx = points.reduce((s, p) => s + p.x * p.x, 0);
    const sxy = points.reduce((s, p) => s + p.x * p.y, 0);
    const d = n * sxx - sx * sx;
    const multiplier = d > 1e-12 ? (n * sxy - sx * sy) / d : 0;
    const offset = (sy - multiplier * sx) / n;
    const error = Math.max(...points.map((p) => Math.abs(multiplier * p.x + offset - p.y)));
    // A joint that never moves is not a follower.
    if (Math.max(...points.map((p) => Math.abs(p.y))) < 1e-6) continue;
    out.set(id, { multiplier: Math.round(multiplier * 1e6) / 1e6, offset: Math.round(offset * 1e4) / 1e4, error, closed: closedAll });
  }
  return out;
}
