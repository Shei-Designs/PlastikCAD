// The sync engine: brings a project store and a remote copy of it into line,
// remembering per project what both sides last agreed on. It knows nothing of
// Google Drive or of the editor; those plug in through the interfaces below.
//
// A project is matched across the two sides by the id in its file header.
// Each save stamps a revision; a side has changed when its revision is not the
// one recorded at the last sync. Changes on one side are copied to the other.
// Changes on both sides are merged object by object; where the same object was
// changed differently, both versions are kept, the remote one as a project of
// its own, so that nothing anyone did is lost on either device.
//
// The engine is careful about what it destroys. A project saved while a pass
// runs is left for the next pass rather than written over; a pass that would
// delete most of the projects on one side asks first; what it removes here
// goes to the store's trash where there is one; and one project's failure
// never keeps the caller from hearing what the pass did to the others.
import { parseDoc, serializeDoc } from '../model/file';
import { newId } from '../model/ops';
import type { Doc } from '../model/types';
import type { ProjectInfo, ProjectStore } from '../state/projects';
import { mergeDocs } from './merge';

export interface RemoteFile {
  id: string;
  name: string;
  /** From the file's metadata; null for a file the remote holds without one. */
  projectId: string | null;
  revision: string | null;
  /** Milliseconds since the epoch. */
  modified: number;
}

export interface Remote {
  list(): Promise<RemoteFile[]>;
  download(file: RemoteFile): Promise<string>;
  /** Creates a file (`existing` null) or replaces one, and returns it as it now is. */
  upload(existing: RemoteFile | null, name: string, text: string, meta: { projectId: string; revision: string | null }): Promise<RemoteFile>;
  remove(file: RemoteFile): Promise<void>;
  /** The file as the remote has it now, null when it is gone. A remote that has this is asked before a file is replaced. */
  stat?(file: RemoteFile): Promise<RemoteFile | null>;
}

/** What both sides last agreed on for one project. */
export interface SyncRecord {
  projectId: string;
  fileId: string;
  /** The revision at the last sync, null for files from before revisions. */
  revision: string | null;
  /** The text at the last sync, the base of a three-way merge. */
  baseText: string;
}

export interface SyncState {
  all(): Promise<SyncRecord[]>;
  put(record: SyncRecord): Promise<void>;
  remove(projectId: string): Promise<void>;
  /** Forgets everything agreed so far. */
  clear(): Promise<void>;
}

export interface SyncReport {
  /** Project names, for telling the user. */
  uploaded: string[];
  downloaded: string[];
  merged: string[];
  /** Projects whose remote version was kept as a project of its own beside the local one. */
  kept: string[];
  deletedLocally: string[];
  deletedRemotely: string[];
  /** Keys in the local store that were written or removed, for the editor to take in. */
  changedKeys: string[];
  removedKeys: string[];
  /** Local files that moved because the project was renamed on the other side. */
  movedKeys: { from: string; to: string }[];
  /** Projects saved, here or there, while the pass ran: left as they are for the next pass. */
  busy: string[];
  /** Projects a mass deletion would have taken and nobody was there to ask about: neither deleted nor restored. */
  held: string[];
  /** What went wrong, one entry per project that failed; the others went through. */
  errors: unknown[];
}

/** A deletion of most of the projects on one side, put to the user before it happens. */
export interface DeletePlan {
  /** The side that would lose them: `local` when the remote no longer has them, `remote` when they are gone here. */
  side: 'local' | 'remote';
  names: string[];
  /** How many projects that side holds. */
  total: number;
}

export interface SyncOptions {
  /** This device's id, stamped into merged saves. */
  device: string;
  /** Name for the remote version kept beside a local one in a conflict. */
  copyName?: (name: string) => string;
  /**
   * Asked before a pass deletes most of the projects on one side: true deletes
   * them, false brings them back from the other side instead. Left out, such
   * a pass holds them as they are.
   */
  confirmDeletes?: (plan: DeletePlan) => Promise<boolean>;
}

