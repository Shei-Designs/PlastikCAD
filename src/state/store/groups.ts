// Grouping and ungrouping, and editing inside a group: its layers taken
// apart to reach one part and put back together afterwards.
import { dissolve, frameAlong, holeGroup, layerMembers, makeGroup, nodeAt, ungroup, uniqueName } from '../../model/ops';
import type { GroupOver } from '../../model/ops';
import type { GroupNode, Scene, SceneNode } from '../../model/types';
import { geometry } from '../geometry';
import { abortAlignPreview, commit, fail, getState, notify, replaceState, set } from './core';
import { selectedNodes } from './editing';

/** Measure and build a group of the given members (their hole flags as they are to be inside it); null if nothing solid would be left. */
export async function buildGroup(members: SceneNode[], hole: boolean, name: string, over: GroupOver = {}): Promise<GroupNode | null> {
  const worker = await geometry.prepare(members, getState().doc.assets);
  const bounds = await worker.measure(members);
  return bounds ? makeGroup(members, bounds, name, { ...over, hole }) : null;
}

export async function groupSelected(): Promise<void> {
  abortAlignPreview();
  const nodes = selectedNodes();
  if (nodes.length < 2) return;
  if (nodes.some((n) => n.locked)) return notify('Unlock the selected objects before grouping them.', 'error');
  set({ busy: 'Grouping…' });
  try {
    const { members, hole } = holeGroup(nodes);
    const group = await buildGroup(members, hole, uniqueName(getState().doc.scene, 'Group'));
    if (!group) return notify('Nothing would be left: the holes remove everything.', 'error');
    // The scene may have moved on while the worker was measuring.
    const ids = new Set(nodes.map((n) => n.id));
    if (!nodes.every((n) => getState().doc.scene.includes(n))) return;
    commit([...getState().doc.scene.filter((n) => !ids.has(n.id)), group], { selection: [group.id] });
  } catch (e) {
    fail(e);
  } finally {
    set({ busy: null });
  }
}

export function ungroupSelected(): void {
  abortAlignPreview();
  const groups = selectedNodes().filter((n) => n.type === 'group' && !n.locked);
  if (groups.length === 0) return;
  const selection = getState().selection.filter((id) => !groups.some((g) => g.id === id));
  const scene: Scene = [];
  for (const node of getState().doc.scene) {
    if (node.type !== 'group' || !groups.includes(node)) {
      scene.push(node);
      continue;
    }
    for (const child of ungroup(node)) {
      // A hole group hands its role down (not to a picture, which is neither); otherwise children keep their own.
      const freed = node.hole && child.type !== 'picture' ? { ...child, hole: true } : child;
      scene.push(freed);
      selection.push(freed.id);
    }
  }
  commit(scene, { selection });
}

// --- editing inside a group --------------------------------------------------------

export function setHighlight(path: string[] | null): void {
  const matrix = path ? frameAlong(getState().doc.scene, path) : null;
  const node = path ? nodeAt(getState().doc.scene, path) : null;
  const highlight = matrix && node ? { matrix, size: node.size } : null;
  if (highlight || getState().highlight) set({ highlight });
}

/**
 * Take the groups along `path` apart so that the part at its end can be
 * changed, remembering how to put them back together (see `finishEditing`).
 */
export function editInside(path: string[]): void {
  if (getState().editing || path.length < 2) return;
  abortAlignPreview();
  const root = getState().doc.scene.find((n) => n.id === path[0]);
  if (root?.type !== 'group') return;
  if (root.locked) return notify('Unlock the object before editing inside it.', 'error');
  const { scene, layers } = dissolve(getState().doc.scene, path);
  const target = path[path.length - 1];
  replaceState({ ...getState(), editing: { root: root.id, target, layers, before: getState().doc.scene }, highlight: null, aligning: null, measuring: null });
  commit(scene, { selection: scene.some((n) => n.id === target) ? [target] : [] });
}

/** Put the layers back together, innermost first, around whatever is left of their contents. */
export async function finishEditing(): Promise<void> {
  const session = getState().editing;
  if (!session) return;
  set({ busy: 'Regrouping…' });
  try {
    let scene = getState().doc.scene;
    let outermost: string | null = null;
    for (const layer of [...session.layers].reverse()) {
      // Undo may have put a layer back already; what was deleted meanwhile is simply left out.
      if (scene.some((n) => n.id === layer.id)) {
        outermost = layer.id;
        continue;
      }
      const found = scene.filter((n) => layer.children.includes(n.id));
      if (found.length === 0) continue;
      // A dissolved hole group showed its parts as holes; each takes its own flag back inside it.
      const { members, hole } = layerMembers(layer, found);
      const group = await buildGroup(members, hole, layer.name, layer);
      if (!group) {
        notify(`"${layer.name}" could not be put back together: nothing solid is left in it.`, 'error');
        continue;
      }
      const at = scene.indexOf(found[0]);
      scene = [...scene.filter((n) => !found.includes(n)).slice(0, at), group, ...scene.filter((n) => !found.includes(n)).slice(at)];
      outermost = group.id;
    }
    replaceState({ ...getState(), editing: null });
    commit(scene, { selection: outermost ? [outermost] : [] });
  } catch (e) {
    fail(e);
  } finally {
    set({ busy: null });
  }
}

/** Back to how things were before `editInside`. */
export function cancelEditing(): void {
  const session = getState().editing;
  if (!session) return;
  replaceState({ ...getState(), editing: null });
  commit(session.before, { selection: [session.root] });
}
