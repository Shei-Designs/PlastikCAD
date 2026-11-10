// Three-way merge of two versions of a design that grew apart from a common
// base, object by object: an object changed on one side only takes that
// side's version, one deleted on one side and left alone on the other goes,
// and one changed differently on both sides is a conflict.
import { canonical, canonicalRobot, foreignId, robotNamesAny } from '../model/file';
import type { Doc, Foreign, ForeignNode, SceneNode } from '../model/types';

export interface Merged {
  doc: Doc;
  /** Objects changed differently on both sides, the robot counting as one; the local version was kept for each. */
  conflicts: number;
}

/**
 * One object of a design as the merge sees it: one the app understands, or one carried for a
 * newer version of the app (see `Foreign`). The two are told apart by what they would be written
 * as, so an object that one side understands and the other carries is one that changed.
 */
type Entry = { text: string; node: SceneNode } | { text: string; carried: ForeignNode };

function entries(doc: Doc | null): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const node of doc?.scene ?? []) out.set(node.id, { text: JSON.stringify(canonical(node)), node });
  // A carried object with no id of its own goes by all that it is.
  for (const carried of doc?.foreign?.nodes ?? []) out.set(foreignId(carried) ?? JSON.stringify(carried.raw), { text: JSON.stringify(carried.raw), carried });
  return out;
}

const same = (a: Entry | undefined, b: Entry | undefined): boolean => a === b || (a !== undefined && b !== undefined && a.text === b.text);

/** The robot of a design as it would be written, carried or not; empty with none. */
const robotText = (d: Doc | null): string => (d?.foreign?.robot ? JSON.stringify(d.foreign.robot) : d?.robot ? JSON.stringify(canonicalRobot(d.robot)) : '');

/**
 * `base` is the version both sides started from; null when it is unknown, in
 * which case every difference counts as a conflict. The result keeps the
 * local object order, with objects added remotely slotted in where the
 * remote side had them.
 */
export function mergeDocs(base: Doc | null, local: Doc, remote: Doc): Merged {
  const B = entries(base);
  const L = entries(local);
  const R = entries(remote);
  const picked = new Map<string, Entry>();
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

  const node = (id: string): SceneNode | undefined => {
    const entry = picked.get(id);
    return entry && 'node' in entry ? entry.node : undefined;
  };
  const scene: SceneNode[] = [];
  const here = new Set(local.scene.map((n) => n.id));
  for (const id of here) if (node(id)) scene.push(node(id)!);
  // Remote additions go after the nearest object that precedes them remotely and is in the result.
  const remoteIds = remote.scene.map((n) => n.id);
  for (let i = 0; i < remoteIds.length; i++) {
    const id = remoteIds[i];
    if (here.has(id) || !node(id)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const index = scene.findIndex((n) => n.id === remoteIds[j]);
      if (index >= 0) {
        at = index + 1;
        break;
      }
    }
    scene.splice(at, 0, node(id)!);
  }
  // What is carried keeps the place each side's file gave it: this side's first, then what only the other side has.
  const carried: ForeignNode[] = [];
  for (const side of [L, R]) for (const [id, entry] of side) if ('carried' in entry && picked.get(id) === entry) carried.push(entry.carried);

  let name = local.name;
  if (local.name !== remote.name && base && local.name === base.name) name = remote.name;
  // Asset keys are content hashes, so the same key is the same data on both sides.
  const assets = { ...remote.assets, ...local.assets };
  // The robot is one thing: the side that changed it has it. Changed differently on both, it is a conflict like an
  // object's, and the local one is kept. It goes as that side has it, understood or carried.
  let from = local;
  if (robotText(local) !== robotText(remote)) {
    if (base && robotText(local) === robotText(base)) from = remote;
    else if (!base || robotText(remote) !== robotText(base)) conflicts++;
  }
  // A robot this version understands may now be laid over an object the result carries, the other side having made
  // of it something this version does not know. It is then carried as well, as it is when such a design is read.
  const overCarried = from.robot && !from.foreign?.robot && robotNamesAny(canonicalRobot(from.robot), new Set(carried.map(foreignId)));
  const carriedRobot = from.foreign?.robot ?? (overCarried ? canonicalRobot(from.robot!) : undefined);
  const foreign: Foreign = {
    ...(carried.length ? { nodes: carried } : {}),
    ...(carriedRobot ? { robot: carriedRobot } : {}),
    // Like the assets above: the same key is the same data on both sides.
    ...(local.foreign?.assets || remote.foreign?.assets ? { assets: { ...remote.foreign?.assets, ...local.foreign?.assets } } : {}),
    ...(local.foreign?.fields || remote.foreign?.fields ? { fields: { ...remote.foreign?.fields, ...local.foreign?.fields } } : {}),
  };
  const { robot: _own, foreign: _carried, ...rest } = local;
  return { doc: { ...rest, name, scene, assets, ...(from.robot && !carriedRobot ? { robot: from.robot } : {}), ...(Object.keys(foreign).length ? { foreign } : {}) }, conflicts };
}
