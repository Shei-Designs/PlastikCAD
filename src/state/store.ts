// The editor: one design, what is selected in it, and every action that can
// be taken on it. Kept outside React so that the viewer, keyboard shortcuts
// and menus all drive the same functions.
import { clampAngle, curvedSize } from '../text/curve';
import type { TextCurve } from '../text/curve';
import { useSyncExternalStore } from 'react';
import { APP_NAME, FILE_EXTENSION, isDesignName } from '../app';
import { clampParams } from '../geometry/shapes';
import { encodeFloat32, encodeUint32 } from '../io/base64';
import { exportMesh, exportOutline, FORMATS } from '../io/export';
import { writeObj } from '../io/obj';
import { zipSync } from 'fflate';
import { write3mf } from '../io/threemf';
import type { FormatId } from '../io/export';
import { centerMesh, centerOutline, fileKind, IMAGE_EXTENSIONS, IMPORT_EXTENSIONS, importFile } from '../io/import';
import { meshPath, parseUrdf, urdfMeshFiles } from '../io/importUrdf';
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
import { ALIGN_MODES, alignAt, alignDot } from '../model/ops';
import type { AlignMode, ArraySpec, GridArray, GroupOver, Layer, RingArray } from '../model/ops';
import type { Asset, Doc, GroupNode, ImageAsset, ImportNode, PartNode, PartParamValue, PictureNode, Scene, SceneNode, ShapeKind, TextNode, Texture, Vec2, Vec3 } from '../model/types';
import { GENERATORS, getGenerator } from '../parts/generators';
import { sanitizeParams } from '../parts/generators/types';
import { mateOf } from '../parts/mates';
import type { MateRequest } from '../parts/mates';
import * as platform from '../platform';
import { askName, tell } from '../ui/ask';
import type { PickedFile } from '../platform';
import { DEFAULT_FONT, loadFont, outlineOf } from '../text/fonts';
import { geometry } from './geometry';
import { loadPrefs, savePrefs } from './persist';
import type { Prefs } from './persist';
import { DiskProjects, fileNameFor, hasProjectStore, openProjectStore, partStore, projectStore, useProjectStore } from './projects';
import type { ProjectInfo } from './projects';
import { initSync, linkAccount, requestSync, unlinkAccount } from '../sync/sync';
import type { SyncReport } from '../sync/engine';
import { mergeDocs } from '../sync/merge';
import { checkRobot } from '../robot/check';
import { buildIsaacStage, buildMjcfModel, buildRobotPackage, buildSdfModel, exportSummary, EXPORT_FORMATS, packageName } from '../robot/export';
import type { ExportFormat } from '../robot/export';
import { fitFollowers, solvePose } from '../robot/kinematics';
import type { Solved } from '../robot/kinematics';
import { jointInChild, jointInDesign as jointInDesignOf, linkNodes, linkOf, meetingPoint, pruned, robotOf, sensorInDesign, sensorInLink, spanningTree } from '../robot/model';
import { snapPointsOf } from '../robot/snaps';
import { FEATURE_KINDS } from '../geometry/features';
import type { Feature, FeatureKind } from '../geometry/features';
import type { SnapPoint } from '../viewer/Viewer';
import { jointFit } from '../robot/defaults';
import { motorFigures, motorForPart, motorOf } from '../robot/motors';
import { massOf } from '../robot/inertia';
import { DRIVE_KINDS, defaultJoint, defaultSensor, SENSOR_KINDS } from '../robot/types';
import type { DriveKind, DriveRole, Robot, RobotJoint, RobotLink, RobotSensor, SensorKind, World } from '../robot/types';
import { massProps } from './massProps';

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
  saved: { scene: Scene; name: string; robot?: Robot } | null;
  /** A write to the project store is under way. */
  saving: boolean;
  /** The projects browser is open. */
  browsing: boolean;
  /** Where projects are kept, once start-up has looked: the folder (null in a browser) and whether another can be chosen. */
  storage: { location: string | null; fixed: boolean; defaultDir: string | null } | null;
  /** New shape following the pointer until it is put down. */
  placing: SceneNode | null;
  /** The custom parts bin is open in the inspector (shown while nothing is selected). */
  bin: boolean;
  /** Counts up whenever the custom parts change, here or by sync, so that the bin lists them again. */
  partsEpoch: number;
  /** Robot mode: the panels show the design as links and joints, and the export makes a robot description. */
  robot: boolean;
  /** The joint picked in Robot mode (nothing else is selected while one is). */
  joint: string | null;
  /** The sensor picked in Robot mode (nothing else is selected while one is). */
  sensor: string | null;
  /** The picked joint or sensor is being placed: the plate offers the snap points of its links. */
  /** Placing the picked joint by a click on a snap point: which of its links shows its points (a sensor's link counts as the child). */
  jointPick: 'child' | 'parent' | null;
  /** The picked joint moved to try the robot: its value, and where every link goes for it (loops solved). */
  pose: { joint: string; value: number; solved: Solved } | null;
  /**
   * The gear a mate is being made for while the wizard is open; the previewed mate carries
   * `id`. `building` while the preview the panel asks for is not in the scene yet.
   */
  mating: { source: string; id: string; building: boolean } | null;
  /**
   * Align mode: anchor dots sit on `bounds`, the box of the anchor object or,
   * without one, of the whole selection. Frozen while a dot is being previewed.
   * `done` has one flag per dot (see `alignDot`): true where every object that
   * could move already sits on that line, so the dot would change nothing.
   * `marker`: the dots place the picked joint or sensor instead, on the box of
   * the anchor object, which a click on any object changes.
   */
  aligning: { anchor: string | null; bounds: Bounds; done: boolean[]; marker?: boolean } | null;
  /** Measure mode: the kinds of feature the pointer takes hold of, and the one or two picked so far. */
  measuring: { kinds: FeatureKind[]; picks: Feature[] } | null;
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
  robot?: Robot;
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
  bin: false,
  partsEpoch: 0,
  robot: false,
  joint: null,
  sensor: null,
  jointPick: null,
  pose: null,
  mating: null,
  aligning: null,
  measuring: null,
  editing: null,
  highlight: null,
  prefs: loadPrefs(),
  notice: null,
  busy: null,
  canUndo: false,
  canRedo: false,
  epoch: 0,
};
state.saved = { scene: state.doc.scene, name: state.doc.name, robot: state.doc.robot };

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
  !s.saved || s.doc.scene !== s.saved.scene || s.doc.name !== s.saved.name || s.doc.robot !== s.saved.robot;

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

/**
 * Word of files written to the app's own folder (Android), in a box that
 * waits: where they are, and Share… to hand them to another app. Elsewhere a
 * toast says where the file went.
 */
/**
 * Says where an export went: a toast, or on Android a box that offers to share
 * it. Files that belong together (`bundle`) are shared as one zip of that name.
 */
export async function reportSaved(names: string[], where: string, uris: string[], mime: string, bundle?: { name: string; files: { name: string; bytes: Uint8Array }[] }): Promise<void> {
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  if (!platform.canShare() || uris.length === 0) return notify(`Saved ${list} to ${where}`, 'ok');
  const chosen = await tell({ title: 'Exported', text: `${list} ${names.length === 1 ? 'is' : 'are'} in ${where}.`, actions: ['Share…', 'Done'] });
  if (chosen !== 'Share…') return;
  if (bundle && bundle.files.length > 1) {
    const zipped = zipSync(Object.fromEntries(bundle.files.map((f) => [f.name, f.bytes])));
    await platform.shareBytes(`${bundle.name}.zip`, zipped, 'application/zip').catch(fail);
  } else {
    await platform.share(uris, mime).catch(fail);
  }
}

