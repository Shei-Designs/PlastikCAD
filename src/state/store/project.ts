// The open project and the others in the store: autosave and its thumbnail,
// opening, renaming, duplicating and deleting, design files from outside, and
// the folder projects are kept in. The stores themselves are in ../projects.
import { APP_NAME, FILE_EXTENSION } from '../../appInfo';
import { locale, plural, tr } from '../../i18n';
import { emptyDoc, HEAD_BYTES, isUntitled, legacyVersions, parseDoc, readHeader, serializeDoc } from '../../model/file';
import { newId, regroup } from '../../model/ops';
import type { Doc } from '../../model/types';
import * as platform from '../../platform';
import { askName, tell } from '../../ui/ask';
import type { PickedFile } from '../../platform';
import { geometry } from '../geometry';
import { DiskProjects, fileNameFor, hasProjectStore, partStore, projectStore, setProjectStore } from '../projects';
import type { ProjectInfo, VersionInfo } from '../projects';
import { requestSync, withSyncPaused } from '../../sync/sync';
import { abortAlignPreview, fail, getState, isDirty, notify, resetHistory, set, setPrefs } from './core';
import type { EditorState } from './core';
import { exportName, reportSaved } from './exporting';

// --- projects -----------------------------------------------------------------
//
// A project is saved as it changes: a second after the last edit, when the
// window is hidden or closed, and before another project is opened. There is
// no Save; "Save a copy" writes the design somewhere else, "Open project file"
// brings an outside file in as a project.

const DESIGN_FILTER = [{ name: tr('{app} design', { app: APP_NAME }), extensions: [FILE_EXTENSION] }];

/** How long after the last change the project is written. */
const AUTOSAVE_MS = 1000;

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

export function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => void saveProject(), AUTOSAVE_MS);
}

/**
 * The design as it goes to disk. While a group is being edited inside, the
 * scene on screen has it taken apart; what is written has it put back
 * together, so that a save or a reload mid-edit never flattens it. Editing
 * carries on regardless.
 */
export function docToSave(s: EditorState = getState()): Doc {
  if (!s.editing) return s.doc;
  return { ...s.doc, scene: regroup(s.doc.scene, s.editing.layers, (n) => geometry.bounds(n)) };
}

/** Picture of the design for the projects browser, or of some of its objects alone, given by the viewer when there is one. */
let thumbSource: ((only?: string[]) => string | null) | null = null;
/** Taking the picture means drawing the scene again, so it is not done on every save. */
const THUMB_EVERY_MS = 10_000;
let thumbTakenAt = 0;
/** The last save kept an older picture (one had just been taken); a fresh one is owed once the pause has passed. */
let thumbStale = false;
let thumbRefresh: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<boolean> | null = null;
let lastSaveError: string | null = null;

export function provideThumbnail(source: ((only?: string[]) => string | null) | null): void {
  thumbSource = source;
}

/** The viewer's picture of the design, or of some of its objects alone; undefined while there is no viewer. */
export function takeThumbnail(only?: string[]): string | null | undefined {
  return thumbSource?.(only);
}

function thumbFor(doc: Doc, fresh: boolean): string | undefined {
  if (doc.scene.length === 0) return undefined;
  if (!thumbSource) return doc.thumb;
  const now = Date.now();
  if (!fresh && doc.thumb && now - thumbTakenAt < THUMB_EVERY_MS) {
    // Otherwise the last edit of a burst (a color picked right after a shape was placed) would never show.
    thumbStale = true;
    clearTimeout(thumbRefresh);
    thumbRefresh = setTimeout(refreshThumbnail, THUMB_EVERY_MS - (now - thumbTakenAt) + 50);
    return doc.thumb;
  }
  const shot = thumbSource();
  if (!shot) return doc.thumb;
  thumbTakenAt = now;
  thumbStale = false;
  return shot;
}

/** Writes the project again with a fresh picture, when the last save made do with an older one and nothing else is pending. */
function refreshThumbnail(): void {
  if (!thumbStale || writing || isDirty() || !hasProjectStore() || getState().projectKey === null || getState().doc.scene.length === 0) return;
  writing = write(true).finally(() => {
    writing = null;
  });
}

