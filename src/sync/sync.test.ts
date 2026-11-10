// The sync engine against an in-memory store and a fake remote, the merge, and
// the Drive client against a fake fetch.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDoc, parseDoc, serializeDoc } from '../model/file';
import { makeShape, newId } from '../model/ops';
import type { Doc, SceneNode } from '../model/types';
import { MemoryProjects } from '../state/projects';
import { DriveRemote, LARGE_UPLOAD } from './drive';
import { emptyRobot } from '../robot/types';
import { bindRecords, MemorySyncState, synchronize } from './engine';
import type { DeletePlan, Remote, RemoteFile, SyncReport } from './engine';
import { authUrl, challengeOf, revoke } from './google';
import { mergeDocs } from './merge';

vi.mock('../platform', () => ({ isDesktop: () => false, isAndroid: () => false, hasKeychain: () => false, oauthStart: async () => ({ redirect: 'http://127.0.0.1:0/', port: 0 }), oauthWait: async () => '', oauthCancel: async () => {} }));

/** A remote that keeps files in memory and counts what it was asked to do. */
class FakeRemote implements Remote {
  files = new Map<string, { file: RemoteFile; text: string }>();
  calls = { list: 0, download: 0, upload: 0, remove: 0 };
  failOn: string | null = null;
  failAll = false;
  /** Run once, in the middle of the next download: something that happens while a pass is under way. */
  meanwhile: (() => Promise<void>) | null = null;
  private serial = 0;
  async list(): Promise<RemoteFile[]> {
    this.calls.list++;
    return [...this.files.values()].map((f) => f.file);
  }
  async download(file: RemoteFile): Promise<string> {
    this.calls.download++;
    const run = this.meanwhile;
    this.meanwhile = null;
    await run?.();
    const found = this.files.get(file.id);
    if (!found) throw new Error('gone');
    return found.text;
  }
  async upload(existing: RemoteFile | null, name: string, text: string, meta: { projectId: string; revision: string | null }): Promise<RemoteFile> {
    this.calls.upload++;
    if (this.failAll || this.failOn === meta.projectId) throw new Error(`cannot upload ${name}`);
    const id = existing?.id ?? `remote-${++this.serial}`;
    const file: RemoteFile = { id, name: `${name}.plastikcad`, projectId: meta.projectId, revision: meta.revision, modified: Date.now() };
    this.files.set(id, { file, text });
    return file;
  }
  async remove(file: RemoteFile): Promise<void> {
    this.calls.remove++;
    this.files.delete(file.id);
  }
  /** Puts a design there as another device would have. */
  put(doc: Doc): RemoteFile {
    const id = `remote-${++this.serial}`;
    const file: RemoteFile = { id, name: `${doc.name}.plastikcad`, projectId: doc.id, revision: doc.revision ?? null, modified: Date.now() };
    this.files.set(id, { file, text: serializeDoc(doc) });
    return file;
  }
  /** Replaces a design there as another device would. */
  replace(doc: Doc): void {
    const entry = [...this.files.values()].find((f) => f.file.projectId === doc.id)!;
    entry.text = serializeDoc(doc);
    entry.file = { ...entry.file, revision: doc.revision ?? null };
  }
  textOf(projectId: string): string | undefined {
    return [...this.files.values()].find((f) => f.file.projectId === projectId)?.text;
  }
}

/** A remote that can also say how a file stands now, as Drive can. */
class StatRemote extends FakeRemote {
  async stat(file: RemoteFile): Promise<RemoteFile | null> {
    return this.files.get(file.id)?.file ?? null;
  }
}

const box = (id: string, x = 0): SceneNode => ({ ...makeShape('box'), id, pos: [x, 0, 10] });
const design = (id: string, name: string, nodes: SceneNode[], revision = newId()): Doc => ({ ...emptyDoc(), id, name, scene: nodes, revision, device: 'device0a' });
/** The same design, changed: new nodes and a new revision following the old. */
const edited = (doc: Doc, nodes: SceneNode[], name = doc.name): Doc => ({ ...doc, name, scene: nodes, revision: newId(), parent: doc.revision });

let local: MemoryProjects;
let remote: FakeRemote;
let state: MemorySyncState;
const sync = (): Promise<SyncReport> => synchronize(local, remote, state, { device: 'device0a' });
const localDoc = async (projectId: string): Promise<Doc | undefined> => {
  for (const info of await local.list()) if (info.id === projectId) return parseDoc(await local.read(info.key));
  return undefined;
};

beforeEach(() => {
  local = new MemoryProjects();
  remote = new FakeRemote();
  state = new MemorySyncState();
});

