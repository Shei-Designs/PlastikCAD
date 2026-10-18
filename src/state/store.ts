// The editor: one design, what is selected in it, and every action that can
// be taken on it. Kept outside React so that the viewer, keyboard shortcuts
// and menus all drive the same functions.
import { useSyncExternalStore } from 'react';
import { APP_NAME, FILE_EXTENSION } from '../app';
import { clampParams } from '../geometry/shapes';
import { encodeFloat32, encodeUint32 } from '../io/base64';
import { exportMesh, exportOutline, FORMATS } from '../io/export';
import { writeObj } from '../io/obj';
import { write3mf } from '../io/threemf';
import type { FormatId } from '../io/export';
import { centerMesh, centerOutline, fileKind, IMAGE_EXTENSIONS, IMPORT_EXTENSIONS, importFile } from '../io/import';
import { bytesToBase64 } from '../io/base64';
import { exportGlb } from './glbExport';
import { emptyDoc, HEAD_BYTES, legacyVersions, MAX_NOTE, parseDoc, readHeader, serializeDoc } from '../model/file';
import { hashString } from '../model/geomKey';
import { apply, axisRotation, boundsCenter, boundsSize, boxBounds, eulerOf, multiply, rotation, tidyVec, unionBounds } from '../model/math';
import type { Bounds, Mat } from '../model/math';
import {
  alignNodes,
  arrayNodes,
  arrayPlaces,
  cloneNode,
  dissolve,
  frameAlong,
  holeGroup,
  layerMembers,
  makeGroup,
  makeShape,
  mirrorNodes,
  newId,
  nodeAt,
  regroup,
  rotateNodes,
  ungroup,
  uniqueName,
  usedAssets,
} from '../model/ops';
import type { AlignMode, ArraySpec, GridArray, GroupOver, Layer, RingArray } from '../model/ops';
import type { Asset, Doc, GroupNode, ImageAsset, ImportNode, PartNode, PartParamValue, PictureNode, Scene, SceneNode, ShapeKind, TextNode, Texture, Vec2, Vec3 } from '../model/types';
import { GENERATORS, getGenerator } from '../parts/generators';
import { sanitizeParams } from '../parts/generators/types';
import { mateOf } from '../parts/mates';
import type { MateRequest } from '../parts/mates';
import * as platform from '../platform';
import type { PickedFile } from '../platform';
import { DEFAULT_FONT, loadFont, outlineOf } from '../text/fonts';
import { geometry } from './geometry';
import { loadPrefs, savePrefs } from './persist';
import type { Prefs } from './persist';
import { DiskProjects, fileNameFor, hasProjectStore, openProjectStore, projectStore, useProjectStore } from './projects';
import type { ProjectInfo } from './projects';
import { initSync, linkAccount, requestSync, unlinkAccount } from '../sync/sync';
import type { SyncReport } from '../sync/engine';
import { mergeDocs } from '../sync/merge';

export interface Notice {
  /** `ok` for something that went through (a save, an export, a sync), `info` for a plain word, `error` for what failed. */
  kind: 'error' | 'info' | 'ok';
  text: string;
  /** Something to do about it, offered as a button ("Share…"). */
  action?: { label: string; run: () => void };
}

export interface EditorState {
  doc: Doc;
  /** Ids of selected top-level nodes. */
  selection: string[];
  /** Where the project is kept (its key in the project store), once it has been written. */
  projectKey: string | null;
  /** The design as last saved or opened, to tell whether there are changes still to write. */
  saved: { scene: Scene; name: string } | null;
  /** A write to the project store is under way. */
  saving: boolean;
  /** The projects browser is open. */
  browsing: boolean;
  /** Where projects are kept, once start-up has looked: the folder (null in a browser) and whether another can be chosen. */
  storage: { location: string | null; fixed: boolean; defaultDir: string | null } | null;
  /** New shape following the pointer until it is put down. */
  placing: SceneNode | null;
  /**
   * The gear a mate is being made for while the wizard is open; the previewed mate carries
   * `id`. `building` while the preview the panel asks for is not in the scene yet.
   */
  mating: { source: string; id: string; building: boolean } | null;
  /**
   * Align mode: anchor dots sit on `bounds`, the box of the anchor object or,
   * without one, of the whole selection. Frozen while a dot is being previewed.
   */
  aligning: { anchor: string | null; bounds: Bounds } | null;
  /**
   * Editing inside a group: the layers taken apart to reach a part of it,
   * which are put back together on Done. `before` is the scene for Cancel.
   */
  editing: { root: string; target: string; layers: Layer[]; before: Scene } | null;
  /** A box drawn in the viewport, for pointing at a part of a group from the structure graph. */
  highlight: { matrix: Mat; size: Vec3 } | null;
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
}

const DESIGN_FILTER = [{ name: `${APP_NAME} design`, extensions: [FILE_EXTENSION] }];
const MERGE_WINDOW_MS = 800;
const UNDO_LIMIT = 200;

let state: EditorState = {
  doc: emptyDoc(),
  selection: [],
  projectKey: null,
  saving: false,
  browsing: false,
  storage: null,
  saved: null,
  placing: null,
  mating: null,
  aligning: null,
  editing: null,
  highlight: null,
  prefs: loadPrefs(),
  notice: null,
  busy: null,
  canUndo: false,
  canRedo: false,
  epoch: 0,
};
state.saved = { scene: state.doc.scene, name: state.doc.name };

const listeners = new Set<() => void>();
let past: Step[] = [];
let future: Step[] = [];
let gesture: Step | null = null;
/** Set while a hovered align dot holds the scene in a gesture (see `previewAlign`). */
let alignPreview = false;
let lastMerge: { key: string; time: number } | null = null;
let clipboard: SceneNode[] = [];
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

function set(patch: Partial<EditorState>): void {
  const before = state;
  // Any change of selection ends align mode.
  if (state.aligning && patch.selection && patch.aligning === undefined && !sameIds(patch.selection, state.selection)) patch = { ...patch, aligning: null };
  state = { ...state, ...patch, canUndo: past.length > 0, canRedo: future.length > 0 };
  if (state.prefs !== before.prefs) savePrefs(state.prefs);
  if (state.doc !== before.doc && isDirty()) scheduleAutosave();
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
  !s.saved || s.doc.scene !== s.saved.scene || s.doc.name !== s.saved.name;

/** How long after the last change the project is written. */
const AUTOSAVE_MS = 1000;

function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => void saveProject(), AUTOSAVE_MS);
}

/**
 * The design as it goes to disk. While a group is being edited inside, the
 * scene on screen has it taken apart; what is written has it put back
 * together, so that a save or a reload mid-edit never flattens it. Editing
 * carries on regardless.
 */
export function docToSave(s: EditorState = state): Doc {
  if (!s.editing) return s.doc;
  return { ...s.doc, scene: regroup(s.doc.scene, s.editing.layers, (n) => geometry.bounds(n)) };
}

export function notify(text: string, kind: Notice['kind'] = 'info', action?: Notice['action']): void {
  clearTimeout(noticeTimer);
  set({ notice: { kind, text, action } });
  // Longer with something to read twice or a button to reach.
  noticeTimer = setTimeout(() => set({ notice: null }), kind === 'error' || action ? 8000 : 3500);
}

/** A "Share…" button for the toast, where files can be handed to other apps; nothing elsewhere. */
const shareAction = (uris: string[], mime: string): Notice['action'] | undefined =>
  platform.canShare() && uris.length ? { label: 'Share…', run: () => void platform.share(uris, mime).catch(fail) } : undefined;

