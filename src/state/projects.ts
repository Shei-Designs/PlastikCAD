// Where projects are kept. The desktop app keeps them as `.bashcad` files in a
// projects folder (on Android, in the app's own storage); a plain browser keeps
// them in IndexedDB. Autosave writes here and the projects browser lists it.
// A project is addressed by its key: the file's path on disk, a record key in
// the browser. The id inside the file identifies the project across copies
// and devices (that is what sync will use); the key says where it is now.
import { FILE_EXTENSION, FILE_FORMAT } from '../app';
import { HEAD_BYTES, parseDoc, readHeader, serializeDoc } from '../model/file';
import type { DocHeader } from '../model/file';
import { newId } from '../model/ops';
import type { Doc } from '../model/types';
import * as platform from '../platform';

export interface ProjectInfo {
  key: string;
  /** Null when the file was saved before projects had ids; it gets one when opened. */
  id: string | null;
  name: string;
  /** Milliseconds since the epoch. */
  modified: number;
  size: number;
  thumb: string | null;
}

export interface ProjectStore {
  /** The folder projects are kept in, for the settings line; null in the browser. */
  readonly location: string | null;
  list(): Promise<ProjectInfo[]>;
  /** The project's file text. Rejects if it is gone. */
  read(key: string): Promise<string>;
  /**
   * Writes a project, new when `key` is null, and returns the key it is at now:
   * a file follows its project's name, so a rename moves it.
   */
  write(key: string | null, name: string, text: string): Promise<string>;
  remove(key: string): Promise<void>;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The header of a project from its full text, for stores that keep whole texts. */
function headerOf(text: string): DocHeader {
  const header = readHeader(text.slice(0, HEAD_BYTES));
  if (header) return header;
  const doc = parseDoc(text);
  return { id: doc.id, name: doc.name, thumb: doc.thumb ?? null };
}

/** A file name for a project name: no path separators or characters some file systems refuse, not too long. */
export function fileNameFor(name: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  return `${clean || 'Untitled'}.${FILE_EXTENSION}`;
}

/** `Name.bashcad`, or `Name (2).bashcad` when a different file already has that name (compared ignoring case, as some file systems do). */
export function uniqueFileName(wanted: string, taken: Iterable<string>, own?: string): string {
  const used = new Set(Array.from(taken, (n) => n.toLowerCase()));
  if (own) used.delete(own.toLowerCase());
  if (!used.has(wanted.toLowerCase())) return wanted;
  const stem = wanted.slice(0, wanted.length - FILE_EXTENSION.length - 1);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n}).${FILE_EXTENSION}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether a file already carries a project name: the same name ignoring case, with or without the number a clash gave it. */
const sameFile = (existing: string, wanted: string): boolean => {
  const stem = wanted.slice(0, wanted.length - FILE_EXTENSION.length - 1);
  return new RegExp(`^${escapeRegExp(stem)}( \\(\\d+\\))?\\.${FILE_EXTENSION}$`, 'i').test(existing);
};
const join = (dir: string, name: string): string => (dir.endsWith('/') || dir.endsWith('\\') ? dir + name : `${dir}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}`);

/** The desktop app's projects folder. Headers are read from the start of each file and remembered until the file changes. */
export class DiskProjects implements ProjectStore {
  private heads = new Map<string, { modified: number; size: number; header: DocHeader }>();

  constructor(readonly location: string) {}

  async list(): Promise<ProjectInfo[]> {
    const entries = await platform.listDesigns(this.location);
    const out: ProjectInfo[] = [];
    for (const entry of entries) {
      let cached = this.heads.get(entry.path);
      if (!cached || cached.modified !== entry.modified || cached.size !== entry.size) {
        const header = await this.header(entry);
        // Not a design after all (some other JSON with the extension): left out.
        if (!header) continue;
        cached = { modified: entry.modified, size: entry.size, header };
        this.heads.set(entry.path, cached);
      }
      out.push({ key: entry.path, id: cached.header.id, name: cached.header.name, modified: entry.modified, size: entry.size, thumb: cached.header.thumb });
    }
    for (const path of this.heads.keys()) if (!entries.some((e) => e.path === path)) this.heads.delete(path);
    return out;
  }

  private async header(entry: platform.DesignEntry): Promise<DocHeader | null> {
    try {
      const head = decoder.decode(await platform.readHead(entry.path, HEAD_BYTES));
      const header = readHeader(head);
      if (header) return header;
      // Laid out some other way (edited by hand, say): the whole file has to be read.
      if (entry.size > 64 * 1024 * 1024) return null;
      return headerOf(decoder.decode((await platform.readPath(entry.path)).bytes));
    } catch {
      return null;
    }
  }

  async read(key: string): Promise<string> {
    return decoder.decode((await platform.readPath(key)).bytes);
  }

  async write(key: string | null, name: string, text: string): Promise<string> {
    const wanted = fileNameFor(name);
    let target = key;
    if (!key || !sameFile(baseName(key), wanted)) {
      const taken = (await platform.listDesigns(this.location)).map((e) => e.name);
      target = join(this.location, uniqueFileName(wanted, taken, key ? baseName(key) : undefined));
      if (key && target !== key) await platform.moveFile(key, target);
    }
    await platform.writePath(target!, encoder.encode(text));
    this.heads.delete(target!);
    return target!;
  }

  async remove(key: string): Promise<void> {
    await platform.removeFile(key);
    this.heads.delete(key);
  }
}

