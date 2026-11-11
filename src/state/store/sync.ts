// Cloud sync as the editor sees it (what a pass changed, linking an account),
// and start-up, which opens the project store and sets sync going.
import { APP_NAME } from '../../appInfo';
import { mark, plural, tr } from '../../i18n';
import { emptyDoc, parseDoc, serializeDoc } from '../../model/file';
import { newId } from '../../model/ops';
import * as platform from '../../platform';
import { openProjectStore, partStore, projectStore, TRASH_FOLDER } from '../projects';
import { tell } from '../../ui/ask';
import { cleanUpDrive, initSync, linkAccount, requestSync, unlinkAccount } from '../../sync/sync';
import type { DeletePlan, SyncReport } from '../../sync/engine';
import { mergeDocs } from '../../sync/merge';
import { fail, getState, isDirty, noteSync, notify, resetHistory, set, setPrefs } from './core';
import { adopt, saveProject, scheduleAutosave } from './project';
import { receiveFiles } from './importing';
import { lookForUpdateQuietly } from './updating';

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
    said.push(tr('The open project was deleted on another device.'));
  } else if (key && report.changedKeys.includes(key)) {
    const kept = await reloadOpenProject(key);
    if (kept) said.push(tr('"{name}" was changed on two devices at once; both versions were kept.', { name: kept }));
  }
  for (const name of report.kept) said.push(tr('"{name}" was changed on two devices at once; both versions were kept.', { name }));
  if (report.deletedLocally.length) said.push(`${tr('Deleted on another device: {names}.', { names: quoted(report.deletedLocally) })}${projectStore().discard ? ` ${tr('Moved to the {folder} folder.', { folder: TRASH_FOLDER })}` : ''}`);
  // Said now, and kept for the projects browser: a toast is gone in seconds, and these are things to know about.
  noteSync(said);
  if (said.length) notify(said.join(' '));
  else if (report.downloaded.length)
    notify(report.downloaded.length === 1 ? tr('Synced "{name}" from Google Drive.', { name: report.downloaded[0] }) : plural(report.downloaded.length, 'Synced {n} project from Google Drive.', 'Synced {n} projects from Google Drive.'), 'ok');
}

/** Names for a sentence: all of a few, the first few of many. */
function quoted(names: string[]): string {
  const shown = names.slice(0, 3).map((n) => tr('"{name}"', { name: n })).join(', ');
  // One text in English, whatever the count: other languages make "more" agree with it.
  return names.length > 3 ? plural(names.length - 3, '{names} and {n} more', '{names} and {n} more', { names: shown }) : shown;
}

/** A sync pass changed the custom parts: the bin lists them again. */
function applyPartsSyncReport(report: SyncReport): void {
  set({ partsEpoch: getState().partsEpoch + 1 });
  const said = report.kept.map((name) => tr('The part "{name}" was changed on two devices at once; both versions were kept.', { name }));
  if (report.deletedLocally.length) said.push(`${tr('Parts deleted on another device: {names}.', { names: quoted(report.deletedLocally) })}${partStore().discard ? ` ${tr('Moved to the {folder} folder.', { folder: TRASH_FOLDER })}` : ''}`);
  noteSync(said);
  if (said.length) notify(said.join(' '));
}

