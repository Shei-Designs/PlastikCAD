// The editor driven without a browser: the geometry kernel is stood in for by
// box bounds, and the platform by stubs that hand back what each test wants.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION } from '../appInfo';
import { parseDoc, serializeDoc } from '../model/file';
import { boxBounds, originOf, unionBounds } from '../model/math';
import { jointInDesign, sensorInDesign } from '../robot/model';
import { AS_JOINT, figureSources } from '../robot/motors';
import type { Bounds } from '../model/math';
import type { GroupNode, PartNode, SceneNode } from '../model/types';
import type { PickedFile } from '../platform';
import type { SyncReport } from '../sync/engine';

/** Lets a test hold the kernel's answer back until it says so. */
let gate: Promise<void> = Promise.resolve();
const PART_BOX: Bounds = { min: [-10, -10, 0], max: [10, 10, 5] };

vi.mock('./geometry', async () => {
  // Files are read by the worker's own code, here on the spot.
  const { readFile, readHeld } = await import('../worker/importing');
  let request = 0;
  return {
  geometry: {
    bounds: (node: SceneNode) => boxBounds(node),
    ready: async () => {},
    forgetAssets: () => {},
    cancel: () => {},
    worker: () => ({
      import: async (file: PickedFile, companions: PickedFile[], options: { scale?: number } = {}) => readFile(++request, file.name, file.bytes, companions, options.scale),
      importHeld: async (held: number, scale: number) => readHeld(held, scale),
    }),
    prepare: async () => ({
      measure: async (nodes: SceneNode[]) => {
        const solids = nodes.filter((n) => !n.hole && n.type !== 'picture');
        return solids.length ? unionBounds(solids.map((n) => boxBounds(n))) : null;
      },
      partBox: async () => {
        await gate;
        return PART_BOX;
      },
    }),
  },
  };
});

const saved: { name: string; bytes: Uint8Array }[] = [];
/** Whether the pretend platform can delete picked files, and which it was asked to. */
let deletable = false;
const deleted: string[] = [];
/** The boxes the editor put up, and what a test answers them with (the first action unless told otherwise). */
const told: { title: string; text: string; actions: string[] }[] = [];
let choose: (actions: string[]) => string = (actions) => actions[0];
vi.mock('../ui/ask', () => ({
  askName: async (options: { value: string }) => options.value,
  tell: async (options: { title: string; text: string; actions: string[] }) => {
    told.push(options);
    return choose(options.actions);
  },
}));
/** Files a test puts on the pretend disk, by path, for `readPath` to find beside an import. */
const shelf = new Map<string, Uint8Array>();
vi.mock('../platform', () => ({
  confirm: async () => true,
  pickFiles: async () => [],
  readPath: async (path: string) => {
    const bytes = shelf.get(path);
    if (!bytes) throw new Error('no files here');
    return { name: path.slice(path.lastIndexOf('/') + 1), path, bytes };
  },
  saveAs: async (name: string, _filters: unknown, bytes: Uint8Array) => {
    saved.push({ name, bytes });
    return { path: `/designs/${name}`, name };
  },
  writePath: async (path: string, bytes: Uint8Array) => {
    saved.push({ name: path, bytes });
  },
  startupFiles: async () => [],
  onFilesOpened: () => () => {},
  canDelete: (path: string | null) => deletable && path !== null,
  deleteFile: async (path: string) => {
    deleted.push(path);
  },
  canShare: () => false,
  keepsExports: () => false,
  share: async () => {},
  shareBytes: async () => {},
  realPath: async (path: string) => path,
  isAndroid: () => false,
  hasKeychain: () => false,
  updatesItself: () => true,
  findAppUpdate: async () => {
    if (release === 'unreachable') throw new Error('no network');
    return release && { version: release, install: async (progress: (fraction: number | null) => void) => void (progress(0.5), updating.push(installs ? 'installed' : 'failed'), installs || fail('signature mismatch')) };
  },
  canSelfUpdate: async () => selfUpdating,
  relaunch: async () => void updating.push('relaunched'),
  openReleases: async () => void updating.push('releases page'),
}));
/** The newer version the pretend releases hold, whether this copy of the app can install it, whether the install works, and what was done about it. */
let release: string | null = null;
let selfUpdating = true;
let installs = true;
const updating: string[] = [];
const fail = (message: string): never => {
  throw new Error(message);
};


const store = await import('./store');
const projects = await import('./projects');
/** The in-memory project store the editor writes to during a test. */
let kept: InstanceType<typeof projects.MemoryProjects>;

const scene = () => store.getState().doc.scene;
const selected = () => store.getState().selection;
const only = () => {
  expect(selected().length).toBe(1);
  return selected()[0];
};

/** What a sync pass reports, with nothing in it but what the test says. */
const synced = (patch: Partial<SyncReport>): SyncReport => ({ uploaded: [], downloaded: [], merged: [], kept: [], deletedLocally: [], deletedRemotely: [], changedKeys: [], removedKeys: [], movedKeys: [], busy: [], held: [], errors: [], ...patch });

/** Two boxes 30 mm apart along X, `a` at x = 30 and `b` at the origin, both selected. */
function twoBoxes(): { a: string; b: string } {
  store.addShape('box');
  const a = only();
  store.nudgeSelected([30, 0, 0]);
  store.addShape('box');
  const b = only();
  store.select([a, b]);
  return { a, b };
}

const posOf = (id: string) => scene().find((n) => n.id === id)!.pos;

