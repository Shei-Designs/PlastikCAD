// The one module that knows whether the UI runs in the desktop app (Tauri) or
// in a plain browser, as it does during development (`pnpm dev`). Tauri's
// window, webview and dialog modules are imported on demand, so the browser
// never loads them.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { APP_NAME } from './appInfo';
import { asError } from './errors';
import { tr } from './i18n';

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PickedFile {
  name: string;
  /** Absolute path; null in the browser. */
  path: string | null;
  bytes: Uint8Array;
}

export function isDesktop(): boolean {
  return isTauri();
}

/** Whether there may be a system keychain to keep a secret in: the desktop app only (see `secret_read` in lib.rs). */
export const hasKeychain = (): boolean => isTauri() && !isAndroid();
/** The secret the app keeps in the system's keychain, or null when it keeps none. Rejects where there is no keychain to ask. */
export const secretRead = (): Promise<string | null> => command<string | null>('secret_read');
export const secretWrite = (secret: string): Promise<void> => command('secret_write', { secret });
export const secretRemove = (): Promise<void> => command('secret_remove');

/** A newer version of the app, found among the releases. */
export interface AppUpdate {
  version: string;
  /** Fetches it, checks it against the app's key and puts it in place. `progress` hears how far the download is, from 0 to 1, or null when its size is not known. */
  install(progress: (fraction: number | null) => void): Promise<void>;
}

/**
 * Asks the releases for a version newer than this one: null when there is none, and anywhere but
 * in the desktop app, which is the only one that updates itself.
 */
export async function findAppUpdate(): Promise<AppUpdate | null> {
  if (!isTauri() || isAndroid()) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check({ timeout: 20_000 });
  if (!update) return null;
  return {
    version: update.version,
    install: async (progress) => {
      let size = 0;
      let got = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') size = event.data.contentLength ?? 0;
        else if (event.event === 'Progress') {
          got += event.data.chunkLength;
          progress(size > 0 ? Math.min(1, got / size) : null);
        }
      });
    },
  };
}

/** Whether this copy of the app can put a newer version in its own place (see `can_self_update` in lib.rs). */
export const canSelfUpdate = (): Promise<boolean> => (isTauri() && !isAndroid() ? command<boolean>('can_self_update') : Promise.resolve(false));
/** Starts the app again, once an update is in place. */
export const relaunch = (): Promise<void> => command('relaunch');
/** Opens the page the releases are on, in the browser. */
export const openReleases = (): Promise<void> => command('open_releases');
/** The desktop app proper, which updates itself: not the Android app, not a browser. */
export const updatesItself = (): boolean => isTauri() && !isAndroid();

/** The Android app: the Tauri shell in an Android webview. */
export function isAndroid(): boolean {
  return isTauri() && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/** Calls one of the commands in `src-tauri/src/lib.rs`, which reject with a plain string. */
async function command<T>(name: string, args?: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<T> {
  if (!isTauri()) throw new Error(`${name} is only available in the desktop app`);
  try {
    return await invoke<T>(name, args, headers && { headers });
  } catch (reason) {
    throw asError(reason);
  }
}

/** A command of the Android device plugin, with what it rejects with made an Error. */
async function device<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(`plugin:device|${name}`, args);
  } catch (reason) {
    throw asError(reason);
  }
}

