// Where projects are kept. The desktop app keeps them as `.plastikcad` files in a
// projects folder (on Android, in the app's own storage); a plain browser keeps
// them in IndexedDB. Autosave writes here and the projects browser lists it.
// A project is addressed by its key: the file's path on disk, a record key in
// the browser. The id inside the file identifies the project across copies
// and devices (that is what sync will use); the key says where it is now.
import { FILE_EXTENSION, FILE_FORMAT } from '../appInfo';
import { tr } from '../i18n';
import { HEAD_BYTES, parseDoc, readHeader, savedTime, serializeDoc } from '../model/file';
import type { DocHeader } from '../model/file';
import { newId } from '../model/ops';
import type { Doc } from '../model/types';
import * as platform from '../platform';

export interface ProjectInfo {
  key: string;
  /** Null when the file was saved before projects had ids; it gets one when opened. */
  id: string | null;
  name: string;
  /** The revision stamped in the file; null for files from before revisions. */
  revision: string | null;
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
  /**
   * Takes a project out of the store without destroying it, where the store
   * has somewhere to put it: for deletions the user did not make on this
   * device, which sync carries over from another.
   */
  discard?(key: string): Promise<void>;
  /** What was discarded, to be put back or destroyed. */
  discarded?(): Promise<ProjectInfo[]>;
  /** Puts a discarded project back among the projects, and returns the key it has there. */
  restore?(key: string): Promise<string>;
  /** Destroys a discarded project, or all of them, with the earlier saves kept of each. */
  purge?(key?: string): Promise<void>;
  /**
   * Keeps the project as it is stored now, before it is written over: an
   * earlier save to go back to. One is kept every few minutes of saving at
   * most, unless `always`, for a replacement the user did not make (a sync).
   */
  keep?(key: string, always?: boolean): Promise<void>;
  /** The earlier saves kept of a project, newest first. Each is read like a project, by its key. */
  versions?(id: string): Promise<VersionInfo[]>;
  /**
   * Runs a look at what is stored together with the write that relies on it, with no other such pair in between:
   * the editor's save and a sync pass each check that a file is still the one they know before they replace it,
   * and neither may write between the other's check and its write.
   */
  exclusive?<T>(run: () => Promise<T>): Promise<T>;
  /**
   * The files the last listing found and could not read (busy, not yet fetched by the system, damaged): they are
   * missing from what `list` gave, and are not to be taken for deleted.
   */
  unreadable?(): readonly string[];
}

/** One at a time, in the order asked; one that fails does not hold up the next. */
export class Turns {
  private last: Promise<unknown> = Promise.resolve();

  take<T>(run: () => Promise<T>): Promise<T> {
    const next = this.last.then(run, run);
    this.last = next.catch(() => undefined);
    return next;
  }
}

