// The sums behind a drag: where the pointer ray meets the line or plane a
// grip moves on, and what the nodes become once the grip box has a new size
// or the turn a new angle. Nothing here keeps state or touches the scene.
import { Plane, Vector3 } from 'three';
import type { Ray } from 'three';
import { clampParams } from '../geometry/shapes';
import { rotation, tidyVec } from '../model/math';
import type { Mat } from '../model/math';
import { scaleNodes } from '../model/ops';
import type { SceneNode, Vec3 } from '../model/types';
import type { Frame } from './handles';
import { axisVector } from './stage';

export const MIN_SIZE = 0.1; // mm
export const ROTATE_STEP = 15;
export const ROTATE_COARSE = 45;

/** The box a grip stretches, as it was when the grip was pressed: square to the axes round one object or several, or (`own`) one object's own box. */
export interface GripBox {
  matrix: Mat;
  size: Vec3;
  own: SceneNode | null;
}

export const gripBox = (f: Frame): GripBox => ({ matrix: f.matrix, size: [f.half[0] * 2, f.half[1] * 2, f.half[2] * 2], own: f.local ? f.single : null });

/** A point of a box (frame or grip box) in the scene. */
export function pointOf(m: Mat, local: Vec3): Vector3 {
  return new Vector3(
    m[0] * local[0] + m[3] * local[1] + m[6] * local[2] + m[9],
    m[1] * local[0] + m[4] * local[1] + m[7] * local[2] + m[10],
    m[2] * local[0] + m[5] * local[1] + m[8] * local[2] + m[11],
  );
}

export function boxAxis(box: GripBox, axis: 0 | 1 | 2): Vector3 {
  const m = box.matrix;
  return new Vector3(m[axis * 3], m[axis * 3 + 1], m[axis * 3 + 2]);
}

/** Distance along a line (from `origin` in direction `axis`) of the point nearest to the pointer ray. */
export function alongAxis(ray: Ray, origin: Vector3, axis: Vector3): number | null {
  const w = origin.clone().sub(ray.origin);
  const b = axis.dot(ray.direction);
  const denominator = 1 - b * b;
  // Looking straight down the line: the pointer says nothing about where along it.
  if (denominator < 1e-3) return null;
  return (b * w.dot(ray.direction) - w.dot(axis)) / denominator;
}

/** True when the box's base plane is seen so nearly edge-on that a pointer cannot be placed on it. */
export function baseEdgeOn(ray: Ray, box: GripBox): boolean {
  return Math.abs(ray.direction.dot(boxAxis(box, 2))) < 0.06;
}

/** Of the box's two base axes, the one squarer to the view, which the pointer can follow. */
export function bestBaseAxis(ray: Ray, box: GripBox): 0 | 1 {
  const d = ray.direction;
  return Math.abs(d.dot(boxAxis(box, 0))) <= Math.abs(d.dot(boxAxis(box, 1))) ? 0 : 1;
}

/**
 * Pointer position on the plane of the box's base, in the box's own (unscaled) frame, relative to
 * its center. With `axisOnly`, or for an edge grip, the pointer is followed along one axis only and
 * the other is held at the grip, which works from any viewing angle.
 */
export function resizePoint(ray: Ray, box: GripBox, sx: number, sy: number, axisOnly?: 0 | 1): Vector3 | null {
  const m = box.matrix;
  const x = new Vector3(m[0], m[1], m[2]);
  const y = new Vector3(m[3], m[4], m[5]);
  const z = new Vector3(m[6], m[7], m[8]);
  const center = new Vector3(m[9], m[10], m[11]);
  const base = center.clone().addScaledVector(z, -box.size[2] / 2);
  const single = axisOnly ?? (sx !== 0 && sy !== 0 ? null : sx !== 0 ? 0 : 1);
  if (single === null) {
    const plane = new Plane().setFromNormalAndCoplanarPoint(z, base);
    if (Math.abs(ray.direction.dot(z)) < 0.06) return null;
    const p = ray.intersectPlane(plane, new Vector3());
    if (!p) return null;
    p.sub(center);
    return new Vector3(p.dot(x), p.dot(y), 0);
  }
  const t = alongAxis(ray, base, single === 0 ? x : y);
  if (t === null) return null;
  // The axis not followed stays at the grip's own place, so that side keeps its size.
  return single === 0 ? new Vector3(t, (sy * box.size[1]) / 2, 0) : new Vector3((sx * box.size[0]) / 2, t, 0);
}

/** Angle of the pointer around a fixed axis through `pivot`, or null when that axis is seen side-on. */
export function angleAbout(ray: Ray, axis: 0 | 1 | 2, pivot: Vec3, frame?: Mat): number | null {
  // The frame's axes (the design's without one): the turn's axis and the two square to it.
  const column = (c: number) => (frame ? new Vector3(frame[c * 3], frame[c * 3 + 1], frame[c * 3 + 2]) : axisVector(c as 0 | 1 | 2));
  const normal = column(axis);
  if (Math.abs(ray.direction.dot(normal)) < 0.2) return null;
  const plane = new Plane().setFromNormalAndCoplanarPoint(normal, new Vector3(...pivot));
  const p = ray.intersectPlane(plane, new Vector3());
  if (!p) return null;
  p.sub(new Vector3(...pivot));
  const u = p.dot(column((axis + 1) % 3));
  const v = p.dot(column((axis + 2) % 3));
  return (Math.atan2(v, u) * 180) / Math.PI;
}

/** A length brought to the nearest grid step; as it is when the step is 0. */
export function snapTo(v: number, step: number): number {
  return step > 0 ? Math.round(v / step) * step : v;
}

/** A turn in degrees taken the short way round (-180 up to 180) and brought to the nearest step. */
export function snapTurn(delta: number, step: number): number {
  delta = ((((delta + 180) % 360) + 360) % 360) - 180;
  return Math.round(delta / step) * step;
}

/** New size for one object on its own box, with the `anchor` side (-1/0/+1 per axis) staying put. */
export function resized(node: SceneNode, size: Vec3, anchor: Vec3): SceneNode {
  const m = rotation(node.rot);
  const pos: Vec3 = [...node.pos];
  for (let c = 0; c < 3; c++) {
    const shift = (anchor[c] * (node.size[c] - size[c])) / 2;
    pos[0] += m[c * 3] * shift;
    pos[1] += m[c * 3 + 1] * shift;
    pos[2] += m[c * 3 + 2] * shift;
  }
  const next = { ...node, size: tidyVec(size), pos: tidyVec(pos) } as SceneNode;
  return next.type === 'shape' ? { ...next, params: clampParams({ shape: next.shape, params: next.params, size: next.size }) } : next;
}

/**
 * The nodes as they are once the grip box has `size`, with the `anchor` side (-1/0/+1 per axis) staying
 * put: one object on its own box resized (Object axes), else stretched along the design's axes about
 * the fixed side of the box, which is square to them.
 */
export function stretched(box: GripBox, nodes: SceneNode[], size: Vec3, anchor: Vec3): SceneNode[] {
  if (box.own) return [resized(box.own, size, anchor)];
  const factor: Vec3 = [0, 1, 2].map((c) => size[c] / Math.max(box.size[c], 1e-6)) as Vec3;
  const pivot = pointOf(box.matrix, [(anchor[0] * box.size[0]) / 2, (anchor[1] * box.size[1]) / 2, (anchor[2] * box.size[2]) / 2]);
  return scaleNodes(nodes, factor, pivot.toArray() as Vec3, MIN_SIZE);
}
