// New shapes and lettering: carried by the pointer until they are put down,
// or added at the middle of the plate straight away.
import { clampAngle, curvedSize } from '../../text/curve';
import type { TextCurve } from '../../text/curve';
import { tidyVec } from '../../model/math';
import { makeShape, newId, uniqueName } from '../../model/ops';
import type { SceneNode, ShapeKind, TextNode, Vec3 } from '../../model/types';
import { DEFAULT_FONT, loadFont, outlineOf } from '../../text/fonts';
import { tr } from '../../i18n';
import { geometry } from '../geometry';
import { abortAlignPreview, commit, fail, getState, replaceState, set } from './core';
import { updateNode } from './editing';

export function startPlacing(kind: ShapeKind): void {
  abortAlignPreview();
  // Parked far below the plate until the pointer reaches the viewport.
  const node = makeShape(kind, [0, 0, -1e6]);
  set({ placing: node, selection: [], bin: false });
}

const TEXT_THICKNESS = 2;
/** Lettering is listed under its own words until it is given another name. */
const textLabel = (text: string): string => text.trim().split('\n')[0].slice(0, 24) || tr('Text');

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
    const node = makeText(tr('Text'), DEFAULT_FONT);
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
    const node = makeText(tr('Text'), DEFAULT_FONT);
    if (!node) return;
    node.pos = [0, 0, node.size[2] / 2];
    node.name = uniqueName(getState().doc.scene, node.name);
    replaceState({ ...getState(), placing: null, bin: false });
    commit([...getState().doc.scene, node], { selection: [node.id] });
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
    const before = getState().doc.scene.find((n) => n.id === id);
    if (before?.type !== 'text') return false;
    await loadFont(change.font ?? before.font);
    // Typing is faster than fonts load: work from the node as it is by now.
    const node = getState().doc.scene.find((n) => n.id === id);
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

export function movePlacing(point: Vec3 | null): void {
  const node = getState().placing;
  if (!node) return;
  // Lifted by the depth of its base below its center: half the box for a shape, less for a part saved turned on its side.
  const lift = node.pos[2] - geometry.bounds(node).min[2];
  const pos: Vec3 = point ? [point[0], point[1], point[2] + lift] : [0, 0, -1e6];
  if (pos.every((v, i) => v === node.pos[i])) return;
  set({ placing: { ...node, pos } });
}

export function commitPlacing(): void {
  const node = getState().placing;
  if (!node) return;
  if (node.pos[2] < -1e5) {
    set({ placing: null });
    return;
  }
  const placed = { ...node, name: uniqueName(getState().doc.scene, node.name) };
  replaceState({ ...getState(), placing: null, bin: false });
  commit([...getState().doc.scene, placed], { selection: [placed.id] });
}

export const cancelPlacing = (): void => {
  if (getState().placing) set({ placing: null });
};

/** Add a shape at the middle of the plate straight away (keyboard route, double-click). */
export function addShape(kind: ShapeKind): void {
  const node = makeShape(kind);
  node.name = uniqueName(getState().doc.scene, node.name);
  replaceState({ ...getState(), placing: null, bin: false });
  commit([...getState().doc.scene, node], { selection: [node.id] });
}