describe('sync engine', () => {
  it('uploads what is new here and downloads what is new there, then has nothing to do', async () => {
    const mine = design('project1', 'Mine', [box('a')]);
    await local.write(null, mine.name, serializeDoc(mine));
    const theirs = design('project2', 'Theirs', [box('b')]);
    remote.put(theirs);
    const report = await sync();
    expect(report.uploaded).toEqual(['Mine']);
    expect(report.downloaded).toEqual(['Theirs']);
    expect(remote.textOf('project1')).toBe(serializeDoc(mine));
    expect((await localDoc('project2'))?.scene.map((n) => n.id)).toEqual(['b']);
    expect(report.changedKeys).toEqual(['mem:2']);
    expect(state.records.size).toBe(2);
    remote.calls = { list: 0, download: 0, upload: 0, remove: 0 };
    const second = await sync();
    expect(second).toMatchObject({ uploaded: [], downloaded: [], merged: [], kept: [], changedKeys: [] });
    expect(remote.calls).toEqual({ list: 1, download: 0, upload: 0, remove: 0 });
  });

  it('copies a change made on one side to the other, renaming the file to follow', async () => {
    const doc = design('project1', 'Plate', [box('a')]);
    const key = await local.write(null, doc.name, serializeDoc(doc));
    await sync();
    // Edited here.
    const v2 = edited(doc, [box('a', 5)]);
    await local.write(key, v2.name, serializeDoc(v2));
    expect((await sync()).uploaded).toEqual(['Plate']);
    expect(parseDoc(remote.textOf('project1')!).scene[0].pos[0]).toBe(5);
    // Edited and renamed there.
    const v3 = edited(v2, [box('a', 7)], 'Base plate');
    const file = [...remote.files.values()].find((f) => f.file.projectId === 'project1')!;
    file.text = serializeDoc(v3);
    file.file = { ...file.file, revision: v3.revision!, name: 'Base plate.plastikcad' };
    const report = await sync();
    expect(report.downloaded).toEqual(['Base plate']);
    expect(report.changedKeys).toEqual([key]);
    const here = await localDoc('project1');
    expect(here?.name).toBe('Base plate');
    expect(here?.scene[0].pos[0]).toBe(7);
    expect((await local.list())[0].name).toBe('Base plate');
  });

  it('merges changes to different objects made on both sides', async () => {
    const doc = design('project1', 'Plate', [box('a'), box('b')]);
    const key = await local.write(null, doc.name, serializeDoc(doc));
    await sync();
    const here = edited(doc, [box('a', 5), box('b'), box('c')]);
    await local.write(key, here.name, serializeDoc(here));
    const there = edited(doc, [box('a'), box('b', -5)]);
    const file = [...remote.files.values()][0];
    file.text = serializeDoc(there);
    file.file = { ...file.file, revision: there.revision! };
    const report = await sync();
    expect(report.merged).toEqual(['Plate']);
    expect(report.kept).toEqual([]);
    const merged = (await localDoc('project1'))!;
    expect(merged.scene.map((n) => [n.id, n.pos[0]])).toEqual([
      ['a', 5],
      ['b', -5],
      ['c', 0],
    ]);
    expect(merged.revision).not.toBe(here.revision);
    expect(merged.parent).toBe(here.revision);
    expect(merged.device).toBe('device0a');
    expect(remote.textOf('project1')).toBe(serializeDoc(merged));
    // Both sides now agree.
    expect((await sync()).changedKeys).toEqual([]);
  });

  it('keeps both versions when the same object was changed on both sides', async () => {
    const doc = design('project1', 'Plate', [box('a')]);
    const key = await local.write(null, doc.name, serializeDoc(doc));
    await sync();
    const here = edited(doc, [box('a', 5)]);
    await local.write(key, here.name, serializeDoc(here));
    const there = edited(doc, [box('a', -5)]);
    const file = [...remote.files.values()][0];
    file.text = serializeDoc(there);
    file.file = { ...file.file, revision: there.revision! };
    const report = await sync();
    expect(report.kept).toEqual(['Plate']);
    const names = (await local.list()).map((p) => p.name).sort();
    expect(names).toEqual(['Plate', 'Plate (other device)']);
    // The local version went up over the remote one; the remote version is a new project on both sides.
    expect(parseDoc(remote.textOf('project1')!).scene[0].pos[0]).toBe(5);
    const copy = (await local.list()).find((p) => p.name === 'Plate (other device)')!;
    expect(copy.id).not.toBe('project1');
    expect(parseDoc(await local.read(copy.key)).scene[0].pos[0]).toBe(-5);
    expect(remote.textOf(copy.id!)).toBeDefined();
    expect(remote.files.size).toBe(2);
    expect((await sync()).changedKeys).toEqual([]);
  });

  it('carries deletions across, unless the other side changed the project since', async () => {
    const a = design('project1', 'A', [box('a')]);
    const b = design('project2', 'B', [box('b')]);
    const c = design('project3', 'C', [box('c')]);
    const keyA = await local.write(null, a.name, serializeDoc(a));
    const keyB = await local.write(null, b.name, serializeDoc(b));
    const keyC = await local.write(null, c.name, serializeDoc(c));
    await sync();
    // A deleted here; B deleted there; C deleted there but edited here.
    await local.remove(keyA);
    const fileB = [...remote.files.values()].find((f) => f.file.projectId === 'project2')!;
    remote.files.delete(fileB.file.id);
    const fileC = [...remote.files.values()].find((f) => f.file.projectId === 'project3')!;
    remote.files.delete(fileC.file.id);
    const c2 = edited(c, [box('c', 9)]);
    await local.write(keyC, c2.name, serializeDoc(c2));
    const report = await sync();
    expect(report.deletedRemotely).toEqual(['A']);
    expect(report.deletedLocally).toEqual(['B']);
    expect(report.removedKeys).toEqual([keyB]);
    expect(report.uploaded).toEqual(['C']);
    expect(remote.textOf('project1')).toBeUndefined();
    expect(await localDoc('project2')).toBeUndefined();
    expect(parseDoc(remote.textOf('project3')!).scene[0].pos[0]).toBe(9);
    expect([...state.records.keys()]).toEqual(['project3']);
  });

  it('records a project both sides already hold identically, and keeps both when they differ with no common base', async () => {
    const same = design('project1', 'Same', [box('a')]);
    await local.write(null, same.name, serializeDoc(same));
    remote.put(same);
    const other = design('project2', 'Other', [box('b')]);
    await local.write(null, other.name, serializeDoc(other));
    remote.put(edited(other, [box('b', 3)]));
    const report = await sync();
    expect(report.uploaded).toEqual([]);
    expect(report.kept).toEqual(['Other']);
    expect(state.records.has('project1')).toBe(true);
    expect((await local.list()).length).toBe(3);
  });

  it('goes on past a project that fails and reports the failure beside what it did', async () => {
    await local.write(null, 'Bad', serializeDoc(design('project1', 'Bad', [box('a')])));
    await local.write(null, 'Good', serializeDoc(design('project2', 'Good', [box('b')])));
    remote.failOn = 'project1';
    const report = await sync();
    expect(report.errors.map(String)).toEqual(['Error: cannot upload Bad']);
    expect(report.uploaded).toEqual(['Good']);
    expect(remote.textOf('project2')).toBeDefined();
    expect(remote.textOf('project1')).toBeUndefined();
    remote.failOn = null;
    expect((await sync()).uploaded).toEqual(['Bad']);
  });

  it('leaves files without an id alone', async () => {
    const text = serializeDoc(design('project1', 'Old', [box('a')])).replace(/ {2}"id": "project1",\n/, '');
    await local.write(null, 'Old', text);
    const report = await sync();
    expect(report.uploaded).toEqual([]);
    expect(remote.files.size).toBe(0);
  });
});