/** Whether the project is worth a file yet: it has one already, something was put in it, or it was named. */
const worthSaving = (): boolean => getState().projectKey !== null || getState().doc.scene.length > 0 || !isUntitled(getState().doc.name);

/**
 * Writes the project to the store now, if anything changed. Resolves true once
 * it is saved (or there was nothing to save), false when the write failed; the
 * changes are then still pending and the next edit tries again.
 */
export function saveProject(fresh = false): Promise<boolean> {
  clearTimeout(autosaveTimer);
  if (writing) return writing.then(() => saveProject(fresh));
  // A fresh save is also owed a fresh picture, when the last one made do with an older shot.
  if ((!isDirty() && !(fresh && thumbStale && getState().projectKey !== null)) || !worthSaving()) return Promise.resolve(true);
  if (!hasProjectStore()) return Promise.resolve(false);
  writing = write(fresh).finally(() => {
    writing = null;
  });
  return writing;
}

async function write(fresh: boolean): Promise<boolean> {
  // What is being written counts as saved once it is, even if more changed meanwhile.
  const base = { scene: getState().doc.scene, name: getState().doc.name, robot: getState().doc.robot };
  const doc = docToSave();
  const thumb = thumbFor(doc, fresh);
  // Every save is a revision following the one before it, so that sync can tell what changed where.
  const stamp = { revision: newId(), parent: doc.revision, device: getState().prefs.device, saved: new Date().toISOString() };
  set({ saving: true });
  try {
    // The save about to be replaced is kept, now and then, as one to go back to; failing to keep it never stops a save.
    const before = getState().projectKey;
    if (before) await projectStore().keep?.(before).catch(() => {});
    const key = await projectStore().write(before, doc.name, serializeDoc({ ...doc, ...stamp, thumb }));
    set({ projectKey: key, saved: base, saving: false, doc: { ...getState().doc, ...stamp, thumb } });
    if (getState().prefs.lastProject !== key) setPrefs({ lastProject: key });
    lastSaveError = null;
    requestSync();
    return true;
  } catch (e) {
    set({ saving: false });
    const message = e instanceof Error ? e.message : String(e);
    // The same failure on every keystroke is reported once.
    if (message !== lastSaveError) notify(tr('Could not save: {message}', { message }), 'error');
    lastSaveError = message;
    return false;
  }
}

/** Ctrl+S: there is nothing to do but write what autosave would have a moment later, and say so. */
export async function saveNow(): Promise<void> {
  if (await saveProject(true)) notify(getState().doc.scene.length || getState().projectKey ? tr('Saved') : tr('Nothing to save yet'), 'ok');
}

export function adopt(doc: Doc, key: string | null): void {
  abortAlignPreview();
  resetHistory();
  clearTimeout(autosaveTimer);
  thumbTakenAt = 0;
  set({
    doc,
    projectKey: key,
    saved: { scene: doc.scene, name: doc.name, robot: doc.robot },
    saving: false,
    selection: [],
    placing: null,
    bin: false,
    robot: false,
    joint: null,
    sensor: null,
    jointPick: null,
    pose: null,
    mating: null,
    editing: null,
    aligning: null,
    highlight: null,
    epoch: getState().epoch + 1,
  });
  setPrefs({ lastProject: key });
  // Lettering outlines are sent again as the fonts come back; imported meshes of the closed design are dropped.
  geometry.forgetAssets(Object.keys(doc.assets));
}

/** Writes what is pending before another project takes the screen; asks whether to go on if that fails. */
async function leaveProject(): Promise<boolean> {
  if (await saveProject(true)) return true;
  return platform.confirm(tr('The latest changes to "{name}" could not be saved. Leave anyway and lose them?', { name: getState().doc.name }), {
    title: APP_NAME,
    okLabel: tr('Leave anyway'),
    cancelLabel: tr('Keep editing'),
  });
}

export const openProjects = (): void => set({ browsing: true });
export const closeProjects = (): void => set({ browsing: false });

/** "New project": asks for its name first; backing out leaves the open project as it is. */
export async function newProject(): Promise<void> {
  const name = await askName({ title: tr('New project'), label: tr('Name'), value: '', okLabel: tr('Create') });
  if (name) await startProject(name);
}