/** A deletion counts as a mass deletion from two projects up, when it takes more than half of what the side has. */
const massDeletion = (count: number, total: number): boolean => count >= 2 && count * 2 > total;

/** An id that is the same every time for the same text: a retried pass finds what an earlier one made. */
function stableId(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b + c, 0x85ebca6b) >>> 0;
  }
  return (a.toString(36) + b.toString(36)).padStart(8, '0').slice(0, 8);
}

/** Why a project is left alone this pass: it was saved while the pass ran. */
class Busy extends Error {}

const stem = (fileName: string): string => fileName.replace(/\.(plastikcad|bashcad)$/i, '');

/** A design read for syncing. What is wrong with it is said with its name, since the pass goes on and reports at its end. */
function read(text: string, name: string): Doc {
  try {
    return parseDoc(text);
  } catch (e) {
    throw new Error(`"${name}": ${e instanceof Error ? e.message : String(e)}`);
  }
}

export class MemorySyncState implements SyncState {
  readonly records = new Map<string, SyncRecord>();
  async all(): Promise<SyncRecord[]> {
    return [...this.records.values()];
  }
  async put(record: SyncRecord): Promise<void> {
    this.records.set(record.projectId, record);
  }
  async remove(projectId: string): Promise<void> {
    this.records.delete(projectId);
  }
  async clear(): Promise<void> {
    this.records.clear();
  }
}

/**
 * What was agreed holds only between the two places it was agreed for: this
 * projects folder and that remote folder. `was` is the pair the records were
 * made for (null when none is on record), `now` the pair in use; when they
 * differ the records are forgotten, so that a new, empty place on either side
 * reads as "never synced" rather than "everything was deleted".
 */
export async function bindRecords(state: SyncState, was: string | null, now: string): Promise<boolean> {
  if (was === null || was === now) return false;
  await state.clear();
  return true;
}

/**
 * One pass over everything. A project that fails does not stop the others:
 * what went wrong is in the report's `errors`, beside what was done. Only
 * trouble listing either side rejects.
 */
