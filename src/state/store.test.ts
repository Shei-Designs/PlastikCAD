// The editor driven without a browser: the geometry kernel is stood in for by
// box bounds, and the platform by stubs that hand back what each test wants.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDoc } from '../model/file';
import { boxBounds, unionBounds } from '../model/math';
import type { Bounds } from '../model/math';
import type { GroupNode, PartNode, SceneNode } from '../model/types';
import type { PickedFile } from '../platform';

/** Lets a test hold the kernel's answer back until it says so. */
let gate: Promise<void> = Promise.resolve();
const PART_BOX: Bounds = { min: [-10, -10, 0], max: [10, 10, 5] };

vi.mock('./geometry', () => ({
  geometry: {
    bounds: (node: SceneNode) => boxBounds(node),
    ready: async () => {},
    forgetAssets: () => {},
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
}));

const saved: { name: string; bytes: Uint8Array }[] = [];
vi.mock('../platform', () => ({
  confirm: async () => true,
  pickFiles: async () => [],
  readPath: async () => {
    throw new Error('no files here');
  },
  saveAs: async (name: string, _filters: unknown, bytes: Uint8Array) => {
    saved.push({ name, bytes });
    return { path: `/designs/${name}`, name };
  },
  writePath: async (path: string, bytes: Uint8Array) => {
    saved.push({ name: path, bytes });
  },
  startupFile: async () => null,
}));


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
  await store.newProject();
  kept = new projects.MemoryProjects();
  projects.useProjectStore(kept);
});

afterEach(() => {
  vi.useRealTimers();
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
    expect(saved[0].name).toBe('Untitled.bashcad');
    const file = parseDoc(new TextDecoder().decode(saved[0].bytes));
    expect(file.scene.length).toBe(1);
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
    await store.newProject();
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
    const file: PickedFile = { name: 'shared.bashcad', path: '/elsewhere/shared.bashcad', bytes: new TextEncoder().encode(text) };
    await store.receiveFiles([file]);
    expect(kept.records.size).toBe(2);
    expect(store.getState().projectKey).toBe('mem:2');
    const [a, b] = [parseDoc(await kept.read('mem:1')), parseDoc(await kept.read('mem:2'))];
    expect(b.id).not.toBe(a.id);
    expect(b.scene).toEqual(a.scene);
    // An untitled design takes its file's name.
    expect(b.name).toBe('shared');
    expect(store.getState().notice?.text).toMatch(/Added "shared"/);
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
});

describe('mating gears', () => {
  const mateIn = (s = scene()) => s.find((n) => n.id === store.getState().mating?.id) as PartNode | undefined;

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
});
