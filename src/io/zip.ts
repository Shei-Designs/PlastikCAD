// A zip archive handed to the app in place of the files in it: a model with
// its material library and pictures, a robot's package, a design. Only what
// the app could read is unpacked, and no more of it than fits in memory.
import { unzipSync } from 'fflate';
import { FILE_EXTENSION, LEGACY_EXTENSION } from '../appInfo';
import { tr } from '../i18n';
import { IMAGE_EXTENSIONS, IMPORT_EXTENSIONS } from './import';
import type { Companion } from './import';

/** What is worth unpacking: what the app imports, and what those files name beside them. */
const WANTED = new Set([...IMPORT_EXTENSIONS, ...IMAGE_EXTENSIONS, 'mtl', 'bin', 'urdf', 'xacro', FILE_EXTENSION, LEGACY_EXTENSION]);
/** Unpacked size, in bytes, past which the archive is not read. */
const MAX_UNPACKED = 512 * 1024 * 1024;
const MAX_FILES = 10_000;

/** Whether an entry of an archive is a file the app could read, by its name. */
function wanted(name: string): boolean {
  const parts = name.replace(/\\/g, '/').split('/');
  const base = parts[parts.length - 1];
  // Folders, what a Mac adds beside every file, and hidden files.
  if (!base || base.startsWith('.') || parts.includes('__MACOSX')) return false;
  return WANTED.has(/\.([^.]+)$/.exec(base)?.[1].toLowerCase() ?? '');
}

/**
 * The files of a zip archive that the app could read, under the paths the
 * archive gives them, up to `limit` bytes of them. Throws an Error with a
 * message fit to show the user.
 */
export function unpackZip(bytes: Uint8Array, limit = MAX_UNPACKED): Companion[] {
  const too = tr('This zip file is too large to open.');
  let unpacked = 0;
  let count = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        if (!wanted(file.name)) return false;
        unpacked += file.originalSize;
        if (unpacked > limit || ++count > MAX_FILES) throw new Error(too);
        return true;
      },
    });
  } catch (e) {
    // The unpacker's own words for a broken archive are not for the user.
    if (e instanceof Error && e.message === too) throw e;
    throw new Error(tr('This {format} file is damaged or not supported.', { format: 'zip' }));
  }
  // What an archive says of a file's size is not to be trusted: what came out is.
  let total = 0;
  for (const name in files) total += files[name].length;
  if (total > limit) throw new Error(too);
  return Object.entries(files).map(([name, data]) => ({ name: name.replace(/\\/g, '/'), bytes: data }));
}
