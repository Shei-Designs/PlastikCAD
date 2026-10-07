// Small affine-transform toolkit shared by the UI, the viewer and the geometry
// worker, so that all three agree on where a node is.
import type { SceneNode, Vec3 } from './types';

/**
 * Affine transform as a 3x4 matrix in column-major order:
 * [xx, xy, xz,  yx, yy, yz,  zx, zy, zz,  tx, ty, tz]
 * (the images of the X, Y and Z axes, then the translation). Manifold's
 * `transform()` wants the 4x4 form of this; the kernel pads it.
 */
export type Mat = [number, number, number, number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

const RAD = Math.PI / 180;

/** a·b: apply b first, then a. */
export function multiply(a: Mat, b: Mat): Mat {
  const out = new Array(12) as Mat;
  for (let c = 0; c < 4; c++) {
    const x = b[c * 3];
    const y = b[c * 3 + 1];
    const z = b[c * 3 + 2];
    for (let r = 0; r < 3; r++) {
      out[c * 3 + r] = a[r] * x + a[3 + r] * y + a[6 + r] * z + (c === 3 ? a[9 + r] : 0);
    }
  }
  return out;
}

export const translation = (v: Vec3): Mat => [1, 0, 0, 0, 1, 0, 0, 0, 1, v[0], v[1], v[2]];
export const scaling = (v: Vec3): Mat => [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2], 0, 0, 0];

/**
 * Cosine and sine that are exact at multiples of 90 degrees. Math.cos(90°) is
 * 6e-17, which is enough to keep two faces that should coincide from doing
 * so, and the geometry kernel then leaves paper-thin slivers between them.
 */
function cosSin(degrees: number): [number, number] {
  const quarter = degrees / 90;
  if (Number.isInteger(quarter)) {
    const q = ((quarter % 4) + 4) % 4;
    return q === 0 ? [1, 0] : q === 1 ? [0, 1] : q === 2 ? [-1, 0] : [0, -1];
  }
  return [Math.cos(degrees * RAD), Math.sin(degrees * RAD)];
}

/** True when every axis is turned by a multiple of 90 degrees, so boxes stay boxes. */
export const squareTurn = (rot: Vec3): boolean => rot.every((a) => Number.isInteger(a / 90));

/** Rotation by `rot` degrees about X, then Y, then Z (fixed axes): Rz·Ry·Rx. */
export function rotation(rot: Vec3): Mat {
  const [cx, sx] = cosSin(rot[0]);
  const [cy, sy] = cosSin(rot[1]);
  const [cz, sz] = cosSin(rot[2]);
  const m: Mat = [
    cz * cy,
    sz * cy,
    -sy,
    cz * sy * sx - sz * cx,
    sz * sy * sx + cz * cx,
    cy * sx,
    cz * sy * cx + sz * sx,
    sz * sy * cx - cz * sx,
    cy * cx,
    0,
    0,
    0,
  ];
  // Products of exact zeros come out as -0, which compares equal but prints and hashes differently.
  for (let i = 0; i < 9; i++) if (m[i] === 0) m[i] = 0;
  return m;
}

/** Rotation by `degrees` about one of the fixed axes (0 = X, 1 = Y, 2 = Z). */
export function axisRotation(axis: 0 | 1 | 2, degrees: number): Mat {
  const rot: Vec3 = [0, 0, 0];
  rot[axis] = degrees;
  return rotation(rot);
}

/** Inverse of `rotation`: Euler angles in degrees for a pure rotation matrix. */
export function eulerOf(m: Mat): Vec3 {
  const sy = Math.max(-1, Math.min(1, -m[2]));
  let x: number;
  let z: number;
  const y = Math.asin(sy);
  if (Math.abs(sy) < 1 - 1e-9) {
    x = Math.atan2(m[5], m[8]);
    z = Math.atan2(m[1], m[0]);
  } else {
    // Gimbal lock: X and Z turn about the same axis, so put it all on Z.
    x = 0;
    z = Math.atan2(-m[3], m[4]);
  }
  return [tidyAngle(x / RAD), tidyAngle(y / RAD), tidyAngle(z / RAD)];
}

/** Rounds away floating-point noise and maps to (-180, 180]. */
export function tidyAngle(degrees: number): number {
  let a = Math.round(degrees * 1e6) / 1e6;
  a = ((((a + 180) % 360) + 360) % 360) - 180;
  if (a === -180) a = 180;
  return a === 0 ? 0 : a;
}

