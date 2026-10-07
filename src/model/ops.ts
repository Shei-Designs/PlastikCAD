// Pure editing operations on scene nodes. Nodes are immutable: every
// operation returns new objects, which is what makes undo and versions cheap.
import { defaultParams, shapeDef } from '../geometry/shapes';
import {
  apply,
  axisRotation,
  eulerOf,
  flipSigns,
  frameMatrix,
  IDENTITY,
  localScale,
  multiply,
  nodeMatrix,
  rotation,
  tidy,
  tidyVec,
} from './math';
import { boxBounds } from './math';
import type { Bounds, Mat } from './math';
import type { GroupNode, Scene, SceneNode, ShapeKind, ShapeNode, Vec3 } from './types';

export const HOLE_COLOR = '#9aa3b2';

export function newId(): string {
  let id = '';
  while (id.length < 8) id += Math.random().toString(36).slice(2);
  return id.slice(0, 8);
}

/** "Box", "Box 2", "Box 3"... whichever is not taken yet. */
export function uniqueName(scene: Scene, base: string): string {
  const taken = new Set(scene.map((n) => n.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** A new shape resting on the build plate at (x, y). */
export function makeShape(kind: ShapeKind, at: Vec3 = [0, 0, 0]): ShapeNode {
  const def = shapeDef(kind);
  const size: Vec3 = [...def.defaultSize];
  return {
    id: newId(),
    type: 'shape',
    name: def.name,
    shape: kind,
    params: defaultParams(kind),
    pos: [at[0], at[1], at[2] + size[2] / 2],
    rot: [0, 0, 0],
    size,
    hole: def.hole ?? false,
    color: def.defaultColor,
  };
}

/** Deep copy with fresh ids. */
export function cloneNode<T extends SceneNode>(node: T): T {
  const copy = { ...node, id: newId() };
  if (copy.type === 'group') copy.children = copy.children.map(cloneNode);
  return copy;
}

export function countShapes(nodes: Scene): number {
  let n = 0;
  for (const node of nodes) n += node.type === 'group' ? countShapes(node.children) : 1;
  return n;
}

export function usedAssets(nodes: Scene, into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.type === 'import') into.add(node.asset);
    else if (node.type === 'group') usedAssets(node.children, into);
  }
  return into;
}

const normaliseFlip = (flip: [boolean, boolean, boolean]): SceneNode['flip'] => (flip.some(Boolean) ? flip : undefined);

function withFlip<T extends SceneNode>(node: T, flip: [boolean, boolean, boolean]): T {
  const next = { ...node };
  const f = normaliseFlip(flip);
  if (f) next.flip = f;
  else delete next.flip;
  return next;
}

/** Turn nodes by `degrees` about a fixed axis through `pivot`. */
export function rotateNodes<T extends SceneNode>(nodes: T[], axis: 0 | 1 | 2, degrees: number, pivot: Vec3): T[] {
  const turn = axisRotation(axis, degrees);
  return nodes.map((node) => {
    const offset = apply(turn, [node.pos[0] - pivot[0], node.pos[1] - pivot[1], node.pos[2] - pivot[2]]);
    return {
      ...node,
      rot: eulerOf(multiply(turn, rotation(node.rot))),
      pos: [pivot[0] + offset[0], pivot[1] + offset[1], pivot[2] + offset[2]],
    };
  });
}

/** Mirror nodes in the plane through `pivot` that is perpendicular to a fixed axis. */
export function mirrorNodes<T extends SceneNode>(nodes: T[], axis: 0 | 1 | 2, pivot: Vec3): T[] {
  return nodes.map((node) => {
    // F·R·D = (F·R·F)·(F·D): a reflection of the whole node is a different
    // rotation plus a flip of the matching local axis.
    const r = rotation(node.rot);
    for (let c = 0; c < 3; c++) {
      for (let row = 0; row < 3; row++) {
        const sign = (c === axis ? -1 : 1) * (row === axis ? -1 : 1);
        r[c * 3 + row] *= sign;
      }
    }
    const flip: [boolean, boolean, boolean] = node.flip ? [...node.flip] : [false, false, false];
    flip[axis] = !flip[axis];
    const pos: Vec3 = [...node.pos];
    pos[axis] = 2 * pivot[axis] - pos[axis];
    return withFlip({ ...node, rot: eulerOf(r), pos }, flip);
  });
}

/** Combine nodes into a group whose result has the given bounds (measured by the geometry kernel). */
export function makeGroup(nodes: SceneNode[], bounds: Bounds, name: string, over: Partial<Pick<GroupNode, 'id' | 'color' | 'hole' | 'hidden' | 'locked'>> = {}): GroupNode {
  const centre: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  // Measured, so kept exact: rounding would scale the contents by a hair (size over natural).
  const size: Vec3 = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  const solids = nodes.filter((n) => !n.hole);
  return {
    id: over.id ?? newId(),
    type: 'group',
    name,
    pos: centre,
    rot: [0, 0, 0],
    size,
    natural: size,
    hole: over.hole ?? false,
    color: over.color ?? (solids[0] ?? nodes[0]).color,
    ...(over.hidden ? { hidden: true } : {}),
    ...(over.locked ? { locked: true } : {}),
    children: nodes.map((n) => {
      const child = { ...n, pos: [n.pos[0] - centre[0], n.pos[1] - centre[1], n.pos[2] - centre[2]] as Vec3 };
      delete child.hidden;
      delete child.locked;
      return child;
    }),
  };
}

const MM_PARAMS = ['radius', 'wall'];

/**
 * The children of a group, placed where the group put them. Exact when the
 * group was scaled evenly or its children are square to it; a child that was
 * both turned and stretched comes out sheared in the group, which a single
 * node cannot express, so it keeps its turn and takes the closest size.
 */
export function ungroup(group: GroupNode): SceneNode[] {
  const outer = nodeMatrix(group);
  const scale = localScale(group);
  const mirrored = scale[0] * scale[1] * scale[2] < 0;
  const even = Math.abs(Math.abs(scale[0]) - Math.abs(scale[1])) < 1e-9 && Math.abs(Math.abs(scale[1]) - Math.abs(scale[2])) < 1e-9;

  return group.children.map((child) => {
    // Images of the child's local axes in the group's parent space.
    const signs = flipSigns(child.flip);
    const axes = multiply(outer, multiply(rotation(child.rot), [signs[0], 0, 0, 0, signs[1], 0, 0, 0, signs[2], 0, 0, 0]));
    const lengths: Vec3 = [0, 1, 2].map((c) => Math.hypot(axes[c * 3], axes[c * 3 + 1], axes[c * 3 + 2])) as Vec3;

    // Split the axes into a proper rotation and per-axis flips. A mirrored
    // group hands one flip down to the child.
    const flip: [boolean, boolean, boolean] = child.flip ? [...child.flip] : [false, false, false];
    if (mirrored) flip[0] = !flip[0];
    const frame = orthonormal(axes, lengths, flip);

    const next: SceneNode = {
      ...child,
      pos: tidyVec(apply(outer, child.pos)),
      rot: eulerOf(frame),
      size: tidyVec([child.size[0] * lengths[0], child.size[1] * lengths[1], child.size[2] * lengths[2]]),
    };
    if (next.type === 'shape' && even && Math.abs(Math.abs(scale[0]) - 1) > 1e-9) {
      // Radii and wall thicknesses are in millimetres, so they grow with the group.
      const params = { ...next.params };
      for (const key of MM_PARAMS) if (key in params) params[key] = tidy(params[key] * Math.abs(scale[0]));
      next.params = params;
    }
    return withFlip(next, flip);
  });
}

/** Rotation whose columns are the given axes with flips undone, squared up by Gram-Schmidt. */
function orthonormal(axes: Mat, lengths: Vec3, flip: [boolean, boolean, boolean]): Mat {
  const col = (c: number): Vec3 => {
    const s = (flip[c] ? -1 : 1) / (lengths[c] || 1);
    return [axes[c * 3] * s, axes[c * 3 + 1] * s, axes[c * 3 + 2] * s];
  };
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const x = unit(col(0));
  let y = col(1);
  const d = dot(x, y);
  y = unit([y[0] - d * x[0], y[1] - d * x[1], y[2] - d * x[2]]);
  const z: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [...x, ...y, ...z, 0, 0, 0];
}

/** Bounds of a node's box; a stand-in for the tight bounds where no geometry is at hand. */
export const boxBoundsOf = (node: SceneNode): Bounds => boxBounds(node);

export type AlignMode = 'min' | 'centre' | 'max';

/** What it takes to put a dissolved group back together. */
export interface Layer {
  id: string;
  name: string;
  color: string;
  hole: boolean;
  hidden?: boolean;
  locked?: boolean;
  /** Ids of what was inside it. */
  children: string[];
}

/** The node at a path of ids from the top level down, or null. */
export function nodeAt(scene: Scene, path: string[]): SceneNode | null {
  let nodes: Scene = scene;
  let found: SceneNode | null = null;
  for (const id of path) {
    found = nodes.find((n) => n.id === id) ?? null;
    if (!found) return null;
    nodes = found.type === 'group' ? found.children : [];
  }
  return found;
}

/**
 * Take apart the groups along `path` (top-level group first), so that the
 * node at its end stands on its own. The layers come back outermost first,
 * with everything needed to rebuild them with `makeGroup` later.
 */
export function dissolve(scene: Scene, path: string[]): { scene: Scene; layers: Layer[] } {
  const layers: Layer[] = [];
  let out = scene;
  for (const id of path.slice(0, -1)) {
    const group = out.find((n) => n.id === id);
    if (group?.type !== 'group') break;
    layers.push({
      id: group.id,
      name: group.name,
      color: group.color,
      hole: group.hole,
      ...(group.hidden ? { hidden: true } : {}),
      ...(group.locked ? { locked: true } : {}),
      children: group.children.map((c) => c.id),
    });
    const freed = ungroup(group).map((child) => (group.hole ? { ...child, hole: true } : child));
    const at = out.indexOf(group);
    out = [...out.slice(0, at), ...freed, ...out.slice(at + 1)];
  }
  return { scene: out, layers };
}

/** World transform of a node's own box (centred, `size` wide) reached through `path`. */
export function frameAlong(scene: Scene, path: string[]): Mat | null {
  let m: Mat = IDENTITY;
  let nodes: Scene = scene;
  for (let i = 0; i < path.length; i++) {
    const node = nodes.find((n) => n.id === path[i]);
    if (!node) return null;
    if (i === path.length - 1) return multiply(m, frameMatrix(node));
    if (node.type !== 'group') return null;
    m = multiply(m, nodeMatrix(node));
    nodes = node.children;
  }
  return null;
}

/** Shift each node along one axis so that its bounds line up with `target`. */
export function alignNodes<T extends SceneNode>(
  nodes: T[],
  boundsOf: (node: SceneNode) => Bounds,
  axis: 0 | 1 | 2,
  mode: AlignMode,
  target: Bounds,
): T[] {
  const at = (b: Bounds) => (mode === 'min' ? b.min[axis] : mode === 'max' ? b.max[axis] : (b.min[axis] + b.max[axis]) / 2);
  return nodes.map((node) => {
    const shift = at(target) - at(boundsOf(node));
    if (shift === 0) return node;
    const pos: Vec3 = [...node.pos];
    // Exact on purpose: the faces are meant to meet.
    pos[axis] = pos[axis] + shift;
    return { ...node, pos };
  });
}

export interface SceneDiff {
  added: number;
  removed: number;
  changed: number;
}

/** What it takes to get from one scene to another, counted in top-level objects. */
export function diffScenes(from: Scene, to: Scene): SceneDiff {
  const before = new Map(from.map((n) => [n.id, n]));
  const diff: SceneDiff = { added: 0, removed: 0, changed: 0 };
  for (const node of to) {
    const old = before.get(node.id);
    if (!old) diff.added++;
    else if (old !== node && JSON.stringify(old) !== JSON.stringify(node)) diff.changed++;
    before.delete(node.id);
  }
  diff.removed = before.size;
  return diff;
}

export function describeDiff(diff: SceneDiff): string {
  const bits: string[] = [];
  if (diff.added) bits.push(`${diff.added} added`);
  if (diff.changed) bits.push(`${diff.changed} changed`);
  if (diff.removed) bits.push(`${diff.removed} removed`);
  return bits.join(' · ') || 'No changes';
}
