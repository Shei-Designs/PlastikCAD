// The selection, and the plain edits of what is selected: moving, sizing,
// copying, painting, naming, hiding, locking and ghosting.
import { clampParams } from '../../geometry/shapes';
import { MAX_NOTE } from '../../model/file';
import { apply, axisRotation, boundsCenter, eulerOf, multiply, rotation, tidyVec, unionBounds } from '../../model/math';
import type { Bounds } from '../../model/math';
import { alignNodes, cloneNode, mirrorNodes, rotateNodes, uniqueName, usedAssets } from '../../model/ops';
import type { AlignMode } from '../../model/ops';
import type { Doc, ImageAsset, PictureNode, Scene, SceneNode, Texture, Vec3 } from '../../model/types';
import { geometry } from '../geometry';
import { abortAlignPreview, commit, getState, set } from './core';
import type { EditorState } from './core';
import { stopAligning } from './tools';

// --- selection --------------------------------------------------------------

export function selectedNodes(s: EditorState = getState()): SceneNode[] {
  if (s.selection.length === 0) return [];
  const ids = new Set(s.selection);
  return s.doc.scene.filter((n) => ids.has(n.id));
}

export function select(ids: string[]): void {
  abortAlignPreview();
  // The dots of a joint or sensor being lined up go with it (an unchanged empty selection would keep them otherwise).
  if (getState().aligning?.marker) stopAligning();
  // Selecting an object takes the right panel from the custom parts bin; any selection, or none, takes it from a joint or sensor.
  set(ids.length ? { selection: ids, bin: false, joint: null, sensor: null, jointPick: null, pose: null } : { selection: ids, joint: null, sensor: null, jointPick: null, pose: null });
}

export function toggleSelected(id: string): void {
  select(getState().selection.includes(id) ? getState().selection.filter((s) => s !== id) : [...getState().selection, id]);
}

export const selectAll = (): void => select(getState().doc.scene.filter((n) => !n.hidden && !n.ghost).map((n) => n.id));

/** Tight bounds of everything selected, or null when nothing is. */
export function selectionBounds(nodes: SceneNode[] = selectedNodes()): Bounds | null {
  return nodes.length ? unionBounds(nodes.map((n) => geometry.bounds(n))) : null;
}

// --- editing ----------------------------------------------------------------

/** Apply `change` to the selected nodes that are not locked. */
export function updateSelected(change: (node: SceneNode) => SceneNode, merge?: string): void {
  abortAlignPreview();
  const ids = new Set(getState().selection);
  let touched = false;
  const scene = getState().doc.scene.map((n) => {
    if (!ids.has(n.id) || n.locked) return n;
    const next = change(n);
    if (next !== n) touched = true;
    return next;
  });
  if (touched) commit(scene, { merge });
}

/** Replace specific nodes (used by drags in the viewport). */
export function replaceNodes(nodes: SceneNode[], merge?: string): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  commit(
    getState().doc.scene.map((n) => byId.get(n.id) ?? n),
    { merge },
  );
}

export function updateNode(id: string, patch: Partial<SceneNode>, merge?: string): void {
  commit(
    getState().doc.scene.map((n) => (n.id === id ? ({ ...n, ...patch } as SceneNode) : n)),
    { merge },
  );
}

/** Change a node's size along one axis, keeping its lowest point where it is when that axis is Z. */
export function resizeNode(node: SceneNode, axis: 0 | 1 | 2, value: number, uniform: boolean): void {
  if (!(value > 0)) return;
  const factor = value / node.size[axis];
  const size = tidyVec(uniform ? [node.size[0] * factor, node.size[1] * factor, node.size[2] * factor] : (node.size.map((v, i) => (i === axis ? value : v)) as Vec3));
  let next = { ...node, size } as SceneNode;
  if (next.type === 'shape') next = { ...next, params: clampParams({ shape: next.shape, params: next.params, size }) };
  // Things stay on the plate (or wherever they stand) when their height changes.
  const before = geometry.bounds(node);
  const after = geometry.bounds(next);
  const lift = before.min[2] - after.min[2];
  if (lift !== 0) next = { ...next, pos: [next.pos[0], next.pos[1], next.pos[2] + lift] };
  updateNode(node.id, next, `size:${node.id}:${axis}`);
}

