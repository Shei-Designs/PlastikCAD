// Keeps the project store in step with the linked cloud account: a little
// after every save, when the app starts, comes online or is asked to, and
// every few minutes. Status is published for the UI; the editor is told what
// changed under it. Nothing here knows about the editor's state.
import { useSyncExternalStore } from 'react';
import { noteDiagnostic } from '../diagnostics';
import { asError } from '../errors';
import { tr } from '../i18n';
import { hasPartStore, hasProjectStore, partStore, projectStore } from '../state/projects';
import { apartRemote, unusedParts } from './apart';
import type { ApartRemote } from './apart';
import { DriveRemote } from './drive';
import { bindRecords, synchronize } from './engine';
import type { DeletePlan, Remote, SyncReport, SyncState } from './engine';
import { authorizedFetch, cancelSignIn, isConfigured, loadTokens, NeedsSignIn, revoke, saveTokens, signIn } from './google';
import type { Tokens } from './google';
import { loadBinding, openSyncState, saveBinding, STORES } from './state';
import type { RecordStore } from './state';

/** The Drive folder the custom parts go in, inside the app's folder. */
export const PARTS_FOLDER = 'Parts';
/** The Drive folder for the large meshes and pictures the designs keep apart (see apart.ts), inside the app's folder. */
export const ASSETS_FOLDER = 'Assets';

export interface SyncStatus {
  /** Whether this build knows a Google client at all. */
  configured: boolean;
  linked: boolean;
  email: string | null;
  busy: boolean;
  /** When the last pass finished without error, ms since the epoch. */
  lastSync: number | null;
  error: string | null;
  offline: boolean;
}

/** After a save, how long to wait for more before syncing. */
const AFTER_SAVE_MS = 5000;
const EVERY_MS = 3 * 60_000;

let status: SyncStatus = { configured: isConfigured(), linked: false, email: null, busy: false, lastSync: null, error: null, offline: false };
const listeners = new Set<() => void>();
let tokens: Tokens | null = null;
let remote: DriveRemote | null = null;
let partsRemote: DriveRemote | null = null;
/** The projects' remote as the engine sees it: designs whole, their large meshes and pictures kept apart behind it. */
let projectsRemote: ApartRemote | null = null;
/** The folder those meshes and pictures are kept in. */
let assetsRemote: DriveRemote | null = null;
const state = openSyncState(STORES.projects);
const partsState = openSyncState(STORES.parts);
let device = '';
let onChanged: ((report: SyncReport) => void | Promise<void>) | null = null;
let onPartsChanged: ((report: SyncReport) => void | Promise<void>) | null = null;
let onNotice: ((text: string) => void) | null = null;
let beforeSync: (() => Promise<unknown>) | null = null;
let confirmDeletes: ((plan: DeletePlan, what: 'projects' | 'parts') => Promise<boolean>) | null = null;
/** How many callers have asked for sync to hold off; no pass starts while any has. */
let paused = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
let running: Promise<SyncReport | null> | null = null;
let again = false;

