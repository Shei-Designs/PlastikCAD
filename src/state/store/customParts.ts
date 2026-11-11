// The custom parts bin: saving an object as a part, and listing, placing,
// renaming and deleting the parts kept there.
import { APP_NAME } from '../../appInfo';
import { tr } from '../../i18n';
import { parseDoc, serializeDoc } from '../../model/file';
import { boundsCenter, tidyVec } from '../../model/math';
import { cloneNode, newId, uniqueName, usedAssets } from '../../model/ops';
import type { Doc, SceneNode } from '../../model/types';
import * as platform from '../../platform';
import { tell } from '../../ui/ask';
import { geometry } from '../geometry';
import { partStore } from '../projects';
import type { ProjectInfo } from '../projects';
import { requestSync } from '../../sync/sync';
import { abortAlignPreview, commit, fail, getState, notify, replaceState, set } from './core';
import { takeThumbnail } from './project';

// --- custom parts -----------------------------------------------------------------
//
// An object the user wants again goes into the parts bin: a design file of its
// own holding that one object, kept beside the projects and synced like them.
// The bin is browsed in the inspector; a part picked there is carried to the
// plate like a shape from the library.

/** Opens the bin in the inspector; whatever was selected or carried is let go of. */
export function openPartsBin(): void {
  abortAlignPreview();
  set({ bin: true, selection: [], placing: null });
}

export function closePartsBin(): void {
  if (getState().bin || getState().placing) set({ bin: false, placing: null });
}

export async function listParts(): Promise<ProjectInfo[]> {
  try {
    return await partStore().list();
  } catch (e) {
    fail(e);
    return [];
  }
}

/** The object as it goes into the bin: fresh ids, shown and unlocked, standing on the plate at its middle. */
function partOf(node: SceneNode): SceneNode {
  const b = geometry.bounds(node);
  const c = boundsCenter(b);
  return { ...cloneNode(node), hidden: undefined, locked: undefined, pos: tidyVec([node.pos[0] - c[0], node.pos[1] - c[1], node.pos[2] - b.min[2]]) };
}

/** Asks, then keeps the object as a custom part. Resolves true once it is in the bin. */
export async function saveAsPart(id: string): Promise<boolean> {
  const node = getState().doc.scene.find((n) => n.id === id);
  if (!node) return false;
  const save = tr('Save part');
  const chosen = await tell({
    title: tr('Save as a part'),
    text: tr('Save "{name}" as a custom part? It goes in the library under Custom, on all your devices, to place in any design.', { name: node.name }),
    actions: [save, tr('Cancel')],
  });
  if (chosen !== save) return false;
  try {
    const part = partOf(node);
    const assets = Object.fromEntries([...usedAssets([part])].filter((key) => getState().doc.assets[key]).map((key) => [key, getState().doc.assets[key]]));
    const doc: Doc = {
      id: newId(),
      name: node.name,
      scene: [part],
      assets,
      thumb: takeThumbnail([node.id]) ?? undefined,
      revision: newId(),
      device: getState().prefs.device,
      saved: new Date().toISOString(),
    };
    await partStore().write(null, doc.name, serializeDoc(doc));
    set({ partsEpoch: getState().partsEpoch + 1 });
    notify(tr('"{name}" is in your custom parts.', { name: node.name }), 'ok');
    requestSync();
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

/** A part from the bin as a new object for the design: fresh ids, named after the part, its pictures brought along. */
async function loadPart(key: string): Promise<SceneNode> {
  const doc = parseDoc(await partStore().read(key));
  const node = doc.scene[0];
  if (!node) throw new Error(tr('This part is empty.'));
  const missing = Object.fromEntries(Object.entries(doc.assets).filter(([k]) => !getState().doc.assets[k]));
  if (Object.keys(missing).length) replaceState({ ...getState(), doc: { ...getState().doc, assets: { ...getState().doc.assets, ...missing } } });
  return { ...cloneNode(node), name: doc.name };
}

/** Start carrying a custom part, to be put down like a shape. */
export async function pickPart(key: string): Promise<void> {
  try {
    const node = await loadPart(key);
    abortAlignPreview();
    set({ placing: { ...node, pos: [0, 0, -1e6] }, selection: [] });
  } catch (e) {
    fail(e);
  }
}

/** Add a custom part at the middle of the plate straight away (keyboard route, double-click). */
export async function addCustomPart(key: string): Promise<void> {
  try {
    const node = await loadPart(key);
    node.name = uniqueName(getState().doc.scene, node.name);
    replaceState({ ...getState(), placing: null, bin: false });
    commit([...getState().doc.scene, node], { selection: [node.id] });
  } catch (e) {
    fail(e);
  }
}

export async function renamePartAt(key: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  try {
    const store = partStore();
    const doc = parseDoc(await store.read(key));
    if (doc.name === clean) return;
    await store.write(key, clean, serializeDoc({ ...doc, name: clean, revision: newId(), parent: doc.revision, device: getState().prefs.device, saved: new Date().toISOString() }));
    set({ partsEpoch: getState().partsEpoch + 1 });
    requestSync();
  } catch (e) {
    fail(e);
  }
}

export async function deletePart(key: string, name: string): Promise<boolean> {
  try {
    const sure = await platform.confirm(tr('Delete the part "{name}" for good? This cannot be undone. Objects already placed from it stay in their designs.', { name }), { title: APP_NAME, okLabel: tr('Delete'), cancelLabel: tr('Keep') });
    if (!sure) return false;
    await partStore().remove(key);
    set({ partsEpoch: getState().partsEpoch + 1 });
    requestSync();
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}