export function deleteSelected(): void {
  abortAlignPreview();
  const ids = new Set(selectedNodes().filter((n) => !n.locked).map((n) => n.id));
  if (ids.size === 0) return;
  commit(
    getState().doc.scene.filter((n) => !ids.has(n.id)),
    { selection: getState().selection.filter((id) => !ids.has(id)) },
  );
}

function addCopies(sources: SceneNode[], offset: Vec3): void {
  if (sources.length === 0) return;
  abortAlignPreview();
  let scene = getState().doc.scene;
  const copies = sources.map((source) => {
    const copy = cloneNode(source);
    copy.name = uniqueName(scene, source.name.replace(/ \d+$/, ''));
    copy.pos = tidyVec([source.pos[0] + offset[0], source.pos[1] + offset[1], source.pos[2] + offset[2]]);
    delete copy.locked;
    scene = [...scene, copy];
    return copy;
  });
  commit(scene, { selection: copies.map((c) => c.id) });
}

/** Copies appear exactly on top of the originals, selected, ready to be dragged away. */
export function duplicateSelected(): void {
  abortAlignPreview();
  addCopies(selectedNodes(), [0, 0, 0]);
}

let clipboard: SceneNode[] = [];

export function copySelected(): void {
  abortAlignPreview();
  const nodes = selectedNodes();
  if (nodes.length) clipboard = nodes;
}

export function paste(): void {
  // Assets of pasted imports are still in the document unless it was replaced in between.
  const usable = clipboard.filter((n) => [...usedAssets([n])].every((a) => getState().doc.assets[a]));
  const stepSize = getState().prefs.snap || 1;
  addCopies(usable, [Math.max(10, stepSize), -Math.max(10, stepSize), 0]);
}

export function nudgeSelected(delta: Vec3): void {
  updateSelected((n) => ({ ...n, pos: tidyVec([n.pos[0] + delta[0], n.pos[1] + delta[1], n.pos[2] + delta[2]]) }), 'nudge');
}

export function setHole(hole: boolean): void {
  // A picture lies on a surface; it is neither solid nor hole.
  updateSelected((n) => (n.hole === hole || n.type === 'picture' ? n : { ...n, hole }));
}

/** Put a texture over the selected objects' surfaces, or take it off. */
export function setTexture(texture: Texture | null): void {
  updateSelected((n) => {
    if (n.type === 'picture') return n;
    if (!texture) {
      if (!n.texture) return n;
      const { texture: _off, ...plain } = n;
      return plain as SceneNode;
    }
    return { ...n, texture };
  }, 'texture');
}

/**
 * Change how a picture is laid on. Switching between flat and wrapped keeps
 * the picture facing the way it did, with its middle where it was: the sheet
 * curves back around an axis behind it, or the band flattens out again.
 */
