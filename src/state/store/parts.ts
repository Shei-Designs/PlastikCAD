// Parametric parts (gears, pulleys, screws): making, measuring and changing
// them, and the mating-gear wizard with its live preview.
import { apply, boundsCenter, boundsSize, boxBounds, rotation, tidyVec } from '../../model/math';
import type { Bounds } from '../../model/math';
import { newId, uniqueName } from '../../model/ops';
import type { PartNode, PartParamValue, Vec3 } from '../../model/types';
import { GENERATORS, getGenerator } from '../../parts/generators';
import { sanitizeParams } from '../../parts/generators/types';
import { mateOf } from '../../parts/mates';
import type { MatePart, MateRequest } from '../../parts/mates';
import { geometry } from '../geometry';
import { tr } from '../../i18n';
import { abortAlignPreview, commit, endWork, fail, getState, notify, pushStep, replaceState, rewriteHistory, set, startWork } from './core';
import type { Step } from './core';
import { updateNode } from './editing';
import { cancelArray, stopAligning } from './tools';

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
    // A part made to be cut out of another (a screw hole) comes in as a hole.
    hole: Boolean(def.cutter),
    color: '#8fa3bf',
  };
}

/** The part's box as its generator makes it, in the generator's own frame, from the geometry kernel. */
async function partBox(node: PartNode): Promise<Bounds> {
  const worker = await geometry.prepare([], getState().doc.assets);
  const bounds = await worker.partBox(node);
  if (!bounds) throw new Error(tr('"{name}" came out empty with these settings.', { name: node.name }));
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
  startWork(tr('Making the part…'));
  try {
    const node = await sizePart(makePart(def.id));
    abortAlignPreview();
    set({ placing: node, selection: [], bin: false });
  } catch (e) {
    fail(e);
  } finally {
    endWork();
  }
}

/** Add a part at the middle of the plate straight away (keyboard route, double-click). */
export async function addPart(category: string): Promise<void> {
  const def = GENERATORS.find((g) => g.category === category);
  if (!def) return;
  startWork(tr('Making the part…'));
  try {
    const node = await sizePart(makePart(def.id));
    node.pos = [0, 0, node.size[2] / 2];
    node.name = uniqueName(getState().doc.scene, node.name);
    replaceState({ ...getState(), placing: null, bin: false });
    commit([...getState().doc.scene, node], { selection: [node.id] });
  } catch (e) {
    fail(e);
  } finally {
    endWork();
  }
}

// --- mating gears -------------------------------------------------------------

/**
 * A mate laid out next to its gear: standing on the same base, meshed, and measured (not yet in the
 * scene). The mate itself comes first; the parts that come with it (the planets of a planetary set) follow.
 */
async function placeMate(source: PartNode, request: MateRequest): Promise<{ nodes: PartNode[]; warnings: string[] }> {
  const mate = mateOf(source, request);
  const sourceBox = await partBox(source);
  // Every part is placed by its box center, which sits off its generator's origin (the gear's axis,
  // the rack's corner); the mate is laid out between origins and then moved by its own box.
  const c1 = boundsCenter(sourceBox).map((c, i) => (c * source.size[i]) / source.natural[i]) as Vec3;
  const [ax, ay, az] = apply(rotation(source.rot), c1);
  const origin: Vec3 = [source.pos[0] - ax, source.pos[1] - ay, source.pos[2] - az];
  const place = async (part: MatePart): Promise<PartNode> => {
    const node = makePart(part.part, part.params);
    if (part.name) node.name = part.name;
    const box = await partBox(node);
    node.natural = boundsSize(box);
    node.size = [...node.natural];
    node.rot = part.rotation;
    const [bx, by, bz] = apply(rotation(part.rotation), boundsCenter(box));
    node.pos = tidyVec([origin[0] + part.offset[0] + bx, origin[1] + part.offset[1] + by, origin[2] + part.offset[2] + bz]);
    node.color = source.color;
    return node;
  };
  return { nodes: await Promise.all([mate, ...(mate.more ?? [])].map(place)), warnings: mate.warnings };
}

/** The ids of the parts that came with the previewed mate (see `placeMate`), in order; kept from one preview to the next. */
let mateMore: string[] = [];
/** Every node of the preview: the mate, under the wizard's id, and the parts that came with it. */
const inPreview = (id: string): ((n: { id: string }) => boolean) => {
  const ids = new Set([id, ...mateMore]);
  return (n) => ids.has(n.id);
};

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
  const source = getState().doc.scene.find((n) => n.id === sourceId);
  if (source?.type !== 'part') return;
  cancelMate();
  cancelArray();
  if (getState().aligning) stopAligning();
  mateMore = [];
  set({ mating: { source: sourceId, id: newId(), building: false }, selection: [sourceId], placing: null });
}

