// Changing the projects folder on desktop, with the disk stood in for by a
// map of files: what moves, what stays, and what the editor keeps open.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boxBounds } from '../model/math';
import type { SceneNode } from '../model/types';
import type { DesignEntry } from '../platform';

const files = new Map<string, Uint8Array>();
/** What the next "Move them / Leave them" question is answered with. */
let moveThem = true;
const HOME = '/home/me/Documents/PlastikCAD';

vi.mock('./geometry', () => ({
  geometry: { bounds: (node: SceneNode) => boxBounds(node), ready: async () => {}, forgetAssets: () => {}, prepare: async () => ({ measure: async () => null }) },
}));
vi.mock('../ui/ask', () => ({ askName: async (o: { value: string }) => o.value, tell: async (o: { actions: string[] }) => o.actions[0] }));
vi.mock('../platform', () => ({
  isDesktop: () => true,
  isAndroid: () => false,
  confirm: async () => moveThem,
  defaultProjectsDir: async () => ({ path: HOME, fixed: false }),
  startupFiles: async () => [],
  listDesigns: async (dir: string): Promise<DesignEntry[]> =>
    Array.from(files, ([path, bytes]) => ({ path, name: path.slice(dir.length + 1), size: bytes.length, modified: 1 }))
      .filter((e) => e.path.startsWith(`${dir}/`) && !e.name.includes('/') && e.name.endsWith('.plastikcad'))
      .sort((a, b) => a.name.localeCompare(b.name)),
  readHead: async (path: string, limit: number) => files.get(path)!.slice(0, limit),
  readPath: async (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`Could not read ${path}`);
    return { name: path.slice(path.lastIndexOf('/') + 1), path, bytes };
  },
  writePath: async (path: string, bytes: Uint8Array) => void files.set(path, bytes),
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
});