async function readBrowserFile(file: File): Promise<PickedFile> {
  return { name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Keeps the files that could be read: one bad entry (a dropped folder, say) should not lose the rest. `unread` hears why each of the others could not. */
async function readable(reads: Promise<PickedFile>[], unread?: (reasons: string[]) => void): Promise<PickedFile[]> {
  const results = await Promise.allSettled(reads);
  const reasons = results.flatMap((result) => (result.status === 'rejected' ? [asError(result.reason).message] : []));
  if (reasons.length) unread?.(reasons);
  return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

/**
 * Tauri registers listeners asynchronously, but callers want an unsubscribe
 * function straight away; this one also works if called before registration
 * has finished.
 */
function listen(register: () => Promise<() => void>): () => void {
  let canceled = false;
  let unlisten: (() => void) | null = null;
  register().then((stop) => {
    if (canceled) stop();
    else unlisten = stop;
  }, console.error);
  return () => {
    canceled = true;
    unlisten?.();
  };
}

function pickInBrowser(filters: FileFilter[], multiple: boolean): Promise<PickedFile[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    const extensions = filters.flatMap((filter) => filter.extensions);
    if (!extensions.includes('*')) input.accept = extensions.map((extension) => `.${extension}`).join(',');
    input.style.display = 'none';
    const settle = (files: Promise<PickedFile[]>) => {
      input.remove();
      files.then(resolve, reject);
    };
    input.addEventListener('change', () => settle(Promise.all(Array.from(input.files ?? [], readBrowserFile))));
    input.addEventListener('cancel', () => settle(Promise.resolve([])));
    // Attached to the page so it cannot be collected while the picker is open.
    document.body.append(input);
    input.click();
  });
}

/** Native open dialog, or a hidden <input type="file"> in the browser. Empty array if canceled. */
export async function pickFiles(options: { filters: FileFilter[]; multiple?: boolean }): Promise<PickedFile[]> {
  const multiple = options.multiple ?? false;
  if (!isTauri()) return pickInBrowser(options.filters, multiple);
  if (isAndroid()) {
    // The device plugin's picker: every file is offered, as the system picker filters by the type a file was
    // stored with, which a GLB or a design file rarely has (they show greyed out), and the app reads what each
    // one is itself. Its grant also lets the app delete what was picked, when asked to.
    const { uris } = await device<{ uris: string[] }>('pick_documents', { multiple });
    return Promise.all(uris.map(readPath));
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked: string | string[] | null = await open({ filters: options.filters, multiple });
  if (picked === null) return [];
  return Promise.all((Array.isArray(picked) ? picked : [picked]).map(readPath));
}

/** Desktop only. Rejects with a readable Error if the file cannot be read. */
export async function readPath(path: string): Promise<PickedFile> {
  // Tauri delivers the bytes as an array of numbers where it cannot use a binary response.
  const data = await command<ArrayBuffer | number[]>('read_file', { path });
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
  return { name: await nameOf(path), path, bytes };
}

/**
 * The file's name with its extension. A path ends in it; a `content://` URI
 * from an Android picker may carry it in its last segment ("primary:Download/box.stl")
 * or not at all, in which case the app asks the provider.
 */
async function nameOf(path: string): Promise<string> {
  if (!path.includes('://')) return baseName(path);
  let segment = baseName(path);
  try {
    segment = baseName(decodeURIComponent(segment));
  } catch {
    // Left as it came.
  }
  if (/\.[^.]+$/.test(segment)) return segment;
  const asked = await command<string | null>('file_name', { path }).catch(() => null);
  return asked ?? segment;
}

/** Where a file is to be saved: a path on desktop, a document URI on Android, or just a name in the browser (a download). */
export interface SaveTarget {
  path: string | null;
  name: string;
  /** Android: the content URI of the written file, for sharing. */
  uri?: string;
}

/**
 * Android: writes an export into the app's own folder in Downloads
 * (`Download/PlastikCAD/<folder>/<name>`), replacing a file of that name, with
 * no dialog. Resolves with the file's content URI and the path as the Files
 * app shows it.
 */
export async function exportToAppFolder(folder: string, name: string, bytes: Uint8Array, mime: string): Promise<{ uri: string; path: string }> {
  return command<{ uri: string; path: string }>('save_export', bytes, {
    folder: encodeURIComponent(folder),
    name: encodeURIComponent(name),
    mime: encodeURIComponent(mime),
  });
}

/** Whether files can be handed to other apps from here (the Android share sheet). */
export const canShare = (): boolean => isAndroid();

/** Whether exports are named in the app and kept in its own folder (Android), rather than placed through a save dialog. */
export const keepsExports = (): boolean => isAndroid();

/** Android: opens the share sheet with the given files. */
export async function share(uris: string[], mime: string): Promise<void> {
  await device('share', { uris, mime });
}

/** Android: opens the share sheet with a file made for the occasion (a zip of an export bundle), staged in the app's cache. */
export async function shareBytes(name: string, bytes: Uint8Array, mime: string): Promise<void> {
  const path = await command<string>('stage_share', bytes, { name: encodeURIComponent(name) });
  await share([path], mime);
}

/** Where a picked file really is on disk, or null where that cannot be told (a document some other app holds). */
export async function realPath(path: string): Promise<string | null> {
  if (!path.includes('://')) return path;
  return command<string | null>('real_path', { path }).catch(() => null);
}

/**
 * Asks where to save: the native dialog on desktop and Android, nothing in
 * the browser (a download goes where the browser puts it). Null if canceled.
 * `mime` is what Android creates the document as.
 */
export async function chooseSave(suggestedName: string, filters: FileFilter[], mime: string): Promise<SaveTarget | null> {
  if (!isTauri()) return { path: null, name: suggestedName };
  const { save } = await import('@tauri-apps/plugin-dialog');
  // Android keeps the type the document was created with; given as a MIME type (which the plugin passes
  // through as it is), rather than left to the extension, which the system may not know. The device
  // plugin picks a type the name survives, as the system adds the extension it knows for a type.
  const picked = await save({ defaultPath: suggestedName, filters: isAndroid() ? [{ name: filters[0]?.name ?? mime, extensions: [await androidMime(suggestedName, mime)] }] : filters });
  if (!picked) return null;
  const path = isAndroid() ? picked : withExtension(picked, filters);
  const name = await nameOf(path);
  // The dialog asked before replacing a file of the name as it was typed. With its ending added the name is
  // another, and a file may be there already that the dialog never looked at.
  if (path !== picked && (await command<boolean>('is_there', { path }).catch(() => false))) {
    const replace = await confirm(tr('"{name}" is already there. Replace it?', { name }), { okLabel: tr('Replace'), cancelLabel: tr('Cancel') });
    if (!replace) return null;
  }
  return { path, name };
}

/**
 * A name typed into the save dialog without its extension, or with another,
 * gets the one the file is: the dialogs do not all add it themselves, and the
 * app writes only the kinds of file it makes.
 */
export function withExtension(path: string, filters: FileFilter[]): string {
  const wanted = filters.flatMap((f) => f.extensions).map((e) => e.toLowerCase());
  if (wanted.length === 0) return path;
  const extension = /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase();
  return extension && wanted.includes(extension) ? path : `${path}.${wanted[0]}`;
}

/** Android: the type to create a document of this name as, for the name to be kept. */
async function androidMime(name: string, mime: string): Promise<string> {
  const answer = await device<{ mime: string }>('mime_for', { name, mime }).catch(() => null);
  return answer?.mime ?? mime;
}

/** Writes to a place chosen with `chooseSave`. */
export async function writeTarget(target: SaveTarget, bytes: Uint8Array, mime: string): Promise<void> {
  if (target.path !== null) return writePath(target.path, bytes);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = target.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file of a bundle, named by the caller once the bundle's name is known. */
export interface BundleFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

/**
 * Saves files that belong together, side by side: on desktop the save dialog
 * names the first and the rest go beside it; on Android they go into a folder
 * of their name in the app's folder in Downloads; in the browser each is a download. `make` is given the
 * name the bundle got (the chosen one, less its extension) and returns the
 * files. Resolves with where they went, or null if canceled.
 */
export async function saveBundle(suggestedName: string, filters: FileFilter[], mime: string, make: (base: string) => BundleFile[]): Promise<{ where: string; uris: string[] } | null> {
  const base = (name: string) => name.replace(/\.[^.]+$/, '');
  if (!isTauri()) {
    const files = make(base(suggestedName));
    for (const file of files) await writeTarget({ path: null, name: file.name }, file.bytes, file.mime);
    return { where: files.map((f) => f.name).reduce((list, name) => tr('{list} and {name}', { list, name })), uris: [] };
  }
  if (isAndroid()) {
    // A folder of the bundle's name keeps its files together among the other exports.
    const folder = base(suggestedName);
    const uris: string[] = [];
    for (const file of make(folder)) uris.push((await exportToAppFolder(folder, file.name, file.bytes, file.mime)).uri);
    return { where: `Download/PlastikCAD/${folder}`, uris };
  }
  const target = await chooseSave(suggestedName, filters, mime);
  if (!target) return null;
  const folder = target.path!.slice(0, target.path!.length - target.name.length);
  for (const file of make(base(target.name))) await writePath(folder + file.name, file.bytes);
  return { where: folder.replace(/[\\/]$/, ''), uris: [] };
}

/** Native save dialog then write (desktop), or a download (browser, where `path` is null). Null if canceled. */
export async function saveAs(suggestedName: string, filters: FileFilter[], bytes: Uint8Array, mime: string): Promise<SaveTarget | null> {
  if (isAndroid()) {
    // Into the app's folder in Downloads, with no dialog; shared from there.
    const exported = await exportToAppFolder('', suggestedName, bytes, mime);
    return { path: exported.path, name: suggestedName, uri: exported.uri };
  }
  const target = await chooseSave(suggestedName, filters, mime);
  if (!target) return null;
  await writeTarget(target, bytes, mime);
  return target;
}

/** Desktop only: overwrite a known path atomically. */
export async function writePath(path: string, bytes: Uint8Array): Promise<void> {
  // The bytes are the request body, so the path travels in a header, and header values must be ASCII.
  await command<void>('write_file', bytes, { path: encodeURIComponent(path) });
}

/** A design in the projects folder, as the desktop app lists them. */
export interface DesignEntry {
  name: string;
  path: string;
  size: number;
  /** Milliseconds since the epoch. */
  modified: number;
}

/** Desktop only: the designs directly inside a folder, which is created if missing. */
export async function listDesigns(dir: string): Promise<DesignEntry[]> {
  return command<DesignEntry[]>('list_designs', { dir });
}

/** Desktop only: the first `limit` bytes of a file. */
export async function readHead(path: string, limit: number): Promise<Uint8Array> {
  const data = await command<ArrayBuffer | number[]>('read_head', { path, limit });
  return data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
}

/** Desktop only. */
export async function removeFile(path: string): Promise<void> {
  await command<void>('remove_file', { path });
}

/** Desktop only: renames or moves a file; fails rather than replace an existing one. */
export async function moveFile(from: string, to: string): Promise<void> {
  await command<void>('move_file', { from, to });
}

/** Desktop only: where projects go unless the user picked a folder; `fixed` where no other folder can be chosen (Android). */
export async function defaultProjectsDir(): Promise<{ path: string; fixed: boolean }> {
  return command<{ path: string; fixed: boolean }>('default_projects_dir');
}

/** Desktop only: native folder picker. Null if canceled. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, defaultPath });
  return typeof picked === 'string' ? picked : null;
}

/** A sign-in waiting for the browser to come back: where it is sent back to, and the loopback port that listens. */
export interface SignInSession {
  redirect: string;
  port: number;
}

/** Desktop: readies a loopback port for the sign-in to come back to. */
export async function oauthStart(): Promise<SignInSession> {
  const port = await command<number>('oauth_start');
  return { redirect: `http://127.0.0.1:${port}/`, port };
}

/** Desktop: opens the sign-in page in the system browser and resolves with the query string the browser is sent back with. */
export const oauthWait = (session: SignInSession, url: string): Promise<string> => command<string>('oauth_wait', { port: session.port, url });

export const oauthCancel = (session: SignInSession): Promise<void> => command<void>('oauth_cancel', { port: session.port });

/**
 * Android: an access token for the scope from Google Play services, which
 * knows the app by its package and signing key (Google takes no redirect URL
 * from an Android app). The first time Google's own sheet asks the user; after
 * that the grant is remembered. `silent` asks only for what is granted already
 * and rejects with "needs-sign-in" otherwise; a sheet dismissed rejects with
 * "cancelled".
 */
export async function androidAuthorize(scope: string, silent: boolean): Promise<string> {
  const { accessToken } = await device<{ accessToken: string }>('authorize', { scope, silent });
  return accessToken;
}

/** Android: forgets a token Play services holds, so the account is asked again next time. */
export const androidClearToken = (token: string): Promise<void> => device<void>('clear_token', { token }).catch(() => undefined);

/**
 * The files the app was started with: the design passed on the command line
 * on desktop, the files tapped or shared to it on Android. None in the browser.
 */
export async function startupFiles(): Promise<string[]> {
  if (!isTauri()) return [];
  if (isAndroid()) return (await device<{ uris: string[] }>('opened_files').catch(() => ({ uris: [] }))).uris;
  const path = await command<string | null>('startup_file');
  // macOS hands the design it was launched with over by event, not as an argument: it is waiting here.
  const waiting = await command<string[]>('opened_files').catch(() => []);
  return [...new Set([...(path ? [path] : []), ...waiting])];
}

/**
 * Files handed to the running app: a tap in the Files app on Android, a
 * design double-clicked on desktop. Fetched when word comes that some
 * arrived. Returns an unsubscribe function.
 */
export function onFilesOpened(handler: (paths: string[]) => void): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  let stop: (() => void) | null = null;
  if (!isAndroid()) {
    // Desktop: a design double-clicked while the app runs. The second launch hands it over and quits.
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('opened', async () => {
        const paths = await command<string[]>('opened_files');
        if (paths.length > 0) handler(paths);
      }))
      .then((unlisten) => {
        stop = unlisten;
        if (stopped) stop();
      })
      .catch(console.error);
    return () => {
      stopped = true;
      stop?.();
    };
  }
  import('@tauri-apps/api/core')
    .then(({ addPluginListener }) => addPluginListener('device', 'opened', async () => {
      const { uris } = await device<{ uris: string[] }>('opened_files');
      if (uris.length > 0) handler(uris);
    }))
    .then((listener) => {
      stop = () => void listener.unregister();
      if (stopped) stop();
    })
    .catch(console.error);
  return () => {
    stopped = true;
    stop?.();
  };
}

/** Whether a picked file can be deleted from here: it has a place (a path, or a document on Android). */
export const canDelete = (path: string | null): boolean => isTauri() && path !== null;

/** Deletes a file the user picked or opened: by path on desktop, through its provider on Android. */
export async function deleteFile(path: string): Promise<void> {
  if (path.includes('://')) return void (await device('delete_document', { uri: path }));
  await command<void>('delete_file', { path });
}

export function setWindowTitle(title: string): void {
  document.title = title;
  if (!isTauri()) return;
  // The native title bar does not follow document.title.
  import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch(console.error);
}

/**
 * Files dropped on the window (native drag-drop on desktop, HTML5 drop in the browser). `unread` is told of the
 * ones that could not be read, and why. Returns an unsubscribe function.
 */
export function onFilesDropped(handler: (files: PickedFile[]) => void, unread?: (reasons: string[]) => void): () => void {
  const deliver = (files: PickedFile[]) => {
    if (files.length > 0) handler(files);
  };
  if (isTauri()) {
    // Tauri handles drops natively (`dragDropEnabled`, on by default), which
    // is what provides real paths; the webview gets no HTML5 drop events.
    return listen(async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      return getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === 'drop') void readable(event.payload.paths.map(readPath), unread).then(deliver);
      });
    });
  }
  // Both events must be canceled, or the browser navigates to the dropped file.
  const allow = (event: DragEvent) => event.preventDefault();
  const drop = (event: DragEvent) => {
    event.preventDefault();
    void readable(Array.from(event.dataTransfer?.files ?? [], readBrowserFile), unread).then(deliver);
  };
  window.addEventListener('dragover', allow);
  window.addEventListener('drop', drop);
  return () => {
    window.removeEventListener('dragover', allow);
    window.removeEventListener('drop', drop);
  };
}