/** On Android the name is asked for in the app (the file goes to its own folder); elsewhere the save dialog names the file. Null if backed out. */
async function exportName(suggested: string, extension: string): Promise<string | null> {
  if (!platform.keepsExports()) return suggested;
  return askName({ title: 'Export', label: 'File name', value: suggested, suffix: `.${extension}`, okLabel: 'Export' });
}

export const dismissNotice = (): void => set({ notice: null });

const fail = (e: unknown): void => notify(e instanceof Error ? e.message : String(e), 'error');

export function setPrefs(patch: Partial<Prefs>): void {
  set({ prefs: { ...state.prefs, ...patch } });
}

// --- scene edits and undo -------------------------------------------------

const step = (): Step => ({ scene: state.doc.scene, selection: state.selection, robot: state.doc.robot });

/** Puts the present on the undo stack before a change. Edits with the same `merge` key in quick succession count as one. */
function record(merge?: string): void {
  if (gesture) return;
  const now = Date.now();
  const merged = merge && lastMerge?.key === merge && now - lastMerge.time < MERGE_WINDOW_MS;
  if (!merged) {
    past.push(step());
    if (past.length > UNDO_LIMIT) past.shift();
  }
  future = [];
  lastMerge = merge ? { key: merge, time: now } : null;
}

/**
 * Replace the scene as one undoable step. Edits with the same `merge` key in
 * quick succession (typing in a field, holding an arrow key) count as one.
 */
function commit(scene: Scene, options: { selection?: string[]; merge?: string } = {}): void {
  abortAlignPreview();
  const selection = options.selection ?? state.selection;
  record(options.merge);
  // The robot lets go of objects that are gone, and of a pose, which was for the objects as they were.
  const robot = state.doc.robot && pruned(state.doc.robot, scene);
  set({ doc: robot !== state.doc.robot ? { ...state.doc, scene, robot } : { ...state.doc, scene }, selection, pose: null });
  // The dots follow the objects, and know what is left to line up.
  if (state.aligning) refreshAlignBounds();
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
    set({ doc: { ...state.doc, scene: base.scene, robot: base.robot }, selection: base.selection });
  } else if (base.scene !== state.doc.scene || base.robot !== state.doc.robot) {
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
  set({ doc: { ...state.doc, scene: target.scene, robot: target.robot }, selection: target.selection.filter((id) => ids.has(id)), pose: null });
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
  // The dots of a joint or sensor being lined up go with it (an unchanged empty selection would keep them otherwise).
  if (state.aligning?.marker) stopAligning();
  // Selecting an object takes the right panel from the custom parts bin; any selection, or none, takes it from a joint or sensor.
  set(ids.length ? { selection: ids, bin: false, joint: null, sensor: null, jointPick: null, pose: null } : { selection: ids, joint: null, sensor: null, jointPick: null, pose: null });
}

export function toggleSelected(id: string): void {
  select(state.selection.includes(id) ? state.selection.filter((s) => s !== id) : [...state.selection, id]);
}

export const selectAll = (): void => select(state.doc.scene.filter((n) => !n.hidden && !n.ghost).map((n) => n.id));

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
  set({ placing: node, selection: [], bin: false });
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
    set({ placing: node, selection: [], bin: false });
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
    state = { ...state, placing: null, bin: false };
    commit([...state.doc.scene, node], { selection: [node.id] });
  } catch (e) {
    fail(e);
  }
}

/**
 * Change the words, font, alignment or curve of lettering. Its letters keep
 * their scale: the box grows or shrinks around them. Curved lettering's box is
 * the box round the curve, scaled evenly from the letters' height; its
 * thickness lives in the curve, since the box's depth takes in the sag too.
 * Returns false if the change would leave nothing to draw (the node then stays
 * as it was).
 */
