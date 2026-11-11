// The scheduler around the engine: which records a pass may trust, what the
// editor hears of a pass that partly failed, and holding off while the
// projects are being moved. Google and Drive are stood in for.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDoc, parseDoc, serializeDoc } from '../model/file';
import { makeShape, newId } from '../model/ops';
import type { Doc } from '../model/types';
import { MemoryProjects, setPartStore, setProjectStore } from '../state/projects';
import type { DeletePlan, MemorySyncState, RemoteFile, SyncReport } from './engine';

/** One Drive account's app folder: its id, and the files in it and in its Parts folder. */
class Account {
  readonly files = new Map<string, { file: RemoteFile; text: string }>();
  readonly parts = new Map<string, { file: RemoteFile; text: string }>();
  failOn: string | null = null;
  signedOut = false;
  private serial = 0;
  constructor(readonly folder: string) {}
  next(): string {
    return `${this.folder}-file-${++this.serial}`;
  }
}

const cloud = vi.hoisted(() => ({ account: null as unknown, tokens: null as unknown, bindings: new Map<string, string>(), states: new Map<string, unknown>() }));
const account = (): Account => cloud.account as Account;

vi.mock('../platform', () => ({ isDesktop: () => false, isAndroid: () => false }));
vi.mock('./google', () => {
  class NeedsSignIn extends Error {}
  return {
    NeedsSignIn,
    isConfigured: () => true,
    loadTokens: async () => cloud.tokens,
    saveTokens: async (tokens: unknown) => void (cloud.tokens = tokens),
    authorizedFetch: () => async () => new Response('{}'),
    signIn: async () => ({ access: 'a', refresh: 'r', expires: Number.MAX_SAFE_INTEGER, email: null }),
    cancelSignIn: () => {},
    revoke: async () => true,
  };
});
vi.mock('./state', async () => {
  // The scheduler takes its record stores once, as it is loaded: they are made here and emptied between tests.
  const { MemorySyncState } = await import('./engine');
  cloud.states.set('records', new MemorySyncState());
  cloud.states.set('parts', new MemorySyncState());
  return {
    STORES: { projects: 'records', parts: 'parts' },
    openSyncState: (store: string) => cloud.states.get(store),
    loadBinding: (store: string) => cloud.bindings.get(store) ?? null,
    saveBinding: (store: string, binding: string | null) => void (binding === null ? cloud.bindings.delete(store) : cloud.bindings.set(store, binding)),
  };
});
vi.mock('./drive', async () => {
  const { NeedsSignIn } = await import('./google');
  class DriveRemote {
    constructor(
      _fetch: unknown,
      private readonly name = 'PlastikCAD',
      private readonly parent: DriveRemote | null = null,
    ) {}
    private get files() {
      return this.parent ? account().parts : account().files;
    }
    async folder(): Promise<string> {
      if (account().signedOut) throw new NeedsSignIn('The Google Drive link has lapsed. Link it again.');
      return this.parent ? `${account().folder}/${this.name}` : account().folder;
    }
    async list(): Promise<RemoteFile[]> {
      await this.folder();
      return [...this.files.values()].map((f) => f.file);
    }
    async download(file: RemoteFile): Promise<string> {
      return this.files.get(file.id)!.text;
    }
    async upload(existing: RemoteFile | null, name: string, text: string, meta: { projectId: string; revision: string | null }): Promise<RemoteFile> {
      if (account().failOn === meta.projectId) throw new Error(`Google Drive could not upload ${name}: quota`);
      const file: RemoteFile = { id: existing?.id ?? account().next(), name: `${name}.plastikcad`, projectId: meta.projectId, revision: meta.revision, modified: Date.now() };
      this.files.set(file.id, { file, text });
      return file;
    }
    async remove(file: RemoteFile): Promise<void> {
      this.files.delete(file.id);
    }
    async account() {
      return { email: 'me@example.com', name: 'Me' };
    }
  }
  return { DriveRemote };
});

const sync = await import('./sync');

const design = (id: string, name: string, x = 0): Doc => ({ ...emptyDoc(), id, name, scene: [{ ...makeShape('box'), id: 'box00001', pos: [x, 0, 10] }], revision: newId(), device: 'device0a' });
/** A projects folder in memory that says where it is, as the folder on disk does. */
const folderAt = (location: string): MemoryProjects => Object.assign(new MemoryProjects(), { location });
/** Puts the projects in `store`, with the parts in memory beside them rather than in a folder on disk. */
const keepIn = (store: MemoryProjects): void => {
  setProjectStore(store);
  setPartStore(new MemoryProjects());
};