/** Yes/no question: native dialog on desktop, window.confirm in the browser. */
export async function confirm(
  message: string,
  options: { title?: string; okLabel?: string; cancelLabel?: string } = {},
): Promise<boolean> {
  if (!isTauri()) return window.confirm(message);
  const { ask } = await import('@tauri-apps/plugin-dialog');
  return ask(message, { title: options.title ?? APP_NAME, okLabel: options.okLabel, cancelLabel: options.cancelLabel });
}

/**
 * Saves before the window closes while `isDirty()` is true. On desktop the
 * close request is held while `flush` writes; if that fails the user is asked
 * whether to close anyway. In a browser only the standard prompt can be shown.
 * Returns an unsubscribe function.
 */
export function guardClose(isDirty: () => boolean, flush: () => Promise<boolean>): () => void {
  if (isTauri()) {
    let closing = false;
    return listen(async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      // Tauri closes the window once this handler settles, unless it called preventDefault.
      return window.onCloseRequested(async (event) => {
        if (!isDirty()) return;
        event.preventDefault();
        // A second click on the close button must not stack another save or dialog.
        if (closing) return;
        closing = true;
        try {
          const saved = await flush();
          const close =
            saved ||
            (await confirm(tr('The latest changes could not be saved. Close anyway and lose them?'), {
              title: tr('Unsaved changes'),
              okLabel: tr('Close anyway'),
              cancelLabel: tr('Keep editing'),
            }));
          if (close) await window.destroy();
        } finally {
          closing = false;
        }
      });
    });
  }
  // Browsers show their own wording; canceling the event is what triggers the prompt.
  const warn = (event: BeforeUnloadEvent) => {
    if (isDirty()) event.preventDefault();
  };
  window.addEventListener('beforeunload', warn);
  return () => window.removeEventListener('beforeunload', warn);
}

/**
 * Android's Back. `handler` closes whatever is open or under way, one thing at a press, and says whether there was
 * anything; when there was not, the app goes behind the others, as an app does from its first screen. Without this
 * the system took every Back for that, a box or a menu being open or not. Returns an unsubscribe function.
 */
export function onBack(handler: () => boolean): () => void {
  if (!isAndroid()) return () => {};
  let stop: (() => void) | undefined;
  let stopped = false;
  void import('@tauri-apps/api/app')
    .then(({ onBackButtonPress }) =>
      onBackButtonPress(() => {
        if (!handler()) void device('leave').catch(() => undefined);
      }),
    )
    .then((listener) => {
      stop = () => void listener.unregister();
      if (stopped) stop();
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    stop?.();
  };
}

/** Runs `handler` when the page is hidden (another app in front, the tab switched), the moment to write out what is pending. Returns an unsubscribe function. */
export function onHidden(handler: () => void): () => void {
  const check = () => {
    if (document.visibilityState === 'hidden') handler();
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('pagehide', handler);
  return () => {
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('pagehide', handler);
  };
}