export function editPicture(id: string, change: Partial<Pick<PictureNode, 'mapping' | 'angle'>>): void {
  const node = getState().doc.scene.find((n) => n.id === id);
  if (node?.type !== 'picture' || node.locked) return;
  let next: PictureNode = { ...node, ...change };
  if (change.mapping && change.mapping !== node.mapping) {
    const [w, d, h] = node.size;
    const toWrap = change.mapping === 'wrap';
    // A flat sheet lies facing +Z; a band stands facing -Y. A quarter turn about X between the two
    // keeps the picture's face and its up the same, whatever way the node is turned.
    const rot = eulerOf(multiply(rotation(node.rot), axisRotation(0, toWrap ? -90 : 90)));
    // The sheet's face is at the node's middle; the band's middle face is half its diameter out from its axis.
    const facing = apply(rotation(toWrap ? node.rot : rot), [0, 0, 1]);
    const reach = w / 2;
    const pos = tidyVec(toWrap ? [node.pos[0] - reach * facing[0], node.pos[1] - reach * facing[1], node.pos[2] - reach * facing[2]] : [node.pos[0] + reach * facing[0], node.pos[1] + reach * facing[1], node.pos[2] + reach * facing[2]]);
    // Flat, the picture is w across and d up; wrapped, a band w in diameter and d tall with the same reach around.
    const size = tidyVec(toWrap ? [w, w, d] : [(Math.PI * w * node.angle) / 360, h, 1]);
    next = { ...next, rot, pos, size };
  }
  commit(
    getState().doc.scene.map((n) => (n.id === id ? next : n)),
    { merge: change.angle !== undefined ? `angle:${id}` : undefined },
  );
}

/** The pictures in the design, for the texture picker. */
export function imageAssets(doc: Doc = getState().doc): { key: string; asset: ImageAsset }[] {
  return Object.entries(doc.assets).flatMap(([key, asset]) => (asset.kind === 'image' ? [{ key, asset }] : []));
}

/** Paint the selection. A group's parts stop showing their own colors: the whole takes this one. */
export function setColor(color: string): void {
  updateSelected((n) => {
    if (n.color === color && !n.hole && !(n.type === 'group' && n.mixed)) return n;
    const next = { ...n, color, hole: false };
    if (next.type === 'group') delete next.mixed;
    return next;
  }, 'color');
}

/** Rename the object at `path` (one inside a group too); a blank name is ignored. */
export function setNameAt(path: string[], name: string): void {
  const clean = name.trim();
  if (!clean) return;
  const patch = (nodes: Scene, depth: number): Scene =>
    nodes.map((n) => {
      if (n.id !== path[depth]) return n;
      if (depth < path.length - 1) return n.type === 'group' ? { ...n, children: patch(n.children, depth + 1) } : n;
      return n.name === clean ? n : { ...n, name: clean };
    });
  const scene = patch(getState().doc.scene, 0);
  if (scene.some((n, i) => n !== getState().doc.scene[i])) commit(scene);
}

/** Attach words to the object at `path` (one inside a group too); an empty note takes them off. */
export function setNote(path: string[], note: string): void {
  const clean = note.trim().slice(0, MAX_NOTE);
  const patch = (nodes: Scene, depth: number): Scene =>
    nodes.map((n) => {
      if (n.id !== path[depth]) return n;
      if (depth < path.length - 1) return n.type === 'group' ? { ...n, children: patch(n.children, depth + 1) } : n;
      if ((n.note ?? '') === clean) return n;
      const next = { ...n };
      if (clean) next.note = clean;
      else delete next.note;
      return next;
    });
  const scene = patch(getState().doc.scene, 0);
  if (scene.some((n, i) => n !== getState().doc.scene[i])) commit(scene, { merge: `note:${path.join('/')}` });
}

export function alignSelected(axis: 0 | 1 | 2, mode: AlignMode): void {
  alignSelectedOn([[axis, mode]]);
}

/** Several alignments as one step (center on X and Y, say). */
export function alignSelectedOn(steps: [0 | 1 | 2, AlignMode][]): void {
  abortAlignPreview();
  const nodes = selectedNodes();
  // In align mode the dots' box is the reference; otherwise a single object is aligned to
  // the plate's center lines, and several to their common box.
  const target: Bounds | null = getState().aligning?.bounds ?? (nodes.length > 1 ? selectionBounds(nodes) : { min: [0, 0, 0], max: [0, 0, 0] });
  if (!target || nodes.length === 0) return;
  let moved = nodes.filter((n) => !n.locked);
  for (const [axis, mode] of steps) moved = alignNodes(moved, (n) => geometry.bounds(n), axis, mode, target);
  replaceNodes(moved);
}

