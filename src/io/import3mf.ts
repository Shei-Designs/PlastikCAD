import { unzipSync } from 'fflate';
import { apply, determinant, IDENTITY, multiply, scaling } from '../model/math';
import type { Mat } from '../model/math';
import type { ImportedModel, ImportedPart } from './import';
import { MeshBuilder } from './weld';
import { XmlScanner } from './xml';

/** Millimeters per unit, for each value of the model's `unit` attribute. */
const UNITS: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

const DEFAULT_MODEL = '3D/3dmodel.model';
// Components may nest; this only stops a file whose objects contain each other.
const MAX_DEPTH = 16;
// A small file can still name a huge model: every component is a copy of all the
// objects below it. These stop one that would never fit in memory.
const MAX_COMPONENTS = 100_000;
const MAX_TRIANGLES = 20_000_000;
/** Unpacked size of the model parts, in bytes, past which the archive is not read. */
const MAX_UNPACKED = 512 * 1024 * 1024;
const TOO_BIG = 'This 3MF file is too large to open.';

// Attribute names of <vertex> and <triangle>, as XmlScanner.numbers() wants them.
const key = (s: string) => s.charCodeAt(0) | ((s.charCodeAt(1) || 0) << 8) | ((s.charCodeAt(2) || 0) << 16);
const XYZ = ['x', 'y', 'z'].map(key);
// A triangle's corners, then its own material: a property group and the index of its first corner's entry.
const V123 = ['v1', 'v2', 'v3', 'pid', 'p1'].map(key);

/** A use of an object: a build item, or a component of another object. */
interface Part {
  /** Model part that holds the object, when it is not the one that refers to it (production extension). */
  path: string | undefined;
  id: string;
  transform: Mat;
}

interface ModelObject {
  name: string | undefined;
  /** xyz per vertex, in the model's unit. */
  vertices: Float64Array;
  triangles: Uint32Array;
  /** The color of each triangle (hex), or undefined; a triangle without one of its own takes the object's. */
  colors: (string | undefined)[] | null;
  /** The object's own color, from its material. */
  color: string | undefined;
  components: Part[];
}

interface Model {
  unit: number;
  objects: Map<string, ModelObject>;
  items: Part[];
}

/**
 * 3MF: every build item of the package, in millimeters, each as a part of
 * its own, split further where its triangles carry different colors. Colors
 * come from the core base materials and the materials extension's color
 * groups; textures, slicer settings and everything else are ignored.
 */
