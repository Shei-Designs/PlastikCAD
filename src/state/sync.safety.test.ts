// What must not cost a user their work when things happen at once: a save while a sync pass is under way, a step
// back after a pass brought changes in, an import that ends after another project was opened, two new projects
// written at the same moment. Driven through the real store, project store and sync engine.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDoc, parseDoc, serializeDoc } from '../model/file';
import { boxBounds, unionBounds } from '../model/math';
import { makeShape, newId } from '../model/ops';
import type { Doc, SceneNode } from '../model/types';
import type { PickedFile } from '../platform';
import { MemorySyncState, synchronize } from '../sync/engine';
import type { Remote, RemoteFile, SyncReport } from '../sync/engine';

/** Holds the worker's answer to an import back until a test lets it go. */
let importGate: Promise<void> = Promise.resolve();

vi.mock('./geometry', async () => {
  const { readFile, readHeld } = await import('../worker/importing');
  let request = 0;
  return {
    geometry: {
      bounds: (node: SceneNode) => boxBounds(node),
      ready: async () => {},
      forgetAssets: () => {},
      cancel: () => {},
      worker: () => ({
        import: async (file: PickedFile, companions: PickedFile[], options: { scale?: number } = {}) => {
          await importGate;
          return readFile(++request, file.name, file.bytes, companions, options.scale);
        },
        importHeld: async (held: number, scale: number) => readHeld(held, scale),
      }),
      prepare: async () => ({
        measure: async (nodes: SceneNode[]) => {
          const solids = nodes.filter((n) => !n.hole && n.type !== 'picture');
          return solids.length ? unionBounds(solids.map((n) => boxBounds(n))) : null;
        },
      }),
    },
  };
});
vi.mock('../ui/ask', () => ({
  askName: async (options: { value: string }) => options.value,
  tell: async (options: { actions: string[] }) => options.actions[options.actions.length - 1],
  askPick: async () => [],
}));
/** Something a test has happen while a question is up, and what was asked. */
let whileAsked: (() => Promise<void>) | null = null;
const asked: string[] = [];
vi.mock('../platform', () => ({
  confirm: async (message: string) => {
    asked.push(message);
    const run = whileAsked;
    whileAsked = null;
    await run?.();
    return true;
  },
  pickFiles: async () => [],
  readPath: async () => {
    throw new Error('no files here');
  },
  startupFiles: async () => [],
  onFilesOpened: () => () => {},
  canDelete: () => false,
  canShare: () => false,
  keepsExports: () => false,
  realPath: async (path: string) => path,
  isAndroid: () => false,
  isDesktop: () => false,
  hasKeychain: () => false,
  updatesItself: () => false,
}));

const store = await import('./store');
const projects = await import('./projects');
let kept: InstanceType<typeof projects.MemoryProjects>;
const scene = () => store.getState().doc.scene;
const ids = (nodes: SceneNode[]): string[] => nodes.map((n) => n.id);

/** A Drive that holds what it is given, and can have something happen in the middle of a download. */
class FakeRemote implements Remote {
  files = new Map<string, { file: RemoteFile; text: string }>();
  meanwhile: { projectId: string; run: () => Promise<void> } | null = null;
  private serial = 0;
  async list(): Promise<RemoteFile[]> {
    return [...this.files.values()].map((f) => f.file);
  }
  async download(file: RemoteFile): Promise<string> {
    if (this.meanwhile?.projectId === file.projectId) {
      const { run } = this.meanwhile;
      this.meanwhile = null;
      await run();
    }
    return this.files.get(file.id)!.text;
  }
  async upload(existing: RemoteFile | null, name: string, text: string, meta: { projectId: string; revision: string | null }): Promise<RemoteFile> {
    const id = existing?.id ?? `remote-${++this.serial}`;
    const file: RemoteFile = { id, name: `${name}.plastikcad`, projectId: meta.projectId, revision: meta.revision, modified: Date.now() };
    this.files.set(id, { file, text });
    return file;
  }
  async remove(file: RemoteFile): Promise<void> {
    this.files.delete(file.id);
  }
  put(doc: Doc): void {
    const id = `remote-${++this.serial}`;
    this.files.set(id, { file: { id, name: `${doc.name}.plastikcad`, projectId: doc.id, revision: doc.revision ?? null, modified: Date.now() }, text: serializeDoc(doc) });
  }
  replace(doc: Doc): void {
    const entry = [...this.files.values()].find((f) => f.file.projectId === doc.id)!;
    entry.text = serializeDoc(doc);
    entry.file = { ...entry.file, revision: doc.revision ?? null };
  }
  textOf(projectId: string): string {
    return [...this.files.values()].find((f) => f.file.projectId === projectId)!.text;
  }
}
const box = (id: string): SceneNode => ({ ...makeShape('box'), id });
const changed = (key: string): SyncReport => ({ uploaded: [], downloaded: ['Plate'], merged: [], kept: [], deletedLocally: [], deletedRemotely: [], changedKeys: [key], removedKeys: [], movedKeys: [], busy: [], held: [], errors: [] });