/** Leaves the open project for an empty one. A named one is written straight away, so that it shows among the projects. */
export async function startProject(name?: string): Promise<void> {
  if (!(await leaveProject())) return;
  const doc = emptyDoc();
  if (name) doc.name = name;
  adopt(doc, null);
  set({ browsing: false });
  if (name) {
    set({ saved: null });
    await saveProject(true);
  }
}

export async function openProject(key: string): Promise<void> {
  try {
    if (key === getState().projectKey) return set({ browsing: false });
    if (!(await leaveProject())) return;
    const text = await projectStore().read(key);
    adopt(parseDoc(text), key);
    set({ browsing: false });
    // A file saved before projects had ids was just given one: written back, so the folder knows it too.
    if (!readHeader(text.slice(0, HEAD_BYTES))?.id) {
      set({ saved: null });
      scheduleAutosave();
    }
  } catch (e) {
    fail(e);
  }
}

export const baseName = (fileName: string): string => fileName.replace(/\.[^.]+$/, '');
export const extension = (fileName: string): string => fileName.split('.').pop()?.toLowerCase() ?? '';
export const folderOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).replace(/[\\/]+$/, '');

/**
 * A design file from outside: picked, dropped or double-clicked. It becomes a
 * project of its own, with a fresh id so that it never passes for the one it
 * was copied from. A file that is already in the projects folder is just opened.
 */
export async function importProjectFile(file: PickedFile): Promise<void> {
  const text = new TextDecoder().decode(file.bytes);
  const doc = parseDoc(text);
  if (isUntitled(doc.name)) doc.name = baseName(file.name);
  const store = projectStore();
  if (file.path && store.location && folderOf(file.path) === store.location.replace(/[\\/]+$/, '')) return openProject(file.path);
  if (!(await leaveProject())) return;
  doc.id = newId();
  const key = await store.write(null, doc.name, serializeDoc(doc));
  adopt(doc, key);
  set({ browsing: false });
  await explainCopy(doc.name, file);
  await offerLegacyVersions(text, doc.name);
}

/**
 * Says that the project is a copy of the file, kept with the app's projects,
 * so that edits are not expected to land in the file; and offers to delete the
 * file, which would otherwise go stale beside the living copy.
 */
async function explainCopy(name: string, file: PickedFile): Promise<void> {
  const text = tr('"{name}" is now a project of its own in {app}. Changes you make are saved with the app\'s projects, not in the file you opened.', { name, app: APP_NAME });
  if (!platform.canDelete(file.path)) {
    await tell({ title: tr('Project added'), text, actions: [tr('OK')] });
    return;
  }
  const remove = tr('Delete the file');
  const chosen = await tell({ title: tr('Project added'), text: `${text} ${tr('The file can stay where it is, or go.')}`, actions: [tr('Keep the file'), remove] });
  if (chosen !== remove) return;
  try {
    await platform.deleteFile(file.path!);
    notify(tr('Deleted {name}.', { name: file.name }), 'ok');
  } catch (e) {
    notify(tr('{app} could not delete {name} from here ({reason}). Remove it in your file manager.', { app: APP_NAME, name: file.name, reason: e instanceof Error ? e.message : String(e) }), 'error');
  }
}

/**
 * Files from before format version 2 may carry saved versions, which the app
 * no longer keeps: each can become a project of its own before they are dropped.
 */
async function offerLegacyVersions(text: string, name: string): Promise<void> {
  const versions = legacyVersions(text);
  if (versions.length === 0) return;
  const keep = await platform.confirm(
    plural(
      versions.length,
      '"{name}" carries {n} saved version from an older version of the app, which no longer keeps them. Add each as a project of its own?',
      '"{name}" carries {n} saved versions from an older version of the app, which no longer keeps them. Add each as a project of its own?',
      { name },
    ),
    {
      title: APP_NAME,
      okLabel: tr('Add them'),
      cancelLabel: tr('Drop them'),
    },
  );
  if (!keep) return;
  for (const version of versions) await projectStore().write(null, version.name, serializeDoc(version));
  notify(plural(versions.length, 'Added {n} saved version as projects.', 'Added {n} saved versions as projects.'), 'ok');
}

