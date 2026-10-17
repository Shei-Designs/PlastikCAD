// The sync engine against an in-memory store and a fake remote, the merge, and
// the Drive client against a fake fetch.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDoc, parseDoc, serializeDoc } from '../model/file';
import { makeShape, newId } from '../model/ops';
import type { Doc, SceneNode } from '../model/types';
import { MemoryProjects } from '../state/projects';
import { DriveRemote } from './drive';
import { MemorySyncState, synchronize } from './engine';
import type { Remote, RemoteFile, SyncReport } from './engine';
import { authUrl, challengeOf, revoke } from './google';
import { mergeDocs } from './merge';

vi.mock('../platform', () => ({ isDesktop: () => false, oauthStart: async () => 0, oauthWait: async () => '', oauthCancel: async () => {} }));

/** A remote that keeps files in memory and counts what it was asked to do. */
class FakeRemote implements Remote {
  files = new Map<string, { file: RemoteFile; text: string }>();
  calls = { list: 0, download: 0, upload: 0, remove: 0 };
  failOn: string | null = null;
  private serial = 0;
  async list(): Promise<RemoteFile[]> {
    this.calls.list++;
    return [...this.files.values()].map((f) => f.file);
  }
  async download(file: RemoteFile): Promise<string> {
    this.calls.download++;
    const found = this.files.get(file.id);
    if (!found) throw new Error('gone');
    return found.text;
  }
  async upload(existing: RemoteFile | null, name: string, text: string, meta: { projectId: string; revision: string | null }): Promise<RemoteFile> {
    this.calls.upload++;
    if (this.failOn === meta.projectId) throw new Error(`cannot upload ${name}`);
    const id = existing?.id ?? `remote-${++this.serial}`;
    const file: RemoteFile = { id, name: `${name}.bashcad`, projectId: meta.projectId, revision: meta.revision, modified: Date.now() };
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
    const file: RemoteFile = { id, name: `${doc.name}.bashcad`, projectId: doc.id, revision: doc.revision ?? null, modified: Date.now() };
    this.files.set(id, { file, text: serializeDoc(doc) });
    return file;
  }
  textOf(projectId: string): string | undefined {
    return [...this.files.values()].find((f) => f.file.projectId === projectId)?.text;
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
    file.file = { ...file.file, revision: v3.revision!, name: 'Base plate.bashcad' };
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

  it('goes on past a project that fails and reports the failure at the end', async () => {
    await local.write(null, 'Bad', serializeDoc(design('project1', 'Bad', [box('a')])));
    await local.write(null, 'Good', serializeDoc(design('project2', 'Good', [box('b')])));
    remote.failOn = 'project1';
    await expect(sync()).rejects.toThrow(/cannot upload Bad/);
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
    answers.push(() => ({ files: [{ id: 'f1', name: 'A.bashcad', modifiedTime: '2026-10-17T10:00:00Z', appProperties: { projectId: 'project1', revision: 'r1' } }, { id: 'f2', name: 'notes.txt' }], nextPageToken: 'more' }));
    answers.push(() => ({ files: [{ id: 'f3', name: 'B.bashcad' }] }));
    const files = await drive.list();
    expect(calls[1].init?.method).toBe('POST');
    expect(JSON.parse(calls[1].init!.body as string)).toMatchObject({ name: 'BashCAD', parents: ['root'] });
    expect(decodeURIComponent(calls[2].url.replace(/\+/g, ' '))).toContain("'folder1' in parents and trashed = false");
    expect(calls[3].url).toContain('pageToken=more');
    expect(files).toEqual([
      { id: 'f1', name: 'A.bashcad', projectId: 'project1', revision: 'r1', modified: Date.parse('2026-10-17T10:00:00Z') },
      { id: 'f3', name: 'B.bashcad', projectId: null, revision: null, modified: 0 },
    ]);
    // The folder is remembered.
    answers.push(() => ({ files: [] }));
    await drive.list();
    expect(calls.length).toBe(5);
  });

  it('uploads as multipart, creating in the folder or replacing in place, and trashes to delete', async () => {
    const drive = new DriveRemote(fetch);
    answers.push(() => ({ files: [{ id: 'folder1', name: 'BashCAD' }] }));
    answers.push(() => ({ id: 'new1', name: 'Plate.bashcad', appProperties: { projectId: 'project1', revision: 'r1' } }));
    const made = await drive.upload(null, 'Plate', '{"x":1}', { projectId: 'project1', revision: 'r1' });
    expect(made).toMatchObject({ id: 'new1', projectId: 'project1', revision: 'r1' });
    const create = calls[1];
    expect(create.url).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=multipart/);
    expect(create.init?.method).toBe('POST');
    const body = create.init!.body as string;
    const boundary = /boundary=(.+)$/.exec(create.init!.headers!['content-type' as keyof HeadersInit] as string)![1];
    expect(body.split(`--${boundary}`).length).toBe(4);
    expect(body).toContain('"parents":["folder1"]');
    expect(body).toContain('"appProperties":{"app":"bashcad","projectId":"project1","revision":"r1"}');
    expect(body).toContain('\r\n\r\n{"x":1}\r\n');

    answers.push(() => ({ id: 'new1', name: 'Plate.bashcad', appProperties: { projectId: 'project1', revision: 'r2' } }));
    await drive.upload(made, 'Plate', '{"x":2}', { projectId: 'project1', revision: 'r2' });
    expect(calls[2].url).toContain('/upload/drive/v3/files/new1?uploadType=multipart');
    expect(calls[2].init?.method).toBe('PATCH');
    expect(calls[2].init!.body as string).not.toContain('parents');

    answers.push(() => ({ id: 'new1' }));
    await drive.remove(made);
    expect(calls[3].init).toMatchObject({ method: 'PATCH', body: '{"trashed":true}' });

    answers.push(() => new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), { status: 403 }));
    await expect(drive.download(made)).rejects.toThrow('Google Drive could not download Plate.bashcad: Rate limit exceeded');
  });
});