beforeEach(async () => {
  importGate = Promise.resolve();
  whileAsked = null;
  asked.length = 0;
  await store.startProject();
  kept = new projects.MemoryProjects();
  projects.setProjectStore(kept);
});

describe('a save while a sync pass is under way', () => {
  /** "Plate" with one box, here and on the Drive, in step; then the other device adds an object to it. */
  async function plateChangedElsewhere() {
    store.addShape('box');
    store.renameProject('Plate');
    await store.saveProject();
    const key = store.getState().projectKey!;
    const id = store.getState().doc.id;
    const remote = new FakeRemote();
    const state = new MemorySyncState();
    const sync = (): Promise<SyncReport> => synchronize(kept, remote, state, { device: 'device0a' });
    await sync();
    const there = parseDoc(remote.textOf(id));
    there.scene = [...there.scene, { ...there.scene[0], id: 'remote01', name: 'From afar' }];
    there.revision = 'remoterev1';
    remote.replace(there);
    return { key, id, remote, sync };
  }

  it('does not put the old design back over what the pass just wrote: it is made on top of it', async () => {
    const { key, id, remote, sync } = await plateChangedElsewhere();
    const mine = scene()[0].id;
    // A second project keeps the pass busy after it has written Plate: that is when the user moves the box and autosave fires.
    remote.put({ ...emptyDoc(), id: 'otherproj01', name: 'Other', scene: [box('b1')], revision: newId() });
    remote.meanwhile = {
      projectId: 'otherproj01',
      run: async () => {
        expect(ids(parseDoc(await kept.read(key)).scene)).toEqual([mine, 'remote01']);
        store.select([mine]);
        store.nudgeSelected([1, 0, 0]);
        expect(await store.saveProject()).toBe(true);
      },
    };
    const report = await sync();
    await store.applySyncReport(report);
    // On the device: the other device's object and the move made here, in the file and on the plate.
    const here = parseDoc(await kept.read(key));
    expect(ids(here.scene)).toEqual([mine, 'remote01']);
    expect(here.scene[0].pos[0]).toBe(1);
    expect(here.parent).toBe('remoterev1');
    expect(ids(scene())).toEqual([mine, 'remote01']);
    expect(store.isDirty()).toBe(false);
    // And the next pass carries both to the Drive.
    await sync();
    const there = parseDoc(remote.textOf(id));
    expect(ids(there.scene)).toEqual([mine, 'remote01']);
    expect(there.scene[0].pos[0]).toBe(1);
  });

  it('keeps what came in as a project of its own where both changed the same object', async () => {
    const { key, id, remote, sync } = await plateChangedElsewhere();
    const mine = scene()[0].id;
    // The other device also moved the box, another way.
    const there = parseDoc(remote.textOf(id));
    there.scene = there.scene.map((n) => (n.id === mine ? { ...n, pos: [0, 7, n.pos[2]] as [number, number, number] } : n));
    there.revision = 'remoterev2';
    remote.replace(there);
    remote.put({ ...emptyDoc(), id: 'otherproj01', name: 'Other', scene: [box('b1')], revision: newId() });
    remote.meanwhile = {
      projectId: 'otherproj01',
      run: async () => {
        store.select([mine]);
        store.nudgeSelected([1, 0, 0]);
        await store.saveProject();
      },
    };
    await store.applySyncReport(await sync());
    const here = parseDoc(await kept.read(key));
    expect(here.scene.find((n) => n.id === mine)?.pos[0]).toBe(1);
    expect(ids(here.scene)).toContain('remote01');
    const names = (await kept.list()).map((p) => p.name).sort();
    expect(names).toEqual(['Other', 'Plate', 'Plate (other device)']);
  });

  it('does not write over a design a newer version of the app saved meanwhile', async () => {
    store.addShape('box');
    store.renameProject('Plate');
    await store.saveProject();
    const key = store.getState().projectKey!;
    const newer = (await kept.read(key)).replace(/"version": \d+/, '"version": 99').replace(/"revision": "[^"]+"/, '"revision": "fromnewer1"');
    await kept.write(key, 'Plate', newer);
    store.nudgeSelected([1, 0, 0]);
    expect(await store.saveProject()).toBe(false);
    expect(await kept.read(key)).toBe(newer);
    expect(store.isDirty()).toBe(true);
    expect(store.getState().notice?.kind).toBe('error');
  });

  it('follows a project that another device renamed, and does not make the old file again', async () => {
    store.addShape('box');
    store.renameProject('Plate');
    await store.saveProject();
    const key = store.getState().projectKey!;
    const renamed = parseDoc(await kept.read(key));
    renamed.name = 'Base plate';
    renamed.revision = 'renamedrev1';
    // As a folder on disk has it after the pass: the file under its new name, and none under the old.
    await kept.remove(key);
    const moved = await kept.write(null, renamed.name, serializeDoc(renamed));
    store.nudgeSelected([1, 0, 0]);
    expect(await store.saveProject()).toBe(true);
    expect((await kept.list()).map((p) => p.name)).toEqual(['Base plate']);
    expect(store.getState().projectKey).toBe(moved);
    expect(store.getState().doc.name).toBe('Base plate');
    expect(parseDoc(await kept.read(moved)).scene[0].pos[0]).toBe(1);
  });
});

