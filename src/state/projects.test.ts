// The projects folder on disk, with the platform stood in for by a map of files.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDoc, serializeDoc } from '../model/file';
import { makeShape } from '../model/ops';
import type { DesignEntry } from '../platform';

const files = new Map<string, Uint8Array>();
const encoder = new TextEncoder();
let clock = 1000;
/** The folders of earlier saves the store asked to have taken away, and the folders it looked into without making them. */
const dropped: string[] = [];
const peeked: string[] = [];

vi.mock('../platform', () => ({
  hasKeychain: () => false,
  isDesktop: () => true,
  listDesigns: async (dir: string, create = true): Promise<DesignEntry[]> =>
    (create ? [] : (peeked.push(dir), [])) &&
    Array.from(files, ([path, bytes]) => ({ path, name: path.slice(dir.length + 1), size: bytes.length, modified: clock }))
      // Only the files directly inside the folder, as the real listing does: a "Parts" subfolder is not among the projects.
      .filter((e) => e.path.startsWith(`${dir}/`) && !e.name.includes('/') && e.name.toLowerCase().endsWith('.plastikcad') && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name)),
  readHead: async (path: string, limit: number) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`Could not read ${path}`);
    return bytes.slice(0, limit);
  },
  readPath: async (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`Could not read ${path}`);
    return { name: path.slice(path.lastIndexOf('/') + 1), path, bytes };
  },
  writePath: async (path: string, bytes: Uint8Array) => {
    files.set(path, bytes);
    clock++;
  },
  removeFile: async (path: string) => {
    if (!files.delete(path)) throw new Error(`Could not delete ${path}`);
  },
  removeHistoryFolder: async (path: string) => void dropped.push(path),
  moveFile: async (from: string, to: string) => {
    if (files.has(to)) throw new Error(`Could not move ${from} to ${to}: a file of that name already exists`);
    const bytes = files.get(from);
    if (!bytes) throw new Error(`Could not move ${from}`);
    files.delete(from);
    files.set(to, bytes);
  },
}));

const { DiskProjects, fileNameFor, KEEP_LATEST, KEEP_VERSIONS, partStore, versionsToDrop, partsDirOf, uniqueFileName, setProjectStore } = await import('./projects');

const DIR = '/home/me/Documents/PlastikCAD';
const design = (id: string, name: string) => serializeDoc({ ...emptyDoc(), id, name, scene: [makeShape('box')] });

beforeEach(() => {
  files.clear();
  clock = 1000;
});

describe('file names', () => {
  it('makes a safe file name from a project name', () => {
    expect(fileNameFor('Bracket')).toBe('Bracket.plastikcad');
    expect(fileNameFor(' a/b\\c:d*e?f"g<h>i|j ')).toBe('a b c d e f g h i j.plastikcad');
    expect(fileNameFor('Trailing dots...')).toBe('Trailing dots.plastikcad');
    expect(fileNameFor('   ')).toBe('Untitled.plastikcad');
    expect(fileNameFor('x'.repeat(200))).toBe(`${'x'.repeat(80)}.plastikcad`);
  });

  it('never makes a hidden file, half a character or a name Windows keeps for itself', () => {
    expect(fileNameFor('.config')).toBe('config.plastikcad');
    expect(fileNameFor(' . ..hidden')).toBe('hidden.plastikcad');
    expect(fileNameFor('...')).toBe('Untitled.plastikcad');
    // An emoji across the eightieth place is cut whole, so the name still goes into a URL.
    const cut = fileNameFor(`${'x'.repeat(79)}\u{1F600}!`);
    expect(cut).toBe(`${'x'.repeat(79)}\u{1F600}.plastikcad`);
    expect(() => encodeURIComponent(cut)).not.toThrow();
    expect(fileNameFor('NUL')).toBe('NUL project.plastikcad');
    expect(fileNameFor('com1')).toBe('com1 project.plastikcad');
    expect(fileNameFor('Console')).toBe('Console.plastikcad');
  });

  it('numbers a name another file already has, ignoring case, but not the file itself', () => {
    expect(uniqueFileName('Box.plastikcad', ['Lid.plastikcad'])).toBe('Box.plastikcad');
    expect(uniqueFileName('Box.plastikcad', ['box.plastikcad'])).toBe('Box (2).plastikcad');
    expect(uniqueFileName('Box.plastikcad', ['Box.plastikcad', 'Box (2).plastikcad'])).toBe('Box (3).plastikcad');
    // An accented letter written as one character or as a letter and its accent is one name to a Mac.
    expect(uniqueFileName('Caf\u00e9.plastikcad', ['Cafe\u0301.plastikcad'])).toBe('Caf\u00e9 (2).plastikcad');
    expect(uniqueFileName('Cafe\u0301.plastikcad', ['CAF\u00c9.plastikcad'], 'Caf\u00e9.plastikcad')).toBe('Cafe\u0301.plastikcad');
    expect(uniqueFileName('Box.plastikcad', ['Box.plastikcad'], 'box.plastikcad')).toBe('Box.plastikcad');
  });
});

