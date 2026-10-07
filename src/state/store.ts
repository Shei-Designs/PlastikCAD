// The editor: one design, what is selected in it, and every action that can
// be taken on it. Kept outside React so that the viewer, keyboard shortcuts
// and menus all drive the same functions.
import { useSyncExternalStore } from 'react';
import { APP_NAME, FILE_EXTENSION } from '../app';
import { clampParams } from '../geometry/shapes';
import { encodeFloat32, encodeUint32 } from '../io/base64';
import { exportMesh, exportOutline, FORMATS } from '../io/export';
import type { FormatId } from '../io/export';
import { centreMesh, centreOutline, IMPORT_EXTENSIONS, importFile } from '../io/import';
import { emptyDoc, parseDoc, serializeDoc } from '../model/file';
import { hashString } from '../model/geomKey';
import { boundsCenter, tidyVec, unionBounds } from '../model/math';
import type { Bounds } from '../model/math';
import {
  alignNodes,
  cloneNode,
  diffScenes,
  makeGroup,
  makeShape,
  mirrorNodes,
  newId,
  rotateNodes,
  ungroup,
  uniqueName,
  usedAssets,
} from '../model/ops';
import type { AlignMode } from '../model/ops';
import type { Asset, Doc, ImportNode, Scene, SceneNode, ShapeKind, TextNode, Vec3, Version } from '../model/types';
import * as platform from '../platform';
import type { PickedFile } from '../platform';
import { DEFAULT_FONT, loadFont, outlineOf } from '../text/fonts';
import { geometry } from './geometry';
import { loadPrefs, loadSession, savePrefs, saveSession } from './persist';
import type { Prefs } from './persist';

export interface Notice {
  kind: 'error' | 'info';
  text: string;
}

export interface EditorState {
  doc: Doc;
  /** Ids of selected top-level nodes. */
  selection: string[];
  /** Where the design is saved, if it has been (desktop app only). */
  filePath: string | null;
  /** The design as last saved or opened, to tell whether there are unsaved changes. */
  saved: { scene: Scene; versions: Version[]; name: string } | null;
  /** Version being looked at instead of the working scene. */
  viewing: string | null;
  /** New shape following the pointer until it is put down. */
  placing: SceneNode | null;
  /**
   * Align mode: anchor dots sit on `bounds`, the box of the anchor object or,
   * without one, of the whole selection. Frozen while a dot is being previewed.
   */
  aligning: { anchor: string | null; bounds: Bounds } | null;
  prefs: Prefs;
  notice: Notice | null;
  /** Something slow is going on ("Grouping…"). */
  busy: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Counts up whenever a different design is loaded, so views can reframe. */
  epoch: number;
}

interface Step {
  scene: Scene;
  selection: string[];
  head: string | null;
}

const DESIGN_FILTER = [{ name: `${APP_NAME} design`, extensions: [FILE_EXTENSION] }];
const MERGE_WINDOW_MS = 800;
const UNDO_LIMIT = 200;

let state: EditorState = {
  doc: emptyDoc(),
  selection: [],
  filePath: null,
  saved: null,
  viewing: null,
  placing: null,
  aligning: null,
  prefs: loadPrefs(),
  notice: null,
  busy: null,
  canUndo: false,
  canRedo: false,
  epoch: 0,
};
state.saved = { scene: state.doc.scene, versions: state.doc.versions, name: state.doc.name };

const listeners = new Set<() => void>();
let past: Step[] = [];
let future: Step[] = [];
let gesture: Step | null = null;
let lastMerge: { key: string; time: number } | null = null;
let clipboard: SceneNode[] = [];
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let sessionTimer: ReturnType<typeof setTimeout> | undefined;
/** Set by the viewport: renders a small picture of the design for the version list. */
let thumbnailer: (() => string | null) | null = null;

