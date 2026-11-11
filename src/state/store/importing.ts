// Files brought into the design: models, drawings and pictures as objects on
// the plate, and a URDF as a robot.
import { isDesignName } from '../../appInfo';
import { plural, tr } from '../../i18n';
import { fileKind, IMAGE_EXTENSIONS, IMPORT_EXTENSIONS } from '../../io/import';
import { meshPath, parseUrdf, urdfMeshFiles } from '../../io/importUrdf';
import { bytesToBase64 } from '../../io/base64';
import { isUntitled } from '../../model/file';
import { hashString } from '../../model/geomKey';
import { tidyVec } from '../../model/math';
import { newId, uniqueName } from '../../model/ops';
import type { Asset, ImageAsset, ImportNode, PictureNode, SceneNode, Vec3 } from '../../model/types';
import * as platform from '../../platform';
import type { PickedFile } from '../../platform';
import { robotOf } from '../../robot/model';
import type { Robot } from '../../robot/types';
import { tell } from '../../ui/ask';
import { Cancelled } from '../../worker/client';
import type { ImportResult } from '../../worker/importing';
import { geometry } from '../geometry';
import { abortAlignPreview, commit, endWork, fail, getState, notify, record, replaceState, set, startWork } from './core';
import { stopAligning } from './tools';
import { buildGroup } from './groups';
import { baseName, extension, folderOf, importProjectFile } from './project';
import { enterRobotMode } from './robot';

/** The default color of an imported object that brought none. */
const IMPORT_COLOR = '#8fa3bf';

/** What a file comes to once it has been read: never the question about its unit, which `readModel` settles. */
type Read = Exclude<ImportResult, { kind: 'units' }>;

/** A size for a sentence: three figures at most, written the one way every language here writes numbers. */
const figure = (v: number): string => String(Number(v.toPrecision(3)));

/**
 * Asks which unit a file was made in that names none and comes out tiny as
 * millimeters. Resolves with the unit in millimeters; backing out keeps millimeters.
 */
async function askUnit(name: string, extent: Vec3): Promise<number> {
  const meters = tr('Meters');
  const inches = tr('Inches');
  const centimeters = tr('Centimeters');
  const chosen = await tell({
    title: tr('Import'),
    text: tr('"{name}" does not say which unit it was made in. As millimeters it is {size} mm. Which unit is it in?', { name, size: extent.map(figure).join(' × ') }),
    actions: [meters, inches, centimeters, tr('Millimeters')],
  });
  return chosen === meters ? 1000 : chosen === inches ? 25.4 : chosen === centimeters ? 10 : 1;
}

/**
 * Reads a model or drawing in the geometry worker, with the files it names
 * (an OBJ's material library, its pictures). Those not picked with it are
 * read from beside it on disk; on Android or in the browser, where the picker
 * grants one file at a time, the user is asked to pick them. Two rounds at
 * most: the library, then what it names. Resolves with what was read and the
 * companions as they stand, for the files that follow.
 */
async function readModel(file: PickedFile, companions: PickedFile[]): Promise<{ data: Read; companions: PickedFile[] }> {
  // Only an OBJ or a .gltf is read a second time, with the files it turned out to name; anything else hands its bytes over.
  const kind = fileKind(file.name, file.bytes);
  const obj = kind === 'obj' || kind === 'gltf';
  let scale: number | undefined;
  const read = async (found: PickedFile[]): Promise<Read> => {
    const worker = geometry.worker();
    const result = await worker.import(file, found, { scale, handOver: !obj });
    if (result.kind !== 'units') return result;
    scale = await askUnit(file.name, result.extent);
    return (await worker.importHeld(result.held, scale)) as Read;
  };
  let found = companions;
  let data = await read(found);
  for (let round = 0; obj && round < 2; round++) {
    const missing = data.kind === 'model' ? data.missing : [];
    if (missing.length === 0) break;
    // A .gltf with its buffers elsewhere has no shapes until they come: there is no importing it without.
    const more = await findCompanions(file, missing, data.kind === 'model' && data.parts.length === 0);
    if (more.length === 0) break;
    found = [...found, ...more];
    data = await read(found);
  }
  return { data, companions: found };
}

/**
 * The files a model names that did not come with it: from beside it on disk, or picked by the user;
 * none if they are not to be had. `needed` when the model has no shapes without them.
 */
