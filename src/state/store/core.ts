// The editor's state and the few functions everything else changes it
// through: `set`, the undo history, gestures and notices. The state and the
// history are private to this file; the other store modules read and change
// them through what is exported here.
import { noteDiagnostic } from '../../diagnostics';
import { asError } from '../../errors';
import { useSyncExternalStore } from 'react';
import { emptyDoc } from '../../model/file';
import type { Bounds, Mat } from '../../model/math';
import type { Layer } from '../../model/ops';
import type { Doc, Scene, SceneNode, Vec3 } from '../../model/types';
import { loadPrefs, savePrefs } from '../persist';
import type { Prefs } from '../persist';
import type { Solved } from '../../robot/kinematics';
import { pruned } from '../../robot/model';
import type { Feature, FeatureKind } from '../../geometry/features';
import { picksStand } from '../../viewer/picks';
import type { Robot } from '../../robot/types';
import { Cancelled } from '../../worker/client';
import { geometry } from '../geometry';
import { cancelMate } from './parts';
import { refreshAlignBounds } from './tools';
import { scheduleAutosave } from './project';

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
  /** The Array panel is open: the selection is laid out in a pattern for a look, until it is applied or dropped. */
  arraying: boolean;
  /** Measure mode: the kinds of feature the pointer takes hold of, and the one or two picked so far. */
  measuring: { kinds: FeatureKind[]; picks: Feature[] } | null;
  /** The handles of one selected object follow its own axes instead of the design's; not saved. */
  objectAxes: boolean;
  /**
   * Editing inside a group: the layers taken apart to reach a part of it,
   * which are put back together on Done. `before` is the scene for Cancel.
   */
  editing: { root: string; target: string; layers: Layer[]; before: Scene } | null;
  /** A box drawn in the viewport, for pointing at a part of a group from the structure graph. */
  highlight: { matrix: Mat; size: Vec3 } | null;
  prefs: Prefs;
  notice: Notice | null;
  /** What sync did that should not go by unseen (a conflict kept as two projects, a deletion from another device): kept until dismissed in the projects browser. */
  syncNotes: string[];
  /** Something slow is going on ("Grouping…"). */
  busy: string | null;
  /** Whether that is work of the geometry worker, which `stopWork` can call off. */
  stoppable: boolean;
  /** The newer version of the app that was found among the releases (see store/updating.ts); null when there is none, or none was looked for. */
  update: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Counts up whenever a different design is loaded, so views can reframe. */
  epoch: number;
}

export interface Step {
  scene: Scene;
  selection: string[];
  robot?: Robot;
}

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
  arraying: false,
  measuring: null,
  objectAxes: false,
  editing: null,
  highlight: null,
  prefs: loadPrefs(),
  notice: null,
  syncNotes: [],
  busy: null,
  stoppable: false,
  update: null,
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
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export function set(patch: Partial<EditorState>): void {
  const before = state;
  // Any change of selection ends align mode.
  if (state.aligning && patch.selection && patch.aligning === undefined && !sameIds(patch.selection, state.selection)) patch = { ...patch, aligning: null };
  // A measurement is of the objects as they stood: once one of them changes, its picks are dropped.
  const m = state.measuring;
  if (m?.picks.length && patch.measuring === undefined && patch.doc && !picksStand(m.picks, state.doc.scene, patch.doc.scene)) patch = { ...patch, measuring: { ...m, picks: [] } };
  state = { ...state, ...patch, canUndo: past.length > 0, canRedo: future.length > 0 };
  if (state.prefs !== before.prefs) savePrefs(state.prefs);
  if (state.doc !== before.doc && isDirty()) scheduleAutosave();
  for (const l of listeners) l();
}

