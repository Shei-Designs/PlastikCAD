// Large meshes and pictures kept apart from the designs on the remote: a design taken apart and
// put back together, the remote that does so on the way up and down, and two devices syncing through it.
import { describe, expect, it, vi } from 'vitest';
import { emptyDoc, NewerVersion, parseDoc, readHeader, serializeDoc } from '../model/file';
import { makeShape, newId } from '../model/ops';
import type { Asset, Doc, ImportNode, SceneNode } from '../model/types';
import { MemoryProjects } from '../state/projects';
import { APART_FROM, apartRemote, contentName, inParts, putTogether, takeApart } from './apart';
import { MemorySyncState, synchronize } from './engine';
import type { Remote, RemoteFile } from './engine';

vi.mock('../platform', () => ({ isDesktop: () => false, isAndroid: () => false }));

/** A remote that keeps files in memory and counts what it was asked to do. */
class FakeRemote implements Remote {
  files = new Map<string, { file: RemoteFile; text: string }>();
  calls = { list: 0, download: 0, upload: 0 };
  /** How many bytes went up and came down. */
  sent = 0;
  received = 0;
  private serial = 0;
  constructor(private readonly extension = '.plastikcad') {}
  async list(): Promise<RemoteFile[]> {
    this.calls.list++;
    return [...this.files.values()].map((f) => f.file);
  }
  async download(file: RemoteFile): Promise<string> {
    this.calls.download++;
    const found = this.files.get(file.id);
    if (!found) throw new Error('gone');
    this.received += found.text.length;
    return found.text;
  }
  async upload(existing: RemoteFile | null, name: string, text: string, meta: { projectId: string; revision: string | null }): Promise<RemoteFile> {
    this.calls.upload++;
    this.sent += text.length;
    const id = existing?.id ?? `remote-${++this.serial}`;
    const file: RemoteFile = { id, name: name.endsWith(this.extension) ? name : `${name}${this.extension}`, projectId: meta.projectId, revision: meta.revision, modified: Date.now() };
    this.files.set(id, { file, text });
    return file;
  }
  async remove(file: RemoteFile): Promise<void> {
    this.files.delete(file.id);
  }
  only(): { file: RemoteFile; text: string } {
    if (this.files.size !== 1) throw new Error(`${this.files.size} files`);
    return [...this.files.values()][0];
  }
}

const letters = (n: number, seed: string): string => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
/** An imported mesh whose text runs to `size` characters or so. */
const mesh = (size: number, seed = 'AAAB'): Asset => ({ kind: 'mesh', positions: letters(size, seed), triangles: 'AAAAAQAAAAIAAAA=' });
const picture = (size: number): Asset => ({ kind: 'image', name: 'label.png', mime: 'image/png', data: letters(size, 'iVBO'), width: 64, height: 32 });
const imported = (id: string, asset: string): ImportNode => ({ id, type: 'import', name: id, asset, natural: [10, 10, 10], size: [10, 10, 10], pos: [0, 0, 5], rot: [0, 0, 0], hole: false, color: '#8fa3bf' });
const box = (id: string, x = 0): SceneNode => ({ ...makeShape('box'), id, pos: [x, 0, 10] });

/** A design with a large mesh, a small one, a large picture worn by the large mesh, and a box. */
function scan(name = 'Scan'): Doc {
  const big = imported('big', 'mesh-big');
  big.texture = { asset: 'img-label', mode: 'wrap', scale: 50, turn: 0 };
  return {
    ...emptyDoc(),
    id: newId(),
    name,
    revision: newId(),
    device: 'device0a',
    scene: [big, imported('small', 'mesh-small'), box('box1')],
    assets: { 'mesh-big': mesh(APART_FROM * 3), 'mesh-small': mesh(400, 'CCCD'), 'img-label': picture(APART_FROM * 2) },
  };
}
const edited = (doc: Doc, scene: SceneNode[]): Doc => ({ ...doc, scene, revision: newId(), parent: doc.revision });

