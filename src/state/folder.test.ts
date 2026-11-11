// Changing the projects folder on desktop, with the disk stood in for by a
// map of files: what moves, what stays, and what the editor keeps open.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boxBounds } from '../model/math';
import type { SceneNode } from '../model/types';
import type { DesignEntry } from '../platform';

const files = new Map<string, Uint8Array>();
/** What the next "Move them / Leave them" question is answered with. */
let moveThem = true;
/** A file that cannot be written (the place is full), and one whose start cannot be read (it is busy), until a test says otherwise. */
let failWrite: string | null = null;
let failHead: string | null = null;
const HOME = '/home/me/Documents/PlastikCAD';

vi.mock('./geometry', () => ({
  geometry: { bounds: (node: SceneNode) => boxBounds(node), ready: async () => {}, forgetAssets: () => {}, prepare: async () => ({ measure: async () => null }) },
}));
vi.mock('../ui/ask', () => ({ askName: async (o: { value: string }) => o.value, tell: async (o: { actions: string[] }) => o.actions[0] }));
vi.mock('../platform', () => ({
  hasKeychain: () => false,
  isDesktop: () => true,
  isAndroid: () => false,
  confirm: async () => moveThem,
  defaultProjectsDir: async () => ({ path: HOME, fixed: false }),
  startupFiles: async () => [],
  listDesigns: async (dir: string): Promise<DesignEntry[]> =>
    Array.from(files, ([path, bytes]) => ({ path, name: path.slice(dir.length + 1), size: bytes.length, modified: 1 }))
      .filter((e) => e.path.startsWith(`${dir}/`) && !e.name.includes('/') && e.name.endsWith('.plastikcad'))
      .sort((a, b) => a.name.localeCompare(b.name)),
  readHead: async (path: string, limit: number) => {
    if (path === failHead) throw new Error(`Could not read ${path}: the file is busy`);
    return files.get(path)!.slice(0, limit);
  },
  readPath: async (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`Could not read ${path}`);
    return { name: path.slice(path.lastIndexOf('/') + 1), path, bytes };
  },
  writePath: async (path: string, bytes: Uint8Array) => {
    if (path === failWrite) throw new Error(`Could not write ${path}: No space left on device (os error 28)`);
    files.set(path, bytes);
  },
  removeFile: async (path: string) => void files.delete(path),
  moveFile: async (from: string, to: string) => {
    files.set(to, files.get(from)!);
    files.delete(from);
  },
}));

const store = await import('./store');
/** The projects directly in a folder; `inside` for everything below it, the earlier saves and the trash too. */
const names = (dir: string, inside = false): string[] => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)).filter((n) => inside || !n.includes('/')).sort();

beforeEach(async () => {
  files.clear();
  failWrite = null;
  failHead = null;
  store.setPrefs({ projectsDir: null, lastProject: null });
  await store.restoreSession();
  await store.startProject('Kept');
  store.addShape('box');
  await store.saveProject();
  await store.startProject('Open');
  store.addShape('box');
  await store.saveProject();
  expect(names(HOME)).toEqual(['Kept.plastikcad', 'Open.plastikcad']);
});

describe('changing the projects folder', () => {
  it('moves the projects, the open one with them, and goes on saving it there', async () => {
    moveThem = true;
    await store.chooseProjectsFolder('/mnt/usb');
    expect(names(HOME)).toEqual([]);
    expect(names('/mnt/usb')).toEqual(['Kept.plastikcad', 'Open.plastikcad']);
    expect(store.getState()).toMatchObject({ projectKey: '/mnt/usb/Open.plastikcad', storage: { location: '/mnt/usb' } });
    store.addShape('sphere');
    await store.saveProject();
    expect(names(HOME)).toEqual([]);
    expect(names('/mnt/usb')).toEqual(['Kept.plastikcad', 'Open.plastikcad']);
    // The earlier saves kept of them came along: nothing is left in the old folder at all.
    expect(names(HOME, true)).toEqual([]);
    expect(names('/mnt/usb', true).filter((n) => n.startsWith('History/')).length).toBeGreaterThan(0);
  });

  it('leaves the projects where they are when asked to, the open one too, and starts afresh in the new folder', async () => {
    moveThem = false;
    await store.chooseProjectsFolder('/mnt/usb');
    expect(names(HOME)).toEqual(['Kept.plastikcad', 'Open.plastikcad']);
    expect(store.getState()).toMatchObject({ projectKey: null, storage: { location: '/mnt/usb' } });
    expect(store.getState().doc.scene).toEqual([]);
    expect(store.getState().notice?.text).toBe('"Open" stays in the old folder with the others.');
    // What is made from here on goes into the new folder, and nothing more into the old one.
    store.addShape('box');
    store.renameProject('New');
    await store.saveProject();
    expect(names('/mnt/usb')).toEqual(['New.plastikcad']);
    expect(names(HOME)).toEqual(['Kept.plastikcad', 'Open.plastikcad']);
  });

  it('moves all of them or none: a move that cannot be finished leaves the old folder whole and the app on it', async () => {
    moveThem = true;
    const before = names(HOME, true);
    // The stick fills up at the second project.
    failWrite = '/mnt/usb/Open.plastikcad';
    await store.chooseProjectsFolder('/mnt/usb');
    expect(store.getState().notice).toMatchObject({ kind: 'error', text: expect.stringContaining('No space left on device') });
    expect(names(HOME, true)).toEqual(before);
    expect(names('/mnt/usb', true)).toEqual([]);
    expect(store.getState()).toMatchObject({ projectKey: `${HOME}/Open.plastikcad`, storage: { location: HOME } });
    expect((await store.listProjects()).map((p) => p.name).sort()).toEqual(['Kept', 'Open']);
  });

  it('takes the trash along, and the earlier saves of what is in it', async () => {
    moveThem = true;
    const kept = (await store.listProjects()).find((p) => p.name === 'Kept')!;
    expect(await store.deleteProject(kept.key, 'Kept')).toBe(true);
    expect((await store.listTrash()).map((p) => p.name)).toEqual(['Kept']);
    await store.chooseProjectsFolder('/mnt/usb');
    expect((await store.listTrash()).map((p) => p.name)).toEqual(['Kept']);
    expect(names(HOME, true)).toEqual([]);
    const back = (await store.listTrash())[0];
    await store.restoreProject(back.key);
    expect(names('/mnt/usb')).toEqual(['Kept.plastikcad', 'Open.plastikcad']);
  });
});

describe('a file in the folder that cannot be read', () => {
  it('is left out of the list, and the folder says its list is short', async () => {
    const { DiskProjects } = await import('./projects');
    // The app started again: nothing is remembered of the files, and one is busy as the folder is first listed.
    const again = new DiskProjects(HOME);
    failHead = `${HOME}/Kept.plastikcad`;
    expect((await again.list()).map((p) => p.name)).toEqual(['Open']);
    expect(again.unreadable()).toEqual([`${HOME}/Kept.plastikcad`]);
    failHead = null;
    expect((await again.list()).map((p) => p.name)).toEqual(['Kept', 'Open']);
    expect(again.unreadable()).toEqual([]);
    // A file that is no design at all is simply not one: the list is whole without it.
    files.set(`${HOME}/Notes.plastikcad`, new TextEncoder().encode('{"shopping": ["bolts"]}'));
    expect((await again.list()).map((p) => p.name)).toEqual(['Kept', 'Open']);
    expect(again.unreadable()).toEqual([]);
  });
});