export const dismissNotice = (): void => set({ notice: null });

const fail = (e: unknown): void => notify(e instanceof Error ? e.message : String(e), 'error');

export function setPrefs(patch: Partial<Prefs>): void {
  set({ prefs: { ...state.prefs, ...patch } });
}

// --- scene edits and undo -------------------------------------------------

const step = (): Step => ({ scene: state.doc.scene, selection: state.selection });

/**
 * Replace the scene as one undoable step. Edits with the same `merge` key in
 * quick succession (typing in a field, holding an arrow key) count as one.
 */
function commit(scene: Scene, options: { selection?: string[]; merge?: string } = {}): void {
  abortAlignPreview();
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
  set({ doc: { ...state.doc, scene }, selection });
}

/** Start of a drag: everything until `endGesture` is a single undo step. */
export function beginGesture(): void {
  // A dot still being hovered is let go of first, so the drag never inherits its snapshot.
  abortAlignPreview();
  gesture ??= step();
}

export function endGesture(cancel = false): void {
  const base = gesture;
  gesture = null;
  alignPreview = false;
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
  abortAlignPreview();
  if (state.mating) cancelMate();
  const target = from.pop();
  if (!target) return;
  to.push(step());
  lastMerge = null;
  const ids = new Set(target.scene.map((n) => n.id));
  set({ doc: { ...state.doc, scene: target.scene }, selection: target.selection.filter((id) => ids.has(id)) });
  // The dots follow the objects back.
  if (state.aligning) refreshAlignBounds();
}

export const undo = (): void => restore(past, future);
export const redo = (): void => restore(future, past);

function resetHistory(): void {
  past = [];
  future = [];
  gesture = null;
  alignPreview = false;
  lastMerge = null;
}

// --- selection --------------------------------------------------------------

export function selectedNodes(s: EditorState = state): SceneNode[] {
  if (s.selection.length === 0) return [];
  const ids = new Set(s.selection);
  return s.doc.scene.filter((n) => ids.has(n.id));
}

export function select(ids: string[]): void {
  abortAlignPreview();
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
  abortAlignPreview();
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
  abortAlignPreview();
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
  try {
    await loadFont(DEFAULT_FONT);
    const node = makeText('Text', DEFAULT_FONT);
    if (!node) return;
    abortAlignPreview();
    set({ placing: node, selection: [] });
  } catch (e) {
    fail(e);
  }
}

