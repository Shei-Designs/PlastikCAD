// Imported meshes and pictures kept apart from the designs on the remote.
// A design holds what it imported, which can be tens of megabytes that never
// change, while the design around them changes with every edit; sent whole,
// every edit would send them again. So a design goes up without them, each
// replaced by the name of a file that holds it, and that file goes up once,
// to a folder of its own, under a name made from its contents: the same mesh
// in two designs, or in two saves of one, is one file.
//
// Only the remote copy is laid out so. The projects on a device stay whole,
// one file each, and the sync engine never sees a design in parts: this wraps
// the remote it talks to, taking a design apart on the way up and putting it
// back together on the way down.
import { tr } from '../i18n';
import { formatFile } from '../model/file';
import type { Remote, RemoteFile } from './engine';

/** An imported mesh or picture this long as text, or longer, is kept apart; a smaller one stays in its design. */
export const APART_FROM = 100_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The name of what a text holds: the same for the same text on every device. */
export async function contentName(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a design in parts holds in place of an asset kept apart: its kind, and the name of its contents. */
const stub = (asset: unknown): string | null => (isRecord(asset) && typeof asset.apart === 'string' && /^[0-9a-f]{64}$/.test(asset.apart) ? asset.apart : null);

/** The assets of a design file's text, as they stand in it; null when it is not one. */
function assetsOf(text: string): { file: Record<string, unknown>; assets: Record<string, unknown> } | null {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(file) && isRecord(file.assets) ? { file, assets: file.assets } : null;
}

/**
 * A design's text without its large meshes and pictures, and those, each
 * under the name of its contents. Null when it holds none, or when the parts
 * would not go back together into the very same text (a file laid out some
 * other way): such a design is sent whole.
 */
export async function takeApart(text: string): Promise<{ text: string; apart: Map<string, string> } | null> {
  const read = assetsOf(text);
  if (!read) return null;
  const apart = new Map<string, string>();
  const assets: Record<string, unknown> = {};
  for (const [key, asset] of Object.entries(read.assets)) {
    assets[key] = asset;
    if (!isRecord(asset) || (asset.kind !== 'mesh' && asset.kind !== 'image') || 'apart' in asset) continue;
    const body = JSON.stringify(asset);
    if (body.length < APART_FROM) continue;
    const name = await contentName(body);
    apart.set(name, body);
    assets[key] = { kind: asset.kind, apart: name };
  }
  if (apart.size === 0) return null;
  const slim = formatFile({ ...read.file, assets });
  const back = await putTogether(slim, (name) => Promise.resolve(apart.get(name) ?? null)).catch(() => null);
  return back === text ? { text: slim, apart } : null;
}

/** Whether a design's text names assets kept apart. */
export const inParts = (text: string): boolean => text.includes('"apart": "');

/**
 * A design's text whole again: every asset kept apart put back, as `find`
 * gives it for the name of its contents (and the key the design has it
 * under). Rejects when one cannot be found, or is not what its name says.
 */
export async function putTogether(text: string, find: (name: string, key: string) => Promise<string | null>): Promise<string> {
  if (!inParts(text)) return text;
  const read = assetsOf(text);
  if (!read) return text;
  const assets: Record<string, unknown> = {};
  let found = false;
  for (const [key, asset] of Object.entries(read.assets)) {
    const name = stub(asset);
    if (name === null) {
      assets[key] = asset;
      continue;
    }
    const body = await find(name, key);
    if (body === null) throw new MissingAsset();
    let whole: unknown;
    try {
      whole = JSON.parse(body);
    } catch {
      throw new MissingAsset();
    }
    if (!isRecord(whole) || whole.kind !== (asset as Record<string, unknown>).kind) throw new MissingAsset();
    assets[key] = whole;
    found = true;
  }
  return found ? formatFile({ ...read.file, assets }) : text;
}

/** An asset a design keeps apart is not where it should be, or is not itself. */
export class MissingAsset extends Error {
  constructor() {
    super('missing asset');
    this.name = 'MissingAsset';
  }
}

/** A remote that keeps the large parts of designs apart. */
export interface ApartRemote extends Remote {
  /** Forgets what the store was last seen to hold: asked at the start of a pass, so that what went missing since is sent again. */
  forget(): void;
}

/** The file an asset is kept in, by the name of its contents. */
const fileOf = (name: string): string => `${name}.json`;

/**
 * `designs` as the engine is to see it, with the large meshes and pictures of
 * what goes up kept in `store` instead (see the top of this file). `local`
 * gives the text of a project as this device has it, by the project's id, or
 * null: what a design coming down keeps apart is taken from there when it is
 * the same, and fetched only when it is not.
 */
export function apartRemote(designs: Remote, store: Remote, local: (projectId: string) => Promise<string | null>): ApartRemote {
  let kept: Map<string, RemoteFile> | null = null;
  /** What the store holds, by file name; asked afresh when something expected is not among it. */
  const listing = async (fresh = false): Promise<Map<string, RemoteFile>> => {
    if (!kept || fresh) {
      kept = new Map();
      // Should a file be there twice (an upload that went through unheard), the first is the one every device takes.
      for (const file of await store.list()) if (!kept.has(file.name)) kept.set(file.name, file);
    }
    return kept;
  };
  const remote: ApartRemote = {
    forget: () => {
      kept = null;
    },
    list: () => designs.list(),
    remove: (file) => designs.remove(file),
    async upload(existing, name, text, meta) {
      const parts = await takeApart(text);
      if (!parts) return designs.upload(existing, name, text, meta);
      const names = [...parts.apart.keys()];
      let have = await listing();
      if (names.some((n) => !have.has(fileOf(n)))) have = await listing(true);
      // The parts first: a design must never be up there naming what is not.
      for (const n of names) {
        if (have.has(fileOf(n))) continue;
        const file = await store.upload(null, fileOf(n), parts.apart.get(n)!, { projectId: n, revision: null });
        have.set(fileOf(n), file);
      }
      return designs.upload(existing, name, parts.text, meta);
    },
    async download(file) {
      const text = await designs.download(file);
      if (!inParts(text)) return text;
      let mine: Record<string, unknown> | null | undefined;
      try {
        return await putTogether(text, async (name, key) => {
          // What this device already has under that key, when it is the same.
          if (mine === undefined) {
            const own = file.projectId ? await local(file.projectId).catch(() => null) : null;
            mine = own ? (assetsOf(own)?.assets ?? null) : null;
          }
          const own = mine?.[key];
          if (isRecord(own) && stub(own) === null) {
            const body = JSON.stringify(own);
            if ((await contentName(body)) === name) return body;
          }
          let have = await listing();
          if (!have.has(fileOf(name))) have = await listing(true);
          const at = have.get(fileOf(name));
          if (!at) return null;
          let body: string;
          try {
            body = await store.download(at);
          } catch (e) {
            // Gone since it was last seen there: said as that. Anything else (the network, the sign-in) is its own trouble.
            if ((await listing(true)).has(fileOf(name))) throw e;
            return null;
          }
          return (await contentName(body)) === name ? body : null;
        });
      } catch (e) {
        if (!(e instanceof MissingAsset)) throw e;
        throw new Error(tr('The imported shapes and pictures of {name} are missing from Google Drive, or damaged there.', { name: file.name }));
      }
    },
  };
  if (designs.stat) remote.stat = (file) => designs.stat!(file);
  return remote;
}