describe('the parts folder', () => {
  it('sits inside the projects folder and follows it', async () => {
    expect(partsDirOf(DIR)).toBe(`${DIR}/Parts`);
    setProjectStore(new DiskProjects(DIR));
    expect(partStore().location).toBe(`${DIR}/Parts`);
    // Parts written there are not among the projects.
    const key = await partStore().write(null, 'Post', design('part0001', 'Post'));
    expect(key).toBe(`${DIR}/Parts/Post.plastikcad`);
    expect((await new DiskProjects(DIR).list()).map((p) => p.name)).toEqual([]);
    expect((await partStore().list()).map((p) => p.name)).toEqual(['Post']);
  });
});

describe('the projects folder', () => {
  it('lists the designs in the folder by their headers, skipping what is not a design', async () => {
    files.set(`${DIR}/Bracket.plastikcad`, encoder.encode(design('bracket1', 'Bracket')));
    files.set(`${DIR}/notes.plastikcad`, encoder.encode('{"hello": true}'));
    files.set(`${DIR}/other.txt`, encoder.encode('x'));
    const store = new DiskProjects(DIR);
    const listed = await store.list();
    expect(listed).toEqual([{ key: `${DIR}/Bracket.plastikcad`, id: 'bracket1', name: 'Bracket', revision: null, modified: 1000, size: files.get(`${DIR}/Bracket.plastikcad`)!.length, thumb: null }]);
  });

  it('reads a whole file whose header is laid out some other way', async () => {
    const text = JSON.stringify(JSON.parse(design('flat0001', 'Flat')));
    files.set(`${DIR}/Flat.plastikcad`, encoder.encode(text));
    const [info] = await new DiskProjects(DIR).list();
    expect(info).toMatchObject({ id: 'flat0001', name: 'Flat' });
  });

  it('writes a new project under its name, numbered when the name is taken', async () => {
    files.set(`${DIR}/Box.plastikcad`, encoder.encode(design('other001', 'Box')));
    const store = new DiskProjects(DIR);
    const text = design('mine0001', 'Box');
    const key = await store.write(null, 'Box', text);
    expect(key).toBe(`${DIR}/Box (2).plastikcad`);
    expect(await store.read(key)).toBe(text);
    // Written again under the same name: the same file.
    expect(await store.write(key, 'Box', text)).toBe(key);
    expect(files.size).toBe(2);
  });

  it('moves the file when the project is renamed, never over another', async () => {
    const store = new DiskProjects(DIR);
    const key = await store.write(null, 'Draft', design('p0000001', 'Draft'));
    expect(key).toBe(`${DIR}/Draft.plastikcad`);
    files.set(`${DIR}/Hinge.plastikcad`, encoder.encode(design('other001', 'Hinge')));
    const renamed = await store.write(key, 'Hinge', design('p0000001', 'Hinge'));
    expect(renamed).toBe(`${DIR}/Hinge (2).plastikcad`);
    expect(files.has(key)).toBe(false);
    expect(new TextDecoder().decode(files.get(renamed))).toContain('"name": "Hinge"');
    // A change of case alone keeps the file, number and all.
    expect(await store.write(renamed, 'hinge', design('p0000001', 'hinge'))).toBe(renamed);
    expect(await store.write(key, 'draft', design('p0000001', 'draft'))).toBe(key);
  });

  it('puts a renamed file back under its old name when the write that follows fails', async () => {
    const store = new DiskProjects(DIR);
    const key = await store.write(null, 'Draft', design('p0000001', 'Draft'));
    const platform = await import('../platform');
    const write = vi.spyOn(platform, 'writePath').mockRejectedValueOnce(new Error('No space left on device'));
    await expect(store.write(key, 'Hinge', design('p0000001', 'Hinge'))).rejects.toThrow(/No space left/);
    write.mockRestore();
    expect([...files.keys()]).toEqual([key]);
    // The editor still knows the project by its old key, and the next save goes through.
    expect(await store.write(key, 'Hinge', design('p0000001', 'Hinge'))).toBe(`${DIR}/Hinge.plastikcad`);
    expect([...files.keys()]).toEqual([`${DIR}/Hinge.plastikcad`]);
  });

  it('discards into a Trash folder inside the projects folder, never over what is already there', async () => {
    const store = new DiskProjects(DIR);
    const first = await store.write(null, 'Box', design('p0000001', 'Box'));
    await store.discard(first);
    expect([...files.keys()]).toEqual([`${DIR}/Trash/Box.plastikcad`]);
    const second = await store.write(null, 'Box', design('p0000002', 'Box'));
    await store.discard(second);
    expect([...files.keys()].sort()).toEqual([`${DIR}/Trash/Box (2).plastikcad`, `${DIR}/Trash/Box.plastikcad`]);
    // What is in the trash is not a project any more.
    expect(await store.list()).toEqual([]);
  });

  it('dates a project by when the design says it was saved, and by its file only when it does not say', async () => {
    const saved = '2026-11-08T09:30:00.000Z';
    files.set(`${DIR}/Dated.plastikcad`, encoder.encode(serializeDoc({ ...emptyDoc(), id: 'dated001', name: 'Dated', scene: [makeShape('box')], saved })));
    files.set(`${DIR}/Plain.plastikcad`, encoder.encode(design('plain001', 'Plain')));
    // The files themselves carry a date that says nothing, as after a restore.
    clock = 1_794_310;
    const listed = await new DiskProjects(DIR).list();
    expect(listed.find((p) => p.name === 'Dated')!.modified).toBe(Date.parse(saved));
    expect(listed.find((p) => p.name === 'Plain')!.modified).toBe(1_794_310);
  });

  it('lists the trash, puts a project back under a free name and destroys what it is told to', async () => {
    const store = new DiskProjects(DIR);
    await store.discard(await store.write(null, 'Box', design('p0000001', 'Box')));
    await store.discard(await store.write(null, 'Lid', design('p0000002', 'Lid')));
    expect((await store.discarded()).map((p) => p.name).sort()).toEqual(['Box', 'Lid']);
    // A project of the same name was made meanwhile: the one put back takes a number.
    await store.write(null, 'Box', design('p0000003', 'Box'));
    const trashed = (await store.discarded()).find((p) => p.name === 'Box')!;
    expect(await store.restore(trashed.key)).toBe(`${DIR}/Box (2).plastikcad`);
    expect((await store.list()).map((p) => p.id).sort()).toEqual(['p0000001', 'p0000003']);
    await store.purge();
    expect(await store.discarded()).toEqual([]);
    expect((await store.list()).length).toBe(2);
  });

  it('keeps earlier saves of a project now and then, always when told to, and no more than it should', async () => {
    const store = new DiskProjects(DIR);
    const at = (minute: number) => `2026-11-10T12:${String(minute).padStart(2, '0')}:00.000Z`;
    const save = (key: string | null, minute: number) => store.write(key, 'Box', serializeDoc({ ...emptyDoc(), id: 'p0000001', name: 'Box', scene: [makeShape('box')], saved: at(minute) }));
    const key = await save(null, 0);
    // The first save of a session keeps what was there; saves soon after it do not.
    await store.keep(key);
    await save(key, 1);
    await store.keep(key);
    await save(key, 2);
    expect((await store.versions('p0000001')).map((v) => new Date(v.saved).toISOString())).toEqual([at(0)]);
    // A replacement nobody here made keeps what it replaces whenever it comes; the same save is not kept twice.
    await store.keep(key, true);
    await store.keep(key, true);
    expect((await store.versions('p0000001')).map((v) => new Date(v.saved).toISOString())).toEqual([at(2), at(0)]);
    // A version reads like a project.
    expect(await store.read((await store.versions('p0000001'))[0].key)).toContain(at(2));
    for (let minute = 3; minute < 30; minute++) {
      await save(key, minute);
      await store.keep(key, true);
    }
    // All of one sitting: the latest are kept, and one more for the day they share is not needed.
    const versions = await store.versions('p0000001');
    expect(versions.length).toBe(KEEP_LATEST);
    expect(new Date(versions[0].saved).toISOString()).toBe(at(29));
    // None of this shows among the projects.
    expect((await store.list()).map((p) => p.name)).toEqual(['Box']);
    // Deleted for good, the project takes its earlier saves with it.
    await store.discard(key);
    dropped.length = 0;
    await store.purge();
    expect(await store.versions('p0000001')).toEqual([]);
    // The folder they were in goes with the last of them, and looking for them again does not make it anew.
    expect(dropped).toEqual([`${DIR}/History/p0000001`]);
    expect(peeked).toContain(`${DIR}/History/p0000001`);
    expect([...files.keys()]).toEqual([]);
  });

  it('lets go of earlier saves by age: the latest all kept, one a day further back, never more than the limit', () => {
    const day = 86_400_000;
    const noon = Date.UTC(2026, 10, 10, 12);
    // Thirty saves ten minutes apart today, then three a day for the ten days before.
    const today = Array.from({ length: 30 }, (_, i) => noon - i * 600_000);
    const before = Array.from({ length: 10 }, (_, d) => [0, 1, 2].map((h) => noon - (d + 1) * day - h * 3_600_000)).flat();
    const dropped = new Set(versionsToDrop([...today, ...before]));
    const kept = [...today, ...before].filter((t) => !dropped.has(t)).sort((a, b) => b - a);
    expect(kept.length).toBe(KEEP_VERSIONS);
    // The latest twelve of today, then the last save of each of the eight days before.
    expect(kept.slice(0, KEEP_LATEST)).toEqual(today.slice(0, KEEP_LATEST));
    expect(kept.slice(KEEP_LATEST)).toEqual(Array.from({ length: KEEP_VERSIONS - KEEP_LATEST }, (_, d) => noon - (d + 1) * day));
    // Few enough, and nothing goes.
    expect(versionsToDrop(today.slice(0, 5))).toEqual([]);
  });

  it('remembers headers until a file changes', async () => {
    const path = `${DIR}/Bracket.plastikcad`;
    files.set(path, encoder.encode(design('bracket1', 'Bracket')));
    const store = new DiskProjects(DIR);
    const platform = await import('../platform');
    const heads = vi.spyOn(platform, 'readHead');
    await store.list();
    await store.list();
    expect(heads).toHaveBeenCalledTimes(1);
    files.set(path, encoder.encode(design('bracket1', 'Bracket v2')));
    clock++;
    const [info] = await store.list();
    expect(heads).toHaveBeenCalledTimes(2);
    expect(info.name).toBe('Bracket v2');
    await store.remove(path);
    expect(await store.list()).toEqual([]);
  });
});
