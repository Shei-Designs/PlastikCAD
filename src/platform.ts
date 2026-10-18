// The one module that knows whether the UI runs in the desktop app (Tauri) or
// in a plain browser, as it does during development (`pnpm dev`). Tauri's
// window, webview and dialog modules are imported on demand, so the browser
// never loads them.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { APP_NAME } from './app';

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
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}

async function readBrowserFile(file: File): Promise<PickedFile> {
  return { name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Keeps the files that could be read: one bad entry (a dropped folder, say) should not lose the rest. */
async function readable(reads: Promise<PickedFile>[]): Promise<PickedFile[]> {
  const results = await Promise.allSettled(reads);
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
  const { open } = await import('@tauri-apps/plugin-dialog');
  // Android's picker filters by the MIME type a file was stored with, which a GLB or a design file rarely
  // has (they show greyed out), so there every file is offered and the app reads what each one is itself.
  const picked: string | string[] | null = await open({ filters: isAndroid() ? [] : options.filters, multiple });
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
  // through as it is), rather than left to the extension, which the system may not know.
  const path = await save({ defaultPath: suggestedName, filters: isAndroid() ? [{ name: filters[0]?.name ?? mime, extensions: [mime] }] : filters });
  if (!path) return null;
  return { path, name: await nameOf(path) };
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
 * Saves files that belong together in a new folder of their own, so they are
 * not parted: on desktop the save dialog names the folder (its chosen name,
 * less the extension) inside the chosen place; on Android a folder is picked
 * and the new one made in it; in the browser each file is a download. `make`
 * is given the name the bundle got and returns its files. Resolves with where
 * they went, or null if canceled.
 */
export async function saveBundle(suggestedName: string, filters: FileFilter[], mime: string, make: (base: string) => BundleFile[]): Promise<string | null> {
  const base = (name: string) => name.replace(/\.[^.]+$/, '');
  if (!isTauri()) {
    const files = make(base(suggestedName));
    for (const file of files) await writeTarget({ path: null, name: file.name }, file.bytes, file.mime);
    return files.map((f) => f.name).join(' and ');
  }
  if (isAndroid()) {
    const picked = await invoke<{ uri: string | null }>('plugin:device|pick_folder');
    if (!picked.uri) return null;
    const name = base(suggestedName);
    const folder = await invoke<{ uri: string }>('plugin:device|create_document', { parent: picked.uri, name, mime: 'vnd.android.document/directory' });
    for (const file of make(name)) {
      const made = await invoke<{ uri: string }>('plugin:device|create_document', { parent: folder.uri, name: file.name, mime: file.mime });
      await writePath(made.uri, file.bytes);
    }
    return `the ${name} folder`;
  }
  const target = await chooseSave(suggestedName, filters, mime);
  if (!target) return null;
  const name = base(target.name);
  const folder = target.path!.slice(0, target.path!.length - target.name.length) + name;
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  for (const file of make(name)) await writePath(`${folder}${separator}${file.name}`, file.bytes);
  return folder;
}

/** Native save dialog then write (desktop), or a download (browser, where `path` is null). Null if canceled. */
export async function saveAs(suggestedName: string, filters: FileFilter[], bytes: Uint8Array, mime: string): Promise<SaveTarget | null> {
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

/** Desktop and Android: listens on a loopback port for a sign-in to come back to. Returns the port. */
export async function oauthStart(): Promise<number> {
  return command<number>('oauth_start');
}

/** Opens the sign-in page in the system browser and resolves with the query string the browser is sent back with. */
export async function oauthWait(port: number, url: string): Promise<string> {
  return command<string>('oauth_wait', { port, url });
}

export async function oauthCancel(port: number): Promise<void> {
  await command<void>('oauth_cancel', { port });
}

/** Desktop only: path of a design file passed on the command line, else null (always null in the browser). */
export async function startupFile(): Promise<string | null> {
  return isTauri() ? command<string | null>('startup_file') : null;
}

export function setWindowTitle(title: string): void {
  document.title = title;
  if (!isTauri()) return;
  // The native title bar does not follow document.title.
  import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch(console.error);
}

/** Files dropped on the window (native drag-drop on desktop, HTML5 drop in the browser). Returns an unsubscribe function. */
export function onFilesDropped(handler: (files: PickedFile[]) => void): () => void {
  const deliver = (files: PickedFile[]) => {
    if (files.length > 0) handler(files);
  };
  if (isTauri()) {
    // Tauri handles drops natively (`dragDropEnabled`, on by default), which
    // is what provides real paths; the webview gets no HTML5 drop events.
    return listen(async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      return getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === 'drop') void readable(event.payload.paths.map(readPath)).then(deliver);
      });
    });
  }
  // Both events must be canceled, or the browser navigates to the dropped file.
  const allow = (event: DragEvent) => event.preventDefault();
  const drop = (event: DragEvent) => {
    event.preventDefault();
    void readable(Array.from(event.dataTransfer?.files ?? [], readBrowserFile)).then(deliver);
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
            (await confirm('The latest changes could not be saved. Close anyway and lose them?', {
              title: 'Unsaved changes',
              okLabel: 'Close anyway',
              cancelLabel: 'Keep editing',
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