let local: MemoryProjects;
const reports: SyncReport[] = [];
const asked: DeletePlan[] = [];
let answer = false;

beforeAll(() => {
  vi.useFakeTimers();
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  cloud.account = new Account('folder-a');
  cloud.tokens = { access: 'a', refresh: 'r', expires: Number.MAX_SAFE_INTEGER, email: null };
  cloud.bindings.clear();
  for (const records of cloud.states.values()) await (records as MemorySyncState).clear();
  reports.length = 0;
  asked.length = 0;
  answer = false;
  local = folderAt('/home/me/PlastikCAD');
  keepIn(local);
  for (const [id, name] of [['project1', 'A'], ['project2', 'B'], ['project3', 'C']]) await local.write(null, name, serializeDoc(design(id, name)));
  await sync.initSync({
    device: 'device0a',
    flush: async () => true,
    changed: (report) => void reports.push(report),
    partsChanged: () => {},
    notice: () => {},
    confirmDeletes: async (plan) => (asked.push(plan), answer),
  });
  await sync.syncNow();
  expect(account().files.size).toBe(3);
});

describe('the sync scheduler', () => {
  it('starts over, deleting nothing, when the Drive folder is not the one it synced with', async () => {
    // Another Google account, or the folder trashed in the Drive and made again: empty either way.
    cloud.account = new Account('folder-b');
    await sync.syncNow();
    expect((await local.list()).length).toBe(3);
    expect(account().files.size).toBe(3);
    expect(asked).toEqual([]);
    expect(sync.getSyncStatus().error).toBeNull();
  });

  it('starts over, trashing nothing, when the projects folder is not the one it synced with', async () => {
    const moved = folderAt('/mnt/usb/PlastikCAD');
    keepIn(moved);
    await sync.syncNow();
    expect(account().files.size).toBe(3);
    expect((await moved.list()).length).toBe(3);
    expect(asked).toEqual([]);
  });

  it('keeps what it knows across a lapsed sign-in to the same folder, and asks before a mass deletion', async () => {
    account().signedOut = true;
    await sync.syncNow();
    expect(sync.getSyncStatus()).toMatchObject({ linked: false, error: 'The Google Drive link has lapsed. Link it again.' });
    account().signedOut = false;
    // Meanwhile the files were emptied out of the folder on another device.
    account().files.clear();
    await sync.linkAccount();
    expect(asked).toEqual([{ side: 'local', names: ['A', 'B', 'C'], total: 3 }]);
    // "Keep them": they are still here, and back in the Drive.
    expect((await local.list()).length).toBe(3);
    expect(account().files.size).toBe(3);
  });

  it('tells the editor what a pass wrote even when another project failed', async () => {
    const [first] = [...account().files.values()];
    const there = { ...parseDoc(first.text), scene: design('x', 'x', 7).scene, revision: newId() };
    first.text = serializeDoc(there);
    first.file = { ...first.file, revision: there.revision! };
    await local.write(null, 'Bad', serializeDoc(design('project4', 'Bad')));
    account().failOn = 'project4';
    await sync.syncNow();
    expect(reports.length).toBe(1);
    expect(reports[0].downloaded).toEqual(['A']);
    expect(reports[0].changedKeys.length).toBe(1);
    expect(sync.getSyncStatus().error).toBe('Google Drive could not upload Bad: quota');
  });

  it('starts no pass while it is paused, and lets the one under way finish first', async () => {
    await local.write(null, 'D', serializeDoc(design('project4', 'D')));
    await sync.withSyncPaused(async () => {
      expect(await sync.syncNow()).toBeNull();
      expect(account().files.size).toBe(3);
    });
    await sync.syncNow();
    expect(account().files.size).toBe(4);
  });

  it('forgets the places with the account when it is unlinked', async () => {
    expect(cloud.bindings.size).toBe(2);
    await sync.unlinkAccount();
    expect(cloud.bindings.size).toBe(0);
    expect((cloud.states.get('records') as MemorySyncState).records.size).toBe(0);
    expect((await local.list()).length).toBe(3);
  });
});