function set(patch: Partial<EditorState>): void {
  const before = state;
  // Any change of selection ends align mode.
  if (state.aligning && patch.selection && patch.aligning === undefined && !sameIds(patch.selection, state.selection)) patch = { ...patch, aligning: null };
  state = { ...state, ...patch, canUndo: past.length > 0, canRedo: future.length > 0 };
  if (state.prefs !== before.prefs) savePrefs(state.prefs);
  if (state.doc !== before.doc || state.filePath !== before.filePath || state.saved !== before.saved) scheduleSession();
  for (const l of listeners) l();
}

const sameIds = (a: string[], b: string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getState = (): EditorState => state;

export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export const isDirty = (s: EditorState = state): boolean =>
  !s.saved || s.doc.scene !== s.saved.scene || s.doc.versions !== s.saved.versions || s.doc.name !== s.saved.name;

function scheduleSession(): void {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => saveSession({ doc: state.doc, filePath: state.filePath, dirty: isDirty() }), 600);
}

export function notify(text: string, kind: Notice['kind'] = 'info'): void {
  clearTimeout(noticeTimer);
  set({ notice: { kind, text } });
  noticeTimer = setTimeout(() => set({ notice: null }), kind === 'error' ? 8000 : 3500);
}

export const dismissNotice = (): void => set({ notice: null });

const fail = (e: unknown): void => notify(e instanceof Error ? e.message : String(e), 'error');

export function setPrefs(patch: Partial<Prefs>): void {
  set({ prefs: { ...state.prefs, ...patch } });
}

export function setThumbnailer(fn: (() => string | null) | null): void {
  thumbnailer = fn;
}

// --- scene edits and undo -------------------------------------------------

const step = (): Step => ({ scene: state.doc.scene, selection: state.selection, head: state.doc.head });

/**
 * Replace the scene as one undoable step. Edits with the same `merge` key in
 * quick succession (typing in a field, holding an arrow key) count as one.
 */
function commit(scene: Scene, options: { selection?: string[]; merge?: string; head?: string | null } = {}): void {
  if (state.viewing) return;
  const selection = options.selection ?? state.selection;
  if (!gesture) {
    const now = Date.now();
    const merged = options.merge && lastMerge?.key === options.merge && now - lastMerge.time < MERGE_WINDOW_MS;
    if (!merged) {
      past.push(step());
      if (past.length > UNDO_LIMIT) past.shift();
    }
    future = [];
    lastMerge = options.merge ? { key: options.merge, time: now } : null;
  }
  const head = options.head === undefined ? state.doc.head : options.head;
  set({ doc: { ...state.doc, scene, head }, selection });
}

/** Start of a drag: everything until `endGesture` is a single undo step. */
export function beginGesture(): void {
  gesture ??= step();
}

export function endGesture(cancel = false): void {
  const base = gesture;
  gesture = null;
  if (!base) return;
  if (cancel) {
    set({ doc: { ...state.doc, scene: base.scene }, selection: base.selection });
  } else if (base.scene !== state.doc.scene) {
    past.push(base);
    if (past.length > UNDO_LIMIT) past.shift();
    future = [];
    lastMerge = null;
    set({});
  }
}

function restore(from: Step[], to: Step[]): void {
  const target = from.pop();
  if (!target || state.viewing) return;
  to.push(step());
  lastMerge = null;
  const ids = new Set(target.scene.map((n) => n.id));
  set({ doc: { ...state.doc, scene: target.scene, head: target.head }, selection: target.selection.filter((id) => ids.has(id)) });
  // The dots follow the objects back.
  if (state.aligning) refreshAlignBounds();
}

export const undo = (): void => restore(past, future);
export const redo = (): void => restore(future, past);

function resetHistory(): void {
  past = [];
  future = [];
  gesture = null;
  lastMerge = null;
}

// --- selection --------------------------------------------------------------

export function selectedNodes(s: EditorState = state): SceneNode[] {
  if (s.selection.length === 0) return [];
  const ids = new Set(s.selection);
  return s.doc.scene.filter((n) => ids.has(n.id));
}

export function select(ids: string[]): void {
  if (state.viewing) return;
  set({ selection: ids });
}

export function toggleSelected(id: string): void {
  select(state.selection.includes(id) ? state.selection.filter((s) => s !== id) : [...state.selection, id]);
}

