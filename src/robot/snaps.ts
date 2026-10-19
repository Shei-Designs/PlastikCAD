// The points a joint can be dropped on: the corners, edge middles and face
// centers of a link's box, and for a round shape the two ends of its axis,
// which carry the axis itself.
import { apply, frameMatrix, rotation } from '../model/math';
import type { SceneNode, Vec3 } from '../model/types';
import type { SnapPoint } from '../viewer/Viewer';

/** Shapes and parts built round an axis along their local Z. */
const ROUND = new Set(['cylinder', 'cone', 'torus', 'dome', 'sphere']);

export const isRound = (node: SceneNode): boolean => (node.type === 'shape' && ROUND.has(node.shape)) || node.type === 'part';

/** The snap points of a node, in the design's coordinates. */
export function snapPointsOf(node: SceneNode): SnapPoint[] {
  const m = frameMatrix(node);
  const turn = rotation(node.rot);
  const [hx, hy, hz] = node.size.map((s) => s / 2);
  const zAxis = apply(turn, [0, 0, 1]);
  const out: SnapPoint[] = [];
  const seen = new Set<string>();
  const add = (local: Vec3, axis?: Vec3) => {
    const key = local.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(axis ? { at: apply(m, local), axis } : { at: apply(m, local) });
  };
  // The ends of the axis first, so that they win where a face center would coincide.
  if (isRound(node)) {
    add([0, 0, hz], zAxis);
    add([0, 0, -hz], zAxis);
    add([0, 0, 0], zAxis);
  }
  add([0, 0, 0]);
  for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) for (const sz of [-1, 0, 1]) if (sx || sy || sz) add([sx * hx, sy * hy, sz * hz]);
  return out;
}