export function parse3mf(bytes: Uint8Array, name = 'Model'): ImportedModel {
  if (bytes.length === 0) throw new Error('This 3MF file is empty.');
  // Lower-case part names: OPC part names are case-insensitive.
  const files = new Map<string, Uint8Array>();
  let unpacked = 0;
  try {
    const unzipped = unzipSync(bytes, {
      filter: (file) => {
        if (!/\.(model|rels)$/i.test(file.name)) return false;
        unpacked += file.originalSize;
        if (unpacked > MAX_UNPACKED) throw new Error(TOO_BIG);
        return true;
      },
    });
    for (const file in unzipped) files.set(partName(file), unzipped[file]);
  } catch (e) {
    if (e instanceof Error && e.message === TOO_BIG) throw e;
    throw new Error('This 3MF file is damaged, or is not a 3MF file.');
  }

  const models = new Map<string, Model | null>();
  const load = (path: string): Model | null => {
    let model = models.get(path);
    if (model === undefined) {
      const part = files.get(path);
      model = part ? parseModel(part) : null;
      models.set(path, model);
      // The XML is not needed again, and can be far larger than the mesh.
      files.delete(path);
    }
    return model;
  };

  const rootPath = rootModelPath(files);
  const root = rootPath === undefined ? null : load(rootPath);
  if (rootPath === undefined || !root) throw new Error('This 3MF file has no 3D model in it.');

  const items = root.items;
  if (items.length === 0) {
    // No build section: take every object that is not a component of another.
    const used = new Set<string>();
    for (const object of root.objects.values()) for (const c of object.components) if (!c.path) used.add(c.id);
    for (const id of root.objects.keys()) if (!used.has(id)) items.push({ path: undefined, id, transform: IDENTITY });
  }

  const parts: ImportedPart[] = [];
  let visits = 0;
  let emitted = 0;
  // One mesh per color within a build item (an item made of components is still one thing on the plate).
  let builders = new Map<string | undefined, MeshBuilder>();
  const builderFor = (color: string | undefined): MeshBuilder => {
    let b = builders.get(color);
    if (!b) {
      b = new MeshBuilder();
      builders.set(color, b);
    }
    return b;
  };
  /** `unit` is that of the model part `placement` is written in; an object kept in another part is in that part's unit. */
  const emit = (path: string, id: string, placement: Mat, unit: number, depth: number, inherited: string | undefined) => {
    const model = load(path);
    const object = model?.objects.get(id);
    if (!model || !object || depth > MAX_DEPTH) return;
    if (++visits > MAX_COMPONENTS) throw new Error('This 3MF file has too many components to open.');
    const rescale = model.unit / unit;
    const transform = rescale === 1 ? placement : multiply(placement, scaling([rescale, rescale, rescale]));
    const { vertices, triangles, colors } = object;
    const own = object.color ?? inherited;
    if (triangles.length) {
      emitted += triangles.length / 3;
      if (emitted > MAX_TRIANGLES) throw new Error('This 3MF file has too many triangles to open.');
      const m = transform;
      // Welded per color, so the index of a vertex is looked up afresh for each builder it goes into.
      const placed = new Float64Array(vertices.length);
      for (let v = 0; v < vertices.length; v += 3) {
        const w = apply(m, [vertices[v], vertices[v + 1], vertices[v + 2]]);
        placed[v] = w[0];
        placed[v + 1] = w[1];
        placed[v + 2] = w[2];
      }
      const count = vertices.length / 3;
      // A mirroring transform turns the triangles inside out; swap two corners to put them right.
      const mirrored = determinant(m) < 0;
      // The builder each triangle goes into, and the vertices each builder needs, welded in the file's order.
      const single = colors ? null : builderFor(own);
      const target: MeshBuilder[] = [];
      const needed = new Map<MeshBuilder, Uint8Array>();
      for (let t = 0; t < triangles.length; t += 3) {
        const b = single ?? builderFor(colors![t / 3] ?? own);
        target.push(b);
        let flags = needed.get(b);
        if (!flags) {
          flags = new Uint8Array(count);
          needed.set(b, flags);
        }
        for (let k = 0; k < 3; k++) if (triangles[t + k] < count) flags[triangles[t + k]] = 1;
      }
      const index = new Map<MeshBuilder, Int32Array>();
      for (const [b, flags] of needed) {
        const cache = new Int32Array(count).fill(-1);
        for (let v = 0; v < count; v++) if (flags[v]) cache[v] = b.vertex(placed[v * 3], placed[v * 3 + 1], placed[v * 3 + 2]);
        index.set(b, cache);
      }
      for (let t = 0; t < triangles.length; t += 3) {
        const a = triangles[t];
        const b = triangles[t + (mirrored ? 2 : 1)];
        const c = triangles[t + (mirrored ? 1 : 2)];
        if (!(a < count && b < count && c < count)) continue;
        const builder = target[t / 3];
        const cache = index.get(builder)!;
        builder.triangle(cache[a], cache[b], cache[c]);
      }
    }
    for (const c of object.components) emit(c.path ?? path, c.id, multiply(transform, c.transform), model.unit, depth + 1, own);
  };
  const toMm = scaling([root.unit, root.unit, root.unit]);
  for (const item of items) {
    builders = new Map();
    emit(item.path ?? rootPath, item.id, multiply(toMm, item.transform), root.unit, 0, undefined);
    const object = load(item.path ?? rootPath)?.objects.get(item.id);
    const itemName = object?.name || name;
    for (const [color, builder] of builders) {
      if (builder.size === 0) continue;
      parts.push({ name: itemName, mesh: builder.finish(), ...(color ? { color } : {}) });
    }
  }

  if (parts.length === 0) throw new Error('This 3MF file has no meshes.');
  return { kind: 'model', parts, used: [] };
}

const partName = (name: string) => name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

/** The package's relationships name the root model; most writers use the conventional path anyway. */
function rootModelPath(files: Map<string, Uint8Array>): string | undefined {
  const rels = files.get('_rels/.rels');
  if (rels) {
    const scan = new XmlScanner(rels);
    while (scan.next()) {
      if (scan.closing || !scan.is('Relationship')) continue;
      const attrs = scan.attrs();
      if (attrs.Type?.endsWith('/3dmodel') && attrs.Target && files.has(partName(attrs.Target))) {
        return partName(attrs.Target);
      }
    }
  }
  if (files.has(partName(DEFAULT_MODEL))) return partName(DEFAULT_MODEL);
  for (const name of files.keys()) if (name.endsWith('.model')) return name;
  return undefined;
}

/** `#RRGGBB` from a 3MF color (`#RRGGBB` or `#RRGGBBAA`), or undefined. */
function hexColor(s: string | undefined): string | undefined {
  const m = s && /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s.trim());
  return m ? `#${m[1].toLowerCase()}` : undefined;
}