/** "Open project file…": brings a design file from anywhere in as a project. */
export async function openProjectFile(): Promise<void> {
  try {
    const [file] = await platform.pickFiles({ filters: DESIGN_FILTER });
    if (file) await importProjectFile(file);
  } catch (e) {
    fail(e);
  }
}

/** "Save a copy…": writes the design to a place of the user's choosing, to share or keep. The project itself stays where it is. */
export async function saveCopy(): Promise<boolean> {
  try {
    await saveProject(true);
    const bytes = new TextEncoder().encode(serializeDoc(docToSave()));
    const name = await exportName(fileNameFor(getState().doc.name).replace(/\.[^.]+$/, ''), FILE_EXTENSION);
    if (!name) return false;
    const where = await platform.saveAs(`${name}.${FILE_EXTENSION}`, DESIGN_FILTER, bytes, 'application/json');
    if (!where) return false;
    await reportSaved([where.name], where.path ? where.path.slice(0, where.path.length - where.name.length).replace(/[\\/]$/, '') || where.path : tr('your downloads'), where.uri ? [where.uri] : [], 'application/json');
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export function renameProject(name: string): void {
  const clean = name.trim();
  if (clean && clean !== getState().doc.name) set({ doc: { ...getState().doc, name: clean } });
}

/** The projects in the store, newest first. */
export async function listProjects(): Promise<ProjectInfo[]> {
  try {
    const items = await projectStore().list();
    return items.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  } catch (e) {
    fail(e);
    return [];
  }
}

/** Deletes a project: into the trash where the store has one, to be put back or destroyed from there; for good where it has none. */
export async function deleteProject(key: string, name: string): Promise<boolean> {
  try {
    const store = projectStore();
    const sure = store.discard
      ? await platform.confirm(tr('Move "{name}" to the Trash?', { name }), { title: APP_NAME, okLabel: tr('Move to Trash'), cancelLabel: tr('Keep') })
      : await platform.confirm(tr('Delete "{name}"? This cannot be undone.', { name }), { title: APP_NAME, okLabel: tr('Delete'), cancelLabel: tr('Keep') });
    if (!sure) return false;
    if (key === getState().projectKey) {
      // Nothing pending may write it back after it is gone.
      clearTimeout(autosaveTimer);
      await writing;
    }
    await (store.discard ? store.discard(key) : store.remove(key));
    if (key === getState().projectKey) adopt(emptyDoc(), null);
    requestSync();
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

/** Whether deleted projects go to a trash here, and earlier saves of each are kept. */
export const keepsTrash = (): boolean => hasProjectStore() && projectStore().discarded !== undefined;
export const keepsVersions = (): boolean => hasProjectStore() && projectStore().versions !== undefined;

/** What is in the trash, the last saved first. */
export async function listTrash(): Promise<ProjectInfo[]> {
  try {
    const items = (await projectStore().discarded?.()) ?? [];
    return items.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  } catch (e) {
    fail(e);
    return [];
  }
}

/** Puts a project back from the trash among the projects. */
export async function restoreProject(key: string): Promise<void> {
  try {
    await projectStore().restore?.(key);
    requestSync();
  } catch (e) {
    fail(e);
  }
}

/** Destroys one project in the trash, or with no key all of them, after asking. Resolves true when they are gone. */
export async function emptyTrash(key?: string, name?: string): Promise<boolean> {
  try {
    const text = key ? tr('Delete "{name}" for good? Its earlier saves go with it. This cannot be undone.', { name: String(name) }) : tr('Delete everything in the Trash for good? This cannot be undone.');
    if (!(await platform.confirm(text, { title: APP_NAME, okLabel: tr('Delete'), cancelLabel: tr('Keep') }))) return false;
    await projectStore().purge?.(key);
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

/** The earlier saves kept of a project, newest first. */
export async function listVersions(id: string | null): Promise<VersionInfo[]> {
  try {
    return id ? ((await projectStore().versions?.(id)) ?? []) : [];
  } catch (e) {
    fail(e);
    return [];
  }
}

/** Opens an earlier save as a project of its own, named after the project and when it was saved; the project itself is left as it is. */
export async function openVersion(version: VersionInfo, name: string): Promise<void> {
  try {
    if (!(await leaveProject())) return;
    const store = projectStore();
    const { revision: _revision, parent: _parent, ...doc } = parseDoc(await store.read(version.key));
    const at = new Date(version.saved).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const copy = { ...doc, id: newId(), name: `${name} (${at})` };
    const key = await store.write(null, copy.name, serializeDoc(copy));
    adopt(parseDoc(await store.read(key)), key);
    set({ browsing: false });
    requestSync();
  } catch (e) {
    fail(e);
  }
}

/** A copy of a project, as a project of its own. Returns its key. */
export async function duplicateProject(key: string): Promise<string | null> {
  try {
    if (key === getState().projectKey) await saveProject(true);
    const store = projectStore();
    const doc = parseDoc(await store.read(key));
    doc.id = newId();
    doc.name = tr('{name} copy', { name: doc.name });
    return await store.write(null, doc.name, serializeDoc(doc));
  } catch (e) {
    fail(e);
    return null;
  }
}

/** Renames a project from the browser, open or not. */
export async function renameProjectAt(key: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  if (key === getState().projectKey) {
    // Written at once, so that the browser lists it under its new name, in its renamed file.
    renameProject(clean);
    await saveProject();
    return;
  }
  try {
    const store = projectStore();
    const doc = parseDoc(await store.read(key));
    if (doc.name === clean) return;
    // A save like any other, with a revision of its own: sync tells what changed by that alone.
    await store.write(key, clean, serializeDoc({ ...doc, name: clean, revision: newId(), parent: doc.revision, device: getState().prefs.device, saved: new Date().toISOString() }));
    requestSync();
  } catch (e) {
    fail(e);
  }
}

/**
 * Desktop: keeps projects in another folder from now on, moving the existing
 * ones there if the user wants. `dir` null asks for the folder.
 */
export async function chooseProjectsFolder(dir: string | null = null): Promise<void> {
  const storage = getState().storage;
  if (!storage || storage.fixed || !storage.location) return;
  try {
    const picked = dir ?? (await platform.pickFolder(storage.location));
    if (!picked || picked === storage.location) return;
    if (!(await leaveProject())) return;
    // No sync pass may see the projects half moved: it would take the ones already gone for deleted.
    await withSyncPaused(() => moveProjectsFolder(storage, picked));
  } catch (e) {
    fail(e);
  }
}

async function moveProjectsFolder(storage: NonNullable<EditorState['storage']>, picked: string): Promise<void> {
  const old = projectStore();
  const items = await old.list();
  const fresh = new DiskProjects(picked);
  let move = false;
  if (items.length) {
    move = await platform.confirm(
      plural(
        items.length,
        'Move your {n} project to the new folder? Otherwise they stay where they are and only new projects go there.',
        'Move your {n} projects to the new folder? Otherwise they stay where they are and only new projects go there.',
      ),
      {
        title: APP_NAME,
        okLabel: tr('Move them'),
        cancelLabel: tr('Leave them'),
      },
    );
  }
  let openKey = getState().projectKey;
  const oldParts = partStore();
  const parts = move ? await oldParts.list() : [];
  if (move) {
    for (const item of items) {
      const text = await old.read(item.key);
      const key = await fresh.write(null, item.name, text);
      await old.remove(item.key);
      // Its earlier saves go with it.
      if (item.id && old instanceof DiskProjects) await fresh.takeVersions(old, item.id);
      if (item.key === getState().projectKey) openKey = key;
    }
  }
  setProjectStore(fresh);
  // The custom parts go with their projects.
  for (const item of parts) {
    await partStore().write(null, item.name, await oldParts.read(item.key));
    await oldParts.remove(item.key);
  }
  if (parts.length) set({ partsEpoch: getState().partsEpoch + 1 });
  // Left behind with the others, the open project is not among the projects kept here any more. The editor starts
  // afresh, rather than go on saving it into a folder the app no longer lists or syncs.
  if (!move && openKey !== null) {
    const name = getState().doc.name;
    adopt(emptyDoc(), null);
    openKey = null;
    notify(tr('"{name}" stays in the old folder with the others.', { name }));
  }
  setPrefs({ projectsDir: picked === storage.defaultDir ? null : picked });
  set({ storage: { ...storage, location: picked }, projectKey: openKey });
  setPrefs({ lastProject: openKey });
}
