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
      .filter((e) => e.path.startsWith(`${dir}/`) && e.name.toLowerCase().endsWith('.bashcad') && !e.name.startsWith('.'))
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

const DIR = '/home/me/Documents/BashCAD';
const design = (id: string, name: string) => serializeDoc({ ...emptyDoc(), id, name, scene: [makeShape('box')] });

beforeEach(() => {
  files.clear();
  clock = 1000;
});

describe('file names', () => {
  it('makes a safe file name from a project name', () => {
    expect(fileNameFor('Bracket')).toBe('Bracket.bashcad');
    expect(fileNameFor(' a/b\\c:d*e?f"g<h>i|j ')).toBe('a b c d e f g h i j.bashcad');
    expect(fileNameFor('Trailing dots...')).toBe('Trailing dots.bashcad');
    expect(fileNameFor('   ')).toBe('Untitled.bashcad');
    expect(fileNameFor('x'.repeat(200))).toBe(`${'x'.repeat(80)}.bashcad`);
  });

  it('numbers a name another file already has, ignoring case, but not the file itself', () => {
    expect(uniqueFileName('Box.bashcad', ['Lid.bashcad'])).toBe('Box.bashcad');
    expect(uniqueFileName('Box.bashcad', ['box.bashcad'])).toBe('Box (2).bashcad');
    expect(uniqueFileName('Box.bashcad', ['Box.bashcad', 'Box (2).bashcad'])).toBe('Box (3).bashcad');
    expect(uniqueFileName('Box.bashcad', ['Box.bashcad'], 'box.bashcad')).toBe('Box.bashcad');
  });
});

describe('the projects folder', () => {
  it('lists the designs in the folder by their headers, skipping what is not a design', async () => {
    files.set(`${DIR}/Bracket.bashcad`, encoder.encode(design('bracket1', 'Bracket')));
    files.set(`${DIR}/notes.bashcad`, encoder.encode('{"hello": true}'));
    files.set(`${DIR}/other.txt`, encoder.encode('x'));
    const store = new DiskProjects(DIR);
    const listed = await store.list();
    expect(listed).toEqual([{ key: `${DIR}/Bracket.bashcad`, id: 'bracket1', name: 'Bracket', revision: null, modified: 1000, size: files.get(`${DIR}/Bracket.bashcad`)!.length, thumb: null }]);
  });

  it('reads a whole file whose header is laid out some other way', async () => {
    const text = JSON.stringify(JSON.parse(design('flat0001', 'Flat')));
    files.set(`${DIR}/Flat.bashcad`, encoder.encode(text));
    const [info] = await new DiskProjects(DIR).list();
    expect(info).toMatchObject({ id: 'flat0001', name: 'Flat' });
  });

  it('writes a new project under its name, numbered when the name is taken', async () => {
    files.set(`${DIR}/Box.bashcad`, encoder.encode(design('other001', 'Box')));
    const store = new DiskProjects(DIR);
    const text = design('mine0001', 'Box');
    const key = await store.write(null, 'Box', text);
    expect(key).toBe(`${DIR}/Box (2).bashcad`);
    expect(await store.read(key)).toBe(text);
    // Written again under the same name: the same file.
    expect(await store.write(key, 'Box', text)).toBe(key);
    expect(files.size).toBe(2);
  });

  it('moves the file when the project is renamed, never over another', async () => {
    const store = new DiskProjects(DIR);
    const key = await store.write(null, 'Draft', design('p0000001', 'Draft'));
    expect(key).toBe(`${DIR}/Draft.bashcad`);
    files.set(`${DIR}/Hinge.bashcad`, encoder.encode(design('other001', 'Hinge')));
    const renamed = await store.write(key, 'Hinge', design('p0000001', 'Hinge'));
    expect(renamed).toBe(`${DIR}/Hinge (2).bashcad`);
    expect(files.has(key)).toBe(false);
    expect(new TextDecoder().decode(files.get(renamed))).toContain('"name": "Hinge"');
    // A change of case alone keeps the file, number and all.
    expect(await store.write(renamed, 'hinge', design('p0000001', 'hinge'))).toBe(renamed);
    expect(await store.write(key, 'draft', design('p0000001', 'draft'))).toBe(key);
  });

  it('remembers headers until a file changes', async () => {
    const path = `${DIR}/Bracket.bashcad`;
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