export async function editText(id: string, change: Partial<Pick<TextNode, 'text' | 'font' | 'align'>> & { curve?: TextCurve | null }): Promise<boolean> {
  try {
    const before = state.doc.scene.find((n) => n.id === id);
    if (before?.type !== 'text') return false;
    await loadFont(change.font ?? before.font);
    // Typing is faster than fonts load: work from the node as it is by now.
    const node = state.doc.scene.find((n) => n.id === id);
    if (node?.type !== 'text' || node.locked) return false;
    const { curve: curveChange, ...rest } = change;
    const next = { text: node.text, font: node.font, align: node.align, ...rest };
    const outline = outlineOf(next);
    if (!outline) return false;
    // The letters' scale is what the height axis carries, curved or not; the thickness is the box's depth when straight.
    const scale = node.natural[1] > 0 ? node.size[1] / node.natural[1] : 1;
    const thickness = node.curve ? node.curve.thickness : node.size[2];
    const wanted = curveChange === undefined ? node.curve : curveChange;
    const curve: TextCurve | undefined = wanted ? { ...wanted, angle: clampAngle(wanted.angle), thickness: wanted.thickness > 0 ? wanted.thickness : thickness } : undefined;
    let natural: Vec3;
    let size: Vec3;
    if (curve) {
      natural = curvedSize(curve, outline.size, curve.thickness / scale);
      size = tidyVec([natural[0] * scale, natural[1] * scale, natural[2] * scale]);
    } else {
      natural = [outline.size[0], outline.size[1], 1];
      size = tidyVec([node.curve ? natural[0] * scale : (node.size[0] / node.natural[0]) * natural[0], natural[1] * scale, thickness]);
    }
    const name = node.name === textLabel(node.text) ? textLabel(next.text) : node.name;
    updateNode(id, { ...next, curve, natural, size, name } as Partial<SceneNode>, `text:${id}`);
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

/**
 * Give a part its measured box, keeping whatever scale it had and where it stands.
 * `was` is the node as it is in the scene, whose base is kept: `node` may already carry
 * new settings, and measuring that would read the new mesh at the old placement.
 */
async function sizePart(node: PartNode, was: PartNode = node): Promise<PartNode> {
  const natural = await measurePart(node);
  const size: Vec3 = [0, 1, 2].map((i) => (node.size[i] / node.natural[i]) * natural[i]) as Vec3;
  const next: PartNode = { ...node, natural, size };
  // Parked parts have no base to keep; placed ones stay on whatever they stand on.
  if (node.pos[2] > -1e5) {
    const lift = geometry.bounds(was).min[2] - boxBounds(next).min[2];
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
    set({ placing: node, selection: [], bin: false });
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
    state = { ...state, placing: null, bin: false };
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
    const sized = await sizePart({ ...node, part: def.id, params, name }, node);
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
  // Lifted by the depth of its base below its center: half the box for a shape, less for a part saved turned on its side.
  const lift = node.pos[2] - geometry.bounds(node).min[2];
  const pos: Vec3 = point ? [point[0], point[1], point[2] + lift] : [0, 0, -1e6];
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
  state = { ...state, placing: null, bin: false };
  commit([...state.doc.scene, placed], { selection: [placed.id] });
}

export const cancelPlacing = (): void => {
  if (state.placing) set({ placing: null });
};

/** Add a shape at the middle of the plate straight away (keyboard route, double-click). */
export function addShape(kind: ShapeKind): void {
  const node = makeShape(kind);
  node.name = uniqueName(state.doc.scene, node.name);
  state = { ...state, placing: null, bin: false };
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
  const scene = patch(state.doc.scene, 0);
  if (scene.some((n, i) => n !== state.doc.scene[i])) commit(scene);
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
}

// --- align mode ---------------------------------------------------------------

/** The box the anchor dots sit on (the anchor object's, or the whole selection's) and which dots have nothing left to do. */
function alignState(anchor: string | null): EditorState['aligning'] {
  // A picked joint or sensor lines up with the anchor object's box, one coordinate at a time.
  const origin = state.joint || state.sensor ? markerOriginIn(state.doc) : null;
  if (origin) {
    const target = anchor ? state.doc.scene.find((n) => n.id === anchor) : undefined;
    if (!target) return null;
    const bounds = geometry.bounds(target);
    const done: boolean[] = [];
    for (const axis of [0, 1, 2] as const) for (const mode of ALIGN_MODES) done[alignDot(axis, mode)] = Math.abs(origin[axis] - alignAt(bounds, axis, mode)) < 1e-3; // the origin is kept to 1e-4 mm
    return { anchor, bounds, done, marker: true };
  }
  const nodes = selectedNodes();
  const target = anchor ? nodes.find((n) => n.id === anchor) : null;
  const bounds = target ? geometry.bounds(target) : selectionBounds(nodes);
  if (!bounds) return null;
  // The objects a dot would move: a locked one sits out, and the anchor is what the others come to.
  const movable = nodes.filter((n) => !n.locked && n.id !== anchor).map((n) => geometry.bounds(n));
  const done: boolean[] = [];
  for (const axis of [0, 1, 2] as const) {
    for (const mode of ALIGN_MODES) {
      done[alignDot(axis, mode)] = movable.every((b) => Math.abs(alignAt(b, axis, mode) - alignAt(bounds, axis, mode)) < 1e-6);
    }
  }
  return { anchor, bounds, done };
}

function refreshAlignBounds(): void {
  const aligning = state.aligning;
  if (!aligning) return;
  set({ aligning: alignState(aligning.anchor) });
}

/** Show the anchor dots around the selection (two or more objects), or, for a picked joint or sensor, on the box of the link it belongs to. */
export function startAligning(): void {
  if (state.aligning) return;
  if (state.joint || state.sensor) {
    const aligning = alignState(markerLink());
    if (aligning) set({ aligning, placing: null, measuring: null });
    return;
  }
  if (state.selection.length < 2) return notify('Select two or more objects to line them up.');
  const aligning = alignState(null);
  if (aligning) set({ aligning, placing: null, measuring: null });
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

// --- measuring ----------------------------------------------------------------

/** The kinds last chosen, kept while the app runs so the tool comes back as it was left. */
let measureKinds: FeatureKind[] = FEATURE_KINDS.map((k) => k.id);

/** Measure mode: the pointer takes hold of points, edges, faces and circles, and two picks are measured against each other. */
export function startMeasuring(): void {
  stopAligning();
  set({ measuring: { kinds: measureKinds, picks: [] }, placing: null });
}

export function stopMeasuring(): void {
  if (state.measuring) set({ measuring: null });
}

export const toggleMeasuring = (): void => (state.measuring ? stopMeasuring() : startMeasuring());

export function setMeasureKinds(kinds: FeatureKind[]): void {
  measureKinds = kinds;
  if (state.measuring) set({ measuring: { ...state.measuring, kinds } });
}

/** A feature picked on the plate: the first of a pair, the second, or after a pair a fresh first. */
export function pickMeasure(feature: Feature): void {
  const m = state.measuring;
  if (!m) return;
  set({ measuring: { ...m, picks: m.picks.length >= 2 ? [feature] : [...m.picks, feature] } });
}

export function clearMeasure(): void {
  if (state.measuring?.picks.length) set({ measuring: { ...state.measuring, picks: [] } });
}

/** Make one of the selected objects the one the others line up with; the same one again clears it. */
export function setAlignAnchor(id: string | null): void {
  const aligning = state.aligning;
  if (!aligning) return;
  // A joint or sensor always lines up with some object, so its anchor cannot be cleared, only changed.
  const anchor = id === aligning.anchor && !aligning.marker ? null : id;
  const next = alignState(anchor);
  if (next) set({ aligning: next });
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

/** Where the picked joint or sensor goes when lined up on a dot: that coordinate taken from the anchor's box; from before any preview. */
function markerAligned(axis: 0 | 1 | 2, mode: AlignMode): Vec3 | null {
  const aligning = state.aligning;
  if (!aligning?.marker) return null;
  const origin = markerOriginIn(gesture ? { ...state.doc, robot: gesture.robot } : state.doc);
  return origin && (origin.map((v, i) => (i === axis ? alignAt(aligning.bounds, axis, mode) : v)) as Vec3);
}

/** Hovering a dot moves the objects there for a look; null puts them back. */
export function previewAlign(axis: 0 | 1 | 2 | null, mode: AlignMode = 'center'): void {
  if (!state.aligning) return;
  if (axis === null) return abortAlignPreview();
  if (state.aligning.marker) {
    const origin = markerAligned(axis, mode);
    if (!origin) return;
    // The gesture keeps the placing out of the history; letting go of the preview puts the robot back.
    gesture ??= step();
    alignPreview = true;
    placeMarker(origin);
    return;
  }
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
  if (state.aligning?.marker) {
    const origin = markerAligned(axis, mode);
    abortAlignPreview();
    if (origin) placeMarker(origin);
    return;
  }
  const nodes = aligned(axis, mode);
  if (!nodes) return;
  // From the scene before the hover, as one step of its own.
  abortAlignPreview();
  replaceNodes(nodes);
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

/** Lock or unlock every selected object at once. */
export function setSelectedLocked(locked: boolean): void {
  const ids = new Set(state.selection);
  let touched = false;
  const scene = state.doc.scene.map((n) => {
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
  const node = state.doc.scene.find((n) => n.id === id);
  if (!node) return;
  abortAlignPreview();
  const next = withGhost(node, !node.ghost);
  commit(
    state.doc.scene.map((n) => (n.id === id ? next : n)),
    { selection: state.selection.filter((s) => s !== id || !next.ghost) },
  );
}

/**
 * Fade the selection out of reach: the objects stay in view as faint shadows
 * but no longer take a click or a drag, so that what is around or inside them
 * can be worked on. `unghostAll` brings every ghost back.
 */
export function ghostSelected(): void {
  const ids = new Set(state.selection);
  if (ids.size === 0) return;
  abortAlignPreview();
  commit(
    state.doc.scene.map((n) => (ids.has(n.id) ? withGhost(n, true) : n)),
    { selection: [] },
  );
}

export const hasGhosts = (s: EditorState = state): boolean => s.doc.scene.some((n) => n.ghost);

/** Bring every ghost back within reach. */
export function unghostAll(): void {
  if (!hasGhosts()) return;
  abortAlignPreview();
  commit(state.doc.scene.map((n) => withGhost(n, false)));
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
  state = { ...state, editing: { root: root.id, target, layers, before: state.doc.scene }, highlight: null, aligning: null, measuring: null };
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

/** Picture of the design for the projects browser, or of some of its objects alone, given by the viewer when there is one. */
let thumbSource: ((only?: string[]) => string | null) | null = null;
/** Taking the picture means drawing the scene again, so it is not done on every save. */
const THUMB_EVERY_MS = 10_000;
let thumbTakenAt = 0;
/** The last save kept an older picture (one had just been taken); a fresh one is owed once the pause has passed. */
let thumbStale = false;
let thumbRefresh: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<boolean> | null = null;
let lastSaveError: string | null = null;

export function provideThumbnail(source: ((only?: string[]) => string | null) | null): void {
  thumbSource = source;
}

function thumbFor(doc: Doc, fresh: boolean): string | undefined {
  if (doc.scene.length === 0) return undefined;
  if (!thumbSource) return doc.thumb;
  const now = Date.now();
  if (!fresh && doc.thumb && now - thumbTakenAt < THUMB_EVERY_MS) {
    // Otherwise the last edit of a burst (a color picked right after a shape was placed) would never show.
    thumbStale = true;
    clearTimeout(thumbRefresh);
    thumbRefresh = setTimeout(refreshThumbnail, THUMB_EVERY_MS - (now - thumbTakenAt) + 50);
    return doc.thumb;
  }
  const shot = thumbSource();
  if (!shot) return doc.thumb;
  thumbTakenAt = now;
  thumbStale = false;
  return shot;
}

/** Writes the project again with a fresh picture, when the last save made do with an older one and nothing else is pending. */
function refreshThumbnail(): void {
  if (!thumbStale || writing || isDirty() || !hasProjectStore() || state.projectKey === null || state.doc.scene.length === 0) return;
  writing = write(true).finally(() => {
    writing = null;
  });
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
  // A fresh save is also owed a fresh picture, when the last one made do with an older shot.
  if ((!isDirty() && !(fresh && thumbStale && state.projectKey !== null)) || !worthSaving()) return Promise.resolve(true);
  if (!hasProjectStore()) return Promise.resolve(false);
  writing = write(fresh).finally(() => {
    writing = null;
  });
  return writing;
}

async function write(fresh: boolean): Promise<boolean> {
  // What is being written counts as saved once it is, even if more changed meanwhile.
  const base = { scene: state.doc.scene, name: state.doc.name, robot: state.doc.robot };
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
    saved: { scene: doc.scene, name: doc.name, robot: doc.robot },
    saving: false,
    selection: [],
    placing: null,
    bin: false,
    robot: false,
    joint: null,
    sensor: null,
    jointPick: null,
    pose: null,
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
  await explainCopy(doc.name, file);
  await offerLegacyVersions(text, doc.name);
}

/**
 * Says that the project is a copy of the file, kept with the app's projects,
 * so that edits are not expected to land in the file; and offers to delete the
 * file, which would otherwise go stale beside the living copy.
 */
async function explainCopy(name: string, file: PickedFile): Promise<void> {
  const text = `"${name}" is now a project of its own in ${APP_NAME}. Changes you make are saved with the app's projects, not in the file you opened.`;
  if (!platform.canDelete(file.path)) {
    await tell({ title: 'Project added', text, actions: ['OK'] });
    return;
  }
  const chosen = await tell({ title: 'Project added', text: `${text} The file can stay where it is, or go.`, actions: ['Keep the file', 'Delete the file'] });
  if (chosen !== 'Delete the file') return;
  try {
    await platform.deleteFile(file.path!);
    notify(`Deleted ${file.name}.`, 'ok');
  } catch (e) {
    notify(`${APP_NAME} could not delete ${file.name} from here (${e instanceof Error ? e.message : String(e)}). Remove it in your file manager.`, 'error');
  }
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
    const name = await exportName(fileNameFor(state.doc.name).replace(/\.[^.]+$/, ''), FILE_EXTENSION);
    if (!name) return false;
    const where = await platform.saveAs(`${name}.${FILE_EXTENSION}`, DESIGN_FILTER, bytes, 'application/json');
    if (!where) return false;
    await reportSaved([where.name], where.path ? where.path.slice(0, where.path.length - where.name.length).replace(/[\\/]$/, '') || where.path : 'your downloads', where.uri ? [where.uri] : [], 'application/json');
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
  if (state.bin || state.placing) set({ bin: false, placing: null });
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
  const node = state.doc.scene.find((n) => n.id === id);
  if (!node) return false;
  const chosen = await tell({
    title: 'Save as a part',
    text: `Save "${node.name}" as a custom part? It goes in the library under Custom, on all your devices, to place in any design.`,
    actions: ['Save part', 'Cancel'],
  });
  if (chosen !== 'Save part') return false;
  try {
    const part = partOf(node);
    const assets = Object.fromEntries([...usedAssets([part])].filter((key) => state.doc.assets[key]).map((key) => [key, state.doc.assets[key]]));
    const doc: Doc = {
      id: newId(),
      name: node.name,
      scene: [part],
      assets,
      thumb: thumbSource?.([node.id]) ?? undefined,
      revision: newId(),
      device: state.prefs.device,
      saved: new Date().toISOString(),
    };
    await partStore().write(null, doc.name, serializeDoc(doc));
    set({ partsEpoch: state.partsEpoch + 1 });
    notify(`"${node.name}" is in your custom parts.`, 'ok');
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
  if (!node) throw new Error('This part is empty.');
  const missing = Object.fromEntries(Object.entries(doc.assets).filter(([k]) => !state.doc.assets[k]));
  if (Object.keys(missing).length) state = { ...state, doc: { ...state.doc, assets: { ...state.doc.assets, ...missing } } };
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
    node.name = uniqueName(state.doc.scene, node.name);
    state = { ...state, placing: null, bin: false };
    commit([...state.doc.scene, node], { selection: [node.id] });
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
    await store.write(key, clean, serializeDoc({ ...doc, name: clean, revision: newId(), parent: doc.revision, device: state.prefs.device, saved: new Date().toISOString() }));
    set({ partsEpoch: state.partsEpoch + 1 });
    requestSync();
  } catch (e) {
    fail(e);
  }
}

export async function deletePart(key: string, name: string): Promise<boolean> {
  try {
    const sure = await platform.confirm(`Delete the part "${name}"? Objects already placed from it stay in their designs.`, { title: APP_NAME, okLabel: 'Delete', cancelLabel: 'Keep' });
    if (!sure) return false;
    await partStore().remove(key);
    set({ partsEpoch: state.partsEpoch + 1 });
    requestSync();
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

// --- robot mode ---------------------------------------------------------------

/** The panels turn to links and joints; whatever was being carried or lined up is let go of. */
export function enterRobotMode(): void {
  if (state.mating) cancelMate();
  if (state.aligning) stopAligning();
  cancelPlacing();
  set({ robot: true, joint: null, bin: false, selection: [] });
}

export function leaveRobotMode(): void {
  if (state.aligning) stopAligning();
  set({ robot: false, joint: null, sensor: null, jointPick: null, pose: null });
}
export const toggleRobotMode = (): void => (state.robot ? leaveRobotMode() : enterRobotMode());

export function selectJoint(id: string | null): void {
  if (state.aligning) stopAligning();
  set(id ? { joint: id, sensor: null, selection: [], jointPick: null, pose: null } : { joint: null, jointPick: null, pose: null });
}

export function selectSensor(id: string | null): void {
  if (state.aligning) stopAligning();
  set(id ? { sensor: id, joint: null, selection: [], jointPick: null, pose: null } : { sensor: null, jointPick: null });
}

/** Replaces the robot as one undoable step, like `commit` does the scene. A pose was for the robot as it was. */
function commitRobot(robot: Robot, merge?: string): void {
  record(merge);
  set({ doc: { ...state.doc, robot }, pose: null });
  // The dots know what is left to line up; not while one is only being looked at.
  if (state.aligning && !alignPreview) refreshAlignBounds();
}

/**
 * The picked joint or sensor is placed by a click on one of these: the
 * corners, edge middles, face centers and axis ends of the joint's two links,
 * or of the sensor's one.
 */
export function jointSnaps(s: EditorState = state): SnapPoint[] {
  if (!s.jointPick) return [];
  if (s.sensor) {
    const sensor = s.doc.robot?.sensors.find((x) => x.id === s.sensor);
    const link = sensor && s.doc.scene.find((n) => n.id === sensor.link);
    return link ? snapPointsOf(link) : [];
  }
  const joint = s.joint ? s.doc.robot?.joints.find((j) => j.id === s.joint) : undefined;
  if (!joint) return [];
  const link = s.doc.scene.find((n) => n.id === (s.jointPick === 'parent' ? joint.parent : joint.child));
  return link ? snapPointsOf(link) : [];
}

/** Shows the snap points of one of the picked joint's links (or the picked sensor's link) to click on. */
export const startJointPick = (side: 'child' | 'parent' = 'child'): void => set({ jointPick: state.joint || state.sensor ? side : null, pose: null });
export const stopJointPick = (): void => set({ jointPick: null });

/** Puts the picked joint (or sensor) on a snap point; a point that carries an axis (the end of a cylinder) gives a joint that axis too. */
export function pickJointSnap(point: SnapPoint): void {
  if (state.sensor) {
    const sensor = robotOf(state.doc).sensors.find((x) => x.id === state.sensor);
    const link = sensor && state.doc.scene.find((n) => n.id === sensor.link);
    if (sensor && link) placeSensor(sensor.id, point.at, sensorInDesign(sensor, link).matrix);
    set({ jointPick: null });
    return;
  }
  const joint = state.joint && robotOf(state.doc).joints.find((j) => j.id === state.joint);
  const child = joint && state.doc.scene.find((n) => n.id === joint.child);
  if (!joint || !child) return;
  const placed = jointInDesignOf(joint, child);
  placeJoint(joint.id, point.at, point.axis ?? placed.axis);
  set({ jointPick: null });
}

// --- sensors, drive and control ---------------------------------------------------

const sensorName = (robot: Robot, base: string): string => {
  let name = base;
  for (let n = 2; robot.sensors.some((x) => x.name === name); n++) name = `${base}_${n}`;
  return name;
};

/** Fixes a sensor to a link at the link's center, looking along the design's +X, and picks it. */
export function addSensor(link: string, kind: SensorKind): string | null {
  const node = state.doc.scene.find((n) => n.id === link);
  if (!node) return null;
  const id = newId();
  const base = SENSOR_KINDS.find((k) => k.id === kind)?.name.toLowerCase().replace(/\s+/g, '_') ?? kind;
  // A touch sensor starts at the link's lowest point, where a foot meets the floor; the others at its middle.
  const bounds = geometry.bounds(node);
  const at: Vec3 = kind === 'touch' ? [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, bounds.min[2]] : node.pos;
  const local = sensorInLink(at, [0, 0, 0], node);
  editRobot((r) => ({ ...r, sensors: [...r.sensors, { ...defaultSensor(id, sensorName(r, base), kind, link, tidyVec(local.origin)), rot: tidyVec(local.rot) }] }));
  selectSensor(id);
  return id;
}

export function updateSensor(id: string, patch: Partial<Omit<RobotSensor, 'id'>>, merge?: string): void {
  editRobot((r) => ({ ...r, sensors: r.sensors.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), merge);
}

/** Puts the sensor at a place in the design, turned as `matrix` says there (it is kept in its link's frame). */
export function placeSensor(id: string, origin: Vec3, matrix: Mat, merge?: string): void {
  const sensor = robotOf(state.doc).sensors.find((x) => x.id === id);
  const link = sensor && state.doc.scene.find((n) => n.id === sensor.link);
  if (!sensor || !link) return;
  const local = sensorInLink(origin, eulerOf(matrix), link);
  updateSensor(id, { origin: tidyVec(local.origin), rot: tidyVec(local.rot) }, merge);
}

export function deleteSensor(id: string): void {
  editRobot((r) => ({ ...r, sensors: r.sensors.filter((x) => x.id !== id) }));
  if (state.sensor === id) set({ sensor: null });
}

/** Sets which wheel joints the differential drive turns on each side; nothing on either side removes the drive. */
/** Picks how the robot drives, or none; the roles that fit the new kind are kept. */
export function setDriveKind(kind: DriveKind | null): void {
  editRobot((r) => {
    const { drive: old, ...rest } = r;
    const def = DRIVE_KINDS.find((k) => k.id === kind);
    if (!def) return rest;
    const roles = Object.fromEntries(Object.entries(old?.roles ?? {}).filter(([, role]) => def.roles.some((x) => x.id === role)));
    return { ...rest, drive: { kind: def.id, roles } };
  });
}

/** Gives a joint its part in the drive, or none. */
export function setDriveRole(joint: string, role: DriveRole | null): void {
  editRobot((r) => {
    if (!r.drive) return r;
    const { [joint]: _old, ...roles } = r.drive.roles;
    return { ...r, drive: { ...r.drive, roles: role ? { ...roles, [joint]: role } : roles } };
  });
}

export const setControl = (control: boolean): void => editRobot((r) => ({ ...r, control }));
export const setWorld = (world: World): void => editRobot((r) => ({ ...r, world }));
export const setScripts = (scripts: boolean): void => editRobot((r) => ({ ...r, scripts }));

/**
 * Moves the picked joint to `value` for a look, every other free joint going
 * where the loops close; null puts the robot back. The design is not touched.
 */
export function setPose(value: number | null): void {
  const joint = state.joint;
  if (value === null || !joint) return void set({ pose: null });
  const start = state.pose?.joint === joint ? state.pose.solved.values : undefined;
  const solved = solvePose(robotOf(state.doc), state.doc.scene, new Map([[joint, value]]), start);
  set({ pose: { joint, value, solved } });
}

/**
 * Finds how the passive joints of a linkage follow the picked one, by
 * sweeping it over its range with the loops closed, and writes that as each
 * one's mimic: exact for a parallelogram, a fit with a reported error else.
 */
export function fitJointFollowers(id: string): void {
  const robot = robotOf(state.doc);
  const fits = fitFollowers(robot, state.doc.scene, id);
  const fitted = [...fits].filter(([, fit]) => fit.closed);
  if (fitted.length === 0) {
    notify(fits.size ? 'The linkage does not close over the whole range of this joint; narrow its limits and try again.' : 'No other joint moves with this one.', 'error');
    return;
  }
  editRobot((r) => ({ ...r, joints: r.joints.map((j) => (fits.has(j.id) && fits.get(j.id)!.closed ? { ...j, mimic: { joint: id, multiplier: fits.get(j.id)!.multiplier, offset: fits.get(j.id)!.offset } } : j)) }));
  const worst = Math.max(...fitted.map(([, fit]) => fit.error));
  const names = fitted.map(([jid]) => robot.joints.find((j) => j.id === jid)?.name ?? jid).join(', ');
  notify(worst < 0.05 ? `${names} now follow${fitted.length === 1 ? 's' : ''} this joint exactly.` : `${names} now follow${fitted.length === 1 ? 's' : ''} this joint, off by up to ${worst.toFixed(1)} over the range (a line cannot do better).`, 'ok');
}

const editRobot = (change: (robot: Robot) => Robot, merge?: string): void => commitRobot(change(robotOf(state.doc)), merge);

export function setRobotRoot(node: string | null): void {
  editRobot((r) => ({ ...r, root: node }));
}

export function updateLink(node: string, patch: Partial<Omit<RobotLink, 'node'>>, merge?: string): void {
  editRobot((r) => ({ ...r, links: [...r.links.filter((l) => l.node !== node), { ...linkOf(r, node), ...patch }] }), merge);
}

const jointName = (robot: Robot, base: string): string => {
  let name = base;
  for (let n = 2; robot.joints.some((j) => j.name === name); n++) name = `${base} ${n}`;
  return name;
};

/**
 * Hangs `child` from `parent` by a new joint, and picks it. The joint starts
 * where the two meet (the middle of where their boxes overlap, or of the gap
 * between them: a wheel's hub on its axle, the end of an arm segment against
 * the last), with its axis along the child's Z.
 */
export function addJoint(parent: string, child: string): string | null {
  const childNode = state.doc.scene.find((n) => n.id === child);
  const parentNode = state.doc.scene.find((n) => n.id === parent);
  if (!childNode || !parentNode || parent === child) return null;
  const origin = jointInChild(meetingPoint(geometry.bounds(parentNode), geometry.bounds(childNode)), [0, 0, 1], childNode).origin;
  const id = newId();
  // A mount from the parts library on either side says which motor turns the joint.
  const motor = motorForPart(parentNode) ?? motorForPart(childNode);
  editRobot((r) => {
    const made = defaultJoint(id, jointName(r, `${childNode.name} joint`), parent, child, tidyVec(origin));
    return { ...r, root: r.root ?? parent, joints: [...r.joints, { ...made, ...jointFit(r, linkNodes(state.doc.scene), made, (n) => weighed(r, n)), ...(motor ? motorFigures(motor) : {}) }] };
  });
  selectJoint(id);
  return id;
}

/** The link's mass in grams as the kernel has weighed it, or null before it has. */
function weighed(robot: Robot, node: SceneNode): number | null {
  const p = massProps.known([node]).get(node.id);
  return p ? massOf(linkOf(robot, node.id).mass, p) : null;
}

export const setBase = (base: Robot['base']): void => editRobot((r) => ({ ...r, base }));

export function updateJoint(id: string, patch: Partial<Omit<RobotJoint, 'id'>>, merge?: string): void {
  // An effort, speed or damping typed by hand makes the motor custom again.
  const typed = ('effort' in patch || 'velocity' in patch || 'damping' in patch) && !('motor' in patch) ? { ...patch, motor: undefined } : patch;
  editRobot((r) => ({ ...r, joints: r.joints.map((j) => (j.id === id ? { ...j, ...typed } : j)) }), merge);
}

/** Gives the joint a motor from the table, and its figures. */
export function setJointMotor(id: string, motor: string): void {
  const m = motorOf(motor);
  if (m) updateJoint(id, motorFigures(m));
}

/** Puts the joint at a place and direction given in the design's coordinates (it is kept in the child's). */
export function placeJoint(id: string, origin: Vec3, axis: Vec3, merge?: string): void {
  const joint = robotOf(state.doc).joints.find((j) => j.id === id);
  const child = joint && state.doc.scene.find((n) => n.id === joint.child);
  if (!joint || !child) return;
  const local = jointInChild(origin, axis, child);
  updateJoint(id, { origin: tidyVec(local.origin), axis: tidyVec(local.axis) }, merge);
}

/** Where the picked joint or sensor sits in the design (mm), as `doc` has it; null when none is picked or its link is gone. */
function markerOriginIn(doc: Doc): Vec3 | null {
  const robot = robotOf(doc);
  if (state.sensor) {
    const sensor = robot.sensors.find((x) => x.id === state.sensor);
    const link = sensor && doc.scene.find((n) => n.id === sensor.link);
    return sensor && link ? sensorInDesign(sensor, link).origin : null;
  }
  const joint = state.joint ? robot.joints.find((j) => j.id === state.joint) : undefined;
  const child = joint && doc.scene.find((n) => n.id === joint.child);
  return joint && child ? jointInDesignOf(joint, child).origin : null;
}

/** The link the picked sensor sits on, or the one the picked joint hangs from. */
function markerLink(): string | null {
  const robot = robotOf(state.doc);
  if (state.sensor) return robot.sensors.find((x) => x.id === state.sensor)?.link ?? null;
  return robot.joints.find((j) => j.id === state.joint)?.parent ?? null;
}

/** Puts the picked joint or sensor at `origin` (design mm), keeping the way it is turned or its axis. */
function placeMarker(origin: Vec3, merge?: string): void {
  if (state.sensor) {
    const sensor = robotOf(state.doc).sensors.find((x) => x.id === state.sensor);
    const link = sensor && state.doc.scene.find((n) => n.id === sensor.link);
    if (sensor && link) placeSensor(sensor.id, origin, sensorInDesign(sensor, link).matrix, merge);
    return;
  }
  const joint = state.joint && robotOf(state.doc).joints.find((j) => j.id === state.joint);
  const child = joint && state.doc.scene.find((n) => n.id === joint.child);
  if (joint && child) placeJoint(joint.id, origin, jointInDesignOf(joint, child).axis, merge);
}

/** Moves the picked joint or sensor to `origin` (design mm) as a drag goes on; the steps of one drag undo together, and a drag that goes nowhere records nothing. */
export function dragMarker(origin: Vec3): void {
  const at = markerOriginIn(state.doc);
  if (at && at.some((v, i) => Math.abs(v - origin[i]) >= 1e-6)) placeMarker(origin, 'marker-drag');
}

/** The drag is over: the next one is an undo step of its own. */
export function endMarkerDrag(): void {
  lastMerge = null;
}

/** Hangs every link no chain of joints reaches from the base by a fixed joint to the base, where the two meet. One undo step. */
export function fixLooseLinks(): void {
  const robot = robotOf(state.doc);
  const nodes = linkNodes(state.doc.scene);
  const base = robot.root ? nodes.find((n) => n.id === robot.root) : undefined;
  if (!base) return;
  const { unreached } = spanningTree(robot, nodes.map((n) => n.id));
  const joints: RobotJoint[] = [];
  for (const id of unreached) {
    const child = nodes.find((n) => n.id === id);
    if (!child) continue;
    const meet = meetingPoint(geometry.bounds(base), geometry.bounds(child));
    const name = jointName({ ...robot, joints: [...robot.joints, ...joints] }, `${child.name} joint`);
    const made = { ...defaultJoint(newId(), name, base.id, id, tidyVec(jointInChild(meet, [0, 0, 1], child).origin)), type: 'fixed' as const };
    joints.push({ ...made, ...jointFit({ ...robot, joints: [...robot.joints, ...joints] }, nodes, made, (n) => weighed(robot, n)) });
  }
  if (joints.length === 0) return;
  editRobot((r) => ({ ...r, joints: [...r.joints, ...joints] }));
}

export function deleteJoint(id: string): void {
  editRobot((r) => ({
    ...r,
    joints: r.joints.filter((j) => j.id !== id).map((j) => (j.mimic?.joint === id ? (({ mimic: _m, ...rest }) => rest)(j) : j)),
  }));
  if (state.joint === id) set({ joint: null });
}

/**
 * Writes the robot as a ROS 2 package in a zip: URDF, meshes and launch files.
 * Stopped by any error the checks find; the overview lists them. False if
 * nothing was written.
 */
export async function exportRobot(format: ExportFormat = state.prefs.robotFormat): Promise<boolean> {
  const doc = state.doc;
  const robot = robotOf(doc);
  const nodes = linkNodes(doc.scene);
  const stop = async (problems: ReturnType<typeof checkRobot>): Promise<boolean> => {
    const errors = problems.filter((p) => p.level === 'error');
    if (errors.length === 0) return false;
    set({ selection: [], joint: null, sensor: null });
    await tell({ title: 'Robot', text: `${errors.length === 1 ? 'One problem stops' : `${errors.length} problems stop`} the export. ${errors[0].text}`, actions: ['OK'] });
    return true;
  };
  const problems = checkRobot(doc, massProps.known(nodes), robot);
  if (await stop(problems)) return false;
  // What goes out and what the checks warn of, before anything is written. Ignored objects are said in the sentence, not listed.
  const unreached = new Set(spanningTree(robot, nodes.map((n) => n.id)).unreached);
  const lines = problems.filter((p) => !(p.link && unreached.has(p.link))).map((p) => p.text);
  const label = EXPORT_FORMATS.find((f) => f.id === format)!.label;
  set({ selection: [], joint: null, sensor: null });
  if ((await tell({ title: `Export ${label}`, text: exportSummary(doc, format, robot), lines, actions: ['Export', 'Cancel'] })) !== 'Export') return false;
  const name = await exportName(packageName(doc.name), 'zip');
  if (!name) return false;
  set({ busy: 'Exporting the robot…' });
  try {
    const worker = await geometry.prepare(nodes, doc.assets);
    const collisions = Object.fromEntries(nodes.map((n) => [n.id, linkOf(robot, n.id).collision]));
    const geo = await worker.robotGeometry(nodes, collisions, true);
    // Checked again with every link weighed, in case some had not been when the first check ran.
    if (await stop(checkRobot(doc, new Map(geo.map((g) => [g.id, g.props])), robot))) return false;
    const build = format === 'sdf' ? buildSdfModel : format === 'mjcf' ? buildMjcfModel : format === 'usd' ? buildIsaacStage : buildRobotPackage;
    const pkg = build(doc, new Map(geo.map((g) => [g.id, g])), robot);
    for (const w of pkg.warnings.filter((text) => text.includes('left out'))) notify(w, 'error');
    const bytes = zipSync(Object.fromEntries(pkg.files.map((f) => [`${pkg.name}/${f.name}`, f.bytes])), { level: 6 });
    const where = await platform.saveAs(`${name}.zip`, [{ name: 'Zip archive', extensions: ['zip'] }], bytes, 'application/zip');
    if (!where) return false;
    await reportSaved([where.name], where.path ? where.path.slice(0, where.path.length - where.name.length).replace(/[\\/]$/, '') || where.path : 'your downloads', where.uri ? [where.uri] : [], 'application/zip');
    return true;
  } catch (e) {
    fail(e);
    return false;
  } finally {
    set({ busy: null });
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

/** A sync pass changed the custom parts: the bin lists them again. */
function applyPartsSyncReport(report: SyncReport): void {
  set({ partsEpoch: state.partsEpoch + 1 });
  for (const name of report.kept) notify(`The part "${name}" was changed on two devices at once; both versions were kept.`);
}

/** The open project changed on disk under the editor: taken in whole, or merged with edits not yet saved. */
async function reloadOpenProject(key: string): Promise<void> {
  try {
    const incoming = parseDoc(await projectStore().read(key));
    if (!isDirty()) {
      const ids = new Set(incoming.scene.map((n) => n.id));
      resetHistory();
      set({ doc: incoming, saved: { scene: incoming.scene, name: incoming.name, robot: incoming.robot }, selection: state.selection.filter((id) => ids.has(id)), editing: null, mating: null, placing: null });
      return;
    }
    // Edits since the last save are merged onto what came in; the next save writes the result.
    const base = state.saved ? { ...state.doc, scene: state.saved.scene, name: state.saved.name } : null;
    const { doc } = mergeDocs(base, state.doc, incoming);
    set({ doc: { ...doc, revision: incoming.revision }, saved: { scene: incoming.scene, name: incoming.name, robot: incoming.robot } });
  } catch (e) {
    fail(e);
  }
}

/** Links a Google account, after saying what that means. */
export async function linkGoogleDrive(): Promise<void> {
  const go = await platform.confirm(
    `${APP_NAME} will keep a copy of your projects in a "${APP_NAME}" folder in your Google Drive and keep them in step with your other devices. It can see only the files it put there itself: a project file dropped into that folder by hand will not show up here. Sign in with Google now?`,
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
    const oldParts = partStore();
    const parts = move ? await oldParts.list() : [];
    if (move) {
      for (const item of items) {
        const text = await old.read(item.key);
        const key = await fresh.write(null, item.name, text);
        await old.remove(item.key);
        if (item.key === state.projectKey) openKey = key;
      }
    }
    useProjectStore(fresh);
    // The custom parts go with their projects.
    for (const item of parts) {
      await partStore().write(null, item.name, await oldParts.read(item.key));
      await oldParts.remove(item.key);
    }
    if (parts.length) set({ partsEpoch: state.partsEpoch + 1 });
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
        // A library the file names, or failing that one named after the file, as the exporters write them.
        const candidates = extension(name) === 'mtl' ? [name, `${baseName(file.name)}.mtl`] : [name];
        for (const candidate of new Set(candidates)) {
          const read = await platform.readPath(dir + candidate).catch(() => null);
          if (read) {
            // Under the name the file asked for, so the import finds it.
            more.push(candidate === name ? read : { ...read, name });
            break;
          }
        }
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
  set({ placing: makePicture(key), selection: [], bin: false });
}

/** Add a picture at the middle of the plate straight away (keyboard route, double-click). */
export async function addPicture(): Promise<void> {
  const key = await pickImage();
  if (!key) return;
  const node = makePicture(key);
  node.pos = [0, 0, node.size[2] / 2];
  node.name = uniqueName(state.doc.scene, node.name);
  state = { ...state, placing: null, bin: false };
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
  state = { ...state, placing: null, bin: false };
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

/** Files picked or dropped: designs are opened, a URDF brings its robot in, models, drawings and pictures are imported into the current design. */
export async function receiveFiles(files: PickedFile[]): Promise<void> {
  try {
    const design = files.find((f) => isDesignName(f.name));
    if (design) return await importProjectFile(design);
    const urdf = files.find((f) => extension(f.name) === 'urdf');
    if (urdf) return await importRobot(urdf, files.filter((f) => f !== urdf));
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

const URDF_FILTER = [{ name: 'URDF robot', extensions: ['urdf'] }];

/** "Import URDF…" in Robot mode: brings a robot's links, joints, sensors and meshes into the design. */
export async function importRobotFile(): Promise<void> {
  try {
    const [file] = await platform.pickFiles({ filters: URDF_FILTER });
    if (file) await importRobot(file, []);
  } catch (e) {
    fail(e);
  }
}

/**
 * The mesh files a URDF names, found beside it on disk by their path in the
 * package, looked for from the URDF's folder upwards (a package keeps its URDF
 * in urdf/ and its meshes in meshes/). An OBJ brings the material library it
 * names along for its colors.
 */
async function urdfCompanions(file: PickedFile, companions: PickedFile[]): Promise<PickedFile[]> {
  const found = [...companions];
  const real = file.path ? await platform.realPath(file.path) : null;
  if (!real) return found;
  const dir = folderOf(real);
  for (const ref of urdfMeshFiles(file.bytes)) {
    const inside = meshPath(ref);
    if (found.some((c) => c.name === inside)) continue;
    const base = inside.split('/').pop()!;
    for (const candidate of new Set([`${dir}/${inside}`, `${dir}/../${inside}`, `${dir}/../../${inside}`, `${dir}/${base}`])) {
      const read = await platform.readPath(candidate).catch(() => null);
      if (!read) continue;
      found.push({ ...read, name: inside });
      if (extension(base) === 'obj') {
        const library = /^\s*mtllib\s+(.+?)\s*$/m.exec(new TextDecoder().decode(read.bytes.subarray(0, 65536)))?.[1];
        const mtl = library && (await platform.readPath(`${folderOf(candidate)}/${library}`).catch(() => null));
        if (mtl) found.push({ ...mtl, name: library });
      }
      break;
    }
  }
  return found;
}

/**
 * Brings a URDF's robot into the design: its links as objects where the file
 * puts them, its joints, sensors and drive over them. The design's own robot
 * keeps its base; the newcomer's hangs loose until it is attached. The design
 * takes the robot's name when it was empty and unnamed.
 */
async function importRobot(file: PickedFile, companions: PickedFile[]): Promise<void> {
  set({ busy: 'Importing…' });
  await new Promise((r) => setTimeout(r, 30));
  try {
    let found = await urdfCompanions(file, companions);
    let imported = parseUrdf(file.bytes, found);
    if (imported.missing.length) {
      const names = imported.missing.map((m) => `"${meshPath(m).split('/').pop()}"`);
      const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      const ok = await platform.confirm(`"${file.name}" draws its links with ${list}, which did not come along. Pick ${names.length === 1 ? 'it' : 'them'} now, or import without?`, { title: 'Import', okLabel: 'Pick', cancelLabel: 'Without' });
      if (ok) {
        const picked = await platform.pickFiles({ filters: [{ name: 'Meshes', extensions: [...IMPORT_EXTENSIONS, 'mtl'] }], multiple: true });
        if (picked.length) {
          found = [...found, ...picked];
          imported = parseUrdf(file.bytes, found);
        }
      }
    }
    if (state.aligning) stopAligning();
    const robot = robotOf(state.doc);
    const merged: Robot = {
      ...robot,
      root: robot.root ?? imported.robot.root,
      base: robot.root ? robot.base : imported.robot.base,
      links: [...robot.links, ...imported.robot.links],
      joints: [...robot.joints, ...imported.robot.joints],
      sensors: [...robot.sensors, ...imported.robot.sensors],
      control: robot.root ? robot.control : imported.robot.control,
    };
    const drive = robot.drive ?? imported.robot.drive;
    if (drive) merged.drive = drive;
    const name = state.doc.scene.length === 0 && state.doc.name === emptyDoc().name ? imported.name : state.doc.name;
    record();
    set({ doc: { ...state.doc, name, scene: [...state.doc.scene, ...imported.scene], assets: { ...state.doc.assets, ...imported.assets }, robot: merged }, selection: [], joint: null, sensor: null, jointPick: null, pose: null, placing: null });
    if (!state.robot) enterRobotMode();
    const links = imported.scene.length;
    const summary = `Imported ${links} link${links === 1 ? '' : 's'} and ${imported.robot.joints.length} joint${imported.robot.joints.length === 1 ? '' : 's'} from ${file.name}.`;
    if (imported.warnings.length) notify(`${summary} ${imported.warnings.join(' ')}`, 'error');
    else notify(summary, 'ok');
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

/** Writes the design (or just the selection) in an exchange format and says where it went. Returns false if canceled. */
export async function exportDesign(formatId: FormatId, selectionOnly: boolean): Promise<boolean> {
  const format = FORMATS.find((f) => f.id === formatId)!;
  const nodes = selectionOnly ? selectedNodes() : state.doc.scene;
  const name = await exportName(state.doc.name, format.extension);
  if (!name) return false;
  const filters = [{ name: format.label, extensions: [format.extension] }];
  let bytes: Uint8Array;
  let warnings: string[] = [];
  if (format.id === 'obj') {
    // The colors live in a material library beside the file, named after it: so the place is chosen
    // first, and the files written for the name they were given there.
    const worker = await geometry.prepare(nodes, state.doc.assets);
    const result = await worker.exportColored(nodes, true);
    // The two go side by side, the library named after the file.
    const bundle = { name, files: [] as { name: string; bytes: Uint8Array }[] };
    const where = await platform.saveBundle(`${name}.obj`, filters, format.mime, (base) => {
      const written = writeObj(result.objects, base);
      const files = [{ name: `${base}.obj`, bytes: written.obj, mime: format.mime }];
      if (written.mtl) files.push({ name: written.mtlName, bytes: written.mtl, mime: 'text/plain' });
      bundle.name = base;
      bundle.files = files;
      return files;
    });
    if (!where) return false;
    for (const w of result.warnings) notify(w, 'error');
    // Shared as one zip, so the two travel together.
    await reportSaved(bundle.files.map((f) => f.name), where.where, where.uris, '*/*', bundle);
    return true;
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
  if (!where) return false;
  for (const w of warnings) notify(w, 'error');
  await reportSaved([where.name], where.path ? where.path.slice(0, where.path.length - where.name.length).replace(/[\\/]$/, '') || where.path : 'your downloads', where.uri ? [where.uri] : [], format.mime);
  return true;
}

// --- start-up -------------------------------------------------------------------

/** Opens the project store, then the file the app was started with, or else the project that was open last. */
export async function restoreSession(): Promise<void> {
  try {
    const { fixed, defaultDir } = await openProjectStore(state.prefs.projectsDir);
    set({ storage: { location: projectStore().location, fixed, defaultDir } });
    // Edits made before the store was ready are written now.
    if (isDirty()) scheduleAutosave();
    initSync({ device: state.prefs.device, flush: () => saveProject(true), changed: (report) => void applySyncReport(report), partsChanged: applyPartsSyncReport, notice: (text) => notify(text, 'error') });
    const opened = await platform.startupFiles();
    if (opened.length > 0) return void (await receiveFiles(await Promise.all(opened.map((p) => platform.readPath(p)))));
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
