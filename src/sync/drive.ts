// Google Drive as a remote for the sync engine: a folder of .plastikcad files,
// each tagged with its project id and revision in the file's app properties.
// With the drive.file scope the app sees only files it created, which is all
// it needs, and nothing else in the Drive. The custom parts are a second
// remote, in a "Parts" folder inside the app's folder.
import { APP_NAME, FILE_EXTENSION, FILE_FORMAT, isDesignName } from '../appInfo';
import { tr } from '../i18n';
import type { Remote, RemoteFile } from './engine';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,modifiedTime,appProperties';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
/** Waits before a request is tried again; a test gives one that does not. */
export type Wait = (ms: number) => Promise<void>;

/** How often a request that Google put off, or that did not get through, is tried again. */
const RETRIES = 4;
/** A design larger than this goes up through Drive's channel for large files, which can go on from where it stopped. */
export const LARGE_UPLOAD = 4 * 1024 * 1024;

/** How long to wait before try `attempt` (0 for the first again): what Google asked for, or one second, then two, four and eight, each with a little added so that devices do not come back together. */
function delay(attempt: number, response?: Response): number {
  const asked = Number(response?.headers.get('retry-after'));
  return (Number.isFinite(asked) && asked > 0 ? Math.min(asked, 60) * 1000 : 1000 * 2 ** attempt) + Math.round(Math.random() * 250);
}

/** Whether an answer says "not now" rather than "no": too many requests, or Google's side failing. */
async function putOff(response: Response): Promise<boolean> {
  if (response.status === 429 || response.status >= 500) return true;
  if (response.status !== 403) return false;
  // Drive also says "too fast" with a 403, told from a real refusal by its reason.
  try {
    const json = (await response.clone().json()) as { error?: { errors?: { reason?: string }[] } };
    const reason = json.error?.errors?.[0]?.reason;
    return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
  } catch {
    return false;
  }
}

interface DriveFile {
  id: string;
  name: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
}

/** The answer's JSON, or an error worded by `failed` from what Google said went wrong. */
async function body<T>(response: Response, failed: (message: string) => string): Promise<T> {
  if (!response.ok) {
    let message = `${response.status}`;
    try {
      const json = (await response.json()) as { error?: { message?: string } };
      if (json.error?.message) message = json.error.message;
    } catch {
      // No JSON in the answer.
    }
    throw new Error(failed(message));
  }
  return (await response.json()) as T;
}

const toRemote = (file: DriveFile): RemoteFile => ({
  id: file.id,
  name: file.name,
  projectId: file.appProperties?.projectId ?? null,
  revision: file.appProperties?.revision ?? null,
  modified: file.modifiedTime ? Date.parse(file.modifiedTime) : 0,
});