export function apply(m: Mat, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[3] * p[1] + m[6] * p[2] + m[9],
    m[1] * p[0] + m[4] * p[1] + m[7] * p[2] + m[10],
    m[2] * p[0] + m[5] * p[1] + m[8] * p[2] + m[11],
  ];
}

export function determinant(m: Mat): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7]) + m[6] * (m[1] * m[5] - m[2] * m[4])
  );
}

export const flipSigns = (flip: SceneNode['flip']): Vec3 => [flip?.[0] ? -1 : 1, flip?.[1] ? -1 : 1, flip?.[2] ? -1 : 1];

/**
 * Size at which a node's geometry is built. Groups and imports are built once
 * at their natural size and scaled; so are shapes whose form does not depend
 * on their proportions. The rest (rounded boxes, tubes, tori) are rebuilt at
 * the exact size, so that radii and wall thicknesses stay true.
 */
export function builtSize(node: SceneNode): Vec3 {
  if (node.type !== 'shape') return node.natural;
  return sizeDependent(node) ? node.size : [1, 1, 1];
}

export function sizeDependent(node: SceneNode): boolean {
  if (node.type !== 'shape') return false;
  return node.shape === 'tube' || node.shape === 'torus' || ((node.shape === 'box' || node.shape === 'cylinder') && (node.params.radius ?? 0) > 0);
}

/** Scale from the geometry as built to the node's size, including mirroring. */
export function localScale(node: SceneNode): Vec3 {
  const built = builtSize(node);
  const sign = flipSigns(node.flip);
  return [(node.size[0] / built[0]) * sign[0], (node.size[1] / built[1]) * sign[1], (node.size[2] / built[2]) * sign[2]];
}

/** Transform from a node's built geometry (centred on the origin) to its parent's coordinates. */
export function nodeMatrix(node: SceneNode): Mat {
  const m = multiply(rotation(node.rot), scaling(localScale(node)));
  m[9] = node.pos[0];
  m[10] = node.pos[1];
  m[11] = node.pos[2];
  return m;
}

/** Transform from a node's local box (centred, `size` wide, unmirrored axes) to its parent: translation and rotation only. */
export function frameMatrix(node: SceneNode): Mat {
  const m = rotation(node.rot);
  m[9] = node.pos[0];
  m[10] = node.pos[1];
  m[11] = node.pos[2];
  return m;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export const emptyBounds = (): Bounds => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
export const isEmptyBounds = (b: Bounds): boolean => b.min[0] > b.max[0];

export function expandBounds(b: Bounds, p: Vec3): void {
  for (let i = 0; i < 3; i++) {
    if (p[i] < b.min[i]) b.min[i] = p[i];
    if (p[i] > b.max[i]) b.max[i] = p[i];
  }
}

export function unionBounds(list: Bounds[]): Bounds {
  const out = emptyBounds();
  for (const b of list) {
    if (isEmptyBounds(b)) continue;
    expandBounds(out, b.min);
    expandBounds(out, b.max);
  }
  return out;
}

export const boundsCenter = (b: Bounds): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
export const boundsSize = (b: Bounds): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

/** Axis-aligned bounds of a node's local box after its transform (loose for round shapes; see the mesh bounds for tight ones). */
export function boxBounds(node: SceneNode): Bounds {
  const m = frameMatrix(node);
  const b = emptyBounds();
  const h: Vec3 = [node.size[0] / 2, node.size[1] / 2, node.size[2] / 2];
  for (let i = 0; i < 8; i++) expandBounds(b, apply(m, [i & 1 ? h[0] : -h[0], i & 2 ? h[1] : -h[1], i & 4 ? h[2] : -h[2]]));
  return b;
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * Rounds to 1/10000 mm so that drags and repeated edits don't accumulate noise
 * in saved files. Only for values that come from the user (a snapped drag, a
 * typed number): a position worked out from measured geometry must keep its
 * full precision, or the faces it was meant to meet are missed by a hair.
 */
export const tidy = (v: number): number => {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r;
};
export const tidyVec = (v: Vec3): Vec3 => [tidy(v[0]), tidy(v[1]), tidy(v[2])];