function publish(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const getSyncStatus = (): SyncStatus => status;
export const useSyncStatus = (): SyncStatus => useSyncExternalStore(subscribe, () => status);

/** A project as this device has it, by its id; null when it has none. */
async function localProject(projectId: string): Promise<string | null> {
  if (!hasProjectStore()) return null;
  const store = projectStore();
  const info = (await store.list()).find((p) => p.id === projectId);
  return info ? store.read(info.key) : null;
}

/** `keep` is false for the sign-in as it was just read from where it is kept. */
function setTokens(next: Tokens | null, keep = true): void {
  tokens = next;
  if (keep) void saveTokens(next);
  remote = next ? new DriveRemote(authorizedFetch(() => tokens, setTokens)) : null;
  partsRemote = remote ? new DriveRemote(authorizedFetch(() => tokens, setTokens), PARTS_FOLDER, remote) : null;
  assetsRemote = remote ? new DriveRemote(authorizedFetch(() => tokens, setTokens), ASSETS_FOLDER, remote, undefined, 'assets') : null;
  projectsRemote = remote && assetsRemote ? apartRemote(remote, assetsRemote, localProject) : null;
  publish({ linked: next !== null, email: next?.email ?? null });
}

/**
 * Picks up the linked account, if any, and starts the schedule. `changed` is
 * told what each pass wrote or removed among the projects, `partsChanged`
 * among the custom parts; `flush` runs before a pass so that pending edits
 * are on disk first; `confirmDeletes` is asked before a pass deletes most of
 * the projects (or parts) on one side, and says whether to go ahead.
 */
export function initSync(options: {
  device: string;
  changed: (report: SyncReport) => void | Promise<void>;
  partsChanged: (report: SyncReport) => void | Promise<void>;
  notice: (text: string) => void;
  flush: () => Promise<unknown>;
  confirmDeletes?: (plan: DeletePlan, what: 'projects' | 'parts') => Promise<boolean>;
}): Promise<void> {
  device = options.device;
  onChanged = options.changed;
  onPartsChanged = options.partsChanged;
  onNotice = options.notice;
  beforeSync = options.flush;
  confirmDeletes = options.confirmDeletes ?? null;
  clearInterval(interval);
  interval = setInterval(() => void syncNow(), EVERY_MS);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => void syncNow());
    window.addEventListener('focus', () => requestSync(1000));
  }
  // The sign-in is read from where it is kept, which on desktop is the system's keychain and takes a moment: the
  // promise is for that. One made meanwhile (the user linking straight away) stands.
  return loadTokens().then((kept) => {
    if (tokens) return;
    setTokens(kept, false);
    if (tokens) requestSync(2000);
  });
}

/** Signs in and runs a first pass. Rejects with a message fit to show. */
export async function linkAccount(): Promise<void> {
  if (!status.configured) throw new Error(tr('Google Drive sync is not set up in this build.'));
  publish({ busy: true, error: null });
  try {
    const fresh = await signIn();
    setTokens(fresh);
    const who = await remote!.account().catch(() => null);
    if (who?.email) setTokens({ ...fresh, email: who.email });
  } finally {
    publish({ busy: false });
  }
  await syncNow();
}

/** Gives up a sign-in under way; `linkAccount` then rejects with "cancelled". */
export const cancelLink = (): void => cancelSignIn();

/**
 * Forgets the account, tells Google so, and drops what was agreed with it; the local projects stay. Resolves false
 * when Google could not be told: the app is unlinked all the same, and still listed in the account.
 */
export async function unlinkAccount(): Promise<boolean> {
  clearTimeout(timer);
  await running;
  const old = tokens;
  setTokens(null);
  await state?.clear();
  await partsState?.clear();
  saveBinding(STORES.projects, null);
  saveBinding(STORES.parts, null);
  publish({ lastSync: null, error: null });
  return old ? revoke(old) : true;
}

/** Syncs once the dust has settled; a pass already waiting is pushed back. */
export function requestSync(delay = AFTER_SAVE_MS): void {
  if (!tokens) return;
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), delay);
}

/** One pass now, or joins the one running (and runs once more after it, since something may have changed since it started). */
export function syncNow(): Promise<SyncReport | null> {
  clearTimeout(timer);
  if (running) {
    again = true;
    return running;
  }
  if (paused) return Promise.resolve(null);
  running = pass().finally(() => {
    running = null;
    if (again) {
      again = false;
      requestSync(500);
    }
  });
  return running;
}

/**
 * Runs `work` with sync held off: the pass under way is let finish first and
 * none starts until the work is done. For changes to where the projects are
 * kept, which a pass must never see half made.
 */
export async function withSyncPaused<T>(work: () => Promise<T>): Promise<T> {
  paused++;
  clearTimeout(timer);
  try {
    await running;
    return await work();
  } finally {
    paused--;
    if (!paused) requestSync(1000);
  }
}

