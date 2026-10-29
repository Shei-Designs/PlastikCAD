// Pure editing operations on scene nodes. Nodes are immutable: every
// operation returns new objects, which is what makes undo cheap.
import { clampParams, defaultParams, shapeDef } from '../geometry/shapes';
import {
  add,
  apply,
  axisRotation,
  boundsCenter,
  eulerOf,
  flipSigns,
  frameMatrix,
  IDENTITY,
  localScale,
  multiply,
  nodeMatrix,
  rotation,
  sub,
  tidy,
  tidyVec,
  unionBounds,
} from './math';
import { boxBounds } from './math';
import type { Bounds, Mat } from './math';
import type { GroupNode, PictureNode, Scene, SceneNode, ShapeKind, ShapeNode, Vec2, Vec3 } from './types';

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
    if (node.texture) into.add(node.texture.asset);
    if (node.type === 'import' || node.type === 'picture') into.add(node.asset);
    else if (node.type === 'group') usedAssets(node.children, into);
  }
  return into;
}

/** The pictures grouped onto an object, in the order they come. */
export const picturesOf = (node: SceneNode): PictureNode[] => (node.type === 'group' ? node.children.filter((c): c is PictureNode => c.type === 'picture') : []);

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

/**
 * Stretch nodes by a factor per fixed axis, about `anchor`, as one box: each
 * moves with the stretch and takes the size that fits its turned box. Exact
 * for nodes square to the axes; one turned in between would shear, which a
 * node cannot express, so it keeps its turn and takes the closest size.
 */