beforeEach(async () => {
  gate = Promise.resolve();
  saved.length = 0;
  // Leaving the previous test's project writes it to that test's store, not this one's.
  await store.startProject();
  kept = new projects.MemoryProjects();
  projects.setProjectStore(kept);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('copies and mirrors of links', () => {
  const robot = () => store.getState().doc.robot!;
  /** A body with a leg on it: the leg weighed, hung by a joint and carrying a sensor. */
  const legged = (): { body: string; leg: string } => {
    const { a: body, b: leg } = twoBoxes();
    store.setRobotRoot(body);
    store.addJoint(body, leg);
    store.updateLink(leg, { mass: { kind: 'measured', grams: 42 }, friction: 1.1 });
    store.addSensor(leg, 'touch');
    return { body, leg };
  };

  it('copy a leg with its settings, its joint to the same body, and its sensor, as one step', () => {
    const { body, leg } = legged();
    store.select([leg]);
    store.duplicateSelected();
    const copy = only();
    expect(copy).not.toBe(leg);
    expect(robot().links.find((l) => l.node === copy)).toMatchObject({ mass: { kind: 'measured', grams: 42 }, friction: 1.1 });
    expect(robot().joints).toHaveLength(2);
    const [first, second] = robot().joints;
    expect(second).toMatchObject({ parent: body, child: copy, origin: first.origin, axis: first.axis, lower: first.lower, upper: first.upper });
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe(`${first.name} 2`);
    expect(robot().sensors.map((x) => [x.link, x.name])).toEqual([[leg, 'touch'], [copy, 'touch_2']]);
    // Paste does the same, and names on.
    store.select([leg]);
    store.copySelected();
    store.paste();
    expect(robot().joints.map((j) => j.name)).toEqual([first.name, `${first.name} 2`, `${first.name} 3`]);
    // One undo takes a copy away with everything it carried.
    store.undo();
    store.undo();
    expect(robot().joints).toHaveLength(1);
    expect(robot().sensors).toHaveLength(1);
    expect(robot().links.filter((l) => l.node !== leg)).toEqual([]);
  });

  it('copy a body and its leg together joined to each other', () => {
    const { body, leg } = legged();
    store.select([body, leg]);
    store.duplicateSelected();
    const [newBody, newLeg] = store.getState().selection;
    expect(robot().joints).toHaveLength(2);
    expect(robot().joints[1]).toMatchObject({ parent: newBody, child: newLeg });
    // The base stays the base.
    expect(robot().root).toBe(body);
  });

  it('mirror a link with its joint and its sensor on the same spots of it', () => {
    const { body, leg } = legged();
    const joint = () => robot().joints[0];
    const node = (id: string) => scene().find((n) => n.id === id)!;
    // The joint off the leg's middle, about an axis that leans; the sensor off the middle too, looking along +Y.
    store.updateNode(leg, { rot: [0, 0, 30] });
    store.placeJoint(joint().id, [4, 7, 3], [1, 2, 0]);
    store.updateSensor(robot().sensors[0].id, { origin: [2, 5, -1], rot: [0, 0, 90] });
    store.updateJoint(joint().id, { lower: -20, upper: 70, start: 15 });
    const limits = [joint().lower, joint().upper, joint().start!];
    const before = jointInDesign(joint(), node(leg));
    const sensorBefore = sensorInDesign(robot().sensors[0], node(leg));
    store.select([body, leg]);
    const pivot = unionBounds([boxBounds(node(body)), boxBounds(node(leg))]);
    const mid = (pivot.min[0] + pivot.max[0]) / 2;
    store.mirrorSelected(0);
    const after = jointInDesign(joint(), node(leg));
    const mirror = (p: number[]) => [2 * mid - p[0], p[1], p[2]];
    mirror(before.origin).forEach((v, i) => expect(after.origin[i]).toBeCloseTo(v, 6));
    // The axis lies across the mirror: it is the mirrored one, pointing much as it did, and the angles are the other way round.
    [-before.axis[0], before.axis[1], before.axis[2]].forEach((v, i) => expect(after.axis[i]).toBeCloseTo(v, 6));
    expect([joint().lower, joint().upper, joint().start]).toEqual([-limits[1], -limits[0], -limits[2]]);
    const sensorAfter = sensorInDesign(robot().sensors[0], node(leg));
    mirror(sensorBefore.origin).forEach((v, i) => expect(sensorAfter.origin[i]).toBeCloseTo(v, 6));
    // It looked along where the leg's +Y pointed; it looks along the mirror image of that.
    [-sensorBefore.matrix[0], sensorBefore.matrix[1], sensorBefore.matrix[2]].forEach((v, i) => expect(sensorAfter.matrix[i]).toBeCloseTo(v, 6));
    // One undo puts the joint back with the objects.
    store.undo();
    jointInDesign(joint(), node(leg)).origin.forEach((v, i) => expect(v).toBeCloseTo(before.origin[i], 6));
  });

  it('mirror a joint along its own axis and it turns about the same axis, within the same limits', () => {
    const { body, leg } = legged();
    const joint = () => robot().joints[0];
    const node = (id: string) => scene().find((n) => n.id === id)!;
    // A thigh's joint about the robot's side-to-side axis, mirrored to the other side.
    store.placeJoint(joint().id, [4, 7, 3], [0, 1, 0]);
    store.updateJoint(joint().id, { lower: -20, upper: 70, start: 15 });
    store.select([body, leg]);
    store.mirrorSelected(1);
    jointInDesign(joint(), node(leg)).axis.forEach((v, i) => expect(v).toBeCloseTo([0, 1, 0][i], 6));
    expect([joint().lower, joint().upper, joint().start]).toEqual([-20, 70, 15]);
  });

  it('mirror a follower across its axis without its leader and it follows the other way', () => {
    const { body } = legged();
    const { a: second } = twoBoxes();
    store.addJoint(body, second);
    const [lead, follower] = robot().joints;
    store.placeJoint(follower.id, [0, 0, 0], [1, 0, 0]);
    store.updateJoint(follower.id, { mimic: { joint: lead.id, multiplier: 2, offset: 5 } });
    store.select([second]);
    store.mirrorSelected(1);
    expect(robot().joints[1].mimic).toEqual({ joint: lead.id, multiplier: -2, offset: -5 });
  });
});

describe('a joint\'s motor', () => {
  it('takes its figures from the table and goes custom when one is typed', () => {
    const { a, b } = twoBoxes();
    store.setRobotRoot(a);
    store.addJoint(a, b);
    const jointOf = () => store.getState().doc.robot!.joints[0];
    const fitted = jointOf().effort;
    expect(fitted).toBeGreaterThan(0);
    store.setJointMotor(jointOf().id, 'sg90');
    expect(jointOf()).toMatchObject({ motor: 'sg90', effort: 0.18, velocity: 600 });
    store.updateJoint(jointOf().id, { effort: 0.25 });
    expect(jointOf().motor).toBeUndefined();
    expect(jointOf().effort).toBe(0.25);
    // Another joint's typed figures can be taken, and leave the motor custom.
    store.addShape('box');
    const c = only();
    const second = store.addJoint(b, c)!;
    expect(figureSources(store.getState().doc.robot!.joints, store.getState().doc.robot!.joints[1]).map((j) => j.id)).toEqual([jointOf().id]);
    store.updateJoint(jointOf().id, { velocity: 123, damping: 0.5 });
    store.setJointMotor(second, AS_JOINT + jointOf().id);
    expect(store.getState().doc.robot!.joints[1]).toMatchObject({ motor: undefined, effort: 0.25, velocity: 123, damping: 0.5 });
    expect(figureSources(store.getState().doc.robot!.joints, store.getState().doc.robot!.joints[1])).toEqual([]);
    // The motor survives a save.
    expect(parseDoc(serializeDoc({ ...store.getState().doc, robot: { ...store.getState().doc.robot!, joints: [{ ...jointOf(), motor: 'nema17' }] } })).robot!.joints[0].motor).toBe('nema17');
  });
});

describe('lining up a joint', () => {
  /** The picked joint's place in the design. */
  const jointAt = (): number[] => {
    const s = store.getState();
    const joint = s.doc.robot!.joints.find((j) => j.id === s.joint)!;
    return jointInDesign(joint, scene().find((n) => n.id === joint.child)!).origin;
  };

  it('puts the joint on the dots of its parent link, previews without touching the history, and takes another object as anchor', () => {
    const { a, b } = twoBoxes();
    store.setRobotRoot(a);
    store.addJoint(a, b);
    expect(store.getState().joint).not.toBeNull();
    const before = jointAt();
    store.startAligning();
    const aligning = store.getState().aligning!;
    expect(aligning.marker).toBe(true);
    expect(aligning.anchor).toBe(a);
    // `a` stands at x 20..40.
    store.previewAlign(0, 'max');
    expect(jointAt()[0]).toBe(40);
    store.previewAlign(null);
    expect(jointAt()).toEqual(before);
    const steps = store.getState().canUndo;
    store.commitAlign(0, 'max');
    expect(jointAt()[0]).toBe(40);
    expect(store.getState().aligning!.done[2]).toBe(true);
    store.undo();
    expect(jointAt()).toEqual(before);
    expect(store.getState().canUndo).toBe(steps);
    // Any object can be the anchor: `b` stands at x -10..10.
    store.setAlignAnchor(b);
    expect(store.getState().aligning!.anchor).toBe(b);
    store.commitAlign(0, 'min');
    expect(jointAt()[0]).toBe(-10);
    // A click on empty space, which selects nothing, takes the dots away too.
    store.startAligning();
    expect(store.getState().aligning).not.toBeNull();
    store.select([]);
    expect(store.getState().aligning).toBeNull();
    expect(store.getState().joint).toBeNull();
    store.leaveRobotMode();
    expect(store.getState().aligning).toBeNull();
  });
});

describe('align mode previews', () => {
  it('lets go of a hovered dot before a deletion, and the gesture does not outlive it', () => {
    const { a } = twoBoxes();
    store.startAligning();
    expect(store.getState().aligning).not.toBeNull();
    store.previewAlign(0, 'min');
    // The preview moved `a` over to the left edge of the pair.
    expect(posOf(a)[0]).toBe(0);
    store.deleteSelected();
    expect(scene()).toEqual([]);
    expect(store.getState().aligning).toBeNull();

    // A later gesture that is canceled must not bring the hovered scene back.
    store.addShape('cylinder');
    store.addShape('sphere');
    const after = scene();
    store.beginGesture();
    store.endGesture(true);
    expect(scene()).toBe(after);
    // And undoing the deletion brings the boxes back where they stood before the hover.
    store.undo();
    store.undo();
    store.undo();
    expect(scene().length).toBe(2);
    expect(posOf(a)[0]).toBe(30);
  });

  it('puts the objects back when the selection changes under a hovered dot', () => {
    const { a, b } = twoBoxes();
    store.startAligning();
    store.previewAlign(0, 'min');
    expect(posOf(a)[0]).toBe(0);
    store.select([b]);
    expect(posOf(a)[0]).toBe(30);
    expect(store.getState().aligning).toBeNull();
    expect(store.getState().canUndo).toBe(true);
    // Nothing of the hover reached the history: undo takes back the second box, not a move.
    store.undo();
    expect(scene().map((n) => n.id)).toEqual([a]);
  });

  it('nudges, copies and groups from the scene before the hover', async () => {
    const { a, b } = twoBoxes();
    store.startAligning();
    store.previewAlign(0, 'min');
    store.nudgeSelected([0, 5, 0]);
    expect(posOf(a)).toEqual([30, 5, 10]);
    expect(posOf(b)).toEqual([0, 5, 10]);
    expect(store.getState().aligning).not.toBeNull();

    store.previewAlign(0, 'min');
    store.duplicateSelected();
    expect(scene().length).toBe(4);
    expect(scene().filter((n) => n.pos[0] === 30).length).toBe(2);

    store.select([a, b]);
    store.startAligning();
    store.previewAlign(0, 'min');
    await store.groupSelected();
    const group = scene().find((n) => n.type === 'group') as GroupNode;
    expect(group.children.map((c) => c.pos[0] + group.pos[0]).sort((x, y) => x - y)).toEqual([0, 30]);
  });

  it('marks the dots that would change nothing', () => {
    const { a, b } = twoBoxes();
    store.startAligning();
    const done = () => store.getState().aligning!.done;
    // The boxes differ only along X: every Y and Z dot is already done, no X dot is.
    expect(done()).toEqual([false, false, false, true, true, true, true, true, true]);
    store.commitAlign(0, 'center');
    expect(done()).toEqual([true, true, true, true, true, true, true, true, true]);
    store.undo();
    expect(done()[0]).toBe(false);
    // With `a` as the anchor the X dots bring `b` over, so they are live again at the anchor's box.
    store.setAlignAnchor(a);
    expect(done()[0]).toBe(false);
    // A locked object sits out: with `b` locked nothing is left to move along X, so the X dots are done.
    store.toggleLocked(b);
    expect(done()[0]).toBe(true);
  });

  it('still previews and keeps an alignment on a click', () => {
    const { a } = twoBoxes();
    store.startAligning();
    store.previewAlign(0, 'min');
    store.previewAlign(0, 'max');
    expect(posOf(a)[0]).toBe(30);
    store.previewAlign(null);
    store.previewAlign(0, 'min');
    store.commitAlign(0, 'min');
    expect(posOf(a)[0]).toBe(0);
    expect(store.getState().aligning).not.toBeNull();
    store.undo();
    expect(posOf(a)[0]).toBe(30);
  });
});

describe('locking the selection', () => {
  it('locks and unlocks every selected object at once, and locked ones sit out of edits', () => {
    const { a, b } = twoBoxes();
    store.toggleLocked(a);
    store.setSelectedLocked(true);
    expect(scene().every((n) => n.locked)).toBe(true);
    store.nudgeSelected([5, 0, 0]);
    expect(posOf(a)[0]).toBe(30);
    expect(posOf(b)[0]).toBe(0);
    store.setSelectedLocked(false);
    expect(scene().some((n) => n.locked)).toBe(false);
    store.nudgeSelected([5, 0, 0]);
    expect(posOf(a)[0]).toBe(35);
    expect(posOf(b)[0]).toBe(5);
  });
});

describe('ghosts', () => {
  it('ghosts the selection out of the selection, keeps ghosts out of select-all, and brings them all back', () => {
    const { a, b } = twoBoxes();
    store.addShape('box');
    const c = only();
    store.select([a, b]);
    store.ghostSelected();
    expect(selected()).toEqual([]);
    expect(scene().filter((n) => n.ghost).map((n) => n.id).sort()).toEqual([a, b].sort());
    expect(store.hasGhosts()).toBe(true);
    store.selectAll();
    expect(selected()).toEqual([c]);
    store.unghostAll();
    expect(scene().some((n) => n.ghost)).toBe(false);
    expect(store.hasGhosts()).toBe(false);
    store.selectAll();
    expect(selected().sort()).toEqual([a, b, c].sort());
  });

  it('toggles one ghost, drops it from the selection, and undoes', () => {
    const { a, b } = twoBoxes();
    store.toggleGhost(a);
    expect(selected()).toEqual([b]);
    expect(scene().find((n) => n.id === a)!.ghost).toBe(true);
    store.toggleGhost(a);
    expect(scene().find((n) => n.id === a)!.ghost).toBeUndefined();
    store.undo();
    expect(scene().find((n) => n.id === a)!.ghost).toBe(true);
    store.undo();
    expect(scene().find((n) => n.id === a)!.ghost).toBeUndefined();
    expect(selected().sort()).toEqual([a, b].sort());
  });

  it('leaves the ghost flag on the group, not its parts, and stays through editing inside', async () => {
    const { a, b } = twoBoxes();
    await store.groupSelected();
    const group = only();
    store.toggleGhost(group);
    const node = scene().find((n) => n.id === group) as GroupNode;
    expect(node.ghost).toBe(true);
    expect(node.children.every((c) => c.ghost === undefined)).toBe(true);
    store.unghostAll();
    store.editInside([group, a]);
    expect(selected()).toEqual([a]);
    await store.finishEditing();
    expect((scene()[0] as GroupNode).children.map((c) => c.id).sort()).toEqual([a, b].sort());
  });
});

describe('notes and colors', () => {
  it('keeps a note on a part through grouping, and edits one inside a group', async () => {
    const { a, b } = twoBoxes();
    store.setNote([a], '  Tap M3  ');
    expect(scene().find((n) => n.id === a)!.note).toBe('Tap M3');
    store.select([a, b]);
    await store.groupSelected();
    const group = scene()[0] as GroupNode;
    expect(group.children.find((c) => c.id === a)!.note).toBe('Tap M3');
    expect(group.note).toBeUndefined();
    store.setNote([group.id, b], 'Spacer');
    store.setNote([group.id], 'Bracket');
    const after = scene()[0] as GroupNode;
    expect(after.note).toBe('Bracket');
    expect(after.children.find((c) => c.id === b)!.note).toBe('Spacer');
    store.setNote([group.id, b], '');
    expect((scene()[0] as GroupNode).children.find((c) => c.id === b)!.note).toBeUndefined();
    store.ungroupSelected();
    expect(scene().find((n) => n.id === a)!.note).toBe('Tap M3');
  });

  it('renames an object, and one inside a group, from the structure', async () => {
    const { a, b } = twoBoxes();
    store.setNameAt([a], '  Lid  ');
    expect(scene().find((n) => n.id === a)!.name).toBe('Lid');
    store.setNameAt([a], '   ');
    expect(scene().find((n) => n.id === a)!.name).toBe('Lid');
    store.select([a, b]);
    await store.groupSelected();
    const group = scene()[0] as GroupNode;
    store.setNameAt([group.id, b], 'Spacer');
    store.setNameAt([group.id], 'Bracket');
    const after = scene()[0] as GroupNode;
    expect(after.name).toBe('Bracket');
    expect(after.children.find((c) => c.id === b)!.name).toBe('Spacer');
    store.undo();
    expect((scene()[0] as GroupNode).name).not.toBe('Bracket');
  });

  it('groups mixed, paints the whole on a color pick, and gives the parts their colors back on ungroup', async () => {
    const { a, b } = twoBoxes();
    store.select([a]);
    store.setColor('#ff0000');
    store.select([b]);
    store.setColor('#0000ff');
    store.select([a, b]);
    await store.groupSelected();
    let group = scene()[0] as GroupNode;
    expect(group.mixed).toBe(true);
    expect(group.color).toBe('#ff0000');
    store.setColor('#00ff00');
    group = scene()[0] as GroupNode;
    expect(group.mixed).toBeUndefined();
    expect(group.color).toBe('#00ff00');
    expect(group.children.map((c) => c.color)).toEqual(['#ff0000', '#0000ff']);
    store.ungroupSelected();
    expect(scene().map((n) => n.color).sort()).toEqual(['#0000ff', '#ff0000']);
  });

  it('keeps a group painted when it is edited inside and put back together', async () => {
    const { a, b } = twoBoxes();
    await store.groupSelected();
    const group = scene()[0] as GroupNode;
    store.setColor('#00ff00');
    store.editInside([group.id, a]);
    await store.finishEditing();
    expect((scene()[0] as GroupNode).mixed).toBeUndefined();
    store.select([group.id]);
    store.ungroupSelected();
    store.select([a, b]);
    await store.groupSelected();
    expect((scene()[0] as GroupNode).mixed).toBe(true);
  });
});

describe('editing inside a group', () => {
  /** A box with a cylinder cut out of it, the whole marked as a hole: a cutter with a cavity. */
  async function cutter(): Promise<{ box: string; bore: string; group: GroupNode }> {
    store.addShape('box');
    const box = only();
    store.addShape('cylinder');
    const bore = only();
    store.setHole(true);
    store.select([box, bore]);
    await store.groupSelected();
    const group = scene()[0] as GroupNode;
    expect(group.type).toBe('group');
    expect(group.hole).toBe(false);
    store.setHole(true);
    return { box, bore, group: scene()[0] as GroupNode };
  }

  const flags = (group: GroupNode) => group.children.map((c) => [c.id, c.hole]);

  it('puts a hole group with a solid and a hole inside back the way it was', async () => {
    const { box, bore, group } = await cutter();
    expect(group.hole).toBe(true);
    expect(flags(group)).toEqual([[box, false], [bore, true]]);
    store.editInside([group.id, box]);
    expect(store.getState().editing?.root).toBe(group.id);
    expect(scene().map((n) => n.hole)).toEqual([true, true]);
    await store.finishEditing();
    expect(store.getState().editing).toBeNull();
    const back = scene()[0] as GroupNode;
    expect(back.id).toBe(group.id);
    expect(back.hole).toBe(true);
    expect(flags(back)).toEqual([[box, false], [bore, true]]);
  });

  it('keeps a part made solid while a hole group was apart', async () => {
    const { box, bore, group } = await cutter();
    store.editInside([group.id, bore]);
    store.setHole(false);
    await store.finishEditing();
    const back = scene()[0] as GroupNode;
    expect(back.hole).toBe(true);
    expect(flags(back)).toEqual([[box, false], [bore, false]]);
  });

  it('round-trips a group of holes and a solid group', async () => {
    store.addShape('cylinder');
    const a = only();
    store.setHole(true);
    store.addShape('cylinder');
    const b = only();
    store.setHole(true);
    store.select([a, b]);
    await store.groupSelected();
    const holes = scene()[0] as GroupNode;
    expect(holes.hole).toBe(true);
    expect(flags(holes)).toEqual([[a, false], [b, false]]);
    store.editInside([holes.id, a]);
    expect(scene().map((n) => n.hole)).toEqual([true, true]);
    await store.finishEditing();
    expect(scene()[0]).toMatchObject({ id: holes.id, hole: true });
    expect(flags(scene()[0] as GroupNode)).toEqual([[a, false], [b, false]]);

    const { a: c, b: d } = twoBoxes();
    store.setHole(false);
    store.select([c, d]);
    await store.groupSelected();
    const solid = scene().find((n) => n.type === 'group' && n.id !== holes.id) as GroupNode;
    store.editInside([solid.id, c]);
    store.select([d]);
    store.setHole(true);
    await store.finishEditing();
    const back = scene().find((n) => n.id === solid.id) as GroupNode;
    expect(back.hole).toBe(false);
    expect(flags(back)).toEqual([[c, false], [d, true]]);
  });

  it('saves a copy with the group put back together, without leaving the edit', async () => {
    const { box, bore, group } = await cutter();
    store.editInside([group.id, box]);
    store.nudgeSelected([5, 0, 0]);
    expect(await store.saveCopy()).toBe(true);
    expect(saved.length).toBe(1);
    expect(saved[0].name).toBe('Untitled.plastikcad');
    const file = parseDoc(new TextDecoder().decode(saved[0].bytes));
    expect(file.scene.length).toBe(1);
    // A copy is made to be passed on: the project's own file names the installation and the save before it, the copy neither.
    expect(parseDoc(await kept.read(store.getState().projectKey!))).toMatchObject({ device: store.getState().prefs.device });
    expect(file.device).toBeUndefined();
    expect(file.parent).toBeUndefined();
    const written = file.scene[0] as GroupNode;
    expect(written).toMatchObject({ id: group.id, type: 'group', hole: true });
    expect(flags(written)).toEqual([[box, false], [bore, true]]);
    // The box kept its move, seen from the group.
    expect(written.children[0].pos[0] + written.pos[0]).toBe(5);
    // Still editing, on the scene taken apart.
    expect(store.getState().editing?.root).toBe(group.id);
    expect(scene().length).toBe(2);
    // The copy went out; the project itself was written to the store first.
    expect(store.getState().projectKey).toBe('mem:1');
    await store.finishEditing();
    expect(flags(scene()[0] as GroupNode)).toEqual([[box, false], [bore, true]]);
  });

  it('autosaves the project whole while a group is being edited inside', async () => {
    const { group } = await cutter();
    await store.saveProject();
    store.editInside([group.id, group.children[0].id]);
    store.nudgeSelected([1, 0, 0]);
    expect(scene().length).toBe(2);
    expect(store.isDirty()).toBe(true);
    expect(await store.saveProject()).toBe(true);
    expect(store.isDirty()).toBe(false);
    const written = parseDoc(await kept.read(store.getState().projectKey!));
    expect(written.scene.length).toBe(1);
    expect(written.scene[0]).toMatchObject({ id: group.id, type: 'group', hole: true });
    expect(store.docToSave().scene).toEqual(written.scene);
  });
});

describe('projects', () => {
  afterEach(() => vi.useRealTimers());

  it('writes an empty untitled project only once something is in it', async () => {
    vi.useFakeTimers();
    expect(store.getState().projectKey).toBeNull();
    store.renameProject('Untitled');
    await vi.advanceTimersByTimeAsync(1500);
    expect(kept.records.size).toBe(0);
    store.addShape('box');
    expect(store.isDirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(store.isDirty()).toBe(false);
    expect(store.getState().projectKey).toBe('mem:1');
    const [info] = await kept.list();
    expect(info).toMatchObject({ key: 'mem:1', name: 'Untitled', id: store.getState().doc.id });
    expect(store.getState().prefs.lastProject).toBe('mem:1');
  });

  it('writes a new project under the name it was given, empty as it is', async () => {
    await store.startProject('Robot arm');
    expect(store.getState().doc.name).toBe('Robot arm');
    expect(store.getState().projectKey).toBe('mem:1');
    expect(store.isDirty()).toBe(false);
    const [info] = await kept.list();
    expect(info).toMatchObject({ key: 'mem:1', name: 'Robot arm' });
  });

  it('autosaves a second after the last change, once', async () => {
    vi.useFakeTimers();
    const writes = vi.spyOn(kept, 'write');
    store.addShape('box');
    await vi.advanceTimersByTimeAsync(600);
    store.nudgeSelected([1, 0, 0]);
    await vi.advanceTimersByTimeAsync(600);
    expect(writes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(parseDoc(await kept.read('mem:1')).scene[0].pos[0]).toBe(1);
  });

  it('takes a fresh thumbnail once the pause has passed, when a save had to keep an older one', async () => {
    vi.useFakeTimers();
    let shots = 0;
    // Only a picture of the real shape is kept by the file format.
    const shot = (n: number) => `data:image/jpeg;base64,${'A'.repeat(n)}`;
    store.provideThumbnail(() => shot(++shots));
    try {
      store.addShape('box');
      expect(await store.saveProject()).toBe(true);
      expect(parseDoc(await kept.read('mem:1')).thumb).toBe(shot(1));
      // A change right after: the save keeps the picture just taken rather than drawing again…
      store.setColor('#ff0000');
      expect(await store.saveProject()).toBe(true);
      expect(parseDoc(await kept.read('mem:1')).thumb).toBe(shot(1));
      // …and owes a fresh one, written on its own once the pause has passed.
      await vi.advanceTimersByTimeAsync(11_000);
      expect(parseDoc(await kept.read('mem:1')).thumb).toBe(shot(2));
      expect(shots).toBe(2);
    } finally {
      store.provideThumbnail(null);
    }
  });

  it('renames the project with the file following, and keeps the id', async () => {
    store.addShape('box');
    await store.saveProject();
    const id = store.getState().doc.id;
    store.renameProject('  Bracket ');
    expect(store.getState().doc.name).toBe('Bracket');
    await store.saveProject();
    const [info] = await kept.list();
    expect(info).toMatchObject({ name: 'Bracket', id });
  });

  it('opens, duplicates and deletes projects from the browser', async () => {
    store.addShape('box');
    store.renameProject('First');
    await store.saveProject();
    const first = store.getState().projectKey!;
    await store.startProject();
    expect(store.getState().projectKey).toBeNull();
    store.addShape('sphere');
    store.renameProject('Second');
    await store.saveProject();
    expect((await store.listProjects()).map((p) => p.name)).toEqual(['Second', 'First']);

    const copy = await store.duplicateProject(first);
    expect(copy).not.toBeNull();
    const copied = parseDoc(await kept.read(copy!));
    const original = parseDoc(await kept.read(first));
    expect(copied.name).toBe('First copy');
    expect(copied.id).not.toBe(original.id);
    expect(copied.scene).toEqual(original.scene);

    await store.openProject(first);
    expect(store.getState().doc.name).toBe('First');
    expect(store.getState().projectKey).toBe(first);
    expect(store.getState().canUndo).toBe(false);

    await store.renameProjectAt(copy!, 'Third');
    expect(parseDoc(await kept.read(copy!)).name).toBe('Third');

    expect(await store.deleteProject(first, 'First')).toBe(true);
    expect(kept.records.has(first)).toBe(false);
    // The open project was deleted: the editor starts afresh and does not write it back.
    expect(store.getState().projectKey).toBeNull();
    expect(scene()).toEqual([]);
    expect(await store.saveProject()).toBe(true);
    expect(kept.records.size).toBe(2);
  });

  it('brings an outside design file in as a project of its own, with a fresh id', async () => {
    store.addShape('box');
    await store.saveProject();
    const text = await kept.read('mem:1');
    const file: PickedFile = { name: 'shared.plastikcad', path: '/elsewhere/shared.plastikcad', bytes: new TextEncoder().encode(text) };
    await store.receiveFiles([file]);
    expect(kept.records.size).toBe(2);
    expect(store.getState().projectKey).toBe('mem:2');
    const [a, b] = [parseDoc(await kept.read('mem:1')), parseDoc(await kept.read('mem:2'))];
    expect(b.id).not.toBe(a.id);
    expect(b.scene).toEqual(a.scene);
    // An untitled design takes its file's name.
    expect(b.name).toBe('shared');
    // It is explained that the project is a copy, kept apart from the file.
    expect(told.pop()).toMatchObject({ title: 'Project added', text: expect.stringMatching(/"shared" is now a project of its own/), actions: ['OK'] });
    expect(deleted).toEqual([]);
  });

  it('offers a copy of a project a newer build saved, without what it does not know, and leaves the project as it is', async () => {
    store.addShape('box');
    store.addShape('cylinder');
    await store.renameProject('Lid');
    await store.saveProject();
    // The project as a newer build might have left it: a shape this one has not got, and a robot that hovers.
    const newer = (await kept.read('mem:1')).replace('"shape": "cylinder"', '"shape": "hypercylinder"').replace(/\n}\n$/, ',\n  "robot": {\n    "base": "hovering"\n  }\n}\n');
    const key = await kept.write(null, 'Lid', newer);
    // Not taken: the open project stays, and nothing is made.
    choose = (actions) => actions[1];
    await store.openProject(key);
    expect(told.pop()).toMatchObject({
      title: 'Made with a newer version',
      text: '"Lid" was saved by a newer version of PlastikCAD. Update the app to open it as it is. This version can open a copy of it without 2 things it does not know. The project itself stays as it is.',
      actions: ['Open a copy', 'Cancel'],
    });
    expect(store.getState().projectKey).toBe('mem:1');
    expect(kept.records.size).toBe(2);
    // Taken: a project of its own, with what this build knows of the other.
    choose = (actions) => actions[0];
    await store.openProject(key);
    expect(store.getState().projectKey).toBe('mem:3');
    expect(store.getState().doc.name).toBe('Lid copy');
    expect(store.getState().doc.scene.map((n) => n.type === 'shape' && n.shape)).toEqual(['box']);
    expect(store.getState().doc.robot).toMatchObject({ base: 'fixed' });
    expect(store.getState().notice).toMatchObject({ kind: 'ok', text: 'Opened "Lid copy".' });
    const copy = parseDoc(await kept.read('mem:3'));
    expect(copy.id).not.toBe(parseDoc(await kept.read('mem:1')).id);
    expect(copy.revision).toBeUndefined();
    // The newer build's project is as it was, to the letter.
    expect(await kept.read(key)).toBe(newer);
    // The same for a design file from outside, named after the file when it has no name of its own.
    await store.receiveFiles([{ name: 'Bracket.plastikcad', path: '/elsewhere/Bracket.plastikcad', bytes: new TextEncoder().encode(newer.replace('"name": "Lid"', '"name": "Untitled"')) }]);
    expect(told.pop()?.text).toMatch(/^"Bracket" was saved by a newer version/);
    expect(store.getState().doc.name).toBe('Bracket copy');
    expect(kept.records.size).toBe(4);
  });

  it('opens a design file by its old extension too', async () => {
    store.addShape('box');
    await store.saveProject();
    const text = (await kept.read('mem:1')).replace('"format": "plastikcad"', '"format": "bashcad"');
    await store.receiveFiles([{ name: 'Old.bashcad', path: '/elsewhere/Old.bashcad', bytes: new TextEncoder().encode(text) }]);
    expect(store.getState().projectKey).toBe('mem:2');
    expect(store.getState().doc.name).toBe('Old');
    told.pop();
  });

  it('offers to delete the file a project was brought in from, where it can', async () => {
    store.addShape('box');
    await store.saveProject();
    const text = await kept.read('mem:1');
    deletable = true;
    try {
      await store.receiveFiles([{ name: 'shared.plastikcad', path: '/elsewhere/shared.plastikcad', bytes: new TextEncoder().encode(text) }]);
    } finally {
      deletable = false;
    }
    expect(told.pop()?.actions).toEqual(['Delete the file', 'Keep the file']);
    expect(deleted).toEqual(['/elsewhere/shared.plastikcad']);
    expect(store.getState().notice?.text).toMatch(/Deleted shared.plastikcad/);
    deleted.length = 0;
  });

  it('keeps that file when the box is left by Escape or a press beside it, which give the last action', async () => {
    store.addShape('box');
    await store.saveProject();
    const text = await kept.read('mem:1');
    deletable = true;
    choose = (actions) => actions[actions.length - 1];
    try {
      await store.receiveFiles([{ name: 'shared.plastikcad', path: '/elsewhere/shared.plastikcad', bytes: new TextEncoder().encode(text) }]);
    } finally {
      deletable = false;
      choose = (actions) => actions[0];
    }
    expect(told.pop()?.actions).toEqual(['Delete the file', 'Keep the file']);
    expect(deleted).toEqual([]);
    expect(store.getState().projectKey).toBe('mem:2');
  });

  it('takes in what a sync pass changed under the open project, merging edits not yet saved', async () => {
    store.addShape('box');
    store.renameProject('Plate');
    await store.saveProject();
    const key = store.getState().projectKey!;
    const box = scene()[0].id;
    const report = synced({ downloaded: ['Plate'], changedKeys: [key] });
    // Clean editor: the incoming version replaces what is on screen.
    const incoming = parseDoc(await kept.read(key));
    incoming.scene = [{ ...incoming.scene[0], pos: [5, 0, 10] as [number, number, number] }, { ...incoming.scene[0], id: 'remote01', name: 'From afar' }];
    incoming.revision = 'remoterev1';
    await kept.write(key, incoming.name, serializeDoc(incoming));
    await store.applySyncReport(report);
    expect(scene().map((n) => [n.id, n.pos[0]])).toEqual([
      [box, 5],
      ['remote01', 0],
    ]);
    expect(store.isDirty()).toBe(false);
    expect(store.getState().doc.revision).toBe('remoterev1');
    // Dirty editor: the unsaved edit (a third object) is merged onto the incoming version.
    store.addShape('sphere');
    const sphere = scene()[2].id;
    const next = { ...incoming, scene: [incoming.scene[0], { ...incoming.scene[1], pos: [-3, 0, 10] as [number, number, number] }], revision: 'remoterev2' };
    await kept.write(key, next.name, serializeDoc(next));
    await store.applySyncReport(report);
    expect(scene().map((n) => [n.id, n.pos[0]])).toEqual([
      [box, 5],
      ['remote01', -3],
      [sphere, 0],
    ]);
    expect(store.isDirty()).toBe(true);
    // The open project renamed on the other side: the editor follows the file.
    const moved = await kept.write(null, 'Plate 2', serializeDoc({ ...next, name: 'Plate 2', revision: 'remoterev3' }));
    await store.applySyncReport({ ...report, changedKeys: [moved], movedKeys: [{ from: key, to: moved }] });
    expect(store.getState().projectKey).toBe(moved);
    expect(store.getState().doc.name).toBe('Plate 2');
    // Deleted on the other side: the editor starts afresh.
    await store.applySyncReport({ ...report, changedKeys: [], removedKeys: [moved] });
    expect(store.getState().projectKey).toBeNull();
    expect(scene()).toEqual([]);
  });

  it('keeps an unsaved change to the robot when a sync pass brings in another, and keeps what came in as a project of its own', async () => {
    store.addShape('box');
    const a = scene()[0].id;
    store.addShape('box');
    const b = scene()[1].id;
    const joint = store.addJoint(a, b)!;
    store.renameProject('Arm');
    await store.saveProject();
    const key = store.getState().projectKey!;
    // Unsaved here: the joint's lower limit. From the other device: its upper limit.
    store.updateJoint(joint, { lower: -10 });
    const incoming = parseDoc(await kept.read(key));
    incoming.robot = { ...incoming.robot!, joints: incoming.robot!.joints.map((j) => ({ ...j, upper: 45 })) };
    incoming.revision = 'remoterev1';
    await kept.write(key, incoming.name, serializeDoc(incoming));
    await store.applySyncReport(synced({ downloaded: ['Arm'], changedKeys: [key] }));
    expect(store.getState().doc.robot!.joints[0]).toMatchObject({ lower: -10, upper: 90 });
    expect(store.isDirty()).toBe(true);
    const copy = (await kept.list()).find((p) => p.name === 'Arm (other device)')!;
    expect(parseDoc(await kept.read(copy.key)).robot!.joints[0]).toMatchObject({ lower: -90, upper: 45 });
    expect(store.getState().notice?.text).toBe('"Arm" was changed on two devices at once; both versions were kept.');
    // A robot changed on the other side alone is simply taken, unsaved edits to the objects merged onto it.
    await store.saveProject();
    store.nudgeSelected([1, 0, 0]);
    const next = parseDoc(await kept.read(key));
    next.robot = { ...next.robot!, base: 'fixed' };
    next.revision = 'remoterev2';
    await kept.write(key, next.name, serializeDoc(next));
    await store.applySyncReport(synced({ downloaded: ['Arm'], changedKeys: [key] }));
    expect(store.getState().doc.robot).toMatchObject({ base: 'fixed', joints: [{ lower: -10 }] });
  });

  it('says everything a sync pass did in one notice', async () => {
    store.dismissSyncNotes();
    store.addShape('box');
    await store.saveProject();
    await store.applySyncReport(synced({ kept: ['Plate', 'Lid'], deletedLocally: ['A', 'B', 'C', 'D'], downloaded: ['Lid'] }));
    expect(store.getState().notice?.text).toBe('"Plate" was changed on two devices at once; both versions were kept. "Lid" was changed on two devices at once; both versions were kept. Deleted on another device: "A", "B", "C" and 1 more. Moved to the Trash folder.');
    await store.applySyncReport(synced({ downloaded: ['Lid'] }));
    expect(store.getState().notice).toMatchObject({ kind: 'ok', text: 'Synced "Lid" from Google Drive.' });
    // What mattered is kept for the projects browser after the toast has gone, each thing once, until dismissed.
    expect(store.getState().syncNotes.length).toBe(3);
    await store.applySyncReport(synced({ kept: ['Plate'] }));
    expect(store.getState().syncNotes.length).toBe(3);
    store.dismissSyncNotes();
    expect(store.getState().syncNotes).toEqual([]);
  });

  it('stamps a rename of a project that is not open as a save, so that sync carries it', async () => {
    store.addShape('box');
    store.renameProject('Plate');
    await store.saveProject();
    const key = store.getState().projectKey!;
    const before = parseDoc(await kept.read(key));
    await store.startProject('Other');
    await store.renameProjectAt(key, 'Base plate');
    const after = parseDoc(await kept.read(key));
    expect(after.name).toBe('Base plate');
    expect(after.revision).not.toBe(before.revision);
    expect(after.parent).toBe(before.revision);
  });

  it('deletes into the trash, puts a project back from it, and destroys only what is in it', async () => {
    store.addShape('box');
    store.renameProject('Plate');
    await store.saveProject();
    const key = store.getState().projectKey!;
    expect(store.keepsTrash()).toBe(true);
    expect(await store.deleteProject(key, 'Plate')).toBe(true);
    // The open project went: the editor starts afresh, and the project waits in the trash.
    expect(store.getState().projectKey).toBeNull();
    expect(await store.listProjects()).toEqual([]);
    const [trashed] = await store.listTrash();
    expect(trashed.name).toBe('Plate');
    await store.restoreProject(trashed.key);
    expect((await store.listProjects()).map((p) => p.name)).toEqual(['Plate']);
    expect(await store.listTrash()).toEqual([]);
    // Emptying the trash leaves the projects alone.
    expect(await store.emptyTrash()).toBe(true);
    expect((await store.listProjects()).length).toBe(1);
  });

  it('keeps an earlier save when a project is saved again, and opens it as a project of its own', async () => {
    store.addShape('box');
    store.renameProject('Plate');
    await store.saveProject();
    const key = store.getState().projectKey!;
    const id = store.getState().doc.id;
    expect(await store.listVersions(id)).toEqual([]);
    // The second save replaces the first, which is kept.
    store.addShape('sphere');
    await store.saveProject();
    const [version] = await store.listVersions(id);
    expect(version).toBeDefined();
    await store.openVersion(version, 'Plate');
    // The earlier save, with its one object, as another project; the project itself still has two.
    expect(scene().length).toBe(1);
    expect(store.getState().projectKey).not.toBe(key);
    expect(store.getState().doc.id).not.toBe(id);
    expect(store.getState().doc.name).toMatch(/^Plate \(.+\)$/);
    expect(parseDoc(await kept.read(key)).scene.length).toBe(2);
    expect((await store.listProjects()).length).toBe(2);
  });

  it('reports a failed save once and keeps the changes pending', async () => {
    vi.spyOn(kept, 'write').mockRejectedValue(new Error('disk full'));
    store.addShape('box');
    expect(await store.saveProject()).toBe(false);
    expect(store.isDirty()).toBe(true);
    expect(store.getState().notice).toMatchObject({ kind: 'error', text: 'Could not save: disk full' });
    store.dismissNotice();
    store.nudgeSelected([1, 0, 0]);
    expect(await store.saveProject()).toBe(false);
    expect(store.getState().notice).toBeNull();
  });

  it('tries a failed save again by itself, without waiting for another edit', async () => {
    vi.useFakeTimers();
    try {
      const write = vi.spyOn(kept, 'write').mockRejectedValueOnce(new Error('disk full'));
      store.addShape('box');
      expect(await store.saveProject()).toBe(false);
      expect(store.isDirty()).toBe(true);
      // Half a minute on, with nothing more done: the disk has room again, and the edit is written.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(write).toHaveBeenCalledTimes(2);
      expect(store.isDirty()).toBe(false);
      expect((await kept.list()).length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('updating the app', () => {
  beforeEach(() => {
    release = null;
    selfUpdating = true;
    installs = true;
    updating.length = 0;
    told.length = 0;
  });
  const available = `Version 9.9.0 is available; this is version ${APP_VERSION}.`;

  it('finds nothing to offer when this is the latest version, or the releases cannot be reached', async () => {
    expect(await store.lookForUpdate()).toBeNull();
    expect(store.getState().update).toBeNull();
    release = 'unreachable';
    await expect(store.lookForUpdate()).rejects.toThrow('no network');
    // Nothing found, nothing to install.
    await store.updateApp();
    expect(told).toEqual([]);
    expect(updating).toEqual([]);
  });

  it('installs a newer version once the user agrees: the design saved first, the app started again after', async () => {
    release = '9.9.0';
    expect(await store.lookForUpdate()).toBe('9.9.0');
    expect(store.getState().update).toBe('9.9.0');
    store.addShape('box');
    // Put off: nothing happens.
    choose = (actions) => actions[1];
    await store.updateApp();
    expect(told.pop()).toMatchObject({ title: 'Update PlastikCAD', text: `${available} The design is saved, the update installed, and PlastikCAD started again.`, actions: ['Update', 'Later'] });
    expect(updating).toEqual([]);
    expect(kept.records.size).toBe(0);
    choose = (actions) => actions[0];
    await store.updateApp();
    expect(kept.records.size).toBe(1);
    expect(updating).toEqual(['installed', 'relaunched']);
    expect(store.getState().busy).toBeNull();
  });

  it('says what went wrong when the update cannot be installed, and does not start the app again', async () => {
    release = '9.9.0';
    installs = false;
    await store.lookForUpdate();
    await store.updateApp();
    expect(updating).toEqual(['failed']);
    expect(store.getState().notice).toMatchObject({ kind: 'error', text: 'The update could not be installed: signature mismatch' });
    expect(store.getState().busy).toBeNull();
  });

  it('shows a copy the system installed as a package the way to the releases instead', async () => {
    release = '9.9.0';
    selfUpdating = false;
    await store.lookForUpdate();
    await store.updateApp();
    expect(told.pop()).toMatchObject({ text: `${available} This copy of PlastikCAD was installed as a system package, which the app cannot update itself: the new version is on the releases page.`, actions: ['Open the releases page', 'Later'] });
    expect(updating).toEqual(['releases page']);
  });
});

describe('mating gears', () => {
  const mateIn = (s = scene()) => s.find((n) => n.id === store.getState().mating?.id) as PartNode | undefined;

  it('leaves the wizard open when undo has nothing to go back to', async () => {
    await store.startProject();
    await store.addPart('gears');
    const gear = scene()[0];
    // A fresh history: opening the project again from what was saved.
    await store.saveProject();
    const key = store.getState().projectKey!;
    await store.startProject('Elsewhere');
    await store.openProject(key);
    store.startMate(gear.id);
    await store.previewMate({ kind: 'gear', teeth: 20, backlash: 0.1, extra: 0.1, angle: 0 });
    expect(store.getState().mating).not.toBeNull();
    store.undo();
    expect(store.getState().mating).not.toBeNull();
    expect(scene().length).toBe(2);
    store.cancelMate();
    expect(scene().length).toBe(1);
  });

  it('undoes an accepted mate without taking the robot with it', async () => {
    await store.addPart('gears');
    const gear = scene()[0];
    store.addShape('box');
    expect(store.addJoint(gear.id, scene()[1].id)).not.toBeNull();
    store.leaveRobotMode();
    store.startMate(gear.id);
    await store.previewMate({ kind: 'gear', teeth: 20, backlash: 0.1, extra: 0.1, angle: 0 });
    await store.commitMate();
    expect(scene().length).toBe(3);
    store.undo();
    expect(scene().length).toBe(2);
    expect(store.getState().doc.robot?.joints.length).toBe(1);
    store.redo();
    expect(scene().length).toBe(3);
    expect(store.getState().doc.robot?.joints.length).toBe(1);
  });

  it('does not keep the previous preview while the one asked for is still being built', async () => {
    await store.addPart('gears');
    const gear = scene()[0];
    expect(gear.type).toBe('part');
    store.startMate(gear.id);
    const mating = store.getState().mating!;
    expect(mating.building).toBe(false);

    const first = store.previewMate({ kind: 'gear', teeth: 20, backlash: 0.1, extra: 0.1, angle: 0 });
    await first;
    expect(mateIn()?.params.teeth).toBe(20);
    expect(store.getState().mating?.building).toBe(false);

    // The next figure is typed; its build is held back while Accept is clicked.
    let open!: () => void;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    void store.previewMate({ kind: 'gear', teeth: 40, backlash: 0.1, extra: 0.1, angle: 0 });
    expect(store.getState().mating?.building).toBe(true);
    const accepted = store.commitMate();
    expect(store.getState().mating).not.toBeNull();
    expect(mateIn()?.params.teeth).toBe(20);
    open();
    await accepted;
    expect(store.getState().mating).toBeNull();
    const mate = scene().find((n) => n.id === mating.id) as PartNode;
    expect(mate.params.teeth).toBe(40);
    // One step: undo takes the mate away and leaves the gear.
    store.undo();
    expect(scene().map((n) => n.id)).toEqual([gear.id]);
  });

  it('waits through a request that arrived while another was building', async () => {
    await store.addPart('gears');
    const gear = scene()[0];
    store.startMate(gear.id);
    const id = store.getState().mating!.id;
    let open!: () => void;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    void store.previewMate({ kind: 'gear', teeth: 20, backlash: 0.1, extra: 0.1, angle: 0 });
    void store.previewMate({ kind: 'gear', teeth: 30, backlash: 0.1, extra: 0.1, angle: 0 });
    const accepted = store.commitMate();
    open();
    await accepted;
    expect(store.getState().mating).toBeNull();
    expect((scene().find((n) => n.id === id) as PartNode).params.teeth).toBe(30);
  });

  it('is dropped by Escape even while building', async () => {
    await store.addPart('gears');
    store.startMate(scene()[0].id);
    let open!: () => void;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    void store.previewMate({ kind: 'gear', teeth: 20, backlash: 0.1, extra: 0.1, angle: 0 });
    const accepted = store.commitMate();
    store.cancelMate();
    open();
    await accepted;
    expect(store.getState().mating).toBeNull();
    expect(scene().length).toBe(1);
  });
});

describe('a planetary set', () => {
  it('previews the sun and its planets together, drops them together, and keeps them as one step', async () => {
    await store.addPart('gears');
    const [gear] = scene();
    await store.editPart(gear.id, { part: 'ring' });
    const ring = scene()[0];
    store.startMate(ring.id);
    await store.previewMate({ kind: 'planetary', teeth: 12, planets: 3, backlash: 0.1, extra: 0, angle: 0 });
    expect(scene().map((n) => n.name)).toEqual(['Internal ring gear', 'Sun gear', 'Planet gear', 'Planet gear 2', 'Planet gear 3']);
    const first = scene().map((n) => n.id);
    // Another count: the parts that stay keep their ids, and one more is added.
    await store.previewMate({ kind: 'planetary', teeth: 12, planets: 4, backlash: 0.1, extra: 0, angle: 0 });
    expect(scene()).toHaveLength(6);
    expect(scene().slice(0, 5).map((n) => n.id)).toEqual(first);
    // Fewer again: the ones over are gone.
    await store.previewMate({ kind: 'planetary', teeth: 12, planets: 2, backlash: 0.1, extra: 0, angle: 0 });
    expect(scene().map((n) => n.name)).toEqual(['Internal ring gear', 'Sun gear', 'Planet gear', 'Planet gear 2']);
    store.cancelMate();
    expect(scene().map((n) => n.id)).toEqual([ring.id]);

    store.startMate(ring.id);
    await store.previewMate({ kind: 'planetary', teeth: 12, planets: 3, backlash: 0.1, extra: 0, angle: 0 });
    await store.commitMate();
    expect(scene()).toHaveLength(5);
    // The sun and the planets are what is selected, and one Undo takes them all back.
    expect(store.getState().selection).toEqual(scene().slice(1).map((n) => n.id));
    store.undo();
    expect(scene().map((n) => n.id)).toEqual([ring.id]);
  });
});

describe('the Array panel', () => {
  it('opens on a selection, shows a pattern that Apply keeps as one step, and drops it when closed any other way', async () => {
    store.startArray();
    expect(store.getState().arraying, 'nothing is selected, so there is nothing to lay out').toBe(false);
    store.addShape('box');
    store.startArray();
    expect(store.getState().arraying).toBe(true);
    store.previewArray({ kind: 'grid', count: [3, 1, 1], pitch: [30, 30, 30] });
    expect(scene()).toHaveLength(3);
    // The button again closes the panel and drops the pattern.
    store.startArray();
    expect(store.getState().arraying).toBe(false);
    expect(scene()).toHaveLength(1);
    store.startArray();
    store.previewArray({ kind: 'grid', count: [2, 2, 1], pitch: [30, 30, 30] });
    store.commitArray();
    expect(store.getState().arraying).toBe(false);
    expect(scene()).toHaveLength(4);
    store.undo();
    expect(scene()).toHaveLength(1);
  });

  it('closes when a mating gear is asked for', async () => {
    await store.addPart('gears');
    store.startArray();
    expect(store.getState().arraying).toBe(true);
    store.startMate(scene()[0].id);
    expect(store.getState().arraying).toBe(false);
    expect(store.getState().mating).not.toBeNull();
    store.cancelMate();
  });
});

describe('parts that cut', () => {
  it('brings a bearing seat in from its tile as a hole', async () => {
    await store.addPart('bearings');
    expect(scene()).toHaveLength(1);
    expect(scene()[0]).toMatchObject({ type: 'part', part: 'bearing-seat', hole: true, name: 'Bearing seat' });
  });

  it('makes a screw into a hole when it becomes a screw hole, and solid again when it is a screw once more', async () => {
    await store.addPart('screws');
    const [bolt] = scene();
    expect(bolt).toMatchObject({ type: 'part', part: 'metric-bolt', hole: false });
    await store.editPart(bolt.id, { part: 'screw-hole' });
    expect(scene()[0]).toMatchObject({ part: 'screw-hole', hole: true, name: 'Screw hole' });
    // A change to its settings leaves it as the user has it: made solid by hand, it stays solid.
    store.updateNode(bolt.id, { hole: false });
    await store.editPart(bolt.id, { params: { recess: 'counterbore' } });
    expect(scene()[0]).toMatchObject({ part: 'screw-hole', hole: false });
    store.updateNode(bolt.id, { hole: true });
    await store.editPart(bolt.id, { part: 'metric-nut' });
    expect(scene()[0]).toMatchObject({ part: 'metric-nut', hole: false });
  });
});

describe('importing', () => {
  const ascii = (facets: number[][]): PickedFile => {
    const lines = ['solid thin'];
    for (const f of facets) {
      lines.push('  facet normal 0 0 0', '    outer loop');
      for (let k = 0; k < 9; k += 3) lines.push(`      vertex ${f[k]} ${f[k + 1]} ${f[k + 2]}`);
      lines.push('    endloop', '  endfacet');
    }
    lines.push('endsolid thin', '');
    return { name: 'thin.stl', path: null, bytes: new TextEncoder().encode(lines.join('\n')) };
  };

  it('refuses a mesh whose thickness rounds away to nothing', async () => {
    await store.receiveFiles([ascii([[0, 0, 0, 10, 0, 0, 0, 10, 0.00002], [0, 0, 0, 0, 10, 0.00002, 10, 0, 0]])]);
    expect(scene()).toEqual([]);
    expect(store.getState().notice?.kind).toBe('error');
    expect(store.getState().notice?.text).toContain('flat or empty');
  });

  it('imports a mesh with a real thickness', async () => {
    await store.receiveFiles([ascii([[0, 0, 0, 10, 0, 0, 0, 10, 2], [0, 0, 0, 0, 10, 2, 10, 0, 0]])]);
    expect(scene().length).toBe(1);
    expect(scene()[0]).toMatchObject({ type: 'import', size: [10, 10, 2] });
  });

  it("keeps the file's own origin, saves it, and starts a joint there", async () => {
    // A wedge from the file's origin to 10 × 10 × 2: the origin is its low corner.
    await store.receiveFiles([ascii([[0, 0, 0, 10, 0, 0, 0, 10, 2], [0, 0, 0, 0, 10, 2, 10, 0, 0]])]);
    const wedge = scene()[0];
    expect(wedge).toMatchObject({ pos: [0, 0, 1], origin: [-5, -5, -1] });
    expect(originOf(wedge)).toEqual([-5, -5, 0]);
    expect(parseDoc(serializeDoc(store.getState().doc)).scene[0]).toMatchObject({ origin: [-5, -5, -1] });
    // Turned and moved, the origin goes with it, and a joint to the wedge starts on it rather than where the boxes meet.
    store.updateNode(wedge.id, { pos: [40, 0, 1], rot: [0, 0, 90] });
    store.addShape('box');
    const box = scene()[1].id;
    const joint = store.addJoint(box, wedge.id)!;
    const made = store.getState().doc.robot!.joints.find((j) => j.id === joint)!;
    const at = jointInDesign(made, scene()[0]).origin;
    [45, -5, 0].forEach((v, i) => expect(at[i]).toBeCloseTo(v, 6));
  });

  it('brings in the files it can read when one among them cannot be, and names that one', async () => {
    const good = ascii([[0, 0, 0, 10, 0, 0, 0, 10, 2], [0, 0, 0, 0, 10, 2, 10, 0, 0]]);
    const empty: PickedFile = { name: 'broken.stl', path: null, bytes: new Uint8Array(0) };
    await store.receiveFiles([{ ...good, name: 'first.stl' }, empty, { ...good, name: 'last.stl' }]);
    expect(scene().map((n) => n.name)).toEqual(['first', 'last']);
    expect(store.getState().notice).toMatchObject({ kind: 'error' });
    expect(store.getState().notice?.text).toMatch(/^broken\.stl: /);
    // Alone, it is still an error, and nothing comes in.
    await store.startProject();
    await store.receiveFiles([empty]);
    expect(scene()).toEqual([]);
    expect(store.getState().notice?.text).toMatch(/^broken\.stl: /);
  });

  it('says what a drawing held that was left out, by the name of its file', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20"><rect id="r" width="10" height="10"/><use href="#gone" x="10"/></svg>';
    await store.receiveFiles([{ name: 'plate.svg', path: null, bytes: new TextEncoder().encode(svg) }]);
    expect(scene()).toHaveLength(1);
    expect(store.getState().notice).toEqual({ kind: 'error', text: 'plate.svg: 1 copy of another shape (<use>) was left out.', action: undefined });
  });

  it('asks which unit a tiny model without one was made in, and takes it at that', async () => {
    // A wedge 0.2 by 0.1 by 0.05: a part written in meters.
    const tiny = ascii([[0, 0, 0, 0.2, 0, 0, 0, 0.1, 0.05], [0, 0, 0, 0, 0.1, 0.05, 0.2, 0, 0]]);
    told.length = 0;
    await store.receiveFiles([tiny]);
    expect(told).toHaveLength(1);
    expect(told[0].text).toBe('"thin.stl" does not say which unit it was made in. As millimeters it is 0.2 × 0.1 × 0.05 mm. Which unit is it in?');
    expect(told[0].actions).toEqual(['Meters', 'Inches', 'Centimeters', 'Millimeters']);
    // The first answer, meters: a thousand times the numbers.
    expect(scene()[0]).toMatchObject({ type: 'import', size: [200, 100, 50], natural: [200, 100, 50] });
    // Inches, and backing out, which keeps millimeters.
    await store.startProject();
    choose = (actions) => actions[1];
    await store.receiveFiles([tiny]);
    expect(scene()[0]).toMatchObject({ size: [5.08, 2.54, 1.27] });
    await store.startProject();
    choose = (actions) => actions[actions.length - 1];
    await store.receiveFiles([tiny]);
    expect(scene()[0]).toMatchObject({ size: [0.2, 0.1, 0.05] });
    choose = (actions) => actions[0];
    // A model of an ordinary size is not asked about.
    told.length = 0;
    await store.startProject();
    await store.receiveFiles([ascii([[0, 0, 0, 10, 0, 0, 0, 10, 2], [0, 0, 0, 0, 10, 2, 10, 0, 0]])]);
    expect(told).toEqual([]);
  });

  describe('a .gltf with its data in a file beside it', () => {
    const data = new Uint8Array(new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0, 0, 0, 0.01]).buffer);
    const index = new Uint8Array(new Uint16Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]).buffer);
    const bin = new Uint8Array(72);
    bin.set(data);
    bin.set(index, 48);
    // A tetrahedron, 10 mm along each axis.
    const gltf = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: '2.0' },
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' }],
        bufferViews: [{ buffer: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 24 }],
        buffers: [{ byteLength: 72, uri: 'tetra.bin' }],
      }),
    );

    it('comes in with the file picked with it', async () => {
      await store.receiveFiles([{ name: 'tetra.gltf', path: null, bytes: gltf }, { name: 'tetra.bin', path: null, bytes: bin }]);
      expect(scene()).toHaveLength(1);
      expect(scene()[0]).toMatchObject({ type: 'import', name: 'tetra', size: [10, 10, 10] });
      // Nothing is said of it: whatever notice an earlier import left is not about this file.
      expect(store.getState().notice?.text ?? '').not.toContain('tetra');
    });

    it('comes in with the file found beside it on disk', async () => {
      shelf.clear();
      shelf.set('/models/tetra.bin', bin);
      await store.receiveFiles([{ name: 'tetra.gltf', path: '/models/tetra.gltf', bytes: gltf }]);
      expect(scene()).toHaveLength(1);
      shelf.clear();
    });

    it('says which file it needs when that is not to be had', async () => {
      await store.receiveFiles([{ name: 'tetra.gltf', path: '/elsewhere/tetra.gltf', bytes: gltf }]);
      expect(scene()).toEqual([]);
      expect(store.getState().notice).toMatchObject({ kind: 'error', text: '"tetra.gltf" keeps its shapes in "tetra.bin", which did not come along. Pick it together with the file.' });
    });
  });

  it('reads a material library named after the OBJ beside it when the one it names is not there', async () => {
    const text = (s: string) => new TextEncoder().encode(s);
    const tetra = ['mtllib colors.mtl', 'v 0 0 0', 'v 10 0 0', 'v 0 10 0', 'v 0 0 10', 'usemtl red', 'f 1 2 3', 'f 1 2 4', 'f 2 3 4', 'f 1 4 3', ''].join('\n');
    shelf.clear();
    shelf.set('/exports/box/box.mtl', text('newmtl red\nKd 1 0 0\n'));
    await store.receiveFiles([{ name: 'box.obj', path: '/exports/box/box.obj', bytes: text(tetra) }]);
    expect(scene().length).toBe(1);
    expect(scene()[0].color).toBe('#ff0000');
    shelf.clear();
  });
});