describe('what a pass must not destroy', () => {
  const three = async (): Promise<void> => {
    for (const [id, name] of [['project1', 'A'], ['project2', 'B'], ['project3', 'C']]) await local.write(null, name, serializeDoc(design(id, name, [box(id)])));
    await sync();
  };

  it('holds a deletion of most of the projects until someone says, and then deletes or restores as told', async () => {
    await three();
    // The remote folder was emptied: trashed in the Drive, or another account signed in to.
    const empty = new FakeRemote();
    const held = await synchronize(local, empty, state, { device: 'device0a' });
    expect(held.held.sort()).toEqual(['A', 'B', 'C']);
    expect(held.deletedLocally).toEqual([]);
    expect((await local.list()).length).toBe(3);
    expect(empty.files.size).toBe(0);

    // Asked, and told to keep them: they go back up.
    const asked: DeletePlan[] = [];
    const restored = await synchronize(local, empty, state, { device: 'device0a', confirmDeletes: async (plan) => (asked.push(plan), false) });
    expect(asked).toEqual([{ side: 'local', names: ['A', 'B', 'C'], total: 3 }]);
    expect(restored.uploaded.sort()).toEqual(['A', 'B', 'C']);
    expect((await local.list()).length).toBe(3);
    expect(empty.files.size).toBe(3);

    // Told to delete: they go.
    const again = new FakeRemote();
    const deleted = await synchronize(local, again, state, { device: 'device0a', confirmDeletes: async () => true });
    expect(deleted.deletedLocally.sort()).toEqual(['A', 'B', 'C']);
    expect((await local.list()).length).toBe(0);
  });

  it('asks the same before trashing most of the remote copies, and brings them back when told to keep them', async () => {
    await three();
    // The projects folder was changed to an empty one.
    const emptyFolder = new MemoryProjects();
    const held = await synchronize(emptyFolder, remote, state, { device: 'device0a' });
    expect(held.held.sort()).toEqual(['A', 'B', 'C']);
    expect(remote.files.size).toBe(3);
    const restored = await synchronize(emptyFolder, remote, state, { device: 'device0a', confirmDeletes: async (plan) => plan.side !== 'remote' });
    expect(restored.downloaded.sort()).toEqual(['A', 'B', 'C']);
    expect(remote.files.size).toBe(3);
    expect((await emptyFolder.list()).length).toBe(3);
  });

  it('lets a single deletion through without asking', async () => {
    await three();
    const fileB = [...remote.files.values()].find((f) => f.file.projectId === 'project2')!;
    remote.files.delete(fileB.file.id);
    const report = await synchronize(local, remote, state, { device: 'device0a', confirmDeletes: async () => expect.unreachable('one of three is not a mass deletion') });
    expect(report.deletedLocally).toEqual(['B']);
  });

  it('forgets what was agreed when either place is another than it was, so an empty new place is filled rather than obeyed', async () => {
    await three();
    expect(await bindRecords(state, null, 'folder-1\n/home/me/PlastikCAD')).toBe(false);
    expect(await bindRecords(state, 'folder-1\n/home/me/PlastikCAD', 'folder-1\n/home/me/PlastikCAD')).toBe(false);
    expect(state.records.size).toBe(3);
    // Another account's folder: nothing is deleted here, everything goes up.
    expect(await bindRecords(state, 'folder-1\n/home/me/PlastikCAD', 'folder-2\n/home/me/PlastikCAD')).toBe(true);
    const other = new FakeRemote();
    const report = await synchronize(local, other, state, { device: 'device0a' });
    expect(report.uploaded.sort()).toEqual(['A', 'B', 'C']);
    expect(report.deletedLocally).toEqual([]);
    // Another projects folder: nothing is trashed there, everything comes down.
    expect(await bindRecords(state, 'folder-2\n/home/me/PlastikCAD', 'folder-2\n/mnt/usb')).toBe(true);
    const fresh = new MemoryProjects();
    const down = await synchronize(fresh, other, state, { device: 'device0a' });
    expect(down.downloaded.sort()).toEqual(['A', 'B', 'C']);
    expect(down.deletedRemotely).toEqual([]);
    expect(other.files.size).toBe(3);
  });

  it('leaves a project saved while the pass ran for the next pass, which then merges it', async () => {
    const v1 = design('project1', 'Plate', [box('a')]);
    const key = await local.write(null, v1.name, serializeDoc(v1));
    await sync();
    // Another device moved the box; while this pass downloads that, autosave writes a second object here.
    remote.replace(edited(v1, [box('a', -5)]));
    const here = edited(v1, [box('a'), box('mine')]);
    remote.meanwhile = async () => void (await local.write(key, here.name, serializeDoc(here)));
    const report = await sync();
    expect(report.busy).toEqual(['Plate']);
    expect(report.changedKeys).toEqual([]);
    expect(parseDoc(await local.read(key)).revision).toBe(here.revision);
    const next = await sync();
    expect(next.merged).toEqual(['Plate']);
    expect(parseDoc(await local.read(key)).scene.map((n) => [n.id, n.pos[0]])).toEqual([
      ['a', -5],
      ['mine', 0],
    ]);
  });

  it('does not delete here a project saved while the pass ran', async () => {
    await three();
    const info = (await local.list()).find((p) => p.id === 'project2')!;
    const fileB = [...remote.files.values()].find((f) => f.file.projectId === 'project2')!;
    remote.files.delete(fileB.file.id);
    // A download for another project gives the save its moment.
    remote.replace(edited(design('project1', 'A', [box('project1')], parseDoc(await local.read((await local.list()).find((p) => p.id === 'project1')!.key)).revision), [box('project1', 4)]));
    remote.meanwhile = async () => void (await local.write(info.key, 'B', serializeDoc(edited(parseDoc(await local.read(info.key)), [box('project2', 7)]))));
    const report = await sync();
    expect(report.busy).toEqual(['B']);
    expect(report.deletedLocally).toEqual([]);
    expect((await sync()).uploaded).toEqual(['B']);
    expect(parseDoc(remote.textOf('project2')!).scene[0].pos[0]).toBe(7);
  });

  it('does not replace a remote file another device replaced since the listing', async () => {
    const stat = new StatRemote();
    const v1 = design('project1', 'Plate', [box('a')]);
    const key = await local.write(null, v1.name, serializeDoc(v1));
    await synchronize(local, stat, state, { device: 'device0a' });
    await local.write(key, 'Plate', serializeDoc(edited(v1, [box('a', 5)])));
    // The other device uploads between this pass's listing and its upload.
    const there = edited(v1, [box('a'), box('theirs')]);
    const list = stat.list.bind(stat);
    stat.list = async () => {
      const listed = await list();
      stat.replace(there);
      return listed;
    };
    const report = await synchronize(local, stat, state, { device: 'device0a' });
    expect(report.busy).toEqual(['Plate']);
    expect(parseDoc(stat.textOf('project1')!).revision).toBe(there.revision);
    stat.list = list;
    const next = await synchronize(local, stat, state, { device: 'device0a' });
    expect(next.merged).toEqual(['Plate']);
    expect(parseDoc(stat.textOf('project1')!).scene.map((n) => n.id)).toEqual(['a', 'theirs']);
  });

  it('still says what it wrote here when another project fails', async () => {
    const open = design('project1', 'Open', [box('a')]);
    const key = await local.write(null, open.name, serializeDoc(open));
    await sync();
    remote.replace(edited(open, [box('a', 9)]));
    await local.write(null, 'Bad', serializeDoc(design('project2', 'Bad', [box('b')])));
    remote.failOn = 'project2';
    const report = await sync();
    expect(report.errors.length).toBe(1);
    expect(report.changedKeys).toEqual([key]);
    expect(report.downloaded).toEqual(['Open']);
  });

  it('makes one copy of a conflict however often the pass has to be tried', async () => {
    const v1 = design('project1', 'Plate', [box('a')]);
    const key = await local.write(null, v1.name, serializeDoc(v1));
    await sync();
    await local.write(key, 'Plate', serializeDoc(edited(v1, [box('a', 5)])));
    remote.replace(edited(v1, [box('a', -5)]));
    remote.failAll = true;
    for (let i = 0; i < 3; i++) expect((await sync()).errors.length).toBeGreaterThan(0);
    expect((await local.list()).map((p) => p.name).sort()).toEqual(['Plate', 'Plate (other device)']);
    remote.failAll = false;
    await sync();
    expect((await sync()).errors).toEqual([]);
    expect((await local.list()).map((p) => p.name).sort()).toEqual(['Plate', 'Plate (other device)']);
    expect([...remote.files.values()].map((f) => f.file.name).sort()).toEqual(['Plate (other device).plastikcad', 'Plate.plastikcad']);
    expect(state.records.size).toBe(2);
    expect((await sync()).uploaded).toEqual([]);
  });

  it('only notes a save both sides already hold when its own record of it was lost', async () => {
    const v1 = design('project1', 'Plate', [box('a')]);
    const key = await local.write(null, v1.name, serializeDoc(v1));
    await sync();
    const stale = { ...state.records.get('project1')! };
    const v2 = edited(v1, [box('a', 5)]);
    await local.write(key, 'Plate', serializeDoc(v2));
    await sync();
    // The app quit between the upload and noting it.
    state.records.set('project1', stale);
    const report = await sync();
    expect(report.merged).toEqual([]);
    expect(report.changedKeys).toEqual([]);
    expect(parseDoc(await local.read(key)).revision).toBe(v2.revision);
    expect(state.records.get('project1')!.revision).toBe(v2.revision);
  });

  it('keeps what a download or a merge replaces here as an earlier save of the project', async () => {
    const v1 = design('project1', 'Plate', [box('a')]);
    const key = await local.write(null, v1.name, serializeDoc(v1));
    await sync();
    expect(await local.versions('project1')).toEqual([]);
    // Changed on the other device only: what was here is kept before the download takes its place.
    remote.replace(edited(v1, [box('a', -5)]));
    await sync();
    const [kept] = await local.versions('project1');
    expect(parseDoc(await local.read(kept.key)).revision).toBe(v1.revision);
    expect(parseDoc(await local.read(key)).scene[0].pos[0]).toBe(-5);
    // An upload replaces nothing here, and keeps nothing.
    await local.write(key, 'Plate', serializeDoc(edited(parseDoc(await local.read(key)), [box('a', 2)])));
    await sync();
    expect((await local.versions('project1')).length).toBe(1);
  });

  it('puts what was deleted elsewhere in the store\'s trash where it has one', async () => {
    const discarded: string[] = [];
    const withTrash = Object.assign(local, { discard: async (k: string) => void (discarded.push(k), await local.remove(k)) });
    await three();
    const fileB = [...remote.files.values()].find((f) => f.file.projectId === 'project2')!;
    remote.files.delete(fileB.file.id);
    const report = await synchronize(withTrash, remote, state, { device: 'device0a' });
    expect(discarded).toEqual(report.removedKeys);
    expect(discarded.length).toBe(1);
  });

  it('names the project a newer build saved, and leaves this device\'s copy of it alone', async () => {
    const v1 = design('project1', 'Plate', [box('a')]);
    const key = await local.write(null, v1.name, serializeDoc(v1));
    await sync();
    const newer = edited(v1, [box('a', 3)]);
    remote.replace(newer);
    const entry = [...remote.files.values()][0];
    entry.text = entry.text.replace('"shape": "box"', '"shape": "hyperbox"');
    const report = await sync();
    expect(report.errors.map(String)).toEqual(['Error: "Plate": This design was saved by a newer version of the app. Update to open it.']);
    expect(parseDoc(await local.read(key)).revision).toBe(v1.revision);
  });
});

