// The Measure tool's picks hold points of an object as it stood when it was
// picked. This says whether they still stand after the scene changed.
import type { Feature } from '../geometry/features';
import type { SceneNode } from '../model/types';

/**
 * True while every picked object is the very one it was: moved, resized,
 * edited or deleted, an object is a new one in the scene, and what was
 * measured on it is no longer there.
 */
export function picksStand(picks: Feature[], before: SceneNode[], after: SceneNode[]): boolean {
  if (before === after) return true;
  return picks.every((pick) => {
    const was = before.find((n) => n.id === pick.node);
    return was !== undefined && after.find((n) => n.id === pick.node) === was;
  });
}
