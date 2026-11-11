// Updates of the desktop app: a newer version is looked for among the releases when the app starts
// and from the About box, and installed when the user says so. The Android app is updated by the
// store it came from, and the app in a browser is whatever the page serves.
import { APP_NAME, APP_VERSION } from '../../appInfo';
import { tr } from '../../i18n';
import * as platform from '../../platform';
import { tell } from '../../ui/ask';
import { getState, notify, set } from './core';
import { saveProject } from './project';

/** The newer version found, to be installed if the user says so. */
let found: platform.AppUpdate | null = null;

/**
 * Looks among the releases for a version newer than this one, and resolves with its number, or
 * null when this is the latest. The File menu offers what was found. Rejects when the releases
 * could not be asked.
 */
export async function lookForUpdate(): Promise<string | null> {
  found = await platform.findAppUpdate();
  set({ update: found?.version ?? null });
  return found?.version ?? null;
}

/** The look at start-up: a newer version is said in a notice; no network, or no answer, is nothing to say. */
export function lookForUpdateQuietly(): void {
  lookForUpdate()
    .then((version) => {
      if (version) notify(tr('Version {version} of {app} is available.', { version, app: APP_NAME }), 'info', { label: tr('Update…'), run: () => void updateApp() });
    })
    .catch(() => {});
}

/**
 * Installs the newer version that was found, once the user has agreed: the design is saved, the
 * update fetched (it is checked against the app's key before it is put in place) and the app
 * started again. A copy of the app that the system installed as a package cannot replace itself,
 * and is shown the way to the releases instead.
 */
export async function updateApp(): Promise<void> {
  if (!found || getState().busy) return;
  const update = found;
  const facts = { version: update.version, current: APP_VERSION, app: APP_NAME };
  const title = tr('Update {app}', facts);
  const available = tr('Version {version} is available; this is version {current}.', facts);
  try {
    if (!(await platform.canSelfUpdate())) {
      const open = tr('Open the releases page');
      const elsewhere = tr('This copy of {app} was installed as a system package, which the app cannot update itself: the new version is on the releases page.', facts);
      if ((await tell({ title, text: `${available} ${elsewhere}`, actions: [open, tr('Later')] })) === open) await platform.openReleases();
      return;
    }
    const go = tr('Update');
    const how = tr('The design is saved, the update installed, and {app} started again.', facts);
    if ((await tell({ title, text: `${available} ${how}`, actions: [go, tr('Later')] })) !== go) return;
    // Not saved, not updated: the save has said what went wrong.
    if (!(await saveProject(true))) return;
    set({ busy: tr('Downloading the update…') });
    await update.install((fraction) => set({ busy: fraction === null ? tr('Downloading the update…') : tr('Downloading the update… {percent}%', { percent: Math.round(fraction * 100) }) }));
    await platform.relaunch();
  } catch (e) {
    notify(tr('The update could not be installed: {reason}', { reason: e instanceof Error ? e.message : String(e) }), 'error');
  } finally {
    set({ busy: null });
  }
}