describe('three-way merge', () => {
  const base = (): Doc => design('basedoc1', 'Base', [box('a'), box('b'), box('c')], 'r1');

  it('takes each side\'s changes, deletions included, and slots remote additions where they were', () => {
    const b = base();
    const local = { ...b, scene: [box('a', 1), box('c')] }; // b deleted here, a moved
    const remote = { ...b, scene: [box('a'), box('x'), box('b'), box('c', 2)] }; // x added before b, c moved there
    const { doc, conflicts } = mergeDocs(b, local, remote);
    expect(conflicts).toBe(0);
    expect(doc.scene.map((n) => [n.id, n.pos[0]])).toEqual([
      ['a', 1],
      ['x', 0],
      ['c', 2],
    ]);
  });

  it('counts an object changed differently on both sides as a conflict and keeps the local one', () => {
    const b = base();
    const { doc, conflicts } = mergeDocs(b, { ...b, scene: [box('a', 1), box('b'), box('c')] }, { ...b, scene: [box('a', 2), box('b'), box('c')] });
    expect(conflicts).toBe(1);
    expect(doc.scene[0].pos[0]).toBe(1);
    // The same change on both sides is no conflict.
    expect(mergeDocs(b, { ...b, scene: [box('a', 3)] }, { ...b, scene: [box('a', 3)] }).conflicts).toBe(0);
  });

  it('keeps an edit over a deletion, takes a rename from the side that renamed, and unites assets', () => {
    const b = base();
    const local = { ...b, scene: [box('b'), box('c')], assets: { 'image-aaa-1': { kind: 'image', name: 'a', mime: 'image/png', data: '', width: 1, height: 1 } } } as Doc;
    const remote = { ...b, name: 'Renamed', scene: [box('a', 4), box('b'), box('c')], assets: { 'image-bbb-1': { kind: 'image', name: 'b', mime: 'image/png', data: '', width: 1, height: 1 } } } as Doc;
    const { doc } = mergeDocs(b, local, remote);
    expect(doc.name).toBe('Renamed');
    expect(doc.scene.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(Object.keys(doc.assets).sort()).toEqual(['image-aaa-1', 'image-bbb-1']);
    // Without a base, an object that differs on the two sides is a conflict; one only one side has is an addition.
    expect(mergeDocs(null, local, remote).conflicts).toBe(0);
    expect(mergeDocs(null, { ...local, scene: [box('b', 1)] }, remote).conflicts).toBe(1);
  });

  it('takes the robot from the side that changed it, and counts one changed differently on both as a conflict', () => {
    const b = { ...base(), robot: { ...emptyRobot(), root: 'a' } };
    const fixed = { ...b, robot: { ...b.robot, base: 'fixed' as const } };
    const rooted = { ...b, robot: { ...b.robot, root: 'b' } };
    expect(mergeDocs(b, b, fixed)).toMatchObject({ conflicts: 0, doc: { robot: { base: 'fixed' } } });
    expect(mergeDocs(b, rooted, b)).toMatchObject({ conflicts: 0, doc: { robot: { root: 'b' } } });
    expect(mergeDocs(b, rooted, fixed)).toMatchObject({ conflicts: 1, doc: { robot: { root: 'b', base: 'free' } } });
    expect(mergeDocs(b, fixed, fixed).conflicts).toBe(0);
    // Without a base there is no telling who changed it.
    expect(mergeDocs(null, rooted, fixed).conflicts).toBe(1);
  });
});

describe('Google sign-in pieces', () => {
  it('derives the PKCE challenge the way RFC 7636 shows', async () => {
    expect(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const url = new URL(authUrl('http://127.0.0.1:1234/', 'chal', 'st'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1234/');
  });
});

describe('revoking the grant', () => {
  it('posts the refresh token to Google and shrugs off failure', async () => {
    const calls: { url: string; body: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      if (calls.length === 1) return new Response('{}', { status: 200 });
      throw new Error('offline');
    }) as typeof fetch;
    try {
      const tokens = { access: 'a', refresh: 'r-token', expires: 0, email: null };
      expect(await revoke(tokens)).toBe(true);
      expect(calls[0]).toEqual({ url: 'https://oauth2.googleapis.com/revoke', body: 'token=r-token' });
      expect(await revoke(tokens)).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('Google Drive remote', () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const answers: ((url: string, init?: RequestInit) => unknown)[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected request ${url}`);
    const value = answer(url, init);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  beforeEach(() => {
    calls.length = 0;
    answers.length = 0;
  });

  it('makes its folder when there is none, lists page by page and keeps only designs', async () => {
    const drive = new DriveRemote(fetch);
    answers.push(() => ({ files: [] }), () => ({ id: 'folder1' }));
    answers.push(() => ({ files: [{ id: 'f1', name: 'A.plastikcad', modifiedTime: '2026-10-17T10:00:00Z', appProperties: { projectId: 'project1', revision: 'r1' } }, { id: 'f2', name: 'notes.txt' }], nextPageToken: 'more' }));
    answers.push(() => ({ files: [{ id: 'f3', name: 'B.plastikcad' }] }));
    const files = await drive.list();
    expect(calls[1].init?.method).toBe('POST');
    expect(JSON.parse(calls[1].init!.body as string)).toMatchObject({ name: 'PlastikCAD', parents: ['root'] });
    expect(decodeURIComponent(calls[2].url.replace(/\+/g, ' '))).toContain("'folder1' in parents and trashed = false");
    expect(calls[3].url).toContain('pageToken=more');
    expect(files).toEqual([
      { id: 'f1', name: 'A.plastikcad', projectId: 'project1', revision: 'r1', modified: Date.parse('2026-10-17T10:00:00Z') },
      { id: 'f3', name: 'B.plastikcad', projectId: null, revision: null, modified: 0 },
    ]);
    // The folder is remembered.
    answers.push(() => ({ files: [] }));
    await drive.list();
    expect(calls.length).toBe(5);
  });

  /** A remote that does not really wait before trying again, and says how long it would have. */
  const waits: number[] = [];
  const patient = (): DriveRemote => {
    waits.length = 0;
    return new DriveRemote(fetch, undefined, null, async (ms) => void waits.push(ms));
  };
  const refusal = (status: number, reason?: string, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify({ error: { message: `no (${status})`, errors: reason ? [{ reason }] : [] } }), { status, headers: { 'content-type': 'application/json', ...headers } });
  const folder = () => ({ files: [{ id: 'folder1', name: 'PlastikCAD' }] });

  it('tries again after a wait when Google puts a request off, for as long as it asks', async () => {
    const drive = patient();
    // Too many requests, with a time to come back at; too fast, said the other way; and a failure on Google's side.
    answers.push(() => refusal(429, undefined, { 'retry-after': '2' }), () => refusal(403, 'userRateLimitExceeded'), () => refusal(503), folder, () => ({ files: [] }));
    expect(await drive.list()).toEqual([]);
    expect(waits.length).toBe(3);
    expect(waits[0]).toBeGreaterThanOrEqual(2000);
    expect(waits[0]).toBeLessThan(2300);
    // With no time asked for: a second, then two, each with a little added.
    expect(Math.floor(waits[1] / 1000)).toBe(2);
    expect(Math.floor(waits[2] / 1000)).toBe(4);
  });

  it('gives up after a few tries, and does not try a real refusal again at all', async () => {
    const down = patient();
    for (let i = 0; i < 5; i++) answers.push(() => refusal(503));
    await expect(down.list()).rejects.toThrow('no (503)');
    expect(waits.length).toBe(4);
    const refused = patient();
    answers.push(() => refusal(403, 'insufficientPermissions'));
    await expect(refused.list()).rejects.toThrow('no (403)');
    expect(waits.length).toBe(0);
  });

  it('tries a request that did not get through again, unless it makes something', async () => {
    const lost = () => {
      throw new TypeError('Failed to fetch');
    };
    const drive = patient();
    answers.push(lost, folder, lost, () => ({ files: [] }));
    expect(await drive.list()).toEqual([]);
    expect(waits.length).toBe(2);
    // A new file may have been made although no answer came back: it is left to the next sync, not made twice.
    answers.push(lost);
    await expect(drive.upload(null, 'Lid', '{}', { projectId: 'project1', revision: 'r1' })).rejects.toThrow('Failed to fetch');
    expect(waits.length).toBe(2);
    // What changes a file that is there can be sent again.
    answers.push(lost, () => ({ id: 'f1', name: 'Lid.plastikcad', appProperties: { projectId: 'project1', revision: 'r2' } }));
    const existing = { id: 'f1', name: 'Lid.plastikcad', projectId: 'project1', revision: 'r1', modified: 0 };
    expect((await drive.upload(existing, 'Lid', '{}', { projectId: 'project1', revision: 'r2' })).revision).toBe('r2');
  });

  const big = 'x'.repeat(LARGE_UPLOAD + 1000);
  const session = (): Response => new Response(null, { status: 200, headers: { location: 'https://upload.example/session1' } });
  const done = () => ({ id: 'f9', name: 'Big.plastikcad', appProperties: { projectId: 'project9', revision: 'r1' } });
  const lengthOf = (body: unknown): number => (body as Uint8Array).length;

  it('sends a large design through the upload that can be gone on with: what is coming first, then the design', async () => {
    const drive = patient();
    answers.push(folder, session, done);
    const file = await drive.upload(null, 'Big', big, { projectId: 'project9', revision: 'r1' });
    expect(file).toMatchObject({ id: 'f9', projectId: 'project9', revision: 'r1' });
    expect(calls[1].url).toContain('/upload/drive/v3/files?uploadType=resumable');
    expect(calls[1].init?.method).toBe('POST');
    expect(calls[1].init?.headers).toMatchObject({ 'x-upload-content-length': String(big.length) });
    expect(JSON.parse(calls[1].init!.body as string)).toMatchObject({ name: 'Big.plastikcad', parents: ['folder1'], appProperties: { projectId: 'project9', revision: 'r1' } });
    expect(calls[2]).toMatchObject({ url: 'https://upload.example/session1', init: { method: 'PUT' } });
    expect(lengthOf(calls[2].init?.body)).toBe(big.length);
    // Over a file that is there: the same, and it stays where it is.
    answers.push(session, done);
    await drive.upload(file, 'Big', big, { projectId: 'project9', revision: 'r2' });
    expect(calls[3].url).toContain('/upload/drive/v3/files/f9?uploadType=resumable');
    expect(calls[3].init?.method).toBe('PATCH');
    expect(JSON.parse(calls[3].init!.body as string).parents).toBeUndefined();
    // A small design goes up in one request, as it always has.
    answers.push(done);
    await drive.upload(file, 'Big', '{}', { projectId: 'project9', revision: 'r3' });
    expect(calls[5].url).toContain('uploadType=multipart');
    expect(calls.length).toBe(6);
  });

  it('goes on with a large upload from where it broke off', async () => {
    const drive = patient();
    const lost = () => {
      throw new TypeError('Failed to fetch');
    };
    // The connection drops with the first megabyte across; Drive says so when asked, and takes the rest.
    answers.push(folder, session, lost, () => new Response(null, { status: 308, headers: { range: 'bytes=0-1048575' } }), done);
    expect((await drive.upload(null, 'Big', big, { projectId: 'project9', revision: 'r1' })).id).toBe('f9');
    expect(waits.length).toBe(1);
    expect(calls[3].init?.headers).toMatchObject({ 'content-range': `bytes */${big.length}` });
    expect(calls[4].init?.headers).toMatchObject({ 'content-range': `bytes 1048576-${big.length - 1}/${big.length}` });
    expect(lengthOf(calls[4].init?.body)).toBe(big.length - 1048576);
    // All of it had arrived when the answer was lost: asking is enough.
    answers.push(session, lost, done);
    expect((await drive.upload({ id: 'f9', name: 'Big.plastikcad', projectId: 'project9', revision: 'r1', modified: 0 }, 'Big', big, { projectId: 'project9', revision: 'r2' })).id).toBe('f9');
    // Drive no longer knows the upload: said as it is, for the next sync to start afresh.
    answers.push(session, () => refusal(503), () => refusal(404));
    await expect(drive.upload({ id: 'f9', name: 'Big.plastikcad', projectId: 'project9', revision: 'r1', modified: 0 }, 'Big', big, { projectId: 'project9', revision: 'r3' })).rejects.toThrow('Google Drive could not upload Big: no (404)');
  });

  it('sends a large design in one piece where Drive gives no address to go on with', async () => {
    const drive = patient();
    answers.push(folder, () => new Response(null, { status: 200 }), done);
    expect((await drive.upload(null, 'Big', big, { projectId: 'project9', revision: 'r1' })).id).toBe('f9');
    expect(calls[2].url).toContain('uploadType=multipart');
    expect((calls[2].init?.body as string).length).toBeGreaterThan(big.length);
  });

  it('keeps the parts in a folder inside the app folder', async () => {
    const app = new DriveRemote(fetch);
    const parts = new DriveRemote(fetch, 'Parts', app);
    answers.push(() => ({ files: [{ id: 'folder1', name: 'PlastikCAD' }] }));
    answers.push(() => ({ files: [] }), () => ({ id: 'folder2' }));
    answers.push(() => ({ files: [] }));
    expect(await parts.list()).toEqual([]);
    expect(decodeURIComponent(calls[0].url.replace(/\+/g, ' '))).toContain("'root' in parents");
    expect(decodeURIComponent(calls[1].url.replace(/\+/g, ' '))).toContain("name = 'Parts' and mimeType = 'application/vnd.google-apps.folder' and 'folder1' in parents");
    expect(JSON.parse(calls[2].init!.body as string)).toMatchObject({ name: 'Parts', parents: ['folder1'] });
    expect(decodeURIComponent(calls[3].url.replace(/\+/g, ' '))).toContain("'folder2' in parents");
  });

  it('uploads as multipart, creating in the folder or replacing in place, and trashes to delete', async () => {
    const drive = new DriveRemote(fetch);
    answers.push(() => ({ files: [{ id: 'folder1', name: 'PlastikCAD' }] }));
    answers.push(() => ({ id: 'new1', name: 'Plate.plastikcad', appProperties: { projectId: 'project1', revision: 'r1' } }));
    const made = await drive.upload(null, 'Plate', '{"x":1}', { projectId: 'project1', revision: 'r1' });
    expect(made).toMatchObject({ id: 'new1', projectId: 'project1', revision: 'r1' });
    const create = calls[1];
    expect(create.url).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=multipart/);
    expect(create.init?.method).toBe('POST');
    const body = create.init!.body as string;
    const boundary = /boundary=(.+)$/.exec(create.init!.headers!['content-type' as keyof HeadersInit] as string)![1];
    expect(body.split(`--${boundary}`).length).toBe(4);
    expect(body).toContain('"parents":["folder1"]');
    expect(body).toContain('"appProperties":{"app":"plastikcad","projectId":"project1","revision":"r1"}');
    expect(body).toContain('\r\n\r\n{"x":1}\r\n');

    answers.push(() => ({ id: 'new1', name: 'Plate.plastikcad', appProperties: { projectId: 'project1', revision: 'r2' } }));
    await drive.upload(made, 'Plate', '{"x":2}', { projectId: 'project1', revision: 'r2' });
    expect(calls[2].url).toContain('/upload/drive/v3/files/new1?uploadType=multipart');
    expect(calls[2].init?.method).toBe('PATCH');
    expect(calls[2].init!.body as string).not.toContain('parents');

    answers.push(() => ({ id: 'new1' }));
    await drive.remove(made);
    expect(calls[3].init).toMatchObject({ method: 'PATCH', body: '{"trashed":true}' });

    answers.push(() => new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), { status: 403 }));
    await expect(drive.download(made)).rejects.toThrow('Google Drive could not download Plate.plastikcad: Rate limit exceeded');
  });

  it('says how a file stands now: its revision, or nothing once it is trashed or gone', async () => {
    const drive = new DriveRemote(fetch);
    const file: RemoteFile = { id: 'f1', name: 'Plate.plastikcad', projectId: 'project1', revision: 'r1', modified: 0 };
    answers.push(() => ({ id: 'f1', name: 'Plate.plastikcad', appProperties: { projectId: 'project1', revision: 'r2' } }));
    expect(await drive.stat(file)).toMatchObject({ id: 'f1', revision: 'r2' });
    expect(calls[0].url).toContain('/files/f1?fields=');
    answers.push(() => ({ id: 'f1', name: 'Plate.plastikcad', trashed: true, appProperties: { projectId: 'project1', revision: 'r2' } }));
    expect(await drive.stat(file)).toBeNull();
    answers.push(() => new Response('{}', { status: 404 }));
    expect(await drive.stat(file)).toBeNull();
  });
});