async function findCompanions(file: PickedFile, missing: string[], needed: boolean): Promise<PickedFile[]> {
  const more: PickedFile[] = [];
  // Beside the file on disk, where the file's place is known (a path; on Android, a document of the
  // app's own, such as its exports, which the app may read by path).
  const real = file.path ? await platform.realPath(file.path) : null;
  if (real) {
    const dir = real.slice(0, Math.max(real.lastIndexOf('/'), real.lastIndexOf('\\')) + 1);
    for (const name of missing) {
      // A library the file names, or failing that one named after the file, as the exporters write them.
      const candidates = extension(name) === 'mtl' ? [name, `${baseName(file.name)}.mtl`] : [name];
      for (const candidate of new Set(candidates)) {
        const read = await platform.readPath(dir + candidate).catch(() => null);
        if (read) {
          // Under the name the file asked for, so the import finds it.
          more.push(candidate === name ? read : { ...read, name });
          break;
        }
      }
    }
  }
  if (more.length === 0 && (!file.path || file.path.includes('://'))) {
    const named = { file: file.name, list: missing.map((n) => tr('"{name}"', { name: n })).join(', ') };
    const question = needed
      ? plural(missing.length, '"{file}" keeps its shapes and pictures in {list}. Pick it now?', '"{file}" keeps its shapes and pictures in {list}. Pick them now?', named)
      : missing.some((n) => extension(n) !== 'mtl')
      ? plural(
          missing.length,
          '"{file}" names {list} for its colors and pictures. Pick it now, or import the shapes without?',
          '"{file}" names {list} for its colors and pictures. Pick them now, or import the shapes without?',
          named,
        )
      : plural(missing.length, '"{file}" names {list} for its colors. Pick it now, or import the shapes without?', '"{file}" names {list} for its colors. Pick them now, or import the shapes without?', named);
    const ok = await platform.confirm(question, {
      title: tr('Import'),
      okLabel: tr('Pick'),
      cancelLabel: needed ? tr('Cancel') : tr('Without'),
    });
    if (!ok) return [];
    const picked = await platform.pickFiles({
      filters: [needed ? { name: tr('Model data and pictures'), extensions: ['bin', ...IMAGE_EXTENSIONS] } : { name: tr('Material libraries and pictures'), extensions: ['mtl', ...IMAGE_EXTENSIONS] }],
      multiple: true,
    });
    more.push(...picked);
  }
  return more;
}

/**
 * Turn imported files into objects standing on the plate, side by side. A
 * file of several parts (the objects of a 3MF, the materials of an OBJ or
 * GLB) becomes one group, its parts where the file put them, each in its own
 * color. The files are read in the geometry worker, one after the other.
 * Returns the names of the companion files the models used up.
 */
async function importModels(files: PickedFile[], companions: PickedFile[]): Promise<Set<string>> {
  const used = new Set<string>();
  const assets = { ...getState().doc.assets };
  const placed: SceneNode[] = [];
  let scene = getState().doc.scene;
  let x = 0;
  const put = (node: SceneNode) => {
    node.pos = tidyVec([x + node.size[0] / 2, 0, node.size[2] / 2]);
    x += node.size[0] + 5;
    placed.push(node);
    scene = [...scene, node];
  };
  // One file that cannot be read does not take the others with it; it is named in what is said afterwards,
  // as is whatever a file holds that was left out.
  const failed: string[] = [];
  const named = (file: PickedFile, message: string): string => (message.includes(file.name) ? message : tr('{name}: {message}', { name: file.name, message }));
  for (const [i, file] of files.entries()) {
    if (files.length > 1) startWork(tr('Importing {n} of {total}…', { n: i + 1, total: files.length }));
    try {
      await bring(file);
    } catch (e) {
      // Called off: nothing of this import is kept.
      if (e instanceof Cancelled) throw e;
      failed.push(named(file, e instanceof Error ? e.message : String(e)));
    }
  }
  if (placed.length === 0 && failed.length) throw new Error(failed.join(' '));
  // Center the row on the plate.
  const shift = (x - 5) / 2;
  for (const n of placed) n.pos = tidyVec([n.pos[0] - shift, n.pos[1], n.pos[2]]);
  replaceState({ ...getState(), doc: { ...getState().doc, assets }, placing: null });
  commit(scene, { selection: placed.map((n) => n.id) });
  if (failed.length) notify(failed.join(' '), 'error');
  return used;

  async function bring(file: PickedFile): Promise<void> {
    const name = uniqueName(scene, baseName(file.name));
    const read = await readModel(file, companions);
    companions = read.companions;
    const { data } = read;
    const members: ImportNode[] = [];
    if (data.kind === 'model') {
      for (const n of data.used) used.add(n);
      for (const part of data.parts) {
        const node = importNode(assets, part.key, part.asset, part.name, tidyVec(part.size), tidyVec(part.size), part.color);
        if (!node) continue;
        node.pos = tidyVec(part.center);
        if (part.image) {
          const key = await addImage({ name: part.image.name, path: null, bytes: part.image.bytes }, part.image.mime);
          assets[key] = getState().doc.assets[key];
          node.texture = { asset: key, mode: part.asset.uv ? 'own' : 'wrap', scale: 50, turn: 0 };
          // A textured part with no color of its own shows its picture's fill, which is what its corner holds.
          if (!part.color) node.color = (await cornerColor(part.image.bytes, part.image.mime)) ?? node.color;
        }
        members.push(node);
      }
    } else {
      for (const part of data.parts) {
        // Flat artwork comes in as a plate a few millimeters thick.
        const node = importNode(assets, part.key, part.asset, name, tidyVec([part.size[0], part.size[1], 1]), tidyVec([part.size[0], part.size[1], 3]), part.color);
        if (!node) continue;
        node.pos = tidyVec([part.center[0], part.center[1], 1.5]);
        members.push(node);
      }
    }
    if (data.kind === 'model' && data.parts.length === 0 && data.missing.length) {
      const list = data.missing.map((n) => tr('"{name}"', { name: n })).join(', ');
      throw new Error(plural(data.missing.length, '"{file}" keeps its shapes in {list}, which did not come along. Pick it together with the file.', '"{file}" keeps its shapes in {list}, which did not come along. Pick them together with the file.', { file: file.name, list }));
    }
    if (members.length === 0) throw new Error(tr('"{name}" is flat or empty, so it cannot be made into a solid.', { name: file.name }));
    for (const warning of data.warnings) failed.push(named(file, warning));
    if (members.length === 1) {
      members[0].name = name;
      put(members[0]);
      return;
    }
    // The assets must be in the design before the kernel can measure the parts.
    replaceState({ ...getState(), doc: { ...getState().doc, assets } });
    const group = await buildGroup(members, false, name).catch((e: unknown) => {
      if (e instanceof Cancelled) throw e;
      return null;
    });
    // Parts that cannot be combined (an open mesh among them) stand on their own.
    if (group) put(group);
    else for (const node of members) put(node);
  }
}