/** Add lettering at the middle of the plate straight away (keyboard route, double-click). */
export async function addText(): Promise<void> {
  try {
    await loadFont(DEFAULT_FONT);
    const node = makeText('Text', DEFAULT_FONT);
    if (!node) return;
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
    if (node?.type !== 'text' || node.locked) return false;
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

// --- parametric parts ---------------------------------------------------------------

/** A part before it has been measured: a unit box, which `sizePart` replaces with the real one. */
function makePart(generatorId: string, params?: Record<string, PartParamValue>): PartNode {
  const def = getGenerator(generatorId);
  return {
    id: newId(),
    type: 'part',
    name: def.name,
    part: def.id,
    params: sanitizeParams(def, params),
    natural: [1, 1, 1],
    pos: [0, 0, -1e6],
    rot: [0, 0, 0],
    size: [1, 1, 1],
    hole: false,
    color: '#8fa3bf',
  };
}

/** The part's box as its generator makes it, in the generator's own frame, from the geometry kernel. */
async function partBox(node: PartNode): Promise<Bounds> {
  const worker = await geometry.prepare([], state.doc.assets);
  const bounds = await worker.partBox(node);
  if (!bounds) throw new Error(`"${node.name}" came out empty with these settings.`);
  return bounds;
}

const measurePart = async (node: PartNode): Promise<Vec3> => boundsSize(await partBox(node));

/** Give a part its measured box, keeping whatever scale it had and where it stands. */
async function sizePart(node: PartNode): Promise<PartNode> {
  const natural = await measurePart(node);
  const size: Vec3 = [0, 1, 2].map((i) => (node.size[i] / node.natural[i]) * natural[i]) as Vec3;
  const next: PartNode = { ...node, natural, size };
  // Parked parts have no base to keep; placed ones stay on whatever they stand on.
  if (node.pos[2] > -1e5) {
    const lift = geometry.bounds(node).min[2] - boxBounds(next).min[2];
    next.pos = [node.pos[0], node.pos[1], node.pos[2] + lift];
  }
  return next;
}

/** Start carrying a new part of this kind (gears, pulleys, screws), to be put down like a shape. */
export async function startPlacingPart(category: string): Promise<void> {
  const def = GENERATORS.find((g) => g.category === category);
  if (!def) return;
  set({ busy: 'Making the part…' });
  try {
    const node = await sizePart(makePart(def.id));
    abortAlignPreview();
    set({ placing: node, selection: [] });
  } catch (e) {
    fail(e);
  } finally {
    set({ busy: null });
  }
}

/** Add a part at the middle of the plate straight away (keyboard route, double-click). */
export async function addPart(category: string): Promise<void> {
  const def = GENERATORS.find((g) => g.category === category);
  if (!def) return;
  set({ busy: 'Making the part…' });
  try {
    const node = await sizePart(makePart(def.id));
    node.pos = [0, 0, node.size[2] / 2];
    node.name = uniqueName(state.doc.scene, node.name);
    state = { ...state, placing: null };
    commit([...state.doc.scene, node], { selection: [node.id] });
  } catch (e) {
    fail(e);
  } finally {
    set({ busy: null });
  }
}

// --- mating gears -------------------------------------------------------------

/** A mate laid out next to its gear: standing on the same base, meshed, and measured (not yet in the scene). */
async function placeMate(source: PartNode, request: MateRequest): Promise<{ node: PartNode; warnings: string[] }> {
  const mate = mateOf(source, request);
  const node = makePart(mate.part, mate.params);
  if (mate.name) node.name = mate.name;
  const [box, sourceBox] = await Promise.all([partBox(node), partBox(source)]);
  node.natural = boundsSize(box);
  node.size = [...node.natural];
  node.rot = mate.rotation;
  // Both parts are placed by their box centers, which sit off their generators' origins (the gear's
  // axis, the rack's corner); the mate is laid out between origins and then moved by its own box.
  const c1 = boundsCenter(sourceBox).map((c, i) => (c * source.size[i]) / source.natural[i]) as Vec3;
  const c2 = boundsCenter(box);
  const [ax, ay, az] = apply(rotation(source.rot), c1);
  const origin: Vec3 = [source.pos[0] - ax, source.pos[1] - ay, source.pos[2] - az];
  const [bx, by, bz] = apply(rotation(mate.rotation), c2);
  node.pos = tidyVec([origin[0] + mate.offset[0] + bx, origin[1] + mate.offset[1] + by, origin[2] + mate.offset[2] + bz]);
  node.color = source.color;
  return { node, warnings: mate.warnings };
}

/** The request waiting while a preview is being built, and a count that tells a stale build from the latest. */
let mateNext: MateRequest | null = null;
let mateBuilding = false;
let mateBuilds = 0;
/** Settles when the build under way is over and the next one, if a request was waiting, has begun. */
let mateDone: Promise<void> = Promise.resolve();

/**
 * Open the mating gear wizard for this gear. The panel then shows the mate it asks for, live,
 * with `previewMate`; `commitMate` keeps it and `cancelMate` drops it. Nothing links the two
 * parts afterwards: change the gear and a fresh mate is a click away.
 */
export function startMate(sourceId: string): void {
  const source = state.doc.scene.find((n) => n.id === sourceId);
  if (source?.type !== 'part') return;
  cancelMate();
  cancelArray();
  if (state.aligning) stopAligning();
  set({ mating: { source: sourceId, id: newId(), building: false }, selection: [sourceId], placing: null });
}

/** Tell the panel whether the mate it asks for is still on its way (Accept waits for it). */
function setMateBuilding(building: boolean): void {
  if (state.mating && state.mating.building !== building) set({ mating: { ...state.mating, building } });
}

/** Show the mate as the panel now asks for it. Rapid requests fold together: only the latest is built. */
export async function previewMate(request: MateRequest): Promise<void> {
  if (mateBuilding) {
    mateNext = request;
    return;
  }
  mateBuilding = true;
  setMateBuilding(true);
  let done!: () => void;
  mateDone = new Promise<void>((resolve) => {
    done = resolve;
  });
  try {
    await buildMatePreview(request);
  } finally {
    mateBuilding = false;
    const next = mateNext;
    mateNext = null;
    if (next && state.mating) void previewMate(next);
    else setMateBuilding(false);
    done();
  }
}

/** Resolves once no preview is being built (right away if none is). */
async function mateSettled(): Promise<void> {
  while (mateBuilding) await mateDone;
}

async function buildMatePreview(request: MateRequest): Promise<void> {
  const mating = state.mating;
  if (!mating) return;
  const source = state.doc.scene.find((n) => n.id === mating.source);
  if (source?.type !== 'part') return cancelMate();
  const build = ++mateBuilds;
  try {
    const { node, warnings } = await placeMate(source, request);
    node.id = mating.id;
    const others = state.doc.scene.filter((n) => n.id !== mating.id);
    node.name = uniqueName(others, node.name);
    await geometry.ready(node, state.doc.assets);
    if (build !== mateBuilds || state.mating?.id !== mating.id) return;
    // The preview is no step of its own: the whole wizard becomes one on Accept.
    set({ doc: { ...state.doc, scene: [...state.doc.scene.filter((n) => n.id !== mating.id), node] } });
    if (warnings.length) notify(warnings[0]);
  } catch (e) {
    fail(e);
  }
}

/** Keep the previewed mate, selected, as one undo step. Waits for the preview the panel last asked for. */
export async function commitMate(): Promise<void> {
  const opened = state.mating;
  if (!opened) return;
  await mateSettled();
  // Canceled, or closed and opened again, meanwhile.
  const mating = state.mating;
  if (!mating || mating.id !== opened.id) return;
  mateNext = null;
  mateBuilds++;
  const node = state.doc.scene.find((n) => n.id === mating.id);
  const before = state.doc.scene.filter((n) => n.id !== mating.id);
  scrubMate(mating.id);
  if (node) {
    past.push({ scene: before, selection: state.selection });
    if (past.length > UNDO_LIMIT) past.shift();
    future = [];
    lastMerge = null;
  }
  set({ mating: null, selection: node ? [node.id] : state.selection });
}

export function cancelMate(): void {
  const mating = state.mating;
  if (!mating) return;
  mateNext = null;
  mateBuilds++;
  scrubMate(mating.id);
  set({ mating: null, doc: { ...state.doc, scene: state.doc.scene.filter((n) => n.id !== mating.id) } });
}

/** Steps recorded while the wizard was open (edits to the gear itself) hold the preview too; it does not belong in them. */
function scrubMate(id: string): void {
  const clean = (s: Step): Step => (s.scene.some((n) => n.id === id) ? { ...s, scene: s.scene.filter((n) => n.id !== id), selection: s.selection.filter((x) => x !== id) } : s);
  past = past.map(clean);
  future = future.map(clean);
}

let partEdits = 0;

type PartChange = { part?: string; params?: Record<string, PartParamValue> };
/** Parts being rebuilt right now, and for each the change that arrived meanwhile, folded into one. */
const partBusy = new Set<string>();
const partNext = new Map<string, PartChange>();

/**
 * Change a part's generator or parameters. The part keeps its scale and stays on its base.
 * A slider fires many changes in a row and each rebuild takes a moment, so while one rebuild
 * is under way the changes that follow are folded together and only the latest is built after
 * it: the worker never queues up a drag's worth of stale shapes.
 */
export async function editPart(id: string, change: PartChange): Promise<void> {
  if (partBusy.has(id)) {
    const held = partNext.get(id);
    // A new kind resets the parameters, as it does when applied straight away.
    partNext.set(id, change.part && change.part !== held?.part ? { ...change } : { part: held?.part ?? change.part, params: { ...held?.params, ...change.params } });
    return;
  }
  partBusy.add(id);
  try {
    await applyPartChange(id, change);
  } finally {
    partBusy.delete(id);
    const next = partNext.get(id);
    if (next) {
      partNext.delete(id);
      void editPart(id, next);
    }
  }
}

async function applyPartChange(id: string, change: PartChange): Promise<void> {
  const node = state.doc.scene.find((n) => n.id === id);
  if (node?.type !== 'part' || node.locked) return;
  const def = getGenerator(change.part ?? node.part);
  const params = change.part && change.part !== node.part ? sanitizeParams(def, change.params) : sanitizeParams(def, { ...node.params, ...change.params });
  // A part still carrying its kind's own name (or that plus a number) takes the new kind's name with it.
  const was = getGenerator(node.part).name;
  const auto = node.name === was || new RegExp(`^${was.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d+$`).test(node.name);
  const name = change.part && change.part !== node.part && auto ? uniqueName(state.doc.scene.filter((n) => n.id !== id), def.name) : node.name;
  const edit = ++partEdits;
  try {
    const sized = await sizePart({ ...node, part: def.id, params, name });
    // The new shape is built before the node changes, so the old one is never shown at the new size.
    await geometry.ready(sized, state.doc.assets);
    // A later edit has overtaken this one, or the part is gone.
    if (edit !== partEdits || !state.doc.scene.some((n) => n.id === id)) return;
    updateNode(id, sized, `part:${id}`);
  } catch (e) {
    fail(e);
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
  const node = makeShape(kind);
  node.name = uniqueName(state.doc.scene, node.name);
  state = { ...state, placing: null };
  commit([...state.doc.scene, node], { selection: [node.id] });
}

export function deleteSelected(): void {
  abortAlignPreview();
  const ids = new Set(selectedNodes().filter((n) => !n.locked).map((n) => n.id));
  if (ids.size === 0) return;
  commit(
    state.doc.scene.filter((n) => !ids.has(n.id)),
    { selection: state.selection.filter((id) => !ids.has(id)) },
  );
}

function addCopies(sources: SceneNode[], offset: Vec3): void {
  if (sources.length === 0) return;
  abortAlignPreview();
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
export function duplicateSelected(): void {
  abortAlignPreview();
  addCopies(selectedNodes(), [0, 0, 0]);
}

export function copySelected(): void {
  abortAlignPreview();
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
  const node = state.doc.scene.find((n) => n.id === id);
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
    state.doc.scene.map((n) => (n.id === id ? next : n)),
    { merge: change.angle !== undefined ? `angle:${id}` : undefined },
  );
}

/** The pictures in the design, for the texture picker. */
export function imageAssets(doc: Doc = state.doc): { key: string; asset: ImageAsset }[] {
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
  const scene = patch(state.doc.scene, 0);
  if (scene.some((n, i) => n !== state.doc.scene[i])) commit(scene, { merge: `note:${path.join('/')}` });
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
  if (state.aligning) return;
  if (state.selection.length < 2) return notify('Select two or more objects to line them up.');
  const bounds = alignBounds(null);
  if (bounds) set({ aligning: { anchor: null, bounds }, placing: null });
}

export function stopAligning(): void {
  if (!state.aligning) return;
  // A dot being previewed is let go of first.
  abortAlignPreview();
  set({ aligning: null });
}

/**
 * Let go of a hovered dot's preview: the scene goes back to how it was before
 * the hover. Everything else that reads or changes the scene or selection does
 * this first, so it works on the real scene and never inherits the gesture
 * (whose end would otherwise throw its own edit away).
 */
function abortAlignPreview(): void {
  if (!alignPreview) return;
  alignPreview = false;
  endGesture(true);
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
export function previewAlign(axis: 0 | 1 | 2 | null, mode: AlignMode = 'center'): void {
  if (!state.aligning) return;
  if (axis === null) return abortAlignPreview();
  const nodes = aligned(axis, mode);
  if (!nodes) return;
  // Not through commit, which would take the preview for an edit and let go of it.
  gesture ??= step();
  alignPreview = true;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  set({ doc: { ...state.doc, scene: state.doc.scene.map((n) => byId.get(n.id) ?? n) } });
}

/** Clicking a dot keeps the objects where the preview put them. */
export function commitAlign(axis: 0 | 1 | 2, mode: AlignMode): void {
  const nodes = aligned(axis, mode);
  if (!nodes) return;
  // From the scene before the hover, as one step of its own.
  abortAlignPreview();
  replaceNodes(nodes);
  refreshAlignBounds();
}

// --- arrays -------------------------------------------------------------------

/**
 * A pattern as the panel asks for it. The frame (the largest of two or more
 * selected objects) is found here: a grid fits inside it, a ring goes round
 * its center, and either way it stays put.
 */
export type ArrayRequest = (Omit<RingArray, 'center'> & { center: Vec2 | 'frame' }) | (Omit<GridArray, 'fit'> & { fit?: { inset: number } });

/** Patterns stop here: every place is another object for the kernel to merge. */
export const ARRAY_LIMIT = 400;
/** Ids of the pattern being previewed, the originals first. */
let arraying: string[] | null = null;

const volumeOf = (node: SceneNode): number => {
  const s = boundsSize(geometry.bounds(node));
  return s[0] * s[1] * s[2];
};

/** The object a grid can be fitted into: the largest of two or more selected. */
export function arrayFrame(nodes: SceneNode[] = selectedNodes()): SceneNode | null {
  return nodes.length < 2 ? null : nodes.reduce((best, n) => (volumeOf(n) > volumeOf(best) ? n : best));
}

/**
 * Lay the selection out in a pattern for a look. Another call replaces the
 * pattern, `commitArray` keeps it and `cancelArray` drops it; until then it is
 * one gesture, so nothing reaches the history.
 */
export function previewArray(request: ArrayRequest): void {
  if (state.aligning) stopAligning();
  // Always from the scene and selection the preview started from.
  const base = gesture ?? step();
  const ids = new Set(base.selection);
  const picked = base.scene.filter((n) => ids.has(n.id));
  const framed = request.kind === 'grid' ? Boolean(request.fit) : request.center === 'frame';
  const frame = framed ? arrayFrame(picked) : null;
  const seeds = picked.filter((n) => !n.locked && n !== frame);
  if (seeds.length === 0) return;
  if (arrayPlaces(request) > ARRAY_LIMIT) return notify(`A pattern can have up to ${ARRAY_LIMIT} places.`);
  let spec: ArraySpec;
  if (request.kind === 'grid') spec = request.fit && frame ? { ...request, fit: { inset: request.fit.inset, bounds: geometry.bounds(frame) } } : { ...request, fit: undefined };
  else if (request.center === 'frame') {
    const c = frame ? boundsCenter(geometry.bounds(frame)) : boundsCenter(unionBounds(seeds.map((n) => geometry.bounds(n))));
    spec = { ...request, center: [c[0], c[1]] };
  } else spec = { ...request, center: request.center };
  const { originals, copies } = arrayNodes(seeds, (n) => geometry.bounds(n), spec);
  const moved = new Map(originals.map((n) => [n.id, n]));
  let scene = base.scene.map((n) => moved.get(n.id) ?? n);
  for (const copy of copies) {
    copy.name = uniqueName(scene, copy.name.replace(/ \d+$/, ''));
    scene = [...scene, copy];
  }
  beginGesture();
  arraying = [...originals.map((n) => n.id), ...copies.map((n) => n.id)];
  commit(scene, { selection: arraying });
}

/** Keep the previewed pattern, selected, as one undo step. */
export function commitArray(): void {
  if (!arraying) return;
  arraying = null;
  endGesture(false);
}

export function cancelArray(): void {
  if (!arraying) return;
  arraying = null;
  endGesture(true);
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

/** Measure and build a group of the given members (their hole flags as they are to be inside it); null if nothing solid would be left. */
async function buildGroup(members: SceneNode[], hole: boolean, name: string, over: GroupOver = {}): Promise<GroupNode | null> {
  const worker = await geometry.prepare(members, state.doc.assets);
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
    const group = await buildGroup(members, hole, uniqueName(state.doc.scene, 'Group'));
    if (!group) return notify('Nothing would be left: the holes remove everything.', 'error');
    // The scene may have moved on while the worker was measuring.
    const ids = new Set(nodes.map((n) => n.id));
    if (!nodes.every((n) => state.doc.scene.includes(n))) return;
    commit([...state.doc.scene.filter((n) => !ids.has(n.id)), group], { selection: [group.id] });
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
  const selection = state.selection.filter((id) => !groups.some((g) => g.id === id));
  const scene: Scene = [];
  for (const node of state.doc.scene) {
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
  const matrix = path ? frameAlong(state.doc.scene, path) : null;
  const node = path ? nodeAt(state.doc.scene, path) : null;
  const highlight = matrix && node ? { matrix, size: node.size } : null;
  if (highlight || state.highlight) set({ highlight });
}

/**
 * Take the groups along `path` apart so that the part at its end can be
 * changed, remembering how to put them back together (see `finishEditing`).
 */
export function editInside(path: string[]): void {
  if (state.editing || path.length < 2) return;
  abortAlignPreview();
  const root = state.doc.scene.find((n) => n.id === path[0]);
  if (root?.type !== 'group') return;
  if (root.locked) return notify('Unlock the object before editing inside it.', 'error');
  const { scene, layers } = dissolve(state.doc.scene, path);
  const target = path[path.length - 1];
  state = { ...state, editing: { root: root.id, target, layers, before: state.doc.scene }, highlight: null, aligning: null };
  commit(scene, { selection: scene.some((n) => n.id === target) ? [target] : [] });
}

/** Put the layers back together, innermost first, around whatever is left of their contents. */
export async function finishEditing(): Promise<void> {
  const session = state.editing;
  if (!session) return;
  set({ busy: 'Regrouping…' });
  try {
    let scene = state.doc.scene;
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
    state = { ...state, editing: null };
    commit(scene, { selection: outermost ? [outermost] : [] });
  } catch (e) {
    fail(e);
  } finally {
    set({ busy: null });
  }
}

/** Back to how things were before `editInside`. */
export function cancelEditing(): void {
  const session = state.editing;
  if (!session) return;
  state = { ...state, editing: null };
  commit(session.before, { selection: [session.root] });
}

// --- projects -----------------------------------------------------------------
//
// A project is saved as it changes: a second after the last edit, when the
// window is hidden or closed, and before another project is opened. There is
// no Save; "Save a copy" writes the design somewhere else, "Open project file"
// brings an outside file in as a project.

/** Picture of the design for the projects browser, given by the viewer when there is one. */
let thumbSource: (() => string | null) | null = null;
/** Taking the picture means drawing the scene again, so it is not done on every save. */
const THUMB_EVERY_MS = 10_000;
let thumbTakenAt = 0;
let writing: Promise<boolean> | null = null;
let lastSaveError: string | null = null;

export function provideThumbnail(source: (() => string | null) | null): void {
  thumbSource = source;
}

function thumbFor(doc: Doc, fresh: boolean): string | undefined {
  if (doc.scene.length === 0) return undefined;
  if (!thumbSource) return doc.thumb;
  const now = Date.now();
  if (!fresh && doc.thumb && now - thumbTakenAt < THUMB_EVERY_MS) return doc.thumb;
  const shot = thumbSource();
  if (!shot) return doc.thumb;
  thumbTakenAt = now;
  return shot;
}

/** Whether the project is worth a file yet: it has one already, something was put in it, or it was named. */
const worthSaving = (): boolean => state.projectKey !== null || state.doc.scene.length > 0 || state.doc.name !== 'Untitled';

/**
 * Writes the project to the store now, if anything changed. Resolves true once
 * it is saved (or there was nothing to save), false when the write failed; the
 * changes are then still pending and the next edit tries again.
 */
export function saveProject(fresh = false): Promise<boolean> {
  clearTimeout(autosaveTimer);
  if (writing) return writing.then(() => saveProject(fresh));
  if (!isDirty() || !worthSaving()) return Promise.resolve(true);
  if (!hasProjectStore()) return Promise.resolve(false);
  writing = write(fresh).finally(() => {
    writing = null;
  });
  return writing;
}

async function write(fresh: boolean): Promise<boolean> {
  // What is being written counts as saved once it is, even if more changed meanwhile.
  const base = { scene: state.doc.scene, name: state.doc.name };
  const doc = docToSave();
  const thumb = thumbFor(doc, fresh);
  // Every save is a revision following the one before it, so that sync can tell what changed where.
  const stamp = { revision: newId(), parent: doc.revision, device: state.prefs.device, saved: new Date().toISOString() };
  set({ saving: true });
  try {
    const key = await projectStore().write(state.projectKey, doc.name, serializeDoc({ ...doc, ...stamp, thumb }));
    set({ projectKey: key, saved: base, saving: false, doc: { ...state.doc, ...stamp, thumb } });
    if (state.prefs.lastProject !== key) setPrefs({ lastProject: key });
    lastSaveError = null;
    requestSync();
    return true;
  } catch (e) {
    set({ saving: false });
    const message = e instanceof Error ? e.message : String(e);
    // The same failure on every keystroke is reported once.
    if (message !== lastSaveError) notify(`Could not save: ${message}`, 'error');
    lastSaveError = message;
    return false;
  }
}

/** Ctrl+S: there is nothing to do but write what autosave would have a moment later, and say so. */
export async function saveNow(): Promise<void> {
  if (await saveProject(true)) notify(state.doc.scene.length || state.projectKey ? 'Saved' : 'Nothing to save yet', 'ok');
}

function adopt(doc: Doc, key: string | null): void {
  abortAlignPreview();
  resetHistory();
  clearTimeout(autosaveTimer);
  thumbTakenAt = 0;
  set({
    doc,
    projectKey: key,
    saved: { scene: doc.scene, name: doc.name },
    saving: false,
    selection: [],
    placing: null,
    mating: null,
    editing: null,
    highlight: null,
    epoch: state.epoch + 1,
  });
  setPrefs({ lastProject: key });
  // Lettering outlines are sent again as the fonts come back; imported meshes of the closed design are dropped.
  geometry.forgetAssets(Object.keys(doc.assets));
}

/** Writes what is pending before another project takes the screen; asks whether to go on if that fails. */
async function leaveProject(): Promise<boolean> {
  if (await saveProject(true)) return true;
  return platform.confirm(`The latest changes to "${state.doc.name}" could not be saved. Leave anyway and lose them?`, {
    title: APP_NAME,
    okLabel: 'Leave anyway',
    cancelLabel: 'Keep editing',
  });
}

export const openProjects = (): void => set({ browsing: true });
export const closeProjects = (): void => set({ browsing: false });

export async function newProject(): Promise<void> {
  if (!(await leaveProject())) return;
  adopt(emptyDoc(), null);
  set({ browsing: false });
}

export async function openProject(key: string): Promise<void> {
  try {
    if (key === state.projectKey) return set({ browsing: false });
    if (!(await leaveProject())) return;
    const text = await projectStore().read(key);
    adopt(parseDoc(text), key);
    set({ browsing: false });
    // A file saved before projects had ids was just given one: written back, so the folder knows it too.
    if (!readHeader(text.slice(0, HEAD_BYTES))?.id) {
      set({ saved: null });
      scheduleAutosave();
    }
  } catch (e) {
    fail(e);
  }
}

const baseName = (fileName: string): string => fileName.replace(/\.[^.]+$/, '');
const extension = (fileName: string): string => fileName.split('.').pop()?.toLowerCase() ?? '';
const folderOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).replace(/[\\/]+$/, '');

/**
 * A design file from outside: picked, dropped or double-clicked. It becomes a
 * project of its own, with a fresh id so that it never passes for the one it
 * was copied from. A file that is already in the projects folder is just opened.
 */
async function importProjectFile(file: PickedFile): Promise<void> {
  const text = new TextDecoder().decode(file.bytes);
  const doc = parseDoc(text);
  if (doc.name === 'Untitled') doc.name = baseName(file.name);
  const store = projectStore();
  if (file.path && store.location && folderOf(file.path) === store.location.replace(/[\\/]+$/, '')) return openProject(file.path);
  if (!(await leaveProject())) return;
  doc.id = newId();
  const key = await store.write(null, doc.name, serializeDoc(doc));
  adopt(doc, key);
  set({ browsing: false });
  notify(`Added "${doc.name}" to your projects.`, 'ok');
  await offerLegacyVersions(text, doc.name);
}

/**
 * Files from before format version 2 may carry saved versions, which the app
 * no longer keeps: each can become a project of its own before they are dropped.
 */
async function offerLegacyVersions(text: string, name: string): Promise<void> {
  const versions = legacyVersions(text);
  if (versions.length === 0) return;
  const count = `${versions.length} saved version${versions.length === 1 ? '' : 's'}`;
  const keep = await platform.confirm(`"${name}" carries ${count} from an older version of the app, which no longer keeps them. Add each as a project of its own?`, {
    title: APP_NAME,
    okLabel: 'Add them',
    cancelLabel: 'Drop them',
  });
  if (!keep) return;
  for (const version of versions) await projectStore().write(null, version.name, serializeDoc(version));
  notify(`Added ${count} as projects.`, 'ok');
}

/** "Open project file…": brings a design file from anywhere in as a project. */
export async function openProjectFile(): Promise<void> {
  try {
    const [file] = await platform.pickFiles({ filters: DESIGN_FILTER });
    if (file) await importProjectFile(file);
  } catch (e) {
    fail(e);
  }
}

/** "Save a copy…": writes the design to a place of the user's choosing, to share or keep. The project itself stays where it is. */
export async function saveCopy(): Promise<boolean> {
  try {
    await saveProject(true);
    const bytes = new TextEncoder().encode(serializeDoc(docToSave()));
    const where = await platform.saveAs(fileNameFor(state.doc.name), DESIGN_FILTER, bytes, 'application/json');
    if (!where) return false;
    notify(`Saved a copy to ${where.path ?? where.name}`, 'ok', shareAction(where.uri ? [where.uri] : [], 'application/json'));
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export function renameProject(name: string): void {
  const clean = name.trim();
  if (clean && clean !== state.doc.name) set({ doc: { ...state.doc, name: clean } });
}

/** The projects in the store, newest first. */
export async function listProjects(): Promise<ProjectInfo[]> {
  try {
    const items = await projectStore().list();
    return items.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  } catch (e) {
    fail(e);
    return [];
  }
}

export async function deleteProject(key: string, name: string): Promise<boolean> {
  try {
    const sure = await platform.confirm(`Delete "${name}"? This cannot be undone.`, { title: APP_NAME, okLabel: 'Delete', cancelLabel: 'Keep' });
    if (!sure) return false;
    if (key === state.projectKey) {
      // Nothing pending may write it back after it is gone.
      clearTimeout(autosaveTimer);
      await writing;
    }
    await projectStore().remove(key);
    if (key === state.projectKey) adopt(emptyDoc(), null);
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

/** A copy of a project, as a project of its own. Returns its key. */
export async function duplicateProject(key: string): Promise<string | null> {
  try {
    if (key === state.projectKey) await saveProject(true);
    const store = projectStore();
    const doc = parseDoc(await store.read(key));
    doc.id = newId();
    doc.name = `${doc.name} copy`;
    return await store.write(null, doc.name, serializeDoc(doc));
  } catch (e) {
    fail(e);
    return null;
  }
}

/** Renames a project from the browser, open or not. */
export async function renameProjectAt(key: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  if (key === state.projectKey) return renameProject(clean);
  try {
    const store = projectStore();
    const doc = parseDoc(await store.read(key));
    if (doc.name === clean) return;
    doc.name = clean;
    await store.write(key, clean, serializeDoc(doc));
  } catch (e) {
    fail(e);
  }
}

// --- cloud sync -----------------------------------------------------------------

/** What a sync pass wrote or removed, taken into the editor: the open project above all. */
export async function applySyncReport(report: SyncReport): Promise<void> {
  let key = state.projectKey;
  const moved = key && report.movedKeys.find((m) => m.from === key);
  if (moved) {
    key = moved.to;
    set({ projectKey: key });
    setPrefs({ lastProject: key });
  }
  if (key && report.removedKeys.includes(key)) {
    adopt(emptyDoc(), null);
    notify('The open project was deleted on another device.');
  } else if (key && report.changedKeys.includes(key)) {
    await reloadOpenProject(key);
  }
  for (const name of report.kept) notify(`"${name}" was changed on two devices at once; both versions were kept.`);
  if (report.downloaded.length) notify(`Synced ${report.downloaded.length === 1 ? `"${report.downloaded[0]}"` : `${report.downloaded.length} projects`} from Google Drive.`, 'ok');
}

/** The open project changed on disk under the editor: taken in whole, or merged with edits not yet saved. */
async function reloadOpenProject(key: string): Promise<void> {
  try {
    const incoming = parseDoc(await projectStore().read(key));
    if (!isDirty()) {
      const ids = new Set(incoming.scene.map((n) => n.id));
      resetHistory();
      set({ doc: incoming, saved: { scene: incoming.scene, name: incoming.name }, selection: state.selection.filter((id) => ids.has(id)), editing: null, mating: null, placing: null });
      return;
    }
    // Edits since the last save are merged onto what came in; the next save writes the result.
    const base = state.saved ? { ...state.doc, scene: state.saved.scene, name: state.saved.name } : null;
    const { doc } = mergeDocs(base, state.doc, incoming);
    set({ doc: { ...doc, revision: incoming.revision }, saved: { scene: incoming.scene, name: incoming.name } });
  } catch (e) {
    fail(e);
  }
}

/** Links a Google account, after saying what that means. */
export async function linkGoogleDrive(): Promise<void> {
  const go = await platform.confirm(
    `${APP_NAME} will keep a copy of your projects in a "BashCAD" folder in your Google Drive and keep them in step with your other devices. It can see only the files it put there itself: a project file dropped into that folder by hand will not show up here. Sign in with Google now?`,
    { title: 'Link Google Drive', okLabel: 'Sign in', cancelLabel: 'Not now' },
  );
  if (!go) return;
  try {
    await linkAccount();
    notify('Google Drive linked.', 'ok');
  } catch (e) {
    fail(e);
  }
}

export async function unlinkGoogleDrive(): Promise<void> {
  const go = await platform.confirm('Unlink Google Drive? Your projects stay here and in your Drive, but changes no longer sync.', { title: APP_NAME, okLabel: 'Unlink', cancelLabel: 'Keep linked' });
  if (!go) return;
  try {
    await unlinkAccount();
    notify('Google Drive unlinked.', 'ok');
  } catch (e) {
    fail(e);
  }
}

/**
 * Desktop: keeps projects in another folder from now on, moving the existing
 * ones there if the user wants. `dir` null asks for the folder.
 */
export async function chooseProjectsFolder(dir: string | null = null): Promise<void> {
  const storage = state.storage;
  if (!storage || storage.fixed || !storage.location) return;
  try {
    const picked = dir ?? (await platform.pickFolder(storage.location));
    if (!picked || picked === storage.location) return;
    if (!(await leaveProject())) return;
    const old = projectStore();
    const items = await old.list();
    const fresh = new DiskProjects(picked);
    let move = false;
    if (items.length) {
      const count = `${items.length} project${items.length === 1 ? '' : 's'}`;
      move = await platform.confirm(`Move your ${count} to the new folder? Otherwise they stay where they are and only new projects go there.`, {
        title: APP_NAME,
        okLabel: 'Move them',
        cancelLabel: 'Leave them',
      });
    }
    let openKey = state.projectKey;
    if (move) {
      for (const item of items) {
        const text = await old.read(item.key);
        const key = await fresh.write(null, item.name, text);
        await old.remove(item.key);
        if (item.key === state.projectKey) openKey = key;
      }
    }
    useProjectStore(fresh);
    setPrefs({ projectsDir: picked === storage.defaultDir ? null : picked });
    set({ storage: { ...storage, location: picked }, projectKey: openKey });
    setPrefs({ lastProject: openKey });
  } catch (e) {
    fail(e);
  }
}

/** The default color of an imported object that brought none. */
const IMPORT_COLOR = '#8fa3bf';

/**
 * Turn imported files into objects standing on the plate, side by side. A
 * file of several parts (the objects of a 3MF, the materials of an OBJ or
 * GLB) becomes one group, its parts where the file put them, each in its own
 * color. Returns the names of the companion files the models used up.
 */
/**
 * The files a model names (an OBJ's material library, its pictures) that were
 * not picked with it. Beside a file on disk they are read from there; on
 * Android or in the browser, where the picker grants one file at a time, the
 * user is asked to pick them. Two rounds at most: the library, then what it names.
 */
async function withCompanions(file: PickedFile, companions: PickedFile[]): Promise<PickedFile[]> {
  if (fileKind(file.name, file.bytes) !== 'obj') return companions;
  let found = companions;
  for (let round = 0; round < 2; round++) {
    let missing: string[];
    try {
      const data = importFile(file.name, file.bytes, found);
      missing = data.kind === 'model' ? (data.missing ?? []) : [];
    } catch {
      return found;
    }
    if (missing.length === 0) return found;
    const more: PickedFile[] = [];
    // Beside the file on disk, where the file's place is known (a path; on Android, a document of the
    // app's own, such as its exports, which the app may read by path).
    const real = file.path ? await platform.realPath(file.path) : null;
    if (real) {
      const dir = real.slice(0, Math.max(real.lastIndexOf('/'), real.lastIndexOf('\\')) + 1);
      for (const name of missing) {
        const read = await platform.readPath(dir + name).catch(() => null);
        if (read) more.push(read);
      }
    }
    if (more.length === 0 && (!file.path || file.path.includes('://'))) {
      const list = missing.map((n) => `"${n}"`).join(', ');
      const ok = await platform.confirm(`"${file.name}" names ${list} for its colors${missing.some((n) => extension(n) !== 'mtl') ? ' and pictures' : ''}. Pick ${missing.length === 1 ? 'it' : 'them'} now, or import the shapes without?`, {
        title: 'Import',
        okLabel: 'Pick',
        cancelLabel: 'Without',
      });
      if (!ok) return found;
      const picked = await platform.pickFiles({ filters: [{ name: 'Material libraries and pictures', extensions: ['mtl', ...IMAGE_EXTENSIONS] }], multiple: true });
      more.push(...picked);
    }
    if (more.length === 0) return found;
    found = [...found, ...more];
  }
  return found;
}

async function importModels(files: PickedFile[], companions: PickedFile[]): Promise<Set<string>> {
  const used = new Set<string>();
  const assets = { ...state.doc.assets };
  const placed: SceneNode[] = [];
  let scene = state.doc.scene;
  let x = 0;
  const put = (node: SceneNode) => {
    node.pos = tidyVec([x + node.size[0] / 2, 0, node.size[2] / 2]);
    x += node.size[0] + 5;
    placed.push(node);
    scene = [...scene, node];
  };
  for (const file of files) {
    companions = await withCompanions(file, companions);
    const data = importFile(file.name, file.bytes, companions);
    const name = uniqueName(scene, baseName(file.name));
    const members: ImportNode[] = [];
    if (data.kind === 'model') {
      for (const n of data.used) used.add(n);
      for (const part of data.parts) {
        const { size, center } = centerMesh(part.mesh);
        const asset: Asset = { kind: 'mesh', positions: encodeFloat32(part.mesh.positions), triangles: encodeUint32(part.mesh.triangles) };
        if (part.mesh.uv) asset.uv = encodeFloat32(part.mesh.uv);
        const node = importNode(assets, asset, part.name, tidyVec(size), tidyVec(size), part.color);
        if (!node) continue;
        node.pos = tidyVec(center);
        if (part.image) {
          const key = await addImage({ name: part.image.name, path: null, bytes: part.image.bytes }, part.image.mime);
          assets[key] = state.doc.assets[key];
          node.texture = { asset: key, mode: part.mesh.uv ? 'own' : 'wrap', scale: 50, turn: 0 };
          // A textured part with no color of its own shows its picture's fill, which is what its corner holds.
          if (!part.color) node.color = (await cornerColor(part.image.bytes, part.image.mime)) ?? node.color;
        }
        members.push(node);
      }
    } else {
      for (const part of data.parts) {
        const { size, center } = centerOutline(part);
        // Flat artwork comes in as a plate a few millimeters thick.
        const node = importNode(assets, { kind: 'outline', shapes: part.shapes }, name, tidyVec([size[0], size[1], 1]), tidyVec([size[0], size[1], 3]), part.color);
        if (!node) continue;
        node.pos = tidyVec([center[0], center[1], 1.5]);
        members.push(node);
      }
    }
    if (members.length === 0) throw new Error(`"${file.name}" is flat or empty, so it cannot be made into a solid.`);
    if (members.length === 1) {
      members[0].name = name;
      put(members[0]);
      continue;
    }
    // The assets must be in the design before the kernel can measure the parts.
    state = { ...state, doc: { ...state.doc, assets } };
    const group = await buildGroup(members, false, name).catch(() => null);
    // Parts that cannot be combined (an open mesh among them) stand on their own.
    if (group) put(group);
    else for (const node of members) put(node);
  }
  // Center the row on the plate.
  const shift = (x - 5) / 2;
  for (const n of placed) n.pos = tidyVec([n.pos[0] - shift, n.pos[1], n.pos[2]]);
  state = { ...state, doc: { ...state.doc, assets }, placing: null };
  commit(scene, { selection: placed.map((n) => n.id) });
  return used;
}

/** An imported object over an asset, which is kept in `assets` under a key made from its contents; null if it has no extent. */
function importNode(assets: Record<string, Asset>, asset: Asset, name: string, natural: Vec3, size: Vec3, color: string | undefined): ImportNode | null {
  // Checked as stored: a hair of an extent rounds away to nothing.
  if (!natural.every((v) => v > 0)) return null;
  const text = asset.kind === 'mesh' ? asset.positions + asset.triangles + (asset.uv ?? '') : JSON.stringify(asset);
  const key = `${asset.kind}-${hashString(text)}-${text.length.toString(36)}`;
  assets[key] = asset;
  return {
    id: newId(),
    type: 'import',
    name,
    asset: key,
    natural,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    size,
    hole: false,
    color: color ?? IMPORT_COLOR,
  };
}

/** The color of an image's top-left pixel, as hex; null if it cannot be read or is transparent there. */
async function cornerColor(bytes: Uint8Array, mime: ImageAsset['mime']): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.drawImage(bitmap, 0, 0, 1, 1, 0, 0, 1, 1);
    bitmap.close();
    const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data;
    if (a < 128) return null;
    return `#${[r, gr, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

/** Pixel size of an image file, by decoding it. */
async function imageSize(bytes: Uint8Array, mime: ImageAsset['mime']): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/** Keep a picture file in the design. Returns its key (an identical picture already there is reused). */
async function addImage(file: PickedFile, mime: ImageAsset['mime'] = fileKind(file.name, file.bytes) === 'png' ? 'image/png' : 'image/jpeg'): Promise<string> {
  const data = bytesToBase64(file.bytes);
  const key = `image-${hashString(data)}-${data.length.toString(36)}`;
  if (state.doc.assets[key]) return key;
  const { width, height } = await imageSize(file.bytes, mime);
  const asset: ImageAsset = { kind: 'image', name: file.name, mime, data, width, height };
  state = { ...state, doc: { ...state.doc, assets: { ...state.doc.assets, [key]: asset } } };
  return key;
}

/** A flat picture sheet showing the image, 60 mm across its longer side, not yet placed. */
function makePicture(key: string): PictureNode {
  const image = state.doc.assets[key] as ImageAsset;
  const s = 60 / Math.max(image.width, image.height);
  return {
    id: newId(),
    type: 'picture',
    name: baseName(image.name),
    asset: key,
    mapping: 'flat',
    angle: 120,
    natural: [1, 1, 1],
    pos: [0, 0, -1e6],
    rot: [0, 0, 0],
    size: tidyVec([image.width * s, image.height * s, 1]),
    hole: false,
    color: '#ffffff',
  };
}

/** Start carrying a new picture, to be put down like a shape: the picture file is asked for first. */
export async function startPlacingPicture(): Promise<void> {
  const key = await pickImage();
  if (!key) return;
  abortAlignPreview();
  set({ placing: makePicture(key), selection: [] });
}

/** Add a picture at the middle of the plate straight away (keyboard route, double-click). */
export async function addPicture(): Promise<void> {
  const key = await pickImage();
  if (!key) return;
  const node = makePicture(key);
  node.pos = [0, 0, node.size[2] / 2];
  node.name = uniqueName(state.doc.scene, node.name);
  state = { ...state, placing: null };
  commit([...state.doc.scene, node], { selection: [node.id] });
}

/** Turn picture files into picture sheets lying on the plate, side by side, 60 mm across. */
async function importPictures(files: PickedFile[]): Promise<void> {
  const nodes: PictureNode[] = [];
  let scene = state.doc.scene;
  let x = 0;
  for (const file of files) {
    const node = makePicture(await addImage(file));
    node.name = uniqueName(scene, node.name);
    node.pos = tidyVec([x + node.size[0] / 2, 0, node.size[2] / 2]);
    x += node.size[0] + 5;
    nodes.push(node);
    scene = [...scene, node];
  }
  const shift = (x - 5) / 2;
  for (const n of nodes) n.pos = tidyVec([n.pos[0] - shift, n.pos[1], n.pos[2]]);
  state = { ...state, placing: null };
  commit(scene, { selection: nodes.map((n) => n.id) });
}

/** Pick a picture file for a texture and keep it in the design. Returns its key, or null if canceled. */
export async function pickImage(): Promise<string | null> {
  try {
    const files = await platform.pickFiles({ filters: [{ name: 'Pictures', extensions: IMAGE_EXTENSIONS }] });
    if (!files.length) return null;
    const key = await addImage(files[0]);
    set({});
    return key;
  } catch (e) {
    fail(e);
    return null;
  }
}

const IMPORTABLE = [...IMPORT_EXTENSIONS, ...IMAGE_EXTENSIONS];

/** Files picked or dropped: designs are opened, models, drawings and pictures are imported into the current design. */
export async function receiveFiles(files: PickedFile[]): Promise<void> {
  try {
    const design = files.find((f) => extension(f.name) === FILE_EXTENSION);
    if (design) return await importProjectFile(design);
    const models = files.filter((f) => IMPORT_EXTENSIONS.includes(fileKind(f.name, f.bytes)));
    const pictures = files.filter((f) => IMAGE_EXTENSIONS.includes(fileKind(f.name, f.bytes)));
    if (models.length === 0 && pictures.length === 0) {
      if (files.some((f) => extension(f.name) === 'mtl')) notify('A .mtl file holds the colors of an OBJ and is read with it: pick the .obj, together with the .mtl for its colors.', 'error');
      else if (files.length) notify(`Cannot import that. Supported: ${IMPORTABLE.map((e) => e.toUpperCase()).join(', ')}.`, 'error');
      return;
    }
    set({ busy: 'Importing…' });
    // Let the "Importing…" badge paint before the parser blocks the thread.
    await new Promise((r) => setTimeout(r, 30));
    // A picture a model used for its texture is not also a picture sheet.
    const used = models.length ? await importModels(models, files) : new Set<string>();
    const sheets = pictures.filter((f) => !used.has(f.name));
    if (sheets.length) await importPictures(sheets);
  } catch (e) {
    fail(e);
  } finally {
    set({ busy: null });
  }
}

export async function importModel(): Promise<void> {
  try {
    const files = await platform.pickFiles({
      filters: [{ name: 'Models, drawings and pictures', extensions: IMPORTABLE }],
      multiple: true,
    });
    if (files.length) await receiveFiles(files);
  } catch (e) {
    fail(e);
  }
}

/** Write the design (or just the selection) in an exchange format. Returns where it went, with a way to share it where there is one, or null if canceled. */
export async function exportDesign(formatId: FormatId, selectionOnly: boolean): Promise<{ where: string; share?: Notice['action'] } | null> {
  const format = FORMATS.find((f) => f.id === formatId)!;
  const nodes = selectionOnly ? selectedNodes() : state.doc.scene;
  const name = state.doc.name;
  const filters = [{ name: format.label, extensions: [format.extension] }];
  let bytes: Uint8Array;
  let warnings: string[] = [];
  if (format.id === 'obj') {
    // The colors live in a material library beside the file, named after it: so the place is chosen
    // first, and the files written for the name they were given there.
    const worker = await geometry.prepare(nodes, state.doc.assets);
    const result = await worker.exportColored(nodes, true);
    // The two go into a folder of their own, so they are not parted.
    const where = await platform.saveBundle(`${name}.obj`, filters, format.mime, (base) => {
      const written = writeObj(result.objects, base);
      const files = [{ name: `${base}.obj`, bytes: written.obj, mime: format.mime }];
      if (written.mtl) files.push({ name: written.mtlName, bytes: written.mtl, mime: 'text/plain' });
      return files;
    });
    if (!where) return null;
    for (const w of result.warnings) notify(w, 'error');
    return { where: where.where, share: shareAction(where.uris, '*/*') };
  }
  if (format.id === 'glb') {
    bytes = await exportGlb(nodes, state.doc.assets, name);
  } else if (format.id === '3mf') {
    // Objects stay apart, each in its colors, so a slicer can print them in their materials.
    const worker = await geometry.prepare(nodes, state.doc.assets);
    const result = await worker.exportColored(nodes, true);
    bytes = write3mf(result.objects, name);
    warnings = result.warnings;
  } else {
    const worker = await geometry.prepare(nodes, state.doc.assets);
    // Exports are always made at fine detail: curves get more facets than are drawn on screen.
    const result = await worker.export(nodes, format.kind === '2d', true);
    bytes = format.id === 'svg' || format.id === 'dxf' ? exportOutline(format.id, result.outline ?? [], name) : exportMesh(format.id, result.mesh, name);
    warnings = result.warnings;
  }
  const where = await platform.saveAs(`${name}.${format.extension}`, filters, bytes, format.mime);
  if (!where) return null;
  for (const w of warnings) notify(w, 'error');
  return { where: where.path ?? where.name, share: shareAction(where.uri ? [where.uri] : [], format.mime) };
}

// --- start-up -------------------------------------------------------------------

/** Opens the project store, then the file the app was started with, or else the project that was open last. */
export async function restoreSession(): Promise<void> {
  try {
    const { fixed, defaultDir } = await openProjectStore(state.prefs.projectsDir);
    set({ storage: { location: projectStore().location, fixed, defaultDir } });
    // Edits made before the store was ready are written now.
    if (isDirty()) scheduleAutosave();
    initSync({ device: state.prefs.device, flush: () => saveProject(true), changed: (report) => void applySyncReport(report), notice: (text) => notify(text, 'error') });
    const path = await platform.startupFile();
    if (path) return void (await importProjectFile(await platform.readPath(path)));
    const last = state.prefs.lastProject;
    if (!last || isDirty()) return;
    try {
      adopt(parseDoc(await projectStore().read(last)), last);
    } catch {
      // Deleted or moved since: start fresh.
      setPrefs({ lastProject: null });
    }
  } catch (e) {
    fail(e);
  }
}
