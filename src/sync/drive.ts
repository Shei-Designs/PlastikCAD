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
  ) {}

  /** The remote's folder, made on first use. */
  async folder(): Promise<string> {
    if (this.folderId) return this.folderId;
    const under = this.parent ? await this.parent.folder() : 'root';
    const q = `name = ${quote(this.folderName)} and mimeType = '${FOLDER_TYPE}' and ${quote(under)} in parents and trashed = false`;
    // The oldest first, so that every device and every pass settles on the same one should there ever be two.
    const found = await body<{ files: DriveFile[] }>(await this.fetch(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=createdTime&pageSize=10`), (message) => tr('Google Drive could not find its folder: {message}', { message }));
    if (found.files.length) return (this.folderId = found.files[0].id);
    const made = await body<DriveFile>(
      await this.fetch(`${API}/files?fields=id`, {
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
      const page = await body<{ files: DriveFile[]; nextPageToken?: string }>(await this.fetch(`${API}/files?${params}`), (message) => tr('Google Drive could not list the projects: {message}', { message }));
      for (const file of page.files) if (isDesignName(file.name)) out.push(toRemote(file));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async download(file: RemoteFile): Promise<string> {
    const response = await this.fetch(`${API}/files/${encodeURIComponent(file.id)}?alt=media`);
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
    const boundary = `${FILE_FORMAT}-${Math.random().toString(36).slice(2)}`;
    const parts = [
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\ncontent-type: application/json\r\n\r\n${text}\r\n`,
      `--${boundary}--`,
    ].join('');
    const url = existing ? `${UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=${FILE_FIELDS}` : `${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`;
    const file = await body<DriveFile>(
      await this.fetch(url, { method: existing ? 'PATCH' : 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: parts }),
      (message) => tr('Google Drive could not upload {name}: {message}', { name, message }),
    );
    const remote = toRemote(file);
    // Drive echoes an empty revision as missing.
    if (remote.revision === '') remote.revision = null;
    return remote;
  }

  async stat(file: RemoteFile): Promise<RemoteFile | null> {
    const response = await this.fetch(`${API}/files/${encodeURIComponent(file.id)}?fields=${FILE_FIELDS},trashed`);
    if (response.status === 404) return null;
    const found = await body<DriveFile & { trashed?: boolean }>(response, (message) => tr('Google Drive could not look at {name}: {message}', { name: file.name, message }));
    if (found.trashed) return null;
    const remote = toRemote(found);
    if (remote.revision === '') remote.revision = null;
    return remote;
  }

  async remove(file: RemoteFile): Promise<void> {
    await body(
      await this.fetch(`${API}/files/${encodeURIComponent(file.id)}?fields=id`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }) }),
      (message) => tr('Google Drive could not delete {name}: {message}', { name: file.name, message }),
    );
  }

  /** Who is signed in. */
  async account(): Promise<{ email: string; name: string }> {
    const about = await body<{ user?: { emailAddress?: string; displayName?: string } }>(await this.fetch(`${API}/about?fields=user`), (message) => tr('Google Drive could not read the account: {message}', { message }));
    return { email: about.user?.emailAddress ?? '', name: about.user?.displayName ?? '' };
  }
}