describe('a design taken apart', () => {
  it('goes without its large meshes and pictures, and back together into the very same text', async () => {
    const text = serializeDoc(scan());
    const parts = await takeApart(text);
    expect(parts).not.toBeNull();
    expect(parts!.apart.size).toBe(2);
    // What is left is the design around them: its header as it was, the small mesh still in it.
    expect(parts!.text.length).toBeLessThan(5000);
    expect(readHeader(parts!.text)).toEqual(readHeader(text));
    expect(parts!.text).toContain('CCCD');
    expect(inParts(parts!.text)).toBe(true);
    // Each part is named after its contents.
    for (const [name, body] of parts!.apart) expect(await contentName(body)).toBe(name);
    expect(await putTogether(parts!.text, async (name) => parts!.apart.get(name) ?? null)).toBe(text);
  });

  it('is left whole when it holds nothing large, or is laid out some other way', async () => {
    const small = { ...scan(), assets: { 'mesh-small': mesh(400) }, scene: [imported('small', 'mesh-small')] };
    expect(await takeApart(serializeDoc(small))).toBeNull();
    expect(await takeApart(serializeDoc({ ...emptyDoc(), id: newId(), scene: [box('a')] }))).toBeNull();
    expect(await takeApart('not a design')).toBeNull();
    // Written by hand on one line: its parts would not go back into the same text.
    expect(await takeApart(JSON.stringify(JSON.parse(serializeDoc(scan()))))).toBeNull();
  });

  it('is refused in parts by a build that reads only whole designs', async () => {
    const parts = await takeApart(serializeDoc(scan()));
    expect(() => parseDoc(parts!.text)).toThrow(NewerVersion);
  });

  it('is not put together from a part that is missing, or is not what its name says', async () => {
    const text = serializeDoc(scan());
    const parts = (await takeApart(text))!;
    await expect(putTogether(parts.text, async () => null)).rejects.toThrow('missing asset');
    await expect(putTogether(parts.text, async () => 'not JSON')).rejects.toThrow('missing asset');
    // A picture where a mesh was named.
    const wrong = [...parts.apart.values()].find((body) => body.includes('"image"'))!;
    await expect(putTogether(parts.text, async () => wrong)).rejects.toThrow('missing asset');
    // A design that only happens to say the word is left as it is.
    const says = serializeDoc({ ...emptyDoc(), id: newId(), scene: [{ ...box('a'), note: 'the "apart": "thing"' }] });
    expect(await putTogether(says, async () => null)).toBe(says);
  });
});