describe('custom parts', () => {
  const parts = () => projects.partStore().list();

  it('keeps a selected object as a part standing at the middle of the plate, and places copies of it', async () => {
    store.addShape('box');
    const original = only();
    store.nudgeSelected([30, 10, 0]);
    expect(await store.saveAsPart(original)).toBe(true);
    const [part] = await parts();
    expect(part.name).toBe('Box');
    const doc = parseDoc(await projects.partStore().read(part.key));
    expect(doc.scene.length).toBe(1);
    expect(doc.scene[0].id).not.toBe(original);
    expect(doc.scene[0].pos).toEqual([0, 0, 10]);
    expect(doc.revision).toBeTruthy();
    // The original stays where it was.
    expect(posOf(original)).toEqual([30, 10, 10]);

    // Picked from the bin, carried to a point and put down: a fresh object named after the part, and the bin closes behind it.
    store.openPartsBin();
    await store.pickPart(part.key);
    expect(store.getState().bin).toBe(true);
    const carried = store.getState().placing!;
    expect(carried.name).toBe('Box');
    expect(carried.id).not.toBe(doc.scene[0].id);
    store.movePlacing([5, 5, 0]);
    expect(store.getState().placing!.pos).toEqual([5, 5, 10]);
    store.commitPlacing();
    expect(store.getState().bin).toBe(false);
    expect(scene().map((n) => n.name)).toEqual(['Box', 'Box 2']);
    // Or added straight to the middle.
    await store.addCustomPart(part.key);
    expect(scene().map((n) => n.name)).toEqual(['Box', 'Box 2', 'Box 3']);
    expect(posOf(only())).toEqual([0, 0, 10]);
  });

  it('keeps a group whole, with fresh ids inside, and drops hidden and locked', async () => {
    twoBoxes();
    await store.groupSelected();
    const group = only();
    store.toggleLocked(group);
    expect(await store.saveAsPart(group)).toBe(true);
    const [part] = await parts();
    const doc = parseDoc(await projects.partStore().read(part.key));
    const saved = doc.scene[0] as GroupNode;
    expect(saved.type).toBe('group');
    expect(saved.locked).toBeUndefined();
    const before = scene().find((n) => n.id === group) as GroupNode;
    expect(saved.children.map((c) => c.id)).not.toEqual(before.children.map((c) => c.id));
    expect(saved.children.length).toBe(2);
  });

  it('renames and deletes parts, and the other library tiles close the bin', async () => {
    store.addShape('cylinder');
    await store.saveAsPart(only());
    const [part] = await parts();
    await store.renamePartAt(part.key, 'Post');
    expect((await parts()).map((p) => p.name)).toEqual(['Post']);
    store.openPartsBin();
    expect(store.getState().bin).toBe(true);
    expect(store.getState().selection).toEqual([]);
    store.startPlacing('box');
    expect(store.getState().bin).toBe(false);
    // Selecting an object in the design closes it too; clearing the selection does not.
    store.openPartsBin();
    store.select([]);
    expect(store.getState().bin).toBe(true);
    store.select([scene()[0].id]);
    expect(store.getState().bin).toBe(false);
    expect(await store.deletePart(part.key, 'Post')).toBe(true);
    expect(await parts()).toEqual([]);
  });

  it('asks first, and does nothing when told not to', async () => {
    store.addShape('box');
    choose = (actions) => actions[actions.length - 1];
    expect(await store.saveAsPart(only())).toBe(false);
    expect(await parts()).toEqual([]);
    expect(told[told.length - 1]?.title).toBe('Save as a part');
    choose = (actions) => actions[0];
  });
});