describe('a step back after a pass brought changes in', () => {
  it('does not take the other device\'s changes out again', async () => {
    store.addShape('box');
    store.renameProject('Plate');
    await store.saveProject();
    const key = store.getState().projectKey!;
    // Not yet saved here: a move. From the other device: a second object.
    store.nudgeSelected([1, 0, 0]);
    const incoming = parseDoc(await kept.read(key));
    incoming.scene = [...incoming.scene, { ...incoming.scene[0], id: 'remote01', name: 'From afar' }];
    incoming.revision = 'remoterev1';
    await kept.write(key, incoming.name, serializeDoc(incoming));
    await store.applySyncReport(changed(key));
    expect(ids(scene())).toContain('remote01');
    expect(scene()[0].pos[0]).toBe(1);
    store.undo();
    expect(ids(scene())).toContain('remote01');
    await store.saveProject();
    expect(ids(parseDoc(await kept.read(key)).scene)).toContain('remote01');
  });

  it('leaves the editor alone when what the pass wrote is the editor\'s own save', async () => {
    store.addShape('box');
    store.renameProject('Plate');
    await store.saveProject();
    const key = store.getState().projectKey!;
    store.nudgeSelected([1, 0, 0]);
    await store.saveProject();
    await store.applySyncReport(changed(key));
    // The move can still be stepped back from: nothing came in.
    store.undo();
    expect(scene()[0].pos[0]).toBe(0);
  });
});

describe('an import that ends after the design changed', () => {
  const stl = (): Uint8Array => {
    const facet = (a: string, b: string, c: string) => `facet normal 0 0 1\nouter loop\nvertex ${a}\nvertex ${b}\nvertex ${c}\nendloop\nendfacet\n`;
    return new TextEncoder().encode(`solid t\n${facet('0 0 0', '10 0 0', '0 10 0')}${facet('0 0 0', '0 10 0', '0 0 10')}${facet('0 0 0', '0 0 10', '10 0 0')}${facet('10 0 0', '0 0 10', '0 10 0')}endsolid t\n`);
  };

  it('is dropped when another project was opened meanwhile, which stays as it is', async () => {
    store.addShape('sphere');
    store.renameProject('B');
    await store.saveProject();
    const keyB = store.getState().projectKey!;
    await store.startProject('A');
    store.addShape('box');
    await store.saveProject();
    const keyA = store.getState().projectKey!;
    let release!: () => void;
    importGate = new Promise((r) => (release = r));
    const importing = store.receiveFiles([{ name: 'big.stl', path: null, bytes: stl() }]);
    await store.openProject(keyB);
    release();
    await importing;
    expect(store.getState().projectKey).toBe(keyB);
    expect(scene().map((n) => n.type)).toEqual(['shape']);
    expect(store.getState().notice?.text).toBe('The import was dropped: another project was opened before it ended.');
    await store.saveProject();
    expect(parseDoc(await kept.read(keyB)).scene.map((n) => n.type)).toEqual(['shape']);
    expect(parseDoc(await kept.read(keyA)).scene.map((n) => n.type)).toEqual(['shape']);
  });

  it('is added to the design as it is by then, with what was changed meanwhile', async () => {
    store.addShape('box');
    const first = scene()[0].id;
    let release!: () => void;
    importGate = new Promise((r) => (release = r));
    const importing = store.receiveFiles([{ name: 'big.stl', path: null, bytes: stl() }]);
    // While "Importing…" is up: the box is deleted and a cylinder added.
    store.select([first]);
    store.deleteSelected();
    store.addShape('cylinder');
    release();
    await importing;
    expect(scene().map((n) => (n.type === 'shape' ? n.shape : n.type))).toEqual(['cylinder', 'import']);
  });
});