export function scaleNodes<T extends SceneNode>(nodes: T[], factor: Vec3, anchor: Vec3, minSize = 0.1): T[] {
  return nodes.map((node) => {
    const m = rotation(node.rot);
    const size: Vec3 = [...node.size];
    // The length each of the node's own axes would have once the scene is stretched.
    for (let c = 0; c < 3; c++) size[c] = Math.max(minSize, node.size[c] * Math.hypot(m[c * 3] * factor[0], m[c * 3 + 1] * factor[1], m[c * 3 + 2] * factor[2]));
    const pos: Vec3 = [0, 1, 2].map((k) => anchor[k] + (node.pos[k] - anchor[k]) * factor[k]) as Vec3;
    const next = { ...node, size: tidyVec(size), pos: tidyVec(pos) };
    return next.type === 'shape' ? { ...next, params: clampParams({ shape: next.shape, params: next.params, size: next.size }) } : next;
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

/** Copies in a row, a grid or a stack: `count` places along X, Y and Z, the original's included. */
export interface GridArray {
  kind: 'grid';
  count: [number, number, number];
  /** Center-to-center distance along each axis; negative runs the other way. */
  pitch: Vec3;
  /** Spread the pattern over a box instead: the first and last centers sit `inset` in from its faces, on X and Y. */
  fit?: { bounds: Bounds; inset: number };
}

/** Copies round a circle in the plate's plane. */
export interface RingArray {
  kind: 'ring';
  count: number;
  /** Degrees the pattern spreads over: 360 is a full ring, less an arc with a copy at either end. */
  sweep: number;
  center: Vec2;
  /**
   * Given, the originals mark the center and are first moved out from it along
   * +X to this radius; otherwise they already sit on the ring where they are.
   */
  radius?: number;
  /** Turn each copy with its place on the ring, the way the bolts of a flange face the middle. */
  turn: boolean;
}

export type ArraySpec = GridArray | RingArray;

/** How many places a pattern has, the original's included. */
export const arrayPlaces = (spec: Pick<GridArray, 'kind' | 'count'> | Pick<RingArray, 'kind' | 'count'>): number =>
  spec.kind === 'grid' ? spec.count[0] * spec.count[1] * spec.count[2] : spec.count;

/**
 * Lay `nodes` out in a pattern. Returns the originals, moved to the first place
 * when the pattern is fitted into a box, and fresh copies for every other place.
 */
export function arrayNodes<T extends SceneNode>(nodes: T[], boundsOf: (n: T) => Bounds, spec: ArraySpec): { originals: T[]; copies: T[] } {
  const copies: T[] = [];
  if (spec.kind === 'grid') {
    const pitch: Vec3 = [...spec.pitch];
    let originals = nodes;
    if (spec.fit) {
      const { bounds, inset } = spec.fit;
      const center = boundsCenter(unionBounds(nodes.map(boundsOf)));
      const shift: Vec3 = [0, 0, 0];
      for (const axis of [0, 1] as const) {
        const n = spec.count[axis];
        if (n < 2) continue;
        const start = bounds.min[axis] + inset;
        pitch[axis] = (bounds.max[axis] - inset - start) / (n - 1);
        shift[axis] = start - center[axis];
      }
      if (shift.some(Boolean)) originals = nodes.map((n) => ({ ...n, pos: tidyVec(add(n.pos, shift)) }));
    }
    for (let k = 0; k < spec.count[2]; k++) {
      for (let j = 0; j < spec.count[1]; j++) {
        for (let i = 0; i < spec.count[0]; i++) {
          if (i === 0 && j === 0 && k === 0) continue;
          for (const n of originals) copies.push(cloneNode({ ...n, pos: tidyVec([n.pos[0] + i * pitch[0], n.pos[1] + j * pitch[1], n.pos[2] + k * pitch[2]]) }));
        }
      }
    }
    return { originals, copies };
  }
  const step = spec.count < 2 ? 0 : spec.sweep >= 360 ? 360 / spec.count : spec.sweep / (spec.count - 1);
  const pivot: Vec3 = [spec.center[0], spec.center[1], 0];
  let originals = nodes;
  if (spec.radius !== undefined) {
    const c = boundsCenter(unionBounds(nodes.map(boundsOf)));
    const shift: Vec3 = [spec.center[0] + spec.radius - c[0], spec.center[1] - c[1], 0];
    if (shift.some(Boolean)) originals = nodes.map((n) => ({ ...n, pos: tidyVec(add(n.pos, shift)) }));
  }
  for (let i = 1; i < spec.count; i++) {
    const degrees = i * step;
    const placed = spec.turn
      ? rotateNodes(originals, 2, degrees, pivot)
      : originals.map((node) => ({ ...node, pos: add(apply(axisRotation(2, degrees), sub(node.pos, pivot)), pivot) }));
    for (const node of placed) copies.push(cloneNode({ ...node, pos: tidyVec(node.pos) }));
  }
  return { originals, copies };
}

/** What `makeGroup` takes over from a group being remade, instead of starting afresh. */
export type GroupOver = Partial<Pick<GroupNode, 'id' | 'color' | 'hole' | 'hidden' | 'locked' | 'ghost' | 'mixed'>>;

/**
 * Combine nodes into a group whose result has the given bounds (measured by
 * the geometry kernel). A new group shows its parts in their own colors
 * (`mixed`) until a color is chosen for it.
 */
export function makeGroup(nodes: SceneNode[], bounds: Bounds, name: string, over: GroupOver = {}): GroupNode {
  const center: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  // Measured, so kept exact: rounding would scale the contents by a hair (size over natural).
  const size: Vec3 = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  const solids = nodes.filter((n) => !n.hole && n.type !== 'picture');
  return {
    id: over.id ?? newId(),
    type: 'group',
    name,
    pos: center,
    rot: [0, 0, 0],
    size,
    natural: size,
    hole: over.hole ?? false,
    color: over.color ?? (solids[0] ?? nodes[0]).color,
    ...((over.mixed ?? true) ? { mixed: true } : {}),
    ...(over.hidden ? { hidden: true } : {}),
    ...(over.locked ? { locked: true } : {}),
    ...(over.ghost ? { ghost: true } : {}),
    children: nodes.map((n) => {
      const child = { ...n, pos: [n.pos[0] - center[0], n.pos[1] - center[1], n.pos[2] - center[2]] as Vec3 };
      delete child.hidden;
      delete child.locked;
      delete child.ghost;
      return child;
    }),
  };
}

/** Shape parameters in millimeters, which grow with a group when it is taken apart (the rest are counts or ratios). */
const MM_PARAMS = ['radius', 'ring'];

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
    if (even && Math.abs(Math.abs(scale[0]) - 1) > 1e-9) {
      const by = Math.abs(scale[0]);
      if (next.type === 'shape') {
        // Radii are in millimeters, so they grow with the group.
        const params = { ...next.params };
        for (const key of MM_PARAMS) if (key in params) params[key] = tidy(params[key] * by);
        next.params = params;
      }
      // As is the pitch of a tiled picture.
      if (next.texture) next.texture = { ...next.texture, scale: tidy(next.texture.scale * by) };
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

export type AlignMode = 'min' | 'center' | 'max';
export const ALIGN_MODES: AlignMode[] = ['min', 'center', 'max'];
/** Where an anchor dot sits in a list with one entry per dot: the three modes along X, then along Y, then along Z. */
export const alignDot = (axis: 0 | 1 | 2, mode: AlignMode): number => axis * 3 + ALIGN_MODES.indexOf(mode);
/** Where a box sits along an axis, for lining up: its low side, its middle or its high side. */
export const alignAt = (b: Bounds, axis: 0 | 1 | 2, mode: AlignMode): number => (mode === 'min' ? b.min[axis] : mode === 'max' ? b.max[axis] : (b.min[axis] + b.max[axis]) / 2);

/** What it takes to put a dissolved group back together. */
export interface Layer {
  id: string;
  name: string;
  color: string;
  hole: boolean;
  /** Whether its parts showed their own colors. Explicit: a group left unset would come back mixed. */
  mixed: boolean;
  hidden?: boolean;
  locked?: boolean;
  ghost?: boolean;
  /** Ids of what was inside it. */
  children: string[];
  /** Of those, the ones that were holes in their own right: taken apart, a hole group shows all its parts as holes. */
  holes: string[];
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
      mixed: Boolean(group.mixed),
      ...(group.hidden ? { hidden: true } : {}),
      ...(group.locked ? { locked: true } : {}),
      ...(group.ghost ? { ghost: true } : {}),
      children: group.children.map((c) => c.id),
      holes: group.children.filter((c) => c.hole).map((c) => c.id),
    });
    // A hole group hands its role down (not to a picture, which is neither); otherwise children keep their own.
    const freed = ungroup(group).map((child) => (group.hole && child.type !== 'picture' ? { ...child, hole: true } : child));
    const at = out.indexOf(group);
    out = [...out.slice(0, at), ...freed, ...out.slice(at + 1)];
  }
  return { scene: out, layers };
}

/**
 * Holes grouped on their own become one hole: inside, they merge like solids,
 * and the group cuts as a whole (a connector cut-out with its screw holes, say).
 */
export function holeGroup(nodes: SceneNode[]): { members: SceneNode[]; hole: boolean } {
  if (nodes.length === 0 || !nodes.every((n) => n.hole)) return { members: nodes, hole: false };
  return { members: nodes.map((n) => ({ ...n, hole: false })), hole: true };
}

/**
 * The members of a dissolved layer as they go back into it. A hole group's
 * parts were all shown as holes while it was apart, so each gets its own flag
 * back, unless it was made solid meanwhile (a picture is never a hole); a
 * solid group takes its members as they are now.
 */
export function layerMembers(layer: Layer, members: SceneNode[]): { members: SceneNode[]; hole: boolean } {
  if (!layer.hole) return holeGroup(members);
  return { members: members.map((n) => ({ ...n, hole: n.hole && n.type !== 'picture' && layer.holes.includes(n.id) })), hole: true };
}

/**
 * The scene with its dissolved layers put back together, innermost first,
 * around whatever is left of their contents, boxed by `boundsOf`. Pure and
 * immediate, for writing a design out while a group is still being edited
 * inside; `finishEditing` does the same with the kernel's exact measure.
 */
export function regroup(scene: Scene, layers: Layer[], boundsOf: (node: SceneNode) => Bounds): Scene {
  let out = scene;
  for (const layer of [...layers].reverse()) {
    if (out.some((n) => n.id === layer.id)) continue;
    const found = out.filter((n) => layer.children.includes(n.id));
    if (found.length === 0) continue;
    const { members, hole } = layerMembers(layer, found);
    const solids = members.filter((n) => !n.hole && n.type !== 'picture');
    if (solids.length === 0) continue;
    const group = makeGroup(members, unionBounds(solids.map(boundsOf)), layer.name, { ...layer, hole });
    // Where the first of them stood (nothing of the layer comes before it, so the index holds once they are out).
    const at = out.indexOf(found[0]);
    const rest = out.filter((n) => !found.includes(n));
    out = [...rest.slice(0, at), group, ...rest.slice(at)];
  }
  return out;
}

/** The color a node is painted: its own, or, for a mixed group, that of its first solid part. */
export function paintOf(node: SceneNode): string {
  if (node.type !== 'group' || !node.mixed) return node.color;
  const solid = node.children.find((c) => !c.hole && c.type !== 'picture');
  return solid ? paintOf(solid) : node.color;
}

/**
 * The color a mixed group shows on the faces that came from the part at
 * `path` (ids from its children down). A painted group inside it colors
 * everything beneath it; a hole has no color of its own, so the faces it cut
 * take the color of the first solid beside it.
 */
export function sourceColor(group: GroupNode, path: string[]): string {
  let nodes: SceneNode[] = group.children;
  let fallback = group.color;
  for (const id of path) {
    const node = nodes.find((n) => n.id === id);
    if (!node) return fallback;
    if (node.hole) {
      const solid = nodes.find((n) => !n.hole && n.type !== 'picture');
      return solid ? paintOf(solid) : fallback;
    }
    if (node.type !== 'group' || !node.mixed) return node.color;
    nodes = node.children;
    fallback = node.color;
  }
  return fallback;
}

/** World transform of a node's own box (centered, `size` wide) reached through `path`. */
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
  return nodes.map((node) => {
    const shift = alignAt(target, axis, mode) - alignAt(boundsOf(node), axis, mode);
    if (shift === 0) return node;
    const pos: Vec3 = [...node.pos];
    // Exact on purpose: the faces are meant to meet.
    pos[axis] = pos[axis] + shift;
    return { ...node, pos };
  });
}