const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export class DriveRemote implements Remote {
  private folderId: string | null = null;

  /** `parent` is the remote whose folder this one's folder sits in; without one it sits at the top of the Drive. */
  constructor(
    private readonly fetch: Fetch,
    readonly folderName = APP_NAME,
    private readonly parent: DriveRemote | null = null,
    private readonly wait: Wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  ) {}

  /**
   * A request to Drive, tried again after a wait when Google puts it off (too many requests, a
   * failure on its side), and when it did not get through at all, unless it makes something: a
   * request that makes a file may have made it although no answer came back, and is left to the
   * next sync rather than made twice.
   */
  private async send(url: string, init?: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await this.fetch(url, init);
        if (attempt >= RETRIES || !(await putOff(response))) return response;
      } catch (e) {
        // What `fetch` throws when the network fails; anything else (the sign-in having lapsed) is not for trying again.
        if (!(e instanceof TypeError) || attempt >= RETRIES || init?.method === 'POST') throw e;
      }
      await this.wait(delay(attempt, response));
    }
  }

  /** The remote's folder, made on first use. */
  async folder(): Promise<string> {
    if (this.folderId) return this.folderId;
    const under = this.parent ? await this.parent.folder() : 'root';
    const q = `name = ${quote(this.folderName)} and mimeType = '${FOLDER_TYPE}' and ${quote(under)} in parents and trashed = false`;
    // The oldest first, so that every device and every pass settles on the same one should there ever be two.
    const found = await body<{ files: DriveFile[] }>(await this.send(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=createdTime&pageSize=10`), (message) => tr('Google Drive could not find its folder: {message}', { message }));
    if (found.files.length) return (this.folderId = found.files[0].id);
    const made = await body<DriveFile>(
      await this.send(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: this.folderName, mimeType: FOLDER_TYPE, parents: [under] }),
      }),
      (message) => tr('Google Drive could not make its folder: {message}', { message }),
    );
    return (this.folderId = made.id);
  }

  async list(): Promise<RemoteFile[]> {
    const folder = await this.folder();
    const q = `${quote(folder)} in parents and trashed = false and mimeType != '${FOLDER_TYPE}'`;
    const out: RemoteFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await body<{ files: DriveFile[]; nextPageToken?: string }>(await this.send(`${API}/files?${params}`), (message) => tr('Google Drive could not list the projects: {message}', { message }));
      for (const file of page.files) if (isDesignName(file.name)) out.push(toRemote(file));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async download(file: RemoteFile): Promise<string> {
    const response = await this.send(`${API}/files/${encodeURIComponent(file.id)}?alt=media`);
    if (!response.ok) await body(response, (message) => tr('Google Drive could not download {name}: {message}', { name: file.name, message }));
    return response.text();
  }

  async upload(existing: RemoteFile | null, name: string, text: string, meta: { projectId: string; revision: string | null }): Promise<RemoteFile> {
    const fileName = isDesignName(name) ? name : `${name}.${FILE_EXTENSION}`;
    const metadata: Record<string, unknown> = {
      name: fileName,
      mimeType: 'application/json',
      appProperties: { app: FILE_FORMAT, projectId: meta.projectId, revision: meta.revision ?? '' },
    };
    if (!existing) metadata.parents = [await this.folder()];
    const fixed = (file: DriveFile): RemoteFile => {
      const remote = toRemote(file);
      // Drive echoes an empty revision as missing.
      if (remote.revision === '') remote.revision = null;
      return remote;
    };
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > LARGE_UPLOAD) {
      const large = await this.uploadLarge(existing, name, metadata, bytes);
      if (large) return fixed(large);
    }
    const boundary = `${FILE_FORMAT}-${Math.random().toString(36).slice(2)}`;
    const parts = [
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\ncontent-type: application/json\r\n\r\n${text}\r\n`,
      `--${boundary}--`,
    ].join('');
    const url = existing ? `${UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=${FILE_FIELDS}` : `${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`;
    const file = await body<DriveFile>(
      await this.send(url, { method: existing ? 'PATCH' : 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: parts }),
      (message) => tr('Google Drive could not upload {name}: {message}', { name, message }),
    );
    return fixed(file);
  }

  /**
   * A large design, through Drive's resumable upload: a first request says what is coming and is
   * answered with an address to send it to, and the design is then sent there. If that breaks off,
   * Drive is asked how much arrived and the rest is sent from there. Null when Drive gives no
   * address to send to (or this page is not let read it): the caller then sends the design in one
   * piece, as a small one goes.
   */
  private async uploadLarge(existing: RemoteFile | null, name: string, metadata: Record<string, unknown>, bytes: Uint8Array): Promise<DriveFile | null> {
    const failed = (message: string): string => tr('Google Drive could not upload {name}: {message}', { name, message });
    const url = existing ? `${UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=${FILE_FIELDS}` : `${UPLOAD}/files?uploadType=resumable&fields=${FILE_FIELDS}`;
    const opened = await this.send(url, {
      method: existing ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/json', 'x-upload-content-length': String(bytes.length) },
      body: JSON.stringify(metadata),
    });
    const session = opened.ok ? opened.headers.get('location') : null;
    if (!session) return null;
    let from = 0;
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (from > 0) headers['content-range'] = `bytes ${from}-${bytes.length - 1}/${bytes.length}`;
        response = await this.fetch(session, { method: 'PUT', headers, body: bytes.subarray(from) as BodyInit });
      } catch (e) {
        if (!(e instanceof TypeError) || attempt >= RETRIES) throw e;
      }
      if (response?.ok) return (await response.json()) as DriveFile;
      // A refusal is final; a failure on Google's side, like a broken connection, is gone on from.
      if (response && (attempt >= RETRIES || !(await putOff(response)))) return body<DriveFile>(response, failed);
      await this.wait(delay(attempt, response));
      // How much of it arrived: 308 with the range Drive holds, or the file itself when all of it did.
      let held: Response | undefined;
      try {
        held = await this.fetch(session, { method: 'PUT', headers: { 'content-range': `bytes */${bytes.length}` } });
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
      }
      if (held?.ok) return (await held.json()) as DriveFile;
      // Drive has forgotten the upload (it keeps one for a week): the next sync starts it afresh.
      if (held && held.status !== 308) return body<DriveFile>(held, failed);
      const end = /^bytes=0-(\d+)$/.exec(held?.headers.get('range') ?? '');
      from = end ? Number(end[1]) + 1 : 0;
    }
  }

  async stat(file: RemoteFile): Promise<RemoteFile | null> {
    const response = await this.send(`${API}/files/${encodeURIComponent(file.id)}?fields=${FILE_FIELDS},trashed`);
    if (response.status === 404) return null;
    const found = await body<DriveFile & { trashed?: boolean }>(response, (message) => tr('Google Drive could not look at {name}: {message}', { name: file.name, message }));
    if (found.trashed) return null;
    const remote = toRemote(found);
    if (remote.revision === '') remote.revision = null;
    return remote;
  }

  async remove(file: RemoteFile): Promise<void> {
    await body(
      await this.send(`${API}/files/${encodeURIComponent(file.id)}?fields=id`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }) }),
      (message) => tr('Google Drive could not delete {name}: {message}', { name: file.name, message }),
    );
  }

  /** Who is signed in. */
  async account(): Promise<{ email: string; name: string }> {
    const about = await body<{ user?: { emailAddress?: string; displayName?: string } }>(await this.send(`${API}/about?fields=user`), (message) => tr('Google Drive could not read the account: {message}', { message }));
    return { email: about.user?.emailAddress ?? '', name: about.user?.displayName ?? '' };
  }
}