/** Put to the user before sync deletes most of the projects (or parts) on one side: true to go ahead, false to bring them back. */
function confirmSyncDeletes(plan: DeletePlan, what: 'projects' | 'parts'): Promise<boolean> {
  // A whole sentence for each case: which side lost them, whether that is all it had, and what they are.
  const all = plan.total === plan.names.length;
  const put = { count: plan.names.length, total: plan.total, names: quoted(plan.names) };
  let text: string;
  if (plan.side === 'local' && what === 'projects') {
    text = all
      ? tr('Google Drive no longer has all {total} of your projects: {names}. Delete them from this device too?', { total: put.total, names: put.names })
      : tr('Google Drive no longer has {count} of your {total} projects: {names}. Delete them from this device too?', put);
  } else if (plan.side === 'local') {
    text = all
      ? tr('Google Drive no longer has all {total} of your parts: {names}. Delete them from this device too?', { total: put.total, names: put.names })
      : tr('Google Drive no longer has {count} of your {total} parts: {names}. Delete them from this device too?', put);
  } else if (what === 'projects') {
    text = all
      ? tr('This device no longer has all {total} of your projects in Google Drive: {names}. Delete them from Google Drive too?', { total: put.total, names: put.names })
      : tr('This device no longer has {count} of your {total} projects in Google Drive: {names}. Delete them from Google Drive too?', put);
  } else {
    text = all
      ? tr('This device no longer has all {total} of your parts in Google Drive: {names}. Delete them from Google Drive too?', { total: put.total, names: put.names })
      : tr('This device no longer has {count} of your {total} parts in Google Drive: {names}. Delete them from Google Drive too?', put);
  }
  return platform.confirm(text, { title: tr('Google Drive sync'), okLabel: tr('Delete them'), cancelLabel: tr('Keep them') });
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
    const copy = { ...incoming, id: newId(), name: tr('{name} (other device)', { name: incoming.name }), revision: newId(), parent: incoming.revision, device: getState().prefs.device, saved: new Date().toISOString() };
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
    tr(
      '{app} will keep a copy of your projects in a "{app}" folder in your Google Drive and keep them in step with your other devices. It can see only the files it put there itself: a project file dropped into that folder by hand will not show up here. Sign in with Google now?',
      { app: APP_NAME },
    ),
    { title: tr('Link Google Drive'), okLabel: tr('Sign in'), cancelLabel: tr('Not now') },
  );
  if (!go) return;
  try {
    await linkAccount();
    notify(tr('Google Drive linked.'), 'ok');
  } catch (e) {
    fail(e);
  }
}

export async function unlinkGoogleDrive(): Promise<void> {
  const go = await platform.confirm(tr('Unlink Google Drive? Your projects stay here and in your Drive, but changes no longer sync.'), { title: APP_NAME, okLabel: tr('Unlink'), cancelLabel: tr('Keep linked') });
  if (!go) return;
  try {
    await unlinkAccount();
    notify(tr('Google Drive unlinked.'), 'ok');
  } catch (e) {
    fail(e);
  }
}

/** A size for a sentence: megabytes to one place, or kilobytes below one. */
const sizeText = (bytes: number): string => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`);

/** Clears out of the Drive the imported meshes and pictures that no design there uses any more, after saying how many there are. */
export async function cleanUpGoogleDrive(): Promise<void> {
  try {
    const moved = await cleanUpDrive(async (count, bytes) => {
      const go = await tell({
        title: tr('Clean up Drive'),
        text: plural(
          count,
          'One imported mesh or picture in your Drive ({size}) is no longer used by any design. Move it to the Drive\'s trash?',
          '{n} imported meshes and pictures in your Drive ({size}) are no longer used by any design. Move them to the Drive\'s trash?',
          { size: sizeText(bytes) },
        ),
        actions: [mark('Move to trash'), mark('Cancel')],
      });
      return go === 'Move to trash';
    });
    if (!moved) return;
    if (moved.count === 0) notify(tr('Nothing to clean up: every imported mesh and picture in your Drive is in use, or under a week old.'), 'ok');
    else notify(plural(moved.count, 'Moved one file ({size}) to the Drive\'s trash.', 'Moved {n} files ({size}) to the Drive\'s trash.', { size: sizeText(moved.bytes) }), 'ok');
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
    void initSync({ device: getState().prefs.device, flush: () => saveProject(true), changed: applySyncReport, partsChanged: applyPartsSyncReport, notice: (text) => notify(text, 'error'), confirmDeletes: confirmSyncDeletes });
    // The desktop app as it is installed looks for a newer version of itself; one run from the source tree has none to find.
    if (platform.updatesItself() && !import.meta.env.DEV) lookForUpdateQuietly();
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