/** Tell the panel whether the mate it asks for is still on its way (Accept waits for it). */
function setMateBuilding(building: boolean): void {
  const mating = getState().mating;
  if (mating && mating.building !== building) set({ mating: { ...mating, building } });
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
    if (next && getState().mating) void previewMate(next);
    else setMateBuilding(false);
    done();
  }
}

/** Resolves once no preview is being built (right away if none is). */
async function mateSettled(): Promise<void> {
  while (mateBuilding) await mateDone;
}

async function buildMatePreview(request: MateRequest): Promise<void> {
  const mating = getState().mating;
  if (!mating) return;
  const source = getState().doc.scene.find((n) => n.id === mating.source);
  if (source?.type !== 'part') return cancelMate();
  const build = ++mateBuilds;
  try {
    const { nodes, warnings } = await placeMate(source, request);
    // The same ids from one preview to the next, so that what is drawn is changed rather than made anew.
    while (mateMore.length < nodes.length - 1) mateMore.push(newId());
    const was = inPreview(mating.id);
    let named = getState().doc.scene.filter((n) => !was(n));
    nodes.forEach((node, i) => {
      node.id = i === 0 ? mating.id : mateMore[i - 1];
      node.name = uniqueName(named, node.name);
      named = [...named, node];
    });
    await Promise.all(nodes.map((node) => geometry.ready(node, getState().doc.assets)));
    if (build !== mateBuilds || getState().mating?.id !== mating.id) return;
    // The preview is no step of its own: the whole wizard becomes one on Accept.
    set({ doc: { ...getState().doc, scene: [...getState().doc.scene.filter((n) => !was(n)), ...nodes] } });
    if (warnings.length) notify(warnings[0]);
  } catch (e) {
    fail(e);
  }
}

/** Keep the previewed mate, selected, as one undo step. Waits for the preview the panel last asked for. */
export async function commitMate(): Promise<void> {
  const opened = getState().mating;
  if (!opened) return;
  await mateSettled();
  // Canceled, or closed and opened again, meanwhile.
  const mating = getState().mating;
  if (!mating || mating.id !== opened.id) return;
  mateNext = null;
  mateBuilds++;
  const preview = inPreview(mating.id);
  const kept = getState().doc.scene.filter(preview);
  const before = getState().doc.scene.filter((n) => !preview(n));
  scrubMate(preview);
  mateMore = [];
  if (kept.length) pushStep({ scene: before, selection: getState().selection, robot: getState().doc.robot });
  set({ mating: null, selection: kept.length ? kept.map((n) => n.id) : getState().selection });
}

export function cancelMate(): void {
  const mating = getState().mating;
  if (!mating) return;
  mateNext = null;
  mateBuilds++;
  const preview = inPreview(mating.id);
  scrubMate(preview);
  mateMore = [];
  set({ mating: null, doc: { ...getState().doc, scene: getState().doc.scene.filter((n) => !preview(n)) } });
}

/** Steps recorded while the wizard was open (edits to the gear itself) hold the preview too; it does not belong in them. */
function scrubMate(preview: (n: { id: string }) => boolean): void {
  const clean = (s: Step): Step => (s.scene.some(preview) ? { ...s, scene: s.scene.filter((n) => !preview(n)), selection: s.selection.filter((id) => !preview({ id })) } : s);
  rewriteHistory(clean);
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
  const node = getState().doc.scene.find((n) => n.id === id);
  if (node?.type !== 'part' || node.locked) return;
  const def = getGenerator(change.part ?? node.part);
  const params = change.part && change.part !== node.part ? sanitizeParams(def, change.params) : sanitizeParams(def, { ...node.params, ...change.params });
  // A part still carrying its kind's own name (or that plus a number) takes the new kind's name with it.
  const was = getGenerator(node.part).name;
  const auto = node.name === was || new RegExp(`^${was.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d+$`).test(node.name);
  const name = change.part && change.part !== node.part && auto ? uniqueName(getState().doc.scene.filter((n) => n.id !== id), def.name) : node.name;
  const edit = ++partEdits;
  try {
    // A part that becomes a cutter (a nut made into a screw hole) becomes a hole, and the other way round.
    const hole = Boolean(def.cutter) === Boolean(getGenerator(node.part).cutter) ? node.hole : Boolean(def.cutter);
    const sized = await sizePart({ ...node, part: def.id, params, name, hole }, node);
    // The new shape is built before the node changes, so the old one is never shown at the new size.
    await geometry.ready(sized, getState().doc.assets);
    // A later edit has overtaken this one, or the part is gone.
    if (edit !== partEdits || !getState().doc.scene.some((n) => n.id === id)) return;
    updateNode(id, sized, `part:${id}`);
  } catch (e) {
    fail(e);
  }
}