/** An imported object over an asset, which is kept in `assets` under `key` (made from its contents, so the same thing twice is kept once); null if it has no extent. */
function importNode(assets: Record<string, Asset>, key: string, asset: Asset, name: string, natural: Vec3, size: Vec3, color: string | undefined): ImportNode | null {
  // Checked as stored: a hair of an extent rounds away to nothing.
  if (!natural.every((v) => v > 0)) return null;
  assets[key] = asset;
  return {
    id: newId(),
    type: 'import',
    name,
    asset: key,
    natural,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    size,
    hole: false,
    color: color ?? IMPORT_COLOR,
  };
}

/** The color of an image's top-left pixel, as hex; null if it cannot be read or is transparent there. */
async function cornerColor(bytes: Uint8Array, mime: ImageAsset['mime']): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.drawImage(bitmap, 0, 0, 1, 1, 0, 0, 1, 1);
    bitmap.close();
    const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data;
    if (a < 128) return null;
    return `#${[r, gr, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

/** Pixel size of an image file, by decoding it. */
async function imageSize(bytes: Uint8Array, mime: ImageAsset['mime']): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/** Keep a picture file in the design. Returns its key (an identical picture already there is reused). */
async function addImage(file: PickedFile, mime: ImageAsset['mime'] = fileKind(file.name, file.bytes) === 'png' ? 'image/png' : 'image/jpeg'): Promise<string> {
  const data = bytesToBase64(file.bytes);
  const key = `image-${hashString(data)}-${data.length.toString(36)}`;
  if (getState().doc.assets[key]) return key;
  const { width, height } = await imageSize(file.bytes, mime);
  const asset: ImageAsset = { kind: 'image', name: file.name, mime, data, width, height };
  replaceState({ ...getState(), doc: { ...getState().doc, assets: { ...getState().doc.assets, [key]: asset } } });
  return key;
}

/** A flat picture sheet showing the image, 60 mm across its longer side, not yet placed. */
function makePicture(key: string): PictureNode {
  const image = getState().doc.assets[key] as ImageAsset;
  const s = 60 / Math.max(image.width, image.height);
  return {
    id: newId(),
    type: 'picture',
    name: baseName(image.name),
    asset: key,
    mapping: 'flat',
    angle: 120,
    natural: [1, 1, 1],
    pos: [0, 0, -1e6],
    rot: [0, 0, 0],
    size: tidyVec([image.width * s, image.height * s, 1]),
    hole: false,
    color: '#ffffff',
  };
}

/** Start carrying a new picture, to be put down like a shape: the picture file is asked for first. */
export async function startPlacingPicture(): Promise<void> {
  const key = await pickImage();
  if (!key) return;
  abortAlignPreview();
  set({ placing: makePicture(key), selection: [], bin: false });
}

/** Add a picture at the middle of the plate straight away (keyboard route, double-click). */
export async function addPicture(): Promise<void> {
  const key = await pickImage();
  if (!key) return;
  const node = makePicture(key);
  node.pos = [0, 0, node.size[2] / 2];
  node.name = uniqueName(getState().doc.scene, node.name);
  replaceState({ ...getState(), placing: null, bin: false });
  commit([...getState().doc.scene, node], { selection: [node.id] });
}

/** Turn picture files into picture sheets lying on the plate, side by side, 60 mm across. */
async function importPictures(files: PickedFile[]): Promise<void> {
  const nodes: PictureNode[] = [];
  let scene = getState().doc.scene;
  let x = 0;
  for (const file of files) {
    const node = makePicture(await addImage(file));
    node.name = uniqueName(scene, node.name);
    node.pos = tidyVec([x + node.size[0] / 2, 0, node.size[2] / 2]);
    x += node.size[0] + 5;
    nodes.push(node);
    scene = [...scene, node];
  }
  const shift = (x - 5) / 2;
  for (const n of nodes) n.pos = tidyVec([n.pos[0] - shift, n.pos[1], n.pos[2]]);
  replaceState({ ...getState(), placing: null, bin: false });
  commit(scene, { selection: nodes.map((n) => n.id) });
}

/** Pick a picture file for a texture and keep it in the design. Returns its key, or null if canceled. */
export async function pickImage(): Promise<string | null> {
  try {
    const files = await platform.pickFiles({ filters: [{ name: tr('Pictures'), extensions: IMAGE_EXTENSIONS }] });
    if (!files.length) return null;
    const key = await addImage(files[0]);
    set({});
    return key;
  } catch (e) {
    fail(e);
    return null;
  }
}

const IMPORTABLE = [...IMPORT_EXTENSIONS, ...IMAGE_EXTENSIONS];

/** Files picked or dropped: designs are opened, a URDF brings its robot in, models, drawings and pictures are imported into the current design. */
export async function receiveFiles(files: PickedFile[]): Promise<void> {
  try {
    const design = files.find((f) => isDesignName(f.name));
    if (design) return await importProjectFile(design);
    const urdf = files.find((f) => extension(f.name) === 'urdf');
    if (urdf) return await importRobot(urdf, files.filter((f) => f !== urdf));
    const models = files.filter((f) => IMPORT_EXTENSIONS.includes(fileKind(f.name, f.bytes)));
    const pictures = files.filter((f) => IMAGE_EXTENSIONS.includes(fileKind(f.name, f.bytes)));
    if (models.length === 0 && pictures.length === 0) {
      if (files.some((f) => extension(f.name) === 'mtl')) notify(tr('A .mtl file holds the colors of an OBJ and is read with it: pick the .obj, together with the .mtl for its colors.'), 'error');
      else if (files.length) notify(tr('Cannot import that. Supported: {formats}.', { formats: IMPORTABLE.map((e) => e.toUpperCase()).join(', ') }), 'error');
      return;
    }
    startWork(tr('Importing…'));
    // A model is read with the files beside it (a material library, its pictures), never with the other models.
    const used = models.length ? await importModels(models, files.filter((f) => !models.includes(f))) : new Set<string>();
    // A picture a model used for its texture is not also a picture sheet.
    const sheets = pictures.filter((f) => !used.has(f.name));
    if (sheets.length) await importPictures(sheets);
  } catch (e) {
    fail(e);
  } finally {
    endWork();
  }
}

const URDF_FILTER = [{ name: tr('URDF robot'), extensions: ['urdf'] }];

/** "Import URDF…" in Robot mode: brings a robot's links, joints, sensors and meshes into the design. */
export async function importRobotFile(): Promise<void> {
  try {
    const [file] = await platform.pickFiles({ filters: URDF_FILTER });
    if (file) await importRobot(file, []);
  } catch (e) {
    fail(e);
  }
}

/**
 * The mesh files a URDF names, found beside it on disk by their path in the
 * package, looked for from the URDF's folder upwards (a package keeps its URDF
 * in urdf/ and its meshes in meshes/). An OBJ brings the material library it
 * names along for its colors.
 */
async function urdfCompanions(file: PickedFile, companions: PickedFile[]): Promise<PickedFile[]> {
  const found = [...companions];
  const real = file.path ? await platform.realPath(file.path) : null;
  if (!real) return found;
  const dir = folderOf(real);
  for (const ref of urdfMeshFiles(file.bytes)) {
    const inside = meshPath(ref);
    if (found.some((c) => c.name === inside)) continue;
    const base = inside.split('/').pop()!;
    for (const candidate of new Set([`${dir}/${inside}`, `${dir}/../${inside}`, `${dir}/../../${inside}`, `${dir}/${base}`])) {
      const read = await platform.readPath(candidate).catch(() => null);
      if (!read) continue;
      found.push({ ...read, name: inside });
      if (extension(base) === 'obj') {
        const named = /^\s*mtllib\s+(.+?)\s*$/m.exec(new TextDecoder().decode(read.bytes.subarray(0, 65536)))?.[1];
        // Beside the mesh or below it, never above it or anywhere else on the disk.
        const library = named && !/^([\\/]|[a-z]:)/i.test(named) && !named.split(/[\\/]/).includes('..') ? named : undefined;
        const mtl = library && (await platform.readPath(`${folderOf(candidate)}/${library}`).catch(() => null));
        if (mtl) found.push({ ...mtl, name: library });
      }
      break;
    }
  }
  return found;
}

/**
 * Brings a URDF's robot into the design: its links as objects where the file
 * puts them, its joints, sensors and drive over them. The design's own robot
 * keeps its base; the newcomer's hangs loose until it is attached. The design
 * takes the robot's name when it was empty and unnamed.
 */
async function importRobot(file: PickedFile, companions: PickedFile[]): Promise<void> {
  set({ busy: tr('Importing…') });
  await new Promise((r) => setTimeout(r, 30));
  try {
    let found = await urdfCompanions(file, companions);
    let imported = parseUrdf(file.bytes, found);
    if (imported.missing.length) {
      const names = imported.missing.map((m) => tr('"{name}"', { name: String(meshPath(m).split('/').pop()) }));
      const list = names.length === 1 ? names[0] : tr('{names} and {last}', { names: names.slice(0, -1).join(', '), last: names[names.length - 1] });
      const ok = await platform.confirm(
        plural(
          names.length,
          '"{file}" draws its links with {list}, which did not come along. Pick it now, or import without?',
          '"{file}" draws its links with {list}, which did not come along. Pick them now, or import without?',
          { file: file.name, list },
        ),
        { title: tr('Import'), okLabel: tr('Pick'), cancelLabel: tr('Without') },
      );
      if (ok) {
        const picked = await platform.pickFiles({ filters: [{ name: tr('Meshes'), extensions: [...IMPORT_EXTENSIONS, 'mtl'] }], multiple: true });
        if (picked.length) {
          found = [...found, ...picked];
          imported = parseUrdf(file.bytes, found);
        }
      }
    }
    if (getState().aligning) stopAligning();
    const robot = robotOf(getState().doc);
    const merged: Robot = {
      ...robot,
      root: robot.root ?? imported.robot.root,
      base: robot.root ? robot.base : imported.robot.base,
      links: [...robot.links, ...imported.robot.links],
      joints: [...robot.joints, ...imported.robot.joints],
      sensors: [...robot.sensors, ...imported.robot.sensors],
      control: robot.root ? robot.control : imported.robot.control,
    };
    const drive = robot.drive ?? imported.robot.drive;
    if (drive) merged.drive = drive;
    const name = getState().doc.scene.length === 0 && isUntitled(getState().doc.name) ? imported.name : getState().doc.name;
    record();
    set({ doc: { ...getState().doc, name, scene: [...getState().doc.scene, ...imported.scene], assets: { ...getState().doc.assets, ...imported.assets }, robot: merged }, selection: [], joint: null, sensor: null, jointPick: null, pose: null, placing: null });
    if (!getState().robot) enterRobotMode();
    const links = imported.scene.length;
    // Two counts in one sentence: each is worded with its noun, and the sentence takes the two.
    const summary = tr('Imported {links} and {joints} from {file}.', {
      links: plural(links, '{n} link', '{n} links'),
      joints: plural(imported.robot.joints.length, '{n} joint', '{n} joints'),
      file: file.name,
    });
    if (imported.warnings.length) notify(`${summary} ${imported.warnings.join(' ')}`, 'error');
    else notify(summary, 'ok');
  } finally {
    set({ busy: null });
  }
}

export async function importModel(): Promise<void> {
  try {
    const files = await platform.pickFiles({
      filters: [{ name: tr('Models, drawings and pictures'), extensions: IMPORTABLE }],
      multiple: true,
    });
    if (files.length) await receiveFiles(files);
  } catch (e) {
    fail(e);
  }
}