describe('a remote that keeps the large parts of designs apart', () => {
  function setup(local: Record<string, string> = {}) {
    const designs = new FakeRemote();
    const store = new FakeRemote('.json');
    const remote = apartRemote(designs, store, async (id) => local[id] ?? null);
    return { designs, store, remote, local };
  }

  it('sends the parts once, and the design around them as often as it changes', async () => {
    const { designs, store, remote } = setup();
    const doc = scan();
    const text = serializeDoc(doc);
    const file = await remote.upload(null, doc.name, text, { projectId: doc.id, revision: doc.revision! });
    expect(store.files.size).toBe(2);
    expect([...store.files.values()].every((f) => /^[0-9a-f]{64}\.json$/.test(f.file.name))).toBe(true);
    expect(designs.only().text.length).toBeLessThan(5000);
    const partsSent = store.sent;
    // The box is moved: the design goes up again, the parts do not.
    const moved = edited(doc, [doc.scene[0], doc.scene[1], box('box1', 30)]);
    await remote.upload(file, moved.name, serializeDoc(moved), { projectId: moved.id, revision: moved.revision! });
    expect(store.files.size).toBe(2);
    expect(store.sent).toBe(partsSent);
    expect(designs.sent).toBeLessThan(10_000);
    // A second design with the same mesh shares its file.
    const other = { ...scan('Other'), assets: { 'mesh-big': doc.assets['mesh-big'] }, scene: [imported('big', 'mesh-big')] };
    await remote.upload(null, other.name, serializeDoc(other), { projectId: other.id, revision: other.revision! });
    expect(store.files.size).toBe(2);
    expect(store.sent).toBe(partsSent);
  });

  it('sends a part again that has gone from the remote since, once it looks afresh', async () => {
    const { store, remote } = setup();
    const doc = scan();
    await remote.upload(null, doc.name, serializeDoc(doc), { projectId: doc.id, revision: doc.revision! });
    // The parts are deleted from the Drive by hand.
    store.files.clear();
    const moved = edited(doc, [doc.scene[0], doc.scene[1], box('box1', 30)]);
    // Within a pass what was seen there is trusted; the next pass looks again and sends what is missing.
    await remote.upload(null, moved.name, serializeDoc(moved), { projectId: moved.id, revision: moved.revision! });
    expect(store.files.size).toBe(0);
    remote.forget();
    await remote.upload(null, moved.name, serializeDoc(moved), { projectId: moved.id, revision: moved.revision! });
    expect(store.files.size).toBe(2);
  });

  it('gives a design back whole, fetching only the parts this device does not have', async () => {
    const doc = scan();
    const text = serializeDoc(doc);
    const up = setup();
    const file = await up.remote.upload(null, doc.name, text, { projectId: doc.id, revision: doc.revision! });
    // A device that has nothing of it fetches both parts.
    const fresh = apartRemote(up.designs, up.store, async () => null);
    up.store.calls.download = 0;
    expect(await fresh.download(file)).toBe(text);
    expect(up.store.calls.download).toBe(2);
    // One that has the project as it was before the box moved fetches none.
    const moved = edited(doc, [doc.scene[0], doc.scene[1], box('box1', 30)]);
    const movedFile = await up.remote.upload(file, moved.name, serializeDoc(moved), { projectId: moved.id, revision: moved.revision! });
    const has = apartRemote(up.designs, up.store, async (id) => (id === doc.id ? text : null));
    up.store.calls.download = 0;
    expect(await has.download(movedFile)).toBe(serializeDoc(moved));
    expect(up.store.calls.download).toBe(0);
    // One whose mesh under that key is another fetches the one that changed, and only that.
    const swapped = serializeDoc({ ...doc, assets: { ...doc.assets, 'mesh-big': mesh(APART_FROM * 3, 'ZZZY') } });
    const differs = apartRemote(up.designs, up.store, async () => swapped);
    up.store.calls.download = 0;
    expect(await differs.download(movedFile)).toBe(serializeDoc(moved));
    expect(up.store.calls.download).toBe(1);
  });

  it('passes a whole design through untouched, either way', async () => {
    const { designs, store, remote } = setup();
    const doc = { ...emptyDoc(), id: newId(), name: 'Plain', revision: newId(), scene: [box('a')] };
    const text = serializeDoc(doc);
    const file = await remote.upload(null, doc.name, text, { projectId: doc.id, revision: doc.revision });
    expect(designs.only().text).toBe(text);
    expect(store.calls).toEqual({ list: 0, download: 0, upload: 0 });
    // As does one an older build sent up whole, large mesh and all.
    const whole = serializeDoc(scan());
    designs.files.get(file.id)!.text = whole;
    expect(await remote.download(file)).toBe(whole);
    expect(store.calls).toEqual({ list: 0, download: 0, upload: 0 });
  });

  it('says so when a part is gone from the remote, or is not what it was', async () => {
    const { store, remote } = setup();
    const doc = scan();
    const file = await remote.upload(null, doc.name, serializeDoc(doc), { projectId: doc.id, revision: doc.revision! });
    const first = [...store.files.values()][0];
    const kept = first.text;
    first.text = `${kept} `;
    await expect(remote.download(file)).rejects.toThrow('The imported shapes and pictures of Scan.plastikcad are missing from Google Drive, or damaged there.');
    first.text = kept;
    expect(await remote.download(file)).toBe(serializeDoc(doc));
    store.files.clear();
    await expect(remote.download(file)).rejects.toThrow('missing from Google Drive');
  });

  it('carries a design between two devices through the engine, the parts going up and coming down once', async () => {
    const designs = new FakeRemote();
    const store = new FakeRemote('.json');
    const device = async (name: string) => {
      const local = new MemoryProjects();
      const text = async (id: string): Promise<string | null> => {
        const info = (await local.list()).find((p) => p.id === id);
        return info ? local.read(info.key) : null;
      };
      const remote = apartRemote(designs, store, text);
      const state = new MemorySyncState();
      return { local, text, pass: () => synchronize(local, remote, state, { device: name }) };
    };
    const a = await device('devicea1');
    const b = await device('deviceb2');
    const doc = scan();
    const key = await a.local.write(null, doc.name, serializeDoc(doc));
    expect((await a.pass()).uploaded).toEqual(['Scan']);
    expect(store.files.size).toBe(2);
    expect((await b.pass()).downloaded).toEqual(['Scan']);
    expect(await b.text(doc.id)).toBe(serializeDoc(doc));
    // The box is moved on A: only the design around the parts travels.
    const sent = store.sent;
    const received = store.received;
    designs.sent = 0;
    designs.received = 0;
    const moved = edited(doc, [doc.scene[0], doc.scene[1], box('box1', 30)]);
    await a.local.write(key, moved.name, serializeDoc(moved));
    expect((await a.pass()).uploaded).toEqual(['Scan']);
    expect((await b.pass()).downloaded).toEqual(['Scan']);
    expect(await b.text(doc.id)).toBe(serializeDoc(moved));
    expect(store.sent).toBe(sent);
    expect(store.received).toBe(received);
    expect(designs.sent + designs.received).toBeLessThan(20_000);
    // And the design reads as one, mesh and all.
    expect(parseDoc((await b.text(doc.id))!).assets['mesh-big']).toEqual(doc.assets['mesh-big']);
  });
});