/** Projects kept in memory: for tests, and the fallback when no storage is available. */
export class MemoryProjects implements ProjectStore {
  readonly location = null;
  readonly records = new Map<string, { name: string; text: string; modified: number }>();
  private serial = 0;
  private clock = 0;

  async list(): Promise<ProjectInfo[]> {
    return Array.from(this.records, ([key, r]) => {
      const header = headerOf(r.text);
      return { key, id: header.id, name: r.name, modified: r.modified, size: r.text.length, thumb: header.thumb };
    });
  }

  async read(key: string): Promise<string> {
    const record = this.records.get(key);
    if (!record) throw new Error('This project is gone.');
    return record.text;
  }

  async write(key: string | null, name: string, text: string): Promise<string> {
    const at = key ?? `mem:${++this.serial}`;
    // Strictly increasing, so that "newest first" holds for writes within the same millisecond.
    this.clock = Math.max(Date.now(), this.clock + 1);
    this.records.set(at, { name, text, modified: this.clock });
    return at;
  }

  async remove(key: string): Promise<void> {
    this.records.delete(key);
  }
}

// --- browser: IndexedDB ------------------------------------------------------

const DB_NAME = FILE_FORMAT;
const DB_VERSION = 2;
/** Header rows, small, for listing. */
const META = 'projects';
/** The file texts, one per project, which can run to megabytes. */
const TEXTS = 'texts';

interface MetaRecord {
  key: string;
  id: string | null;
  name: string;
  modified: number;
  size: number;
  thumb: string | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = (event) => {
      const db = open.result;
      const meta = db.createObjectStore(META, { keyPath: 'key' });
      db.createObjectStore(TEXTS);
      // Version 1 kept the one open design as a session copy; it becomes the first project.
      if (event.oldVersion === 1 && db.objectStoreNames.contains('session')) {
        const tx = open.transaction!;
        const get = tx.objectStore('session').get('current');
        get.onsuccess = () => {
          const session = get.result as { doc?: Doc } | undefined;
          const doc = session?.doc;
          if (doc && Array.isArray(doc.scene) && doc.scene.length > 0) {
            try {
              const text = serializeDoc({ ...doc, id: typeof doc.id === 'string' ? doc.id : newId() });
              const header = headerOf(text);
              const key = newId();
              meta.put({ key, id: header.id, name: header.name, modified: Date.now(), size: text.length, thumb: header.thumb } satisfies MetaRecord);
              tx.objectStore(TEXTS).put(text, key);
            } catch {
              // A session copy the current app cannot read is let go.
            }
          }
          db.deleteObjectStore('session');
        };
      }
    };
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('The project storage is in use by another tab.'));
    open.onsuccess = () => resolve(open.result);
  });
}

function transact<T>(mode: IDBTransactionMode, run: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction([META, TEXTS], mode);
        const request = run(tx);
        tx.oncomplete = () => {
          db.close();
          resolve(request ? request.result : (undefined as T));
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('The project could not be stored.'));
        };
      }),
  );
}

/** Projects in the browser's IndexedDB, where they survive reloads but belong to this browser profile alone. */
export class DbProjects implements ProjectStore {
  readonly location = null;

  async list(): Promise<ProjectInfo[]> {
    const rows = await transact<MetaRecord[]>('readonly', (tx) => tx.objectStore(META).getAll());
    return rows.map((r) => ({ key: r.key, id: r.id, name: r.name, modified: r.modified, size: r.size, thumb: r.thumb }));
  }

  async read(key: string): Promise<string> {
    const text = await transact<string | undefined>('readonly', (tx) => tx.objectStore(TEXTS).get(key));
    if (typeof text !== 'string') throw new Error('This project is gone.');
    return text;
  }

  async write(key: string | null, name: string, text: string): Promise<string> {
    const at = key ?? newId();
    const header = headerOf(text);
    await transact<void>('readwrite', (tx) => {
      tx.objectStore(META).put({ key: at, id: header.id, name, modified: Date.now(), size: text.length, thumb: header.thumb } satisfies MetaRecord);
      tx.objectStore(TEXTS).put(text, at);
    });
    return at;
  }

  async remove(key: string): Promise<void> {
    await transact<void>('readwrite', (tx) => {
      tx.objectStore(META).delete(key);
      tx.objectStore(TEXTS).delete(key);
    });
  }
}

// --- the store in use -----------------------------------------------------

let current: ProjectStore | null = null;

/** The store projects are kept in; `useProjectStore` first, or there is none. */
export function projectStore(): ProjectStore {
  if (!current) throw new Error('The project storage is not ready yet.');
  return current;
}

export function useProjectStore(store: ProjectStore): void {
  current = store;
}

/** Whether a store has been chosen (start-up has got that far). */
export const hasProjectStore = (): boolean => current !== null;

/**
 * Picks the store for this platform: the projects folder on desktop (the one
 * the user chose, else the default), IndexedDB in a browser, memory when even
 * that is unavailable. Returns the folder's default when there is one, so
 * settings can say whether it can be changed.
 */
export async function openProjectStore(chosenDir: string | null): Promise<{ fixed: boolean; defaultDir: string | null }> {
  if (platform.isDesktop()) {
    const home = await platform.defaultProjectsDir();
    const dir = home.fixed ? home.path : (chosenDir ?? home.path);
    current = new DiskProjects(dir);
    return { fixed: home.fixed, defaultDir: home.path };
  }
  if (typeof indexedDB === 'undefined') {
    current = new MemoryProjects();
    return { fixed: true, defaultDir: null };
  }
  current = new DbProjects();
  return { fixed: true, defaultDir: null };
}