/**
 * Moves to the Drive's trash the imported meshes and pictures in its Assets folder that no design
 * there names any more (see `unusedParts`). `confirm` is told how many there are and how many bytes
 * they take, and says whether to go ahead. Resolves with what was moved (nothing, when there was
 * nothing to move), or null when it was called off. No sync runs meanwhile.
 */
export function cleanUpDrive(confirm: (count: number, bytes: number) => Promise<boolean>): Promise<{ count: number; bytes: number } | null> {
  if (!remote || !assetsRemote) return Promise.reject(new Error(tr('Google Drive is not linked.')));
  const [designs, store] = [remote, assetsRemote];
  return withSyncPaused(async () => {
    publish({ busy: true });
    try {
      const unused = await unusedParts(designs, store);
      const bytes = unused.reduce((sum, file) => sum + (file.size ?? 0), 0);
      if (unused.length === 0) return { count: 0, bytes: 0 };
      if (!(await confirm(unused.length, bytes))) return null;
      for (const file of unused) await store.remove(file);
      // What the folder holds is looked at afresh by the next pass.
      projectsRemote?.forget();
      return { count: unused.length, bytes };
    } finally {
      publish({ busy: false });
    }
  });
}

/** One set (the projects, or the parts) brought into line, its records first checked against the places they were agreed for. */
async function syncSet(store: RecordStore, what: 'projects' | 'parts', local: ReturnType<typeof projectStore>, folder: DriveRemote, to: Remote, records: SyncState): Promise<SyncReport> {
  const places = `${await folder.folder()}\n${local.location ?? ''}`;
  await bindRecords(records, loadBinding(store), places);
  saveBinding(store, places);
  const ask = confirmDeletes;
  return synchronize(local, to, records, { device, ...(ask ? { confirmDeletes: (plan: DeletePlan) => ask(plan, what) } : {}) });
}

const touched = (report: SyncReport): boolean => report.changedKeys.length > 0 || report.removedKeys.length > 0 || report.kept.length > 0;

async function pass(): Promise<SyncReport | null> {
  if (!tokens || !remote || !state || !hasProjectStore()) return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    publish({ offline: true });
    return null;
  }
  publish({ busy: true, offline: false });
  try {
    await beforeSync?.();
    // What the Assets folder holds is looked at afresh each pass.
    projectsRemote?.forget();
    const report = await syncSet(STORES.projects, 'projects', projectStore(), remote, projectsRemote ?? remote, state);
    // Told whatever else went wrong: the editor must take in what the pass did write, or it would save its old copy over it.
    if (touched(report)) await onChanged?.(report);
    let failure: unknown = report.errors[0];
    let busy = report.busy.length > 0;
    // The parts after the projects, so that trouble with them never holds a project back.
    if (partsRemote && partsState && hasPartStore() && !(failure instanceof NeedsSignIn)) {
      const parts = await syncSet(STORES.parts, 'parts', partStore(), partsRemote, partsRemote, partsState);
      if (touched(parts)) await onPartsChanged?.(parts);
      failure ??= parts.errors[0];
      busy ||= parts.busy.length > 0;
    }
    // Something was saved while the pass ran: once more, soon.
    if (busy) again = true;
    if (failure !== undefined) throw failure;
    publish({ busy: false, lastSync: Date.now(), error: null });
    return report;
  } catch (e) {
    if (e instanceof NeedsSignIn) {
      // The grant is gone (revoked from the Google account, say): said once, here and in the projects browser.
      setTokens(null);
      noteDiagnostic('sync', `Sign-in needed: ${e.message}`);
      publish({ busy: false, error: e.message });
      onNotice?.(tr('Google Drive sync stopped: {reason}', { reason: e.message }));
      return null;
    }
    const message = asError(e).message;
    // Network trouble is not an error worth a red line; it will be tried again.
    const offline = /Failed to fetch|NetworkError|Load failed|network/i.test(message);
    noteDiagnostic('sync', offline ? `Offline: ${message}` : message);
    publish({ busy: false, error: offline ? null : message, offline });
    return null;
  }
}
