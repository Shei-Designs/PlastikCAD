// The design written out in an exchange format, and the word of where an
// export went.
import { exportMesh, exportOutline, FORMATS } from '../../io/export';
import { writeObj } from '../../io/obj';
import { zipSync } from 'fflate';
import { zipTime } from '../../io/format';
import { write3mf } from '../../io/threemf';
import { writePly } from '../../io/ply';
import type { FormatId } from '../../io/export';
import { exportGlb } from '../glbExport';
import * as platform from '../../platform';
import { fileNameFor } from '../projects';
import { askName, tell } from '../../ui/ask';
import { plural, tr } from '../../i18n';
import { geometry } from '../geometry';
import { endWork, fail, getState, notify, startWork } from './core';
import { selectedNodes } from './editing';

/**
 * Word of files written to the app's own folder (Android), in a box that
 * waits: where they are, and Share… to hand them to another app. Elsewhere a
 * toast says where the file went.
 */
/**
 * Says where an export went: a toast, or on Android a box that offers to share
 * it. Files that belong together (`bundle`) are shared as one zip of that name.
 */
export async function reportSaved(names: string[], where: string, uris: string[], mime: string, bundle?: { name: string; files: { name: string; bytes: Uint8Array }[] }): Promise<void> {
  const list = names.length === 1 ? names[0] : tr('{names} and {last}', { names: names.slice(0, -1).join(', '), last: names[names.length - 1] });
  // One text in English, whatever the count: other languages make the verb agree with it.
  if (!platform.canShare() || uris.length === 0) return notify(plural(names.length, 'Saved {list} to {where}', 'Saved {list} to {where}', { list, where }), 'ok');
  const share = tr('Share…');
  const chosen = await tell({ title: tr('Exported'), text: plural(names.length, '{list} is in {where}.', '{list} are in {where}.', { list, where }), actions: [share, tr('Done')] });
  if (chosen !== share) return;
  if (bundle && bundle.files.length > 1) {
    const zipped = zipSync(Object.fromEntries(bundle.files.map((f) => [f.name, f.bytes])), { mtime: zipTime() });
    await platform.shareBytes(`${bundle.name}.zip`, zipped, 'application/zip').catch(fail);
  } else {
    await platform.share(uris, mime).catch(fail);
  }
}

/** On Android the name is asked for in the app (the file goes to its own folder); elsewhere the save dialog names the file. Null if backed out. */
export async function exportName(suggested: string, extension: string): Promise<string | null> {
  if (!platform.keepsExports()) return suggested;
  return askName({ title: tr('Export'), label: tr('File name'), value: suggested, suffix: `.${extension}`, okLabel: tr('Export') });
}

/** Writes the design (or just the selection) in an exchange format and says where it went. Returns false if canceled. */
export async function exportDesign(formatId: FormatId, selectionOnly: boolean): Promise<boolean> {
  const format = FORMATS.find((f) => f.id === formatId)!;
  const nodes = selectionOnly ? selectedNodes() : getState().doc.scene;
  // A file's name, not the design's as typed: one with a slash in it would name a folder in the save box.
  const name = await exportName(fileNameFor(getState().doc.name).replace(/\.[^.]+$/, ''), format.extension);
  if (!name) return false;
  const filters = [{ name: format.label, extensions: [format.extension] }];
  // The geometry is made first, with word of it on the screen and a way to call it off; then the file is saved.
  const made = async <T>(run: () => Promise<T>): Promise<T> => {
    startWork(tr('Exporting…'));
    try {
      return await run();
    } finally {
      endWork();
    }
  };
  let bytes: Uint8Array;
  let warnings: string[] = [];
  if (format.id === 'obj') {
    // The colors live in a material library beside the file, named after it: so the place is chosen
    // first, and the files written for the name they were given there.
    const result = await made(async () => (await geometry.prepare(nodes, getState().doc.assets)).exportColored(nodes, true));
    // The two go side by side, the library named after the file.
    const bundle = { name, files: [] as { name: string; bytes: Uint8Array }[] };
    const where = await platform.saveBundle(`${name}.obj`, filters, format.mime, (base) => {
      const written = writeObj(result.objects, base);
      const files = [{ name: `${base}.obj`, bytes: written.obj, mime: format.mime }];
      if (written.mtl) files.push({ name: written.mtlName, bytes: written.mtl, mime: 'text/plain' });
      bundle.name = base;
      bundle.files = files;
      return files;
    });
    if (!where) return false;
    for (const w of result.warnings) notify(w, 'error');
    // Shared as one zip, so the two travel together.
    await reportSaved(bundle.files.map((f) => f.name), where.where, where.uris, '*/*', bundle);
    return true;
  }
  if (format.id === 'glb') {
    bytes = await made(() => exportGlb(nodes, getState().doc.assets, name));
  } else if (format.id === 'step') {
    // Objects stay apart, each a solid with its name and its color.
    const result = await made(async () => (await geometry.prepare(nodes, getState().doc.assets)).exportStep(nodes));
    bytes = result.bytes;
    warnings = result.warnings;
  } else if (format.id === '3mf' || format.id === 'ply') {
    // Objects stay apart, each in its colors, so a slicer can print them in their materials; a PLY file has them as one mesh, each face in its color.
    const result = await made(async () => (await geometry.prepare(nodes, getState().doc.assets)).exportColored(nodes, true));
    bytes = format.id === 'ply' ? writePly(result.objects) : write3mf(result.objects, name);
    warnings = result.warnings;
  } else {
    // Exports are always made at fine detail: curves get more facets than are drawn on screen.
    const result = await made(async () => (await geometry.prepare(nodes, getState().doc.assets)).export(nodes, format.kind === '2d', true));
    bytes = format.id === 'svg' || format.id === 'dxf' ? exportOutline(format.id, result.outline ?? [], name) : exportMesh(format.id, result.mesh, name);
    warnings = result.warnings;
  }
  const where = await platform.saveAs(`${name}.${format.extension}`, filters, bytes, format.mime);
  if (!where) return false;
  for (const w of warnings) notify(w, 'error');
  await reportSaved([where.name], where.path ? where.path.slice(0, where.path.length - where.name.length).replace(/[\\/]$/, '') || where.path : tr('your downloads'), where.uri ? [where.uri] : [], format.mime);
  return true;
}
