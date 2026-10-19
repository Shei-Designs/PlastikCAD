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
      .filter((e) => e.path.startsWith(`${dir}/`) && e.name.toLowerCase().endsWith('.plastikcad') && !e.name.startsWith('.'))
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

const { DiskProjects, fileNameFor, uniqueFileName } = await import('./projects');

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

  it('numbers a name another file already has, ignoring case, but not the file itself', () => {
    expect(uniqueFileName('Box.plastikcad', ['Lid.plastikcad'])).toBe('Box.plastikcad');
    expect(uniqueFileName('Box.plastikcad', ['box.plastikcad'])).toBe('Box (2).plastikcad');
    expect(uniqueFileName('Box.plastikcad', ['Box.plastikcad', 'Box (2).plastikcad'])).toBe('Box (3).plastikcad');
    expect(uniqueFileName('Box.plastikcad', ['Box.plastikcad'], 'box.plastikcad')).toBe('Box.plastikcad');
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