function parseModel(xml: Uint8Array): Model {
  const model: Model = { unit: 1, objects: new Map(), items: [] };
  const scan = new XmlScanner(xml);
  // Vertices and triangles of the object being read; copied out at its end.
  let vertices = new Float64Array(3 * 4096);
  let vertexLength = 0;
  let triangles = new Uint32Array(3 * 4096);
  let triangleLength = 0;
  let colors: (string | undefined)[] | null = null;
  let id: string | undefined;
  let objectName: string | undefined;
  let objectColor: string | undefined;
  let components: Part[] = [];
  const values = new Float64Array(5);
  // Property groups that are colors (base materials and color groups), by resource id: their entries in order.
  const palettes = new Map<string, (string | undefined)[]>();
  let palette: (string | undefined)[] | null = null;
  const colorOf = (pid: string | undefined, pindex: string | undefined): string | undefined => {
    if (pid === undefined || pindex === undefined) return undefined;
    return palettes.get(pid)?.[Number(pindex)];
  };

  const endObject = () => {
    if (id === undefined) return;
    model.objects.set(id, {
      name: objectName,
      vertices: vertices.slice(0, vertexLength),
      triangles: triangles.slice(0, triangleLength),
      colors: colors?.some((c) => c !== undefined && c !== objectColor) ? colors : null,
      color: objectColor,
      components,
    });
    id = undefined;
  };

  // Names are matched without their prefix: a file may write the core elements under one (`<c:object>`).
  while (scan.next()) {
    if (scan.closing) {
      if (scan.localIs('object')) endObject();
    } else if (scan.localIs('vertex')) {
      if (id === undefined) continue;
      scan.numbers(XYZ, values);
      if (vertexLength + 3 > vertices.length) {
        const grown = new Float64Array(vertices.length * 2);
        grown.set(vertices);
        vertices = grown;
      }
      // A missing coordinate stays NaN, which drops the triangles that use the vertex.
      vertices[vertexLength++] = values[0];
      vertices[vertexLength++] = values[1];
      vertices[vertexLength++] = values[2];
    } else if (scan.localIs('triangle')) {
      if (id === undefined) continue;
      scan.numbers(V123, values);
      // Negated so that NaN fails too.
      if (!(values[0] >= 0 && values[1] >= 0 && values[2] >= 0)) continue;
      if (triangleLength + 3 > triangles.length) {
        const grown = new Uint32Array(triangles.length * 2);
        grown.set(triangles);
        triangles = grown;
      }
      // A triangle may name its own color: a group of its own, or the object's with an entry of its own.
      if (values[4] >= 0) {
        const group = values[3] >= 0 ? palettes.get(String(values[3])) : palette;
        const color = group?.[values[4]];
        if (color !== undefined || colors) {
          colors ??= [];
          colors[triangleLength / 3] = color;
        }
      }
      triangles[triangleLength++] = values[0];
      triangles[triangleLength++] = values[1];
      triangles[triangleLength++] = values[2];
    } else if (scan.localIs('object')) {
      endObject();
      const attrs = scan.attrs();
      id = attrs.id;
      objectName = attrs.name?.trim() || undefined;
      objectColor = colorOf(attrs.pid, attrs.pindex);
      palette = attrs.pid !== undefined ? (palettes.get(attrs.pid) ?? null) : null;
      colors = null;
      components = [];
      vertexLength = 0;
      triangleLength = 0;
      if (scan.selfClosing) endObject();
    } else if (scan.localIs('basematerials') || scan.localIs('colorgroup')) {
      const list: (string | undefined)[] = [];
      const gid = scan.attrs().id;
      if (gid !== undefined) palettes.set(gid, list);
      // Its entries follow until it closes; they are read into the newest list.
      palette = list;
    } else if (scan.localIs('base') || scan.localIs('color')) {
      if (id === undefined && palette) {
        const attrs = scan.attrs();
        palette.push(hexColor(attrs.displaycolor ?? attrs.color));
      }
    } else if (scan.localIs('component')) {
      if (id !== undefined) pushPart(components, scan.attrs());
    } else if (scan.localIs('item')) {
      pushPart(model.items, scan.attrs());
    } else if (scan.localIs('model')) {
      // Looked up as an own key only: "toString" is not a unit.
      const unit = scan.attrs().unit ?? 'millimeter';
      model.unit = Object.prototype.hasOwnProperty.call(UNITS, unit) ? UNITS[unit] : 1;
    }
  }
  endObject();
  return model;
}

function pushPart(parts: Part[], attrs: Record<string, string>): void {
  if (attrs.objectid === undefined) return;
  // The production extension's path attribute, under whatever prefix the file gives its namespace.
  const pathKey = Object.keys(attrs).find((key) => key.endsWith(':path'));
  parts.push({
    path: pathKey ? partName(attrs[pathKey]) : undefined,
    id: attrs.objectid,
    transform: parseTransform(attrs.transform),
  });
}

/**
 * 3MF writes a transform as the rows of a 4x3 matrix that multiplies row
 * vectors: the images of the X, Y and Z axes, then the translation. `Mat` has
 * the same order.
 */
function parseTransform(s: string | undefined): Mat {
  if (!s) return IDENTITY;
  const m = s.trim().split(/\s+/).map(Number);
  return m.length === 12 && m.every(Number.isFinite) ? (m as Mat) : IDENTITY;
}
