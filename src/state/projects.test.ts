// The projects folder on disk, with the platform stood in for by a map of files.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDoc, serializeDoc } from '../model/file';
import { makeShape } from '../model/ops';
import type { DesignEntry } from '../platform';

const files = new Map<string, Uint8Array>();
const encoder = new TextEncoder();
let clock = 1000;

vi.mock('../platform', () => ({
  isDesktop: () => true,
  listDesigns: async (dir: string): Promise<DesignEntry[]> =>
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
  moveFile: async (from: string, to: string) => {
    if (files.has(to)) throw new Error(`Could not move ${from} to ${to}: a file of that name already exists`);
    const bytes = files.get(from);
    if (!bytes) throw new Error(`Could not move ${from}`);
    files.delete(from);
    files.set(to, bytes);
  },
}));

const { DiskProjects, fileNameFor, partStore, partsDirOf, uniqueFileName, useProjectStore } = await import('./projects');

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
    expect(uniqueFileName('Box.plastikcad', ['Box.plastikcad'], 'box.plastikcad')).toBe('Box.plastikcad');
  });
});

describe('the parts folder', () => {
  it('sits inside the projects folder and follows it', async () => {
    expect(partsDirOf(DIR)).toBe(`${DIR}/Parts`);
    useProjectStore(new DiskProjects(DIR));
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