const sameIds = (a: string[], b: string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

/** Calls `listener` after every change of the state; the function returned stops it. */
export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getState = (): EditorState => state;

/**
 * Puts `next` in place of the state without any of what `set` does: no
 * listener hears of it and nothing is saved. For a change that rides along
 * with the `commit` or `set` that follows it.
 */
export function replaceState(next: EditorState): void {
  state = next;
}

export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export const isDirty = (s: EditorState = state): boolean =>
  !s.saved || s.doc.scene !== s.saved.scene || s.doc.name !== s.saved.name || s.doc.robot !== s.saved.robot;

export function notify(text: string, kind: Notice['kind'] = 'info', action?: Notice['action']): void {
  clearTimeout(noticeTimer);
  if (kind === 'error') noteDiagnostic('error', text);
  set({ notice: { kind, text, action } });
  // Longer with something to read twice or a button to reach.
  noticeTimer = setTimeout(() => set({ notice: null }), kind === 'error' || action ? 8000 : 3500);
}

export const dismissNotice = (): void => set({ notice: null });

/** Keeps word from sync for the projects browser, the latest last, each said once. */
export function noteSync(texts: string[]): void {
  const notes = [...state.syncNotes.filter((t) => !texts.includes(t)), ...texts].slice(-20);
  if (texts.length) set({ syncNotes: notes });
}

export const dismissSyncNotes = (): void => set({ syncNotes: [] });

/** Says what went wrong. Work that the user called off (see `stopWork`) went as asked, and is not said. */
export const fail = (e: unknown): void => {
  if (!(e instanceof Cancelled)) notify(asError(e).message, 'error');
};

/** Word on the screen that the geometry worker is at something slow, with a way to call it off. */
export const startWork = (label: string): void => set({ busy: label, stoppable: true });
export const endWork = (): void => set({ busy: null, stoppable: false });

/**
 * Calls off the slow work under way (an import, an export, a group being made): whoever waits on it
 * is refused with `Cancelled` and leaves things as they were.
 */
export function stopWork(): void {
  if (state.stoppable) geometry.cancel();
}

export function setPrefs(patch: Partial<Prefs>): void {
  set({ prefs: { ...state.prefs, ...patch } });
}

// --- scene edits and undo -------------------------------------------------

export const step = (): Step => ({ scene: state.doc.scene, selection: state.selection, robot: state.doc.robot });

/** Puts the present on the undo stack before a change. Edits with the same `merge` key in quick succession count as one. */
export function record(merge?: string): void {
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
export function commit(scene: Scene, options: { selection?: string[]; merge?: string } = {}): void {
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

/** The scene, selection and robot as the gesture under way found them; null when there is none. */
export function gestureBase(): Step | null {
  return gesture;
}

/** A hovered align dot takes hold of the scene: a gesture begins, unless one is under way, and is marked as the dot's. */
export function holdAlignPreview(): void {
  gesture ??= step();
  alignPreview = true;
}

/** Whether a hovered align dot holds the scene just now. */
export function previewingAlign(): boolean {
  return alignPreview;
}

/**
 * Let go of a hovered dot's preview: the scene goes back to how it was before
 * the hover. Everything else that reads or changes the scene or selection does
 * this first, so it works on the real scene and never inherits the gesture
 * (whose end would otherwise throw its own edit away).
 */
export function abortAlignPreview(): void {
  if (!alignPreview) return;
  alignPreview = false;
  endGesture(true);
}

function restore(from: Step[], to: Step[]): void {
  // With nothing to go back to, nothing is touched: not a dot being previewed, not an open wizard.
  if (from.length === 0) return;
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

export function resetHistory(): void {
  past = [];
  future = [];
  gesture = null;
  alignPreview = false;
  lastMerge = null;
}

/** Puts `entry` on the undo stack: the step before an edit that was made without `record` (a mate's preview, once accepted). */
export function pushStep(entry: Step): void {
  past.push(entry);
  if (past.length > UNDO_LIMIT) past.shift();
  future = [];
  lastMerge = null;
}

/** Passes every step kept for undo and redo through `change`. */
export function rewriteHistory(change: (s: Step) => Step): void {
  past = past.map(change);
  future = future.map(change);
}

/** The next edit is a step of its own, whatever its merge key. */
export function endMerge(): void {
  lastMerge = null;
}