describe('two new projects of one name written at the same moment', () => {
  it('get a file each', async () => {
    const { DiskProjects } = projects;
    const files = new Map<string, Uint8Array>();
    const platform = await import('../platform');
    Object.assign(platform, {
      listDesigns: async (dir: string) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/')).map((path) => ({ name: path.slice(dir.length + 1), path, size: files.get(path)!.length, modified: 1 })),
      writePath: async (path: string, bytes: Uint8Array) => {
        // The write takes a moment, as a real one does: time enough for the other to have looked.
        await new Promise((r) => setTimeout(r, 5));
        files.set(path, bytes);
      },
      moveFile: async () => {},
    });
    const disk = new DiskProjects('/home/me/Documents/PlastikCAD');
    const one = serializeDoc({ ...emptyDoc(), id: 'fromsync01', name: 'Untitled' });
    const other = serializeDoc({ ...emptyDoc(), id: 'fromeditor', name: 'Untitled' });
    const keys = await Promise.all([disk.write(null, 'Untitled', one), disk.write(null, 'Untitled', other)]);
    expect(new Set(keys).size).toBe(2);
    expect([...files.keys()].sort()).toEqual(['/home/me/Documents/PlastikCAD/Untitled (2).plastikcad', '/home/me/Documents/PlastikCAD/Untitled.plastikcad']);
  });
});

describe('the trash emptied while a sync pass adds to it', () => {
  it('destroys what was listed when the question was put, and nothing that arrived since', async () => {
    store.addShape('box');
    store.renameProject('Old junk');
    await store.saveProject();
    const junk = store.getState().projectKey!;
    await store.startProject('Wanted');
    store.addShape('sphere');
    await store.saveProject();
    const wanted = store.getState().projectKey!;
    await store.startProject();
    await kept.discard(junk);
    expect((await store.listTrash()).map((p) => p.name)).toEqual(['Old junk']);
    // While the question is up, a pass moves a project deleted on another device into the trash.
    whileAsked = () => kept.discard(wanted);
    expect(await store.emptyTrash()).toBe(true);
    expect((await store.listTrash()).map((p) => p.name)).toEqual(['Wanted']);
  });
});

describe('a project file copied by hand in the folder', () => {
  it('becomes a project of its own when it is opened, so that both sync and each keeps its own earlier saves', async () => {
    store.addShape('box');
    store.renameProject('Box');
    await store.saveProject();
    const key = store.getState().projectKey!;
    const id = store.getState().doc.id;
    const copy = await kept.write(null, 'Box copy', (await kept.read(key)).replace('"name": "Box"', '"name": "Box copy"'));
    expect((await kept.list()).map((p) => p.id)).toEqual([id, id]);
    await store.openProject(copy);
    await store.saveProject();
    const all = await kept.list();
    expect(new Set(all.map((p) => p.id)).size).toBe(2);
    expect(all.find((p) => p.key === key)?.id).toBe(id);
    // And the one that was there is opened as it is.
    await store.openProject(key);
    expect(store.getState().doc.id).toBe(id);
  });
});

describe('a design of the first format, already in the folder', () => {
  it('is asked about the saved versions it carries before they go', async () => {
    const v1 = JSON.stringify({ format: 'plastikcad', version: 1, units: 'mm', name: 'Legacy', scene: [box('n1')], assets: {}, versions: [{ label: 'First draft', scene: [box('n1'), box('n2')] }] }, null, 2);
    const key = await kept.write(null, 'Legacy', v1);
    await store.openProject(key);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^"Legacy" carries 1 saved version/);
    await store.saveProject();
    expect((await kept.list()).map((p) => p.name).sort()).toEqual(['Legacy', 'Legacy - First draft']);
  });
});