export function mirrorSelected(axis: 0 | 1 | 2): void {
  abortAlignPreview();
  const nodes = selectedNodes().filter((n) => !n.locked);
  const bounds = selectionBounds(nodes);
  if (!bounds) return;
  replaceNodes(mirrorNodes(nodes, axis, boundsCenter(bounds)));
}

/** Turn the selection by `degrees` about a fixed axis through its center (a single object turns about its own). */
export function rotateSelected(axis: 0 | 1 | 2, degrees: number): void {
  abortAlignPreview();
  const nodes = selectedNodes().filter((n) => !n.locked);
  if (nodes.length === 0) return;
  const bounds = selectionBounds(nodes);
  if (!bounds) return;
  replaceNodes(rotateNodes(nodes, axis, degrees, nodes.length === 1 ? nodes[0].pos : boundsCenter(bounds)));
}

/** Rest each selected object on the build plate. */
export function dropSelected(): void {
  updateSelected((n) => {
    const low = geometry.bounds(n).min[2];
    return low === 0 ? n : { ...n, pos: [n.pos[0], n.pos[1], n.pos[2] - low] };
  });
}

export function toggleHidden(id: string): void {
  const node = getState().doc.scene.find((n) => n.id === id);
  if (!node) return;
  const next = { ...node };
  if (node.hidden) delete next.hidden;
  else next.hidden = true;
  commit(
    getState().doc.scene.map((n) => (n.id === id ? next : n)),
    { selection: getState().selection.filter((s) => s !== id || !next.hidden) },
  );
}

export function toggleLocked(id: string): void {
  const node = getState().doc.scene.find((n) => n.id === id);
  if (!node) return;
  const next = { ...node };
  if (node.locked) delete next.locked;
  else next.locked = true;
  commit(getState().doc.scene.map((n) => (n.id === id ? next : n)));
}

/** Lock or unlock every selected object at once. */
export function setSelectedLocked(locked: boolean): void {
  const ids = new Set(getState().selection);
  let touched = false;
  const scene = getState().doc.scene.map((n) => {
    if (!ids.has(n.id) || Boolean(n.locked) === locked) return n;
    touched = true;
    const next = { ...n };
    if (locked) next.locked = true;
    else delete next.locked;
    return next;
  });
  if (touched) commit(scene);
}

/** The node with its ghost flag turned on or off. */
function withGhost(node: SceneNode, ghost: boolean): SceneNode {
  if (Boolean(node.ghost) === ghost) return node;
  const next = { ...node };
  if (ghost) next.ghost = true;
  else delete next.ghost;
  return next;
}

/** Fade one object out of reach, or bring it back. A ghost leaves the selection: nothing picks it. */
export function toggleGhost(id: string): void {
  const node = getState().doc.scene.find((n) => n.id === id);
  if (!node) return;
  abortAlignPreview();
  const next = withGhost(node, !node.ghost);
  commit(
    getState().doc.scene.map((n) => (n.id === id ? next : n)),
    { selection: getState().selection.filter((s) => s !== id || !next.ghost) },
  );
}

/**
 * Fade the selection out of reach: the objects stay in view as faint shadows
 * but no longer take a click or a drag, so that what is around or inside them
 * can be worked on. `unghostAll` brings every ghost back.
 */
export function ghostSelected(): void {
  const ids = new Set(getState().selection);
  if (ids.size === 0) return;
  abortAlignPreview();
  commit(
    getState().doc.scene.map((n) => (ids.has(n.id) ? withGhost(n, true) : n)),
    { selection: [] },
  );
}

export const hasGhosts = (s: EditorState = getState()): boolean => s.doc.scene.some((n) => n.ghost);

/** Bring every ghost back within reach. */
export function unghostAll(): void {
  if (!hasGhosts()) return;
  abortAlignPreview();
  commit(getState().doc.scene.map((n) => withGhost(n, false)));
}
