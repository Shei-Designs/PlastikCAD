// The modes that work on the selection from the viewport: align, with its
// anchor dots, measure, and array patterns.
import { boundsCenter, boundsSize, unionBounds } from '../../model/math';
import { alignNodes, arrayNodes, arrayPlaces, uniqueName } from '../../model/ops';
import { ALIGN_MODES, alignAt, alignDot } from '../../model/ops';
import type { AlignMode, ArraySpec, GridArray, RingArray } from '../../model/ops';
import type { SceneNode, Vec2, Vec3 } from '../../model/types';
import { geometry } from '../geometry';
import { FEATURE_KINDS } from '../../geometry/features';
import type { Feature, FeatureKind } from '../../geometry/features';
import { abortAlignPreview, beginGesture, commit, endGesture, gestureBase, getState, holdAlignPreview, notify, set, step } from './core';
import type { EditorState } from './core';
import { replaceNodes, selectedNodes, selectionBounds } from './editing';
import { markerLink, markerOriginIn, placeMarker } from './robot';

// --- align mode ---------------------------------------------------------------

/** The box the anchor dots sit on (the anchor object's, or the whole selection's) and which dots have nothing left to do. */
function alignState(anchor: string | null): EditorState['aligning'] {
  // A picked joint or sensor lines up with the anchor object's box, one coordinate at a time.
  const origin = getState().joint || getState().sensor ? markerOriginIn(getState().doc) : null;
  if (origin) {
    const target = anchor ? getState().doc.scene.find((n) => n.id === anchor) : undefined;
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

export function refreshAlignBounds(): void {
  const aligning = getState().aligning;
  if (!aligning) return;
  set({ aligning: alignState(aligning.anchor) });
}

/** Show the anchor dots around the selection (two or more objects), or, for a picked joint or sensor, on the box of the link it belongs to. */
export function startAligning(): void {
  if (getState().aligning) return;
  if (getState().joint || getState().sensor) {
    const aligning = alignState(markerLink());
    if (aligning) set({ aligning, placing: null, measuring: null });
    return;
  }
  if (getState().selection.length < 2) return notify('Select two or more objects to line them up.');
  const aligning = alignState(null);
  if (aligning) set({ aligning, placing: null, measuring: null });
}

export function stopAligning(): void {
  if (!getState().aligning) return;
  // A dot being previewed is let go of first.
  abortAlignPreview();
  set({ aligning: null });
}

export const toggleAligning = (): void => (getState().aligning ? stopAligning() : startAligning());

// --- measuring ----------------------------------------------------------------

/** The kinds last chosen, kept while the app runs so the tool comes back as it was left. */
let measureKinds: FeatureKind[] = FEATURE_KINDS.map((k) => k.id);

/** Measure mode: the pointer takes hold of points, edges, faces and circles, and two picks are measured against each other. */
export function startMeasuring(): void {
  stopAligning();
  set({ measuring: { kinds: measureKinds, picks: [] }, placing: null });
}

export function stopMeasuring(): void {
  if (getState().measuring) set({ measuring: null });
}

export const toggleMeasuring = (): void => (getState().measuring ? stopMeasuring() : startMeasuring());

export const toggleObjectAxes = (): void => set({ objectAxes: !getState().objectAxes });

export function setMeasureKinds(kinds: FeatureKind[]): void {
  measureKinds = kinds;
  const measuring = getState().measuring;
  if (measuring) set({ measuring: { ...measuring, kinds } });
}

/** A feature picked on the plate: the first of a pair, the second, or after a pair a fresh first. */
export function pickMeasure(feature: Feature): void {
  const m = getState().measuring;
  if (!m) return;
  set({ measuring: { ...m, picks: m.picks.length >= 2 ? [feature] : [...m.picks, feature] } });
}

export function clearMeasure(): void {
  const measuring = getState().measuring;
  if (measuring?.picks.length) set({ measuring: { ...measuring, picks: [] } });
}

/** Make one of the selected objects the one the others line up with; the same one again clears it. */
export function setAlignAnchor(id: string | null): void {
  const aligning = getState().aligning;
  if (!aligning) return;
  // A joint or sensor always lines up with some object, so its anchor cannot be cleared, only changed.
  const anchor = id === aligning.anchor && !aligning.marker ? null : id;
  const next = alignState(anchor);
  if (next) set({ aligning: next });
}

/** The selection as it would be after lining up on a dot; from the scene before any preview. */
function aligned(axis: 0 | 1 | 2, mode: AlignMode): SceneNode[] | null {
  const aligning = getState().aligning;
  if (!aligning) return null;
  const base = gestureBase()?.scene ?? getState().doc.scene;
  const ids = new Set(getState().selection);
  const nodes = base.filter((n) => ids.has(n.id) && !n.locked && n.id !== aligning.anchor);
  return alignNodes(nodes, (n) => geometry.bounds(n), axis, mode, aligning.bounds);
}

/** Where the picked joint or sensor goes when lined up on a dot: that coordinate taken from the anchor's box; from before any preview. */
function markerAligned(axis: 0 | 1 | 2, mode: AlignMode): Vec3 | null {
  const aligning = getState().aligning;
  if (!aligning?.marker) return null;
  const held = gestureBase();
  const origin = markerOriginIn(held ? { ...getState().doc, robot: held.robot } : getState().doc);
  return origin && (origin.map((v, i) => (i === axis ? alignAt(aligning.bounds, axis, mode) : v)) as Vec3);
}

/** Hovering a dot moves the objects there for a look; null puts them back. */
export function previewAlign(axis: 0 | 1 | 2 | null, mode: AlignMode = 'center'): void {
  const aligning = getState().aligning;
  if (!aligning) return;
  if (axis === null) return abortAlignPreview();
  if (aligning.marker) {
    const origin = markerAligned(axis, mode);
    if (!origin) return;
    // The gesture keeps the placing out of the history; letting go of the preview puts the robot back.
    holdAlignPreview();
    placeMarker(origin);
    return;
  }
  const nodes = aligned(axis, mode);
  if (!nodes) return;
  // Not through commit, which would take the preview for an edit and let go of it.
  holdAlignPreview();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  set({ doc: { ...getState().doc, scene: getState().doc.scene.map((n) => byId.get(n.id) ?? n) } });
}

/** Clicking a dot keeps the objects where the preview put them. */
export function commitAlign(axis: 0 | 1 | 2, mode: AlignMode): void {
  if (getState().aligning?.marker) {
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
  if (getState().aligning) stopAligning();
  // Always from the scene and selection the preview started from.
  const base = gestureBase() ?? step();
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
