// Three-way merge of two versions of a design that grew apart from a common
// base, object by object: an object changed on one side only takes that
// side's version, one deleted on one side and left alone on the other goes,
// and one changed differently on both sides is a conflict.
import { canonical, canonicalRobot } from '../model/file';
import type { Doc, SceneNode } from '../model/types';

export interface Merged {
  doc: Doc;
  /** Objects changed differently on both sides, the robot counting as one; the local version was kept for each. */
  conflicts: number;
}

const text = (node: SceneNode): string => JSON.stringify(canonical(node));
const same = (a: SceneNode | undefined, b: SceneNode | undefined): boolean => a === b || (a !== undefined && b !== undefined && text(a) === text(b));

/**
 * `base` is the version both sides started from; null when it is unknown, in
 * which case every difference counts as a conflict. The result keeps the
 * local object order, with objects added remotely slotted in where the
 * remote side had them.
 */
export function mergeDocs(base: Doc | null, local: Doc, remote: Doc): Merged {
  const B = new Map((base?.scene ?? []).map((n) => [n.id, n]));
  const L = new Map(local.scene.map((n) => [n.id, n]));
  const R = new Map(remote.scene.map((n) => [n.id, n]));
  const picked = new Map<string, SceneNode>();
  let conflicts = 0;
  for (const id of new Set([...L.keys(), ...R.keys(), ...B.keys()])) {
    const b = B.get(id);
    const l = L.get(id);
    const r = R.get(id);
    if (same(l, r)) {
      if (l) picked.set(id, l);
      continue;
    }
    const localChanged = !same(l, b);
    const remoteChanged = !same(r, b);
    if (!localChanged) {
      if (r) picked.set(id, r);
    } else if (!remoteChanged) {
      if (l) picked.set(id, l);
    } else if (l && r) {
      // Changed differently on both sides.
      conflicts++;
      picked.set(id, l);
    } else {
      // Deleted on one side, edited on the other: the edit is kept.
      picked.set(id, (l ?? r)!);
    }
  }

  const scene: SceneNode[] = [];
  for (const node of local.scene) if (picked.has(node.id)) scene.push(picked.get(node.id)!);
  // Remote additions go after the nearest object that precedes them remotely and is in the result.
  const remoteIds = remote.scene.map((n) => n.id);
  for (let i = 0; i < remoteIds.length; i++) {
    const id = remoteIds[i];
    if (L.has(id) || !picked.has(id)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const index = scene.findIndex((n) => n.id === remoteIds[j]);
      if (index >= 0) {
        at = index + 1;
        break;
      }
    }
    scene.splice(at, 0, picked.get(id)!);
  }

  let name = local.name;
  if (local.name !== remote.name && base && local.name === base.name) name = remote.name;
  // Asset keys are content hashes, so the same key is the same data on both sides.
  const assets = { ...remote.assets, ...local.assets };
  // The robot is one thing: the side that changed it has it. Changed differently on both, it is a conflict like an
  // object's, and the local one is kept.
  const robotText = (d: Doc | null) => (d?.robot ? JSON.stringify(canonicalRobot(d.robot)) : '');
  let robot = local.robot;
  if (robotText(local) !== robotText(remote)) {
    if (base && robotText(local) === robotText(base)) robot = remote.robot;
    else if (!base || robotText(remote) !== robotText(base)) conflicts++;
  }
  const { robot: _own, ...rest } = local;
  return { doc: { ...rest, name, scene, assets, ...(robot ? { robot } : {}) }, conflicts };
}