/** An earlier save of a project, kept beside the projects. */
export interface VersionInfo {
  key: string;
  /** When it was saved, in ms since the epoch. */
  saved: number;
  size: number;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Where a projects folder keeps what was deleted from it, until the user empties it. */
export const TRASH_FOLDER = 'Trash';
/** Where it keeps earlier saves of its projects, a folder to each project's id. */
export const HISTORY_FOLDER = 'History';
/** How many earlier saves are kept of a project, how many of those are simply the latest, and how far apart those made by ordinary saving are. */
export const KEEP_VERSIONS = 20;
export const KEEP_LATEST = 12;
export const KEEP_EVERY_MS = 10 * 60_000;

/**
 * Which earlier saves to let go of, given when each was made. The latest are
 * all kept; further back one is kept a day (UTC), the last of that day, so
 * that a long sitting does not push out the days before it; and the oldest go
 * once there are more than are kept in all.
 */
export function versionsToDrop(saved: number[]): number[] {
  const drop: number[] = [];
  const days = new Set<number>();
  let kept = 0;
  for (const [i, time] of [...saved].sort((a, b) => b - a).entries()) {
    const day = Math.floor(time / 86_400_000);
    if (kept < KEEP_VERSIONS && (i < KEEP_LATEST || !days.has(day))) {
      kept++;
      days.add(day);
    } else {
      drop.push(time);
    }
  }
  return drop;
}

/** A file name for an earlier save, which sorts by when it was saved: 20261110-135300 (UTC). */
const stampName = (saved: number): string => `${new Date(saved).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}.${FILE_EXTENSION}`;
/** When the save of that file name was made, or null if it is not one. */
function stampTime(name: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\./.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/** The header of a project from its full text, for stores that keep whole texts. */
function headerOf(text: string): DocHeader {
  const header = readHeader(text.slice(0, HEAD_BYTES));
  if (header) return header;
  const doc = parseDoc(text);
  return { id: doc.id, name: doc.name, revision: doc.revision ?? null, saved: savedTime(doc.saved), thumb: doc.thumb ?? null };
}

/** A file name for a project name: no path separators or characters some file systems refuse, not too long. */
export function fileNameFor(name: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A leading dot would hide the file, from the projects browser as from everything else.
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/, '');
  // Cut by characters, not code units: half of a pair is not a name any file system or URL takes.
  const short = Array.from(clean).slice(0, 80).join('').trim();
  // Names Windows keeps for devices, whatever their extension.
  const safe = /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(short) ? `${short} project` : short;
  return `${safe || tr('Untitled')}.${FILE_EXTENSION}`;
}

/** `Name.plastikcad`, or `Name (2).plastikcad` when a different file already has that name (compared ignoring case, as some file systems do). */
export function uniqueFileName(wanted: string, taken: Iterable<string>, own?: string): string {
  const used = new Set(Array.from(taken, folded));
  if (own) used.delete(folded(own));
  if (!used.has(folded(wanted))) return wanted;
  const stem = wanted.slice(0, wanted.length - FILE_EXTENSION.length - 1);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n}).${FILE_EXTENSION}`;
    if (!used.has(folded(candidate))) return candidate;
  }
}

/**
 * A file name as the file systems that fold names see it: case aside (Windows, macOS, a memory card), and an
 * accented letter the same whether written as one character or as a letter and its accent (macOS takes the two
 * for one file, and names that came from a Mac are often in the second form).
 */
const folded = (name: string): string => name.normalize('NFC').toLowerCase();

const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
const folderOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether a file already carries a project name: the same name ignoring case, with or without the number a clash gave it. */
const sameFile = (existing: string, wanted: string): boolean => {
  const stem = folded(wanted.slice(0, wanted.length - FILE_EXTENSION.length - 1));
  return new RegExp(`^${escapeRegExp(stem)}( \\(\\d+\\))?\\.${FILE_EXTENSION}$`, 'i').test(folded(existing));
};
const join = (dir: string, name: string): string => (dir.endsWith('/') || dir.endsWith('\\') ? dir + name : `${dir}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}`);

/** The desktop app's projects folder. Headers are read from the start of each file and remembered until the file changes. */
export class DiskProjects implements ProjectStore {
  private heads = new Map<string, { modified: number; size: number; header: DocHeader }>();
  private readonly pairs = new Turns();
  /** Writes go one at a time: a new project looks for a free name and then takes it, and two at once would take the same one. */
  private readonly writes = new Turns();

  constructor(readonly location: string) {}

  exclusive<T>(run: () => Promise<T>): Promise<T> {
    return this.pairs.take(run);
  }

  list(): Promise<ProjectInfo[]> {
    return this.listIn(this.location);
  }

  /** The designs in a folder, by their headers. */
  private async listIn(dir: string): Promise<ProjectInfo[]> {
    const entries = await platform.listDesigns(dir);
    const out: ProjectInfo[] = [];
    const unread: string[] = [];
    for (const entry of entries) {
      let cached = this.heads.get(entry.path);
      if (!cached || cached.modified !== entry.modified || cached.size !== entry.size) {
        const header = await this.header(entry).catch(() => {
          if (dir === this.location) unread.push(entry.path);
          return null;
        });
        // Not a design after all (some other JSON with the extension), or not to be read just now: left out.
        if (!header) continue;
        cached = { modified: entry.modified, size: entry.size, header };
        this.heads.set(entry.path, cached);
      }
      // Dated by the design's own word of when it was saved, where it has one. The file's date says when the file was
      // written here: the moment of a sync or a copy, and after a device restore it has been seen to read 1970.
      out.push({ key: entry.path, id: cached.header.id, name: cached.header.name, revision: cached.header.revision, modified: cached.header.saved ?? entry.modified, size: entry.size, thumb: cached.header.thumb });
    }
    // What is gone from this folder is forgotten; headers of the other folders are left alone.
    for (const path of this.heads.keys()) if (folderOf(path) === folderOf(join(dir, 'x')) && !entries.some((e) => e.path === path)) this.heads.delete(path);
    if (dir === this.location) this.unread = unread;
    return out;
  }

  private unread: string[] = [];

  unreadable(): readonly string[] {
    return this.unread;
  }

  /** The header of a file; null when it is not a design. Rejects when the file could not be read at all. */
  private async header(entry: platform.DesignEntry): Promise<DocHeader | null> {
    const head = decoder.decode(await platform.readHead(entry.path, HEAD_BYTES));
    const header = readHeader(head);
    if (header) return header;
    // Laid out some other way (edited by hand, say): the whole file has to be read.
    if (entry.size > 64 * 1024 * 1024) return null;
    const text = decoder.decode((await platform.readPath(entry.path)).bytes);
    try {
      return headerOf(text);
    } catch {
      return null;
    }
  }

  async read(key: string): Promise<string> {
    return decoder.decode((await platform.readPath(key)).bytes);
  }

  write(key: string | null, name: string, text: string): Promise<string> {
    return this.writes.take(() => this.writeNow(key, name, text));
  }

  private async writeNow(key: string | null, name: string, text: string): Promise<string> {
    const wanted = fileNameFor(name);
    let target = key;
    if (!key || !sameFile(baseName(key), wanted)) {
      const taken = (await platform.listDesigns(this.location)).map((e) => e.name);
      target = join(this.location, uniqueFileName(wanted, taken, key ? baseName(key) : undefined));
      if (key && target !== key) await platform.moveFile(key, target);
    }
    try {
      await platform.writePath(target!, encoder.encode(text));
    } catch (e) {
      // The file must not be left under a name its project does not know it by: every later save would look for it at the old one.
      if (key && target !== key) await platform.moveFile(target!, key).catch(() => {});
      throw e;
    }
    this.heads.delete(target!);
    return target!;
  }

  async remove(key: string): Promise<void> {
    await platform.removeFile(key);
    this.heads.delete(key);
  }

  /** The folder discarded projects are moved to, inside the projects folder. */
  get trash(): string {
    return join(this.location, TRASH_FOLDER);
  }

  async discard(key: string): Promise<void> {
    const taken = (await platform.listDesigns(this.trash)).map((e) => e.name);
    await platform.moveFile(key, join(this.trash, uniqueFileName(baseName(key), taken)));
    this.heads.delete(key);
  }

  discarded(): Promise<ProjectInfo[]> {
    return this.listIn(this.trash);
  }

  async restore(key: string): Promise<string> {
    const taken = (await platform.listDesigns(this.location)).map((e) => e.name);
    const back = join(this.location, uniqueFileName(baseName(key), taken));
    await platform.moveFile(key, back);
    this.heads.delete(key);
    return back;
  }

  async purge(key?: string): Promise<void> {
    const trashed = await this.discarded();
    const gone = trashed.filter((item) => key === undefined || item.key === key);
    // The earlier saves go with a project only when no project of that id is left, here or in the trash.
    const left = new Set([...(await this.list()), ...trashed.filter((item) => !gone.includes(item))].map((item) => item.id));
    for (const item of gone) {
      await platform.removeFile(item.key);
      this.heads.delete(item.key);
      if (!item.id || left.has(item.id)) continue;
      for (const version of await this.versions(item.id)) await platform.removeFile(version.key).catch(() => {});
    }
  }

  /** When an earlier save was last kept of each project, by key, this session. */
  private kept = new Map<string, number>();

  async keep(key: string, always = false): Promise<void> {
    const now = Date.now();
    const last = this.kept.get(key);
    if (!always && last !== undefined && now - last < KEEP_EVERY_MS) return;
    // Nothing there yet (a project's first save), or nothing that says whose it is: nothing to keep.
    const file = await platform.readPath(key).catch(() => null);
    const header = file && readHeader(decoder.decode(file.bytes.subarray(0, HEAD_BYTES)));
    if (!file || !header?.id) return;
    this.kept.set(key, now);
    const dir = join(join(this.location, HISTORY_FOLDER), header.id);
    const name = stampName(header.saved ?? now);
    const names = (await platform.listDesigns(dir)).map((e) => e.name);
    if (!names.includes(name)) {
      await platform.writePath(join(dir, name), file.bytes);
      names.push(name);
    }
    const gone = new Set(versionsToDrop(names.map(stampTime).filter((t): t is number => t !== null)));
    for (const old of names) if (gone.has(stampTime(old) ?? -1)) await platform.removeFile(join(dir, old)).catch(() => {});
  }

  /** Takes over what another folder holds in its trash, with the earlier saves of each, when its projects move here. */
  async takeTrash(from: DiskProjects): Promise<void> {
    for (const item of await from.discarded()) {
      const taken = (await platform.listDesigns(this.trash)).map((e) => e.name);
      await platform.moveFile(item.key, join(this.trash, uniqueFileName(baseName(item.key), taken))).catch(() => {});
      if (item.id) await this.takeVersions(from, item.id);
    }
  }

  /** Takes over the earlier saves another folder kept of a project, when its projects move here. */
  async takeVersions(from: DiskProjects, id: string): Promise<void> {
    for (const version of await from.versions(id)) await platform.moveFile(version.key, join(join(join(this.location, HISTORY_FOLDER), id), baseName(version.key))).catch(() => {});
  }

  async versions(id: string): Promise<VersionInfo[]> {
    const entries = await platform.listDesigns(join(join(this.location, HISTORY_FOLDER), id));
    return entries
      .map((e) => ({ key: e.path, saved: stampTime(e.name), size: e.size }))
      .filter((v): v is VersionInfo => v.saved !== null)
      .sort((a, b) => b.saved - a.saved);
  }
}

/** Projects kept in memory: for tests, and the fallback when no storage is available. */
export class MemoryProjects implements ProjectStore {
  readonly location = null;
  readonly records = new Map<string, { name: string; text: string; modified: number }>();
  /** What was discarded, and the earlier saves kept, as the folder on disk keeps them. */
  readonly trash = new Map<string, { name: string; text: string; modified: number }>();
  readonly history = new Map<string, { key: string; saved: number; text: string }[]>();
  private kept = new Map<string, number>();
  private serial = 0;
  private clock = 0;
  private readonly pairs = new Turns();

  exclusive<T>(run: () => Promise<T>): Promise<T> {
    return this.pairs.take(run);
  }

  async list(): Promise<ProjectInfo[]> {
    return this.infos(this.records);
  }

  private infos(records: Map<string, { name: string; text: string; modified: number }>): ProjectInfo[] {
    return Array.from(records, ([key, r]) => {
      const header = headerOf(r.text);
      return { key, id: header.id, name: r.name, revision: header.revision, modified: r.modified, size: r.text.length, thumb: header.thumb };
    });
  }

  async read(key: string): Promise<string> {
    const text = this.records.get(key)?.text ?? this.trash.get(key)?.text ?? [...this.history.values()].flat().find((v) => v.key === key)?.text;
    if (text === undefined) throw new Error(tr('This project is gone.'));
    return text;
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

  async discard(key: string): Promise<void> {
    const record = this.records.get(key);
    if (!record) throw new Error(tr('This project is gone.'));
    this.records.delete(key);
    this.trash.set(`trash:${key}`, record);
  }

  async discarded(): Promise<ProjectInfo[]> {
    return this.infos(this.trash);
  }

  async restore(key: string): Promise<string> {
    const record = this.trash.get(key);
    if (!record) throw new Error(tr('This project is gone.'));
    this.trash.delete(key);
    const back = `mem:${++this.serial}`;
    this.records.set(back, record);
    return back;
  }

  async purge(key?: string): Promise<void> {
    const gone = (await this.discarded()).filter((item) => key === undefined || item.key === key);
    for (const item of gone) this.trash.delete(item.key);
    const left = new Set([...(await this.list()), ...(await this.discarded())].map((item) => item.id));
    for (const item of gone) if (item.id && !left.has(item.id)) this.history.delete(item.id);
  }

  async keep(key: string, always = false): Promise<void> {
    const record = this.records.get(key);
    const header = record && headerOf(record.text);
    const last = this.kept.get(key);
    if (!record || !header?.id || (!always && last !== undefined && Date.now() - last < KEEP_EVERY_MS)) return;
    this.kept.set(key, Date.now());
    const saved = header.saved ?? record.modified;
    const versions = this.history.get(header.id) ?? [];
    if (!versions.some((v) => v.saved === saved)) versions.push({ key: `version:${header.id}:${saved}`, saved, text: record.text });
    const gone = new Set(versionsToDrop(versions.map((v) => v.saved)));
    this.history.set(header.id, versions.filter((v) => !gone.has(v.saved)).sort((a, b) => b.saved - a.saved));
  }

  async versions(id: string): Promise<VersionInfo[]> {
    return (this.history.get(id) ?? []).map((v) => ({ key: v.key, saved: v.saved, size: v.text.length }));
  }
}

// --- browser: IndexedDB ------------------------------------------------------

const DB_VERSION = 2;
/** Header rows, small, for listing. */
const META = 'projects';
/** The file texts, one per project, which can run to megabytes. */
const TEXTS = 'texts';

interface MetaRecord {
  key: string;
  id: string | null;
  name: string;
  revision?: string | null;
  modified: number;
  size: number;
  thumb: string | null;
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, DB_VERSION);
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
              meta.put({ key, id: header.id, name: header.name, revision: header.revision, modified: Date.now(), size: text.length, thumb: header.thumb } satisfies MetaRecord);
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
    open.onblocked = () => reject(new Error(tr('The project storage is in use by another tab.')));
    open.onsuccess = () => resolve(open.result);
  });
}

function transact<T>(name: string, mode: IDBTransactionMode, run: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return openDb(name).then(
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
          reject(tx.error ?? new Error(tr('The project could not be stored.')));
        };
      }),
  );
}

/** Projects in the browser's IndexedDB, where they survive reloads but belong to this browser profile alone. */
export class DbProjects implements ProjectStore {
  readonly location = null;

  private readonly pairs = new Turns();

  /** `name` is the database: the projects have one, the custom parts another. */
  constructor(private readonly name: string = FILE_FORMAT) {}

  exclusive<T>(run: () => Promise<T>): Promise<T> {
    return this.pairs.take(run);
  }

  async list(): Promise<ProjectInfo[]> {
    const rows = await transact<MetaRecord[]>(this.name, 'readonly', (tx) => tx.objectStore(META).getAll());
    return rows.map((r) => ({ key: r.key, id: r.id, name: r.name, revision: r.revision ?? null, modified: r.modified, size: r.size, thumb: r.thumb }));
  }

  async read(key: string): Promise<string> {
    const text = await transact<string | undefined>(this.name, 'readonly', (tx) => tx.objectStore(TEXTS).get(key));
    if (typeof text !== 'string') throw new Error(tr('This project is gone.'));
    return text;
  }

  async write(key: string | null, name: string, text: string): Promise<string> {
    const at = key ?? newId();
    const header = headerOf(text);
    await transact<void>(this.name, 'readwrite', (tx) => {
      // Dated as the projects folder on disk dates a project: by when the design says it was saved.
      tx.objectStore(META).put({ key: at, id: header.id, name, revision: header.revision, modified: header.saved ?? Date.now(), size: text.length, thumb: header.thumb } satisfies MetaRecord);
      tx.objectStore(TEXTS).put(text, at);
    });
    return at;
  }

  async remove(key: string): Promise<void> {
    await transact<void>(this.name, 'readwrite', (tx) => {
      tx.objectStore(META).delete(key);
      tx.objectStore(TEXTS).delete(key);
    });
  }
}

// --- the store in use -----------------------------------------------------

/** The browser database the custom parts live in. */
const PARTS_DB = `${FILE_FORMAT}-parts`;

let current: ProjectStore | null = null;
let parts: ProjectStore | null = null;

/** The store projects are kept in; `setProjectStore` first, or there is none. */
export function projectStore(): ProjectStore {
  if (!current) throw new Error(tr('The project storage is not ready yet.'));
  return current;
}

/**
 * The store custom parts are kept in: objects the user saved from a design to
 * place again. Each is a design file of one object, kept apart from the
 * projects (a "Parts" folder inside the projects folder on desktop, a database
 * of its own in a browser) so that it never shows up as a project.
 */
export function partStore(): ProjectStore {
  if (!parts) throw new Error(tr('The parts storage is not ready yet.'));
  return parts;
}

const PARTS_FOLDER = 'Parts';
/** The folder custom parts go in, inside a projects folder. */
export const partsDirOf = (projectsDir: string): string => join(projectsDir, PARTS_FOLDER);

/** Parts follow the projects folder; a store without a folder gets a memory store for them until `setPartStore` says otherwise. */
export function setProjectStore(store: ProjectStore): void {
  current = store;
  parts = store.location ? new DiskProjects(partsDirOf(store.location)) : new MemoryProjects();
}

export function setPartStore(store: ProjectStore): void {
  parts = store;
}

/** Whether a store has been chosen (start-up has got that far). */
export const hasProjectStore = (): boolean => current !== null;
export const hasPartStore = (): boolean => parts !== null;

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
    setProjectStore(new DiskProjects(dir));
    return { fixed: home.fixed, defaultDir: home.path };
  }
  if (typeof indexedDB === 'undefined') {
    setProjectStore(new MemoryProjects());
    setPartStore(new MemoryProjects());
    return { fixed: true, defaultDir: null };
  }
  setProjectStore(new DbProjects());
  setPartStore(new DbProjects(PARTS_DB));
  return { fixed: true, defaultDir: null };
}