export const selectAll = (): void => select(state.doc.scene.filter((n) => !n.hidden).map((n) => n.id));

/** Tight bounds of everything selected, or null when nothing is. */
export function selectionBounds(nodes: SceneNode[] = selectedNodes()): Bounds | null {
  return nodes.length ? unionBounds(nodes.map((n) => geometry.bounds(n))) : null;
}

// --- editing ----------------------------------------------------------------

/** Apply `change` to the selected nodes that are not locked. */
export function updateSelected(change: (node: SceneNode) => SceneNode, merge?: string): void {
  const ids = new Set(state.selection);
  let touched = false;
  const scene = state.doc.scene.map((n) => {
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
    state.doc.scene.map((n) => byId.get(n.id) ?? n),
    { merge },
  );
}

export function updateNode(id: string, patch: Partial<SceneNode>, merge?: string): void {
  commit(
    state.doc.scene.map((n) => (n.id === id ? ({ ...n, ...patch } as SceneNode) : n)),
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

export function startPlacing(kind: ShapeKind): void {
  if (state.viewing) return;
  // Parked far below the plate until the pointer reaches the viewport.
  const node = makeShape(kind, [0, 0, -1e6]);
  set({ placing: node, selection: [] });
}

const TEXT_THICKNESS = 2;
/** Lettering is listed under its own words until it is given another name. */
const textLabel = (text: string): string => text.trim().split('\n')[0].slice(0, 24) || 'Text';

/** New lettering parked below the plate, or null if the words draw nothing. Its font must be loaded. */
function makeText(text: string, font: string): TextNode | null {
  const outline = outlineOf({ text, font, align: 'left' });
  if (!outline) return null;
  return {
    id: newId(),
    type: 'text',
    name: textLabel(text),
    text,
    font,
    align: 'left',
    natural: [outline.size[0], outline.size[1], 1],
    pos: [0, 0, -1e6],
    rot: [0, 0, 0],
    size: [outline.size[0], outline.size[1], TEXT_THICKNESS],
    hole: false,
    color: '#e6e1d6',
  };
}

/** Start carrying new lettering, to be put down like a shape. */
export async function startPlacingText(): Promise<void> {
  if (state.viewing) return;
  try {
    await loadFont(DEFAULT_FONT);
    const node = makeText('Text', DEFAULT_FONT);
    if (node && !state.viewing) set({ placing: node, selection: [] });
  } catch (e) {
    fail(e);
  }
}

/** Add lettering at the middle of the plate straight away (keyboard route, double-click). */
export async function addText(): Promise<void> {
  if (state.viewing) return;
  try {
    await loadFont(DEFAULT_FONT);
    const node = makeText('Text', DEFAULT_FONT);
    if (!node || state.viewing) return;
    node.pos = [0, 0, node.size[2] / 2];
    node.name = uniqueName(state.doc.scene, node.name);
    state = { ...state, placing: null };
    commit([...state.doc.scene, node], { selection: [node.id] });
  } catch (e) {
    fail(e);
  }
}

/**
 * Change the words, font or alignment of lettering. Its letters keep their
 * scale: the box grows or shrinks around them. Returns false if the change
 * would leave nothing to draw (the node then stays as it was).
 */
export async function editText(id: string, change: Partial<Pick<TextNode, 'text' | 'font' | 'align'>>): Promise<boolean> {
  try {
    const before = state.doc.scene.find((n) => n.id === id);
    if (before?.type !== 'text') return false;
    await loadFont(change.font ?? before.font);
    // Typing is faster than fonts load: work from the node as it is by now.
    const node = state.doc.scene.find((n) => n.id === id);
    if (node?.type !== 'text' || node.locked || state.viewing) return false;
    const next = { text: node.text, font: node.font, align: node.align, ...change };
    const outline = outlineOf(next);
    if (!outline) return false;
    const natural: Vec3 = [outline.size[0], outline.size[1], 1];
    const size = tidyVec([(node.size[0] / node.natural[0]) * natural[0], (node.size[1] / node.natural[1]) * natural[1], node.size[2]]);
    const name = node.name === textLabel(node.text) ? textLabel(next.text) : node.name;
    updateNode(id, { ...next, natural, size, name } as Partial<SceneNode>, `text:${id}`);
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export function movePlacing(point: Vec3 | null): void {
  const node = state.placing;
  if (!node) return;
  const pos: Vec3 = point ? [point[0], point[1], point[2] + node.size[2] / 2] : [0, 0, -1e6];
  if (pos.every((v, i) => v === node.pos[i])) return;
  set({ placing: { ...node, pos } });
}

export function commitPlacing(): void {
  const node = state.placing;
  if (!node) return;
  if (node.pos[2] < -1e5) {
    set({ placing: null });
    return;
  }
  const placed = { ...node, name: uniqueName(state.doc.scene, node.name) };
  state = { ...state, placing: null };
  commit([...state.doc.scene, placed], { selection: [placed.id] });
}

export const cancelPlacing = (): void => {
  if (state.placing) set({ placing: null });
};

/** Add a shape at the middle of the plate straight away (keyboard route, double-click). */
export function addShape(kind: ShapeKind): void {
  if (state.viewing) return;
  const node = makeShape(kind);
  node.name = uniqueName(state.doc.scene, node.name);
  state = { ...state, placing: null };
  commit([...state.doc.scene, node], { selection: [node.id] });
}

export function deleteSelected(): void {
  const ids = new Set(selectedNodes().filter((n) => !n.locked).map((n) => n.id));
  if (ids.size === 0) return;
  commit(
    state.doc.scene.filter((n) => !ids.has(n.id)),
    { selection: state.selection.filter((id) => !ids.has(id)) },
  );
}

function addCopies(sources: SceneNode[], offset: Vec3): void {
  if (sources.length === 0 || state.viewing) return;
  let scene = state.doc.scene;
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
export const duplicateSelected = (): void => addCopies(selectedNodes(), [0, 0, 0]);

export function copySelected(): void {
  const nodes = selectedNodes();
  if (nodes.length) clipboard = nodes;
}

export function paste(): void {
  // Assets of pasted imports are still in the document unless it was replaced in between.
  const usable = clipboard.filter((n) => [...usedAssets([n])].every((a) => state.doc.assets[a]));
  const stepSize = state.prefs.snap || 1;
  addCopies(usable, [Math.max(10, stepSize), -Math.max(10, stepSize), 0]);
}

export function nudgeSelected(delta: Vec3): void {
  updateSelected((n) => ({ ...n, pos: tidyVec([n.pos[0] + delta[0], n.pos[1] + delta[1], n.pos[2] + delta[2]]) }), 'nudge');
}

export function setHole(hole: boolean): void {
  updateSelected((n) => (n.hole === hole ? n : { ...n, hole }));
}

export function setColor(color: string): void {
  updateSelected((n) => (n.color === color && !n.hole ? n : { ...n, color, hole: false }), 'color');
}

export function alignSelected(axis: 0 | 1 | 2, mode: AlignMode): void {
  alignSelectedOn([[axis, mode]]);
}

/** Several alignments as one step (centre on X and Y, say). */
export function alignSelectedOn(steps: [0 | 1 | 2, AlignMode][]): void {
  const nodes = selectedNodes();
  // In align mode the dots' box is the reference; otherwise a single object is aligned to
  // the plate's centre lines, and several to their common box.
  const target: Bounds | null = state.aligning?.bounds ?? (nodes.length > 1 ? selectionBounds(nodes) : { min: [0, 0, 0], max: [0, 0, 0] });
  if (!target || nodes.length === 0) return;
  let moved = nodes.filter((n) => !n.locked);
  for (const [axis, mode] of steps) moved = alignNodes(moved, (n) => geometry.bounds(n), axis, mode, target);
  replaceNodes(moved);
  if (state.aligning) refreshAlignBounds();
}

// --- align mode ---------------------------------------------------------------

/** The box the anchor dots sit on: the anchor object's, or the whole selection's. */
function alignBounds(anchor: string | null): Bounds | null {
  const nodes = selectedNodes();
  const target = anchor ? nodes.find((n) => n.id === anchor) : null;
  return target ? geometry.bounds(target) : selectionBounds(nodes);
}

function refreshAlignBounds(): void {
  const aligning = state.aligning;
  if (!aligning) return;
  const bounds = alignBounds(aligning.anchor);
  set({ aligning: bounds ? { ...aligning, bounds } : null });
}

/** Show the anchor dots around the selection (two or more objects). */
export function startAligning(): void {
  if (state.viewing || state.aligning) return;
  if (state.selection.length < 2) return notify('Select two or more objects to line them up.');
  const bounds = alignBounds(null);
  if (bounds) set({ aligning: { anchor: null, bounds }, placing: null });
}

export function stopAligning(): void {
  if (!state.aligning) return;
  // A dot being previewed is let go of first.
  if (gesture) endGesture(true);
  set({ aligning: null });
}

export const toggleAligning = (): void => (state.aligning ? stopAligning() : startAligning());

/** Make one of the selected objects the one the others line up with; the same one again clears it. */
export function setAlignAnchor(id: string | null): void {
  const aligning = state.aligning;
  if (!aligning) return;
  const anchor = id === aligning.anchor ? null : id;
  const bounds = alignBounds(anchor);
  if (bounds) set({ aligning: { anchor, bounds } });
}

/** The selection as it would be after lining up on a dot; from the scene before any preview. */
function aligned(axis: 0 | 1 | 2, mode: AlignMode): SceneNode[] | null {
  const aligning = state.aligning;
  if (!aligning) return null;
  const base = gesture?.scene ?? state.doc.scene;
  const ids = new Set(state.selection);
  const nodes = base.filter((n) => ids.has(n.id) && !n.locked && n.id !== aligning.anchor);
  return alignNodes(nodes, (n) => geometry.bounds(n), axis, mode, aligning.bounds);
}

/** Hovering a dot moves the objects there for a look; null puts them back. */
export function previewAlign(axis: 0 | 1 | 2 | null, mode: AlignMode = 'centre'): void {
  if (!state.aligning) return;
  if (axis === null) {
    if (gesture) endGesture(true);
    return;
  }
  const nodes = aligned(axis, mode);
  if (!nodes) return;
  beginGesture();
  replaceNodes(nodes);
}

/** Clicking a dot keeps the objects where the preview put them. */
export function commitAlign(axis: 0 | 1 | 2, mode: AlignMode): void {
  const nodes = aligned(axis, mode);
  if (!nodes) return;
  beginGesture();
  replaceNodes(nodes);
  endGesture(false);
  refreshAlignBounds();
}

export function mirrorSelected(axis: 0 | 1 | 2): void {
  const nodes = selectedNodes().filter((n) => !n.locked);
  const bounds = selectionBounds(nodes);
  if (!bounds) return;
  replaceNodes(mirrorNodes(nodes, axis, boundsCenter(bounds)));
}

/** Turn the selection by `degrees` about a fixed axis through its centre (a single object turns about its own). */
export function rotateSelected(axis: 0 | 1 | 2, degrees: number): void {
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
  const node = state.doc.scene.find((n) => n.id === id);
  if (!node) return;
  const next = { ...node };
  if (node.hidden) delete next.hidden;
  else next.hidden = true;
  commit(
    state.doc.scene.map((n) => (n.id === id ? next : n)),
    { selection: state.selection.filter((s) => s !== id || !next.hidden) },
  );
}

export function toggleLocked(id: string): void {
  const node = state.doc.scene.find((n) => n.id === id);
  if (!node) return;
  const next = { ...node };
  if (node.locked) delete next.locked;
  else next.locked = true;
  commit(state.doc.scene.map((n) => (n.id === id ? next : n)));
}

export async function groupSelected(): Promise<void> {
  const nodes = selectedNodes();
  if (state.viewing || nodes.length < 2) return;
  if (nodes.some((n) => n.locked)) return notify('Unlock the selected objects before grouping them.', 'error');
  set({ busy: 'Grouping…' });
  try {
    const worker = await geometry.prepare(nodes, state.doc.assets);
    const bounds = await worker.measure(nodes);
    if (!bounds) {
      notify(nodes.every((n) => n.hole) ? 'A group needs at least one solid: these are all holes.' : 'Nothing would be left: the holes remove everything.', 'error');
      return;
    }
    // The scene may have moved on while the worker was measuring.
    const ids = new Set(nodes.map((n) => n.id));
    if (!nodes.every((n) => state.doc.scene.includes(n))) return;
    const group = makeGroup(nodes, bounds, uniqueName(state.doc.scene, 'Group'));
    commit([...state.doc.scene.filter((n) => !ids.has(n.id)), group], { selection: [group.id] });
  } catch (e) {
    fail(e);
  } finally {
    set({ busy: null });
  }
}

export function ungroupSelected(): void {
  const groups = selectedNodes().filter((n) => n.type === 'group' && !n.locked);
  if (groups.length === 0) return;
  const selection = state.selection.filter((id) => !groups.some((g) => g.id === id));
  const scene: Scene = [];
  for (const node of state.doc.scene) {
    if (node.type !== 'group' || !groups.includes(node)) {
      scene.push(node);
      continue;
    }
    for (const child of ungroup(node)) {
      // A hole group hands its role down; otherwise children keep their own.
      const freed = node.hole ? { ...child, hole: true } : child;
      scene.push(freed);
      selection.push(freed.id);
    }
  }
  commit(scene, { selection });
}

// --- documents ----------------------------------------------------------------

function adopt(doc: Doc, filePath: string | null, dirty = false): void {
  resetHistory();
  set({
    doc,
    filePath,
    saved: dirty ? null : { scene: doc.scene, versions: doc.versions, name: doc.name },
    selection: [],
    viewing: null,
    placing: null,
    epoch: state.epoch + 1,
  });
  if (filePath) rememberRecent(filePath);
}

function rememberRecent(path: string): void {
  setPrefs({ recent: [path, ...state.prefs.recent.filter((p) => p !== path)].slice(0, 8) });
}

async function okToDiscard(): Promise<boolean> {
  if (!isDirty() || (state.doc.scene.length === 0 && state.doc.versions.length === 0)) return true;
  return platform.confirm(`"${state.doc.name}" has unsaved changes. Discard them?`, {
    title: APP_NAME,
    okLabel: 'Discard',
    cancelLabel: 'Keep editing',
  });
}

export async function newDesign(): Promise<void> {
  if (await okToDiscard()) adopt(emptyDoc(), null);
}

const baseName = (fileName: string): string => fileName.replace(/\.[^.]+$/, '');
const extension = (fileName: string): string => fileName.split('.').pop()?.toLowerCase() ?? '';

function openFile(file: PickedFile): void {
  const doc = parseDoc(new TextDecoder().decode(file.bytes));
  if (doc.name === 'Untitled') doc.name = baseName(file.name);
  adopt(doc, file.path);
}

export async function openDesign(): Promise<void> {
  try {
    if (!(await okToDiscard())) return;
    const [file] = await platform.pickFiles({ filters: DESIGN_FILTER });
    if (file) openFile(file);
  } catch (e) {
    fail(e);
  }
}

export async function openPath(path: string, ask = true): Promise<void> {
  try {
    if (ask && !(await okToDiscard())) return;
    openFile(await platform.readPath(path));
  } catch (e) {
    setPrefs({ recent: state.prefs.recent.filter((p) => p !== path) });
    fail(e);
  }
}

function markSaved(filePath: string | null): void {
  set({ filePath, saved: { scene: state.doc.scene, versions: state.doc.versions, name: state.doc.name } });
  if (filePath) rememberRecent(filePath);
}

export async function saveDesignAs(): Promise<boolean> {
  try {
    const bytes = new TextEncoder().encode(serializeDoc(state.doc));
    const where = await platform.saveAs(`${state.doc.name}.${FILE_EXTENSION}`, DESIGN_FILTER, bytes, 'application/json');
    if (!where) return false;
    if (state.doc.name === 'Untitled') set({ doc: { ...state.doc, name: baseName(where.name) } });
    markSaved(where.path);
    notify(`Saved ${where.path ?? where.name}`);
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export async function saveDesign(): Promise<boolean> {
  if (!state.filePath) return saveDesignAs();
  try {
    await platform.writePath(state.filePath, new TextEncoder().encode(serializeDoc(state.doc)));
    markSaved(state.filePath);
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export function renameDesign(name: string): void {
  const clean = name.trim();
  if (clean && clean !== state.doc.name) set({ doc: { ...state.doc, name: clean } });
}

/** Turn imported files into objects standing on the plate, side by side. */
function importModels(files: PickedFile[]): void {
  const assets = { ...state.doc.assets };
  const nodes: ImportNode[] = [];
  let scene = state.doc.scene;
  let x = 0;
  for (const file of files) {
    const data = importFile(file.name, file.bytes);
    let asset: Asset;
    let natural: Vec3;
    let size: Vec3;
    if (data.kind === 'mesh') {
      natural = centreMesh(data).size;
      size = natural;
      asset = { kind: 'mesh', positions: encodeFloat32(data.positions), triangles: encodeUint32(data.triangles) };
    } else {
      const flat = centreOutline(data).size;
      natural = [flat[0], flat[1], 1];
      // Flat artwork comes in as a plate a few millimetres thick.
      size = [flat[0], flat[1], 3];
      asset = { kind: 'outline', shapes: data.shapes };
    }
    if (!natural.every((v) => v > 1e-6)) throw new Error(`"${file.name}" is flat or empty, so it cannot be made into a solid.`);
    const text = asset.kind === 'mesh' ? asset.positions + asset.triangles : JSON.stringify(asset.shapes);
    const key = `${asset.kind}-${hashString(text)}-${text.length.toString(36)}`;
    assets[key] = asset;
    const node: ImportNode = {
      id: newId(),
      type: 'import',
      name: uniqueName(scene, baseName(file.name)),
      asset: key,
      natural: tidyVec(natural),
      pos: tidyVec([x + size[0] / 2, 0, size[2] / 2]),
      rot: [0, 0, 0],
      size: tidyVec(size),
      hole: false,
      color: '#8fa3bf',
    };
    x += size[0] + 5;
    nodes.push(node);
    scene = [...scene, node];
  }
  // Centre the row on the plate.
  const shift = (x - 5) / 2;
  for (const n of nodes) n.pos = tidyVec([n.pos[0] - shift, n.pos[1], n.pos[2]]);
  state = { ...state, doc: { ...state.doc, assets }, placing: null };
  commit(scene, { selection: nodes.map((n) => n.id) });
}

/** Files picked or dropped: designs are opened, models and drawings are imported into the current design. */
export async function receiveFiles(files: PickedFile[]): Promise<void> {
  try {
    const design = files.find((f) => extension(f.name) === FILE_EXTENSION);
    if (design) {
      if (await okToDiscard()) openFile(design);
      return;
    }
    const models = files.filter((f) => IMPORT_EXTENSIONS.includes(extension(f.name)));
    if (models.length === 0) {
      if (files.length) notify(`Cannot import that. Supported: ${IMPORT_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')}.`, 'error');
      return;
    }
    if (state.viewing) return notify('Go back to the working design before importing.', 'error');
    set({ busy: 'Importing…' });
    // Let the "Importing…" badge paint before the parser blocks the thread.
    await new Promise((r) => setTimeout(r, 30));
    importModels(models);
  } catch (e) {
    fail(e);
  } finally {
    set({ busy: null });
  }
}

export async function importModel(): Promise<void> {
  try {
    const files = await platform.pickFiles({
      filters: [{ name: 'Models and drawings', extensions: IMPORT_EXTENSIONS }],
      multiple: true,
    });
    if (files.length) await receiveFiles(files);
  } catch (e) {
    fail(e);
  }
}

/** Write the design (or just the selection) in an exchange format. Returns where it went, or null if cancelled. */
export async function exportDesign(formatId: FormatId, selectionOnly: boolean): Promise<string | null> {
  const format = FORMATS.find((f) => f.id === formatId)!;
  const shown = state.viewing ? (state.doc.versions.find((v) => v.id === state.viewing)?.scene ?? []) : state.doc.scene;
  const nodes = selectionOnly && !state.viewing ? selectedNodes() : shown;
  const worker = await geometry.prepare(nodes, state.doc.assets);
  const result = await worker.export(nodes, format.kind === '2d');
  const name = state.doc.name;
  const bytes =
    format.id === 'svg' || format.id === 'dxf' ? exportOutline(format.id, result.outline ?? [], name) : exportMesh(format.id, result.mesh, name);
  const where = await platform.saveAs(`${name}.${format.extension}`, [{ name: format.label, extensions: [format.extension] }], bytes, format.mime);
  if (!where) return null;
  for (const w of result.warnings) notify(w, 'error');
  return where.path ?? where.name;
}

// --- versions -------------------------------------------------------------------

/** Keep the design as it is now, so it can be looked at or brought back later. */
export function saveVersion(label: string): void {
  if (state.viewing) return;
  const doc = state.doc;
  const head = doc.versions.find((v) => v.id === doc.head);
  const diff = diffScenes(head?.scene ?? [], doc.scene);
  if (diff.added + diff.changed + diff.removed === 0) {
    return notify(head ? `Nothing has changed since "${head.label}".` : 'There is nothing to save yet.');
  }
  const version: Version = {
    id: newId(),
    parent: doc.head,
    label: label.trim() || `Version ${doc.versions.length + 1}`,
    time: new Date().toISOString(),
    scene: doc.scene,
  };
  const thumb = thumbnailer?.();
  if (thumb) version.thumb = thumb;
  set({ doc: { ...doc, versions: [...doc.versions, version], head: version.id } });
  // A version is meant to be safe: write it to disk right away when the design has a file.
  if (state.filePath) void saveDesign();
}

export function viewVersion(id: string | null): void {
  if (id && !state.doc.versions.some((v) => v.id === id)) return;
  set({ viewing: id, selection: [], placing: null });
}

/** Make an old version the working design. The current state stays reachable through undo. */
export function restoreVersion(id: string): void {
  const version = state.doc.versions.find((v) => v.id === id);
  if (!version) return;
  state = { ...state, viewing: null };
  commit(version.scene, { selection: [], head: version.id });
  notify(`Restored "${version.label}"`);
}

export function renameVersion(id: string, label: string): void {
  const clean = label.trim();
  if (!clean) return;
  set({ doc: { ...state.doc, versions: state.doc.versions.map((v) => (v.id === id ? { ...v, label: clean } : v)) } });
}

export function deleteVersion(id: string): void {
  const doc = state.doc;
  const gone = doc.versions.find((v) => v.id === id);
  if (!gone) return;
  // Versions made from the deleted one now descend from its parent.
  const versions = doc.versions.filter((v) => v.id !== id).map((v) => (v.parent === id ? { ...v, parent: gone.parent } : v));
  set({
    doc: { ...doc, versions, head: doc.head === id ? gone.parent : doc.head },
    viewing: state.viewing === id ? null : state.viewing,
  });
}

/** The scene on screen: the working one, or the version being looked at. */
export function shownScene(s: EditorState = state): Scene {
  if (!s.viewing) return s.doc.scene;
  return s.doc.versions.find((v) => v.id === s.viewing)?.scene ?? s.doc.scene;
}

// --- start-up -------------------------------------------------------------------

/** Open the file the app was started with, or pick up where the last session stopped. */
export async function restoreSession(): Promise<void> {
  try {
    const path = await platform.startupFile();
    if (path) return void (await openPath(path, false));
    const session = await loadSession();
    if (session) adopt(session.doc, session.filePath, session.dirty);
  } catch (e) {
    fail(e);
  }
}