export async function synchronize(local: ProjectStore, remote: Remote, state: SyncState, options: SyncOptions): Promise<SyncReport> {
  const report: SyncReport = { uploaded: [], downloaded: [], merged: [], kept: [], deletedLocally: [], deletedRemotely: [], changedKeys: [], removedKeys: [], movedKeys: [], busy: [], held: [], errors: [] };
  const copyName = options.copyName ?? ((name: string) => `${name} (other device)`);

  const locals = new Map<string, ProjectInfo>();
  for (const info of await local.list()) {
    // Files without an id are not synced until they are opened and get one; a second file with the same id is left alone.
    if (info.id && !locals.has(info.id)) locals.set(info.id, info);
  }
  const remotes = new Map<string, RemoteFile>();
  for (const file of await remote.list()) {
    if (file.projectId && !remotes.has(file.projectId)) remotes.set(file.projectId, file);
  }
  const records = new Map((await state.all()).map((r) => [r.projectId, r]));

  const texts = new Map<string, string>();
  const localText = async (info: ProjectInfo): Promise<string> => {
    let text = texts.get(info.key);
    if (text === undefined) texts.set(info.key, (text = await local.read(info.key)));
    return text;
  };
  const localChanged = async (info: ProjectInfo, record: SyncRecord): Promise<boolean> =>
    info.revision !== null || record.revision !== null ? info.revision !== record.revision : (await localText(info)) !== record.baseText;
  const remoteChanged = async (file: RemoteFile, record: SyncRecord): Promise<boolean> =>
    file.revision !== null || record.revision !== null ? file.revision !== record.revision : (await remote.download(file)) !== record.baseText;

  /** Stops the work on a project that was saved here since the pass listed it: writing over it now would lose that save. */
  const untouched = async (info: ProjectInfo): Promise<void> => {
    const now = (await local.list()).find((p) => p.key === info.key);
    const same = now !== undefined && (info.revision !== null || now.revision !== null ? now.revision === info.revision : (await local.read(info.key)) === (await localText(info)));
    if (!same) throw new Busy(info.name);
  };
  /** The same for the other side, where the remote can say: a file another device replaced since the listing is not replaced again. */
  const unreplaced = async (file: RemoteFile, name: string): Promise<void> => {
    if (!remote.stat) return;
    const now = await remote.stat(file);
    if (!now || now.revision !== file.revision) throw new Busy(name);
  };

  const writeLocal = async (info: ProjectInfo | undefined, name: string, text: string): Promise<string> => {
    if (info) await untouched(info);
    const key = await local.write(info?.key ?? null, name, text);
    report.changedKeys.push(key);
    if (info && key !== info.key) report.movedKeys.push({ from: info.key, to: key });
    return key;
  };
  const uploadOver = async (file: RemoteFile, name: string, text: string, meta: { projectId: string; revision: string | null }): Promise<RemoteFile> => {
    await unreplaced(file, name);
    return remote.upload(file, name, text, meta);
  };
  const record = (projectId: string, file: RemoteFile, revision: string | null, baseText: string) => state.put({ projectId, fileId: file.id, revision, baseText });

  // What the pass would delete is worked out first: a pass about to delete most of the projects on one side is far
  // more often a remote folder that was replaced, or a projects folder that was, than somebody's wish.
  const dropLocal = new Set<string>();
  const dropRemote = new Set<string>();
  for (const [projectId, known] of records) {
    const info = locals.get(projectId);
    const file = remotes.get(projectId);
    try {
      if (info && !file && !(await localChanged(info, known))) dropLocal.add(projectId);
      else if (!info && file && !(await remoteChanged(file, known))) dropRemote.add(projectId);
    } catch {
      // Whatever kept it from being read is met again, and reported, in its turn below.
    }
  }
  const decide = async (side: DeletePlan['side'], ids: Set<string>, total: number): Promise<'delete' | 'restore' | 'hold'> => {
    if (!massDeletion(ids.size, total)) return 'delete';
    if (!options.confirmDeletes) return 'hold';
    const names = [...ids].map((id) => (side === 'local' ? locals.get(id)!.name : stem(remotes.get(id)!.name)));
    return (await options.confirmDeletes({ side, names, total })) ? 'delete' : 'restore';
  };
  const localDeletes = await decide('local', dropLocal, locals.size);
  const remoteDeletes = await decide('remote', dropRemote, remotes.size);

  for (const projectId of new Set([...locals.keys(), ...remotes.keys(), ...records.keys()])) {
    const info = locals.get(projectId);
    const file = remotes.get(projectId);
    const known = records.get(projectId);
    try {
      if (info && !file && !known) {
        // New here.
        await uploadNew(info);
      } else if (!info && file && !known) {
        // New on the other side.
        await downloadNew(file);
      } else if (info && !file && known) {
        if (!dropLocal.has(projectId) || localDeletes === 'restore') {
          // Deleted remotely but changed here since, or kept after all: it goes back up.
          await uploadNew(info);
        } else if (localDeletes === 'hold') {
          report.held.push(info.name);
        } else {
          await untouched(info);
          await (local.discard ? local.discard(info.key) : local.remove(info.key));
          report.removedKeys.push(info.key);
          await state.remove(projectId);
          report.deletedLocally.push(info.name);
        }
      } else if (!info && file && known) {
        const name = stem(file.name);
        if (!dropRemote.has(projectId) || remoteDeletes === 'restore') {
          // Deleted here but changed on the other side since, or kept after all: it comes back.
          await downloadNew(file);
        } else if (remoteDeletes === 'hold') {
          report.held.push(name);
        } else {
          await unreplaced(file, name);
          await remote.remove(file);
          await state.remove(projectId);
          report.deletedRemotely.push(name);
        }
      } else if (!info && !file && known) {
        await state.remove(projectId);
      } else if (info && file && !known) {
        // Both sides have it but this device never synced it: a second device with its own copy, or lost state.
        const text = await localText(info);
        const remoteText = await remote.download(file);
        if (text === remoteText || (info.revision !== null && info.revision === file.revision)) {
          await record(projectId, file, info.revision, text);
        } else {
          await reconcile(info, file, null, text, remoteText);
        }
      } else if (info && file && known) {
        if (info.revision !== null && info.revision === file.revision) {
          // Both sides hold the same save. The record can lag behind it when the app quit between an upload and noting it.
          if (known.revision !== info.revision) await record(projectId, file, info.revision, await localText(info));
          continue;
        }
        const changedHere = await localChanged(info, known);
        const changedThere = await remoteChanged(file, known);
        if (!changedHere && !changedThere) continue;
        const text = await localText(info);
        if (changedHere && !changedThere) {
          const uploaded = await uploadOver(file, info.name, text, { projectId, revision: info.revision });
          await record(projectId, uploaded, info.revision, text);
          report.uploaded.push(info.name);
        } else if (!changedHere && changedThere) {
          const remoteText = await remote.download(file);
          const doc = read(remoteText, info.name);
          await writeLocal(info, doc.name, remoteText);
          await record(projectId, file, file.revision ?? doc.revision ?? null, remoteText);
          report.downloaded.push(doc.name);
        } else {
          await reconcile(info, file, known.baseText, text, await remote.download(file));
        }
      }
    } catch (e) {
      if (e instanceof Busy) report.busy.push(e.message);
      else report.errors.push(e);
    }
  }
  return report;

  async function uploadNew(info: ProjectInfo): Promise<void> {
    const text = await localText(info);
    const uploaded = await remote.upload(null, info.name, text, { projectId: info.id!, revision: info.revision });
    await record(info.id!, uploaded, info.revision, text);
    report.uploaded.push(info.name);
  }

  async function downloadNew(file: RemoteFile): Promise<void> {
    const text = await remote.download(file);
    const doc = read(text, stem(file.name));
    await writeLocal(undefined, doc.name, text);
    await record(file.projectId!, file, file.revision ?? doc.revision ?? null, text);
    report.downloaded.push(doc.name);
  }

  /** Both sides changed: merge, or keep both. */
  async function reconcile(info: ProjectInfo, file: RemoteFile, baseText: string | null, text: string, remoteText: string): Promise<void> {
    const localDoc = read(text, info.name);
    const remoteDoc = read(remoteText, info.name);
    const base = baseText === null ? null : read(baseText, info.name);
    const { doc, conflicts } = mergeDocs(base, localDoc, remoteDoc);
    if (conflicts === 0) {
      const merged = { ...doc, revision: newId(), parent: localDoc.revision, device: options.device, saved: new Date().toISOString() };
      const mergedText = serializeDoc(merged);
      await unreplaced(file, info.name);
      await writeLocal(info, merged.name, mergedText);
      const uploaded = await remote.upload(file, merged.name, mergedText, { projectId: merged.id, revision: merged.revision });
      await record(merged.id, uploaded, merged.revision, mergedText);
      report.merged.push(merged.name);
      return;
    }
    // The remote version lives on as a project of its own, on both sides; the local one stays as it is. The copy's id
    // follows from what it is a copy of, so a pass that failed part-way is finished by the next one rather than
    // repeated: a copy already here is not made again, and goes up in its own turn as any new project does.
    const copyId = stableId(`${info.id}:${remoteDoc.revision ?? remoteText}`);
    if (!locals.has(copyId)) {
      const copy = { ...remoteDoc, id: copyId, name: copyName(remoteDoc.name), revision: newId(), parent: remoteDoc.revision, device: options.device, saved: new Date().toISOString() };
      const copyText = serializeDoc(copy);
      const key = await writeLocal(undefined, copy.name, copyText);
      locals.set(copyId, { key, id: copyId, name: copy.name, revision: copy.revision, modified: Date.now(), size: copyText.length, thumb: null });
      const copyFile = await remote.upload(null, copy.name, copyText, { projectId: copy.id, revision: copy.revision });
      await record(copy.id, copyFile, copy.revision, copyText);
    }
    const uploaded = await uploadOver(file, info.name, text, { projectId: info.id!, revision: info.revision });
    await record(info.id!, uploaded, info.revision, text);
    report.kept.push(remoteDoc.name);
  }
}
