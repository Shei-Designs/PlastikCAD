// Cloud sync as the editor sees it (what a pass changed, linking an account),
// and start-up, which opens the project store and sets sync going.
import { APP_NAME } from '../../appInfo';
import { emptyDoc, parseDoc, serializeDoc } from '../../model/file';
import { newId } from '../../model/ops';
import * as platform from '../../platform';
import { openProjectStore, partStore, projectStore, TRASH_FOLDER } from '../projects';
import { initSync, linkAccount, requestSync, unlinkAccount } from '../../sync/sync';
import type { DeletePlan, SyncReport } from '../../sync/engine';
import { mergeDocs } from '../../sync/merge';
import { fail, getState, isDirty, noteSync, notify, resetHistory, set, setPrefs } from './core';
import { adopt, saveProject, scheduleAutosave } from './project';
import { receiveFiles } from './importing';

// --- cloud sync -----------------------------------------------------------------

/** What a sync pass wrote or removed, taken into the editor: the open project above all. */
export async function applySyncReport(report: SyncReport): Promise<void> {
  let key = getState().projectKey;
  const moved = key && report.movedKeys.find((m) => m.from === key);
  if (moved) {
    key = moved.to;
    set({ projectKey: key });
    setPrefs({ lastProject: key });
  }
  // One notice holds everything the pass has to say; a second would only replace the first.
  const said: string[] = [];
  if (key && report.removedKeys.includes(key)) {
    adopt(emptyDoc(), null);
    said.push('The open project was deleted on another device.');
  } else if (key && report.changedKeys.includes(key)) {
    const kept = await reloadOpenProject(key);
    if (kept) said.push(`"${kept}" was changed on two devices at once; both versions were kept.`);
  }
  for (const name of report.kept) said.push(`"${name}" was changed on two devices at once; both versions were kept.`);
  if (report.deletedLocally.length) said.push(`Deleted on another device: ${quoted(report.deletedLocally)}.${projectStore().discard ? ` Moved to the ${TRASH_FOLDER} folder.` : ''}`);
  // Said now, and kept for the projects browser: a toast is gone in seconds, and these are things to know about.
  noteSync(said);
  if (said.length) notify(said.join(' '));
  else if (report.downloaded.length) notify(`Synced ${report.downloaded.length === 1 ? `"${report.downloaded[0]}"` : `${report.downloaded.length} projects`} from Google Drive.`, 'ok');
}

/** Names for a sentence: all of a few, the first few of many. */
function quoted(names: string[]): string {
  const shown = names.slice(0, 3).map((n) => `"${n}"`).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/** A sync pass changed the custom parts: the bin lists them again. */
function applyPartsSyncReport(report: SyncReport): void {
  set({ partsEpoch: getState().partsEpoch + 1 });
  const said = report.kept.map((name) => `The part "${name}" was changed on two devices at once; both versions were kept.`);
  if (report.deletedLocally.length) said.push(`Parts deleted on another device: ${quoted(report.deletedLocally)}.${partStore().discard ? ` Moved to the ${TRASH_FOLDER} folder.` : ''}`);
  noteSync(said);
  if (said.length) notify(said.join(' '));
}

/** Put to the user before sync deletes most of the projects (or parts) on one side: true to go ahead, false to bring them back. */
function confirmSyncDeletes(plan: DeletePlan, what: 'projects' | 'parts'): Promise<boolean> {
  const count = plan.total === plan.names.length ? `all ${plan.total} of your ${what}` : `${plan.names.length} of your ${plan.total} ${what}`;
  const text =
    plan.side === 'local'
      ? `Google Drive no longer has ${count}: ${quoted(plan.names)}. Delete them from this device too?`
      : `This device no longer has ${count} in Google Drive: ${quoted(plan.names)}. Delete them from Google Drive too?`;
  return platform.confirm(text, { title: 'Google Drive sync', okLabel: 'Delete them', cancelLabel: 'Keep them' });
}

/**
 * The open project changed on disk under the editor: taken in whole, or merged
 * with edits not yet saved. Where both changed the same thing the edits here
 * win and what came in is kept as a project of its own, whose name is returned.
 */
async function reloadOpenProject(key: string): Promise<string | null> {
  try {
    const incoming = parseDoc(await projectStore().read(key));
    if (!isDirty()) {
      const ids = new Set(incoming.scene.map((n) => n.id));
      resetHistory();
      set({ doc: incoming, saved: { scene: incoming.scene, name: incoming.name, robot: incoming.robot }, selection: getState().selection.filter((id) => ids.has(id)), editing: null, mating: null, placing: null, aligning: null });
      return null;
    }
    // Edits since the last save are merged onto what came in; the next save writes the result.
    const saved = getState().saved;
    const base = saved ? { ...getState().doc, scene: saved.scene, name: saved.name, robot: saved.robot } : null;
    const { doc, conflicts } = mergeDocs(base, getState().doc, incoming);
    set({ doc: { ...doc, revision: incoming.revision }, saved: { scene: incoming.scene, name: incoming.name, robot: incoming.robot } });
    if (conflicts === 0) return null;
    const copy = { ...incoming, id: newId(), name: `${incoming.name} (other device)`, revision: newId(), parent: incoming.revision, device: getState().prefs.device, saved: new Date().toISOString() };
    await projectStore().write(null, copy.name, serializeDoc(copy));
    requestSync();
    return incoming.name;
  } catch (e) {
    fail(e);
    return null;
  }
}

/** Links a Google account, after saying what that means. */
export async function linkGoogleDrive(): Promise<void> {
  const go = await platform.confirm(
    `${APP_NAME} will keep a copy of your projects in a "${APP_NAME}" folder in your Google Drive and keep them in step with your other devices. It can see only the files it put there itself: a project file dropped into that folder by hand will not show up here. Sign in with Google now?`,
    { title: 'Link Google Drive', okLabel: 'Sign in', cancelLabel: 'Not now' },
  );
  if (!go) return;
  try {
    await linkAccount();
    notify('Google Drive linked.', 'ok');
  } catch (e) {
    fail(e);
  }
}

export async function unlinkGoogleDrive(): Promise<void> {
  const go = await platform.confirm('Unlink Google Drive? Your projects stay here and in your Drive, but changes no longer sync.', { title: APP_NAME, okLabel: 'Unlink', cancelLabel: 'Keep linked' });
  if (!go) return;
  try {
    await unlinkAccount();
    notify('Google Drive unlinked.', 'ok');
  } catch (e) {
    fail(e);
  }
}

// --- start-up -------------------------------------------------------------------

/** Opens the project store, then the file the app was started with, or else the project that was open last. */
export async function restoreSession(): Promise<void> {
  try {
    const { fixed, defaultDir } = await openProjectStore(getState().prefs.projectsDir);
    set({ storage: { location: projectStore().location, fixed, defaultDir } });
    // Edits made before the store was ready are written now.
    if (isDirty()) scheduleAutosave();
    initSync({ device: getState().prefs.device, flush: () => saveProject(true), changed: applySyncReport, partsChanged: applyPartsSyncReport, notice: (text) => notify(text, 'error'), confirmDeletes: confirmSyncDeletes });
    const opened = await platform.startupFiles();
    if (opened.length > 0) return void (await receiveFiles(await Promise.all(opened.map((p) => platform.readPath(p)))));
    const last = getState().prefs.lastProject;
    if (!last || isDirty()) return;
    try {
      adopt(parseDoc(await projectStore().read(last)), last);
    } catch {
      // Deleted or moved since: start fresh.
      setPrefs({ lastProject: null });
    }
  } catch (e) {
    fail(e);
  }
}
