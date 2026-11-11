// The desktop and Android apps read and write files through the native side, which refuses every kind
// of file it does not know by its extension (src-tauri/src/lib.rs). A format added to the app and not
// to that list works in the browser and in every browser test, and is refused in the app itself.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FILE_EXTENSION, LEGACY_EXTENSION } from './appInfo';
import { FORMATS } from './io/export';
import { IMAGE_EXTENSIONS, IMPORT_EXTENSIONS } from './io/import';

const native = readFileSync(fileURLToPath(new URL('../src-tauri/src/lib.rs', import.meta.url)), 'utf8');

/** The extensions of one of the native side's lists, its named constants put in. */
function kinds(list: string): string[] {
  const body = new RegExp(`const ${list}: &\\[&str\\] = &\\[([^;]*)\\];`).exec(native)?.[1];
  if (body === undefined) throw new Error(`No list ${list} in lib.rs`);
  const named = (constant: string): string => {
    const value = new RegExp(`const ${constant}: &str = "([^"]+)";`).exec(native)?.[1];
    if (value === undefined) throw new Error(`No constant ${constant} in lib.rs`);
    return value;
  };
  return body
    .split(',')
    .map((word) => word.trim())
    .filter(Boolean)
    .map((word) => (word.startsWith('"') ? word.slice(1, -1) : named(word)));
}

describe('the kinds of file the native side lets through', () => {
  it('opens every kind the app imports, and what those files name beside them', () => {
    const readable = kinds('READABLE');
    // A material library beside an OBJ, the data beside a glTF, and a robot description with its macros.
    const beside = ['mtl', 'bin', 'urdf', 'xacro'];
    for (const extension of [FILE_EXTENSION, LEGACY_EXTENSION, ...IMPORT_EXTENSIONS, ...IMAGE_EXTENSIONS, ...beside]) {
      expect(readable, `.${extension} files are opened`).toContain(extension);
    }
  });

  it('saves every format the app exports', () => {
    const writable = kinds('WRITABLE');
    // A material library goes out beside an OBJ, and a robot as an archive.
    for (const extension of [FILE_EXTENSION, ...FORMATS.map((f) => f.extension), 'mtl', 'zip']) {
      expect(writable, `.${extension} files are saved`).toContain(extension);
    }
  });

  it('saves nothing the app does not write, and opens nothing it does not read', () => {
    expect([...kinds('WRITABLE')].sort()).toEqual([...new Set([FILE_EXTENSION, ...FORMATS.map((f) => f.extension), 'mtl', 'zip'])].sort());
    expect([...kinds('READABLE')].sort()).toEqual([...new Set([FILE_EXTENSION, LEGACY_EXTENSION, ...IMPORT_EXTENSIONS, ...IMAGE_EXTENSIONS, 'mtl', 'bin', 'urdf', 'xacro'])].sort());
  });
});
