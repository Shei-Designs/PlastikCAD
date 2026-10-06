import { unzipSync } from 'fflate';
import type { MeshData } from '../geometry/mesh';
import { determinant, IDENTITY, multiply, scaling } from '../model/math';
import type { Mat } from '../model/math';
import { MeshBuilder } from './weld';
import { XmlScanner } from './xml';

/** Millimetres per unit, for each value of the model's `unit` attribute. */
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

// Attribute names of <vertex> and <triangle>, as XmlScanner.numbers() wants them.
const XYZ = ['x', 'y', 'z'].map((s) => s.charCodeAt(0));
const V123 = ['v1', 'v2', 'v3'].map((s) => s.charCodeAt(0) | (s.charCodeAt(1) << 8));

/** A use of an object: a build item, or a component of another object. */
interface Part {
  /** Model part that holds the object, when it is not the one that refers to it (production extension). */
  path: string | undefined;
  id: string;
  transform: Mat;
}

interface ModelObject {
  /** xyz per vertex, in the model's unit. */
  vertices: Float64Array;
  triangles: Uint32Array;
  components: Part[];
}

interface Model {
  unit: number;
  objects: Map<string, ModelObject>;
  items: Part[];
}

/**
 * 3MF: every build item of the package, merged into one mesh in millimetres.
 * Colours, materials, slicer settings and everything else are ignored.
 */
export function parse3mf(bytes: Uint8Array): MeshData {
  if (bytes.length === 0) throw new Error('This 3MF file is empty.');
  // Lower-case part names: OPC part names are case-insensitive.
  const files = new Map<string, Uint8Array>();
  try {
    const unzipped = unzipSync(bytes, { filter: (file) => /\.(model|rels)$/i.test(file.name) });
    for (const name in unzipped) files.set(partName(name), unzipped[name]);
  } catch {
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

  const builder = new MeshBuilder();
  const emit = (path: string, id: string, transform: Mat, depth: number) => {
    const object = load(path)?.objects.get(id);
    if (!object || depth > MAX_DEPTH) return;
    const { vertices, triangles } = object;
    if (triangles.length) {
      const m = transform;
      const index = new Int32Array(vertices.length / 3);
      for (let v = 0; v < index.length; v++) {
        const x = vertices[v * 3];
        const y = vertices[v * 3 + 1];
        const z = vertices[v * 3 + 2];
        index[v] = builder.vertex(
          m[0] * x + m[3] * y + m[6] * z + m[9],
          m[1] * x + m[4] * y + m[7] * z + m[10],
          m[2] * x + m[5] * y + m[8] * z + m[11],
        );
      }
      // A mirroring transform turns the triangles inside out; swap two corners to put them right.
      const mirrored = determinant(m) < 0;
      for (let t = 0; t < triangles.length; t += 3) {
        const a = triangles[t];
        const b = triangles[t + (mirrored ? 2 : 1)];
        const c = triangles[t + (mirrored ? 1 : 2)];
        if (a < index.length && b < index.length && c < index.length) builder.triangle(index[a], index[b], index[c]);
      }
    }
    for (const c of object.components) emit(c.path ?? path, c.id, multiply(transform, c.transform), depth + 1);
  };
  const toMm = scaling([root.unit, root.unit, root.unit]);
  for (const item of items) emit(item.path ?? rootPath, item.id, multiply(toMm, item.transform), 0);

  if (builder.size === 0) throw new Error('This 3MF file has no meshes.');
  return builder.finish();
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

function parseModel(xml: Uint8Array): Model {
  const model: Model = { unit: 1, objects: new Map(), items: [] };
  const scan = new XmlScanner(xml);
  // Vertices and triangles of the object being read; copied out at its end.
  let vertices = new Float64Array(3 * 4096);
  let vertexLength = 0;
  let triangles = new Uint32Array(3 * 4096);
  let triangleLength = 0;
  let id: string | undefined;
  let components: Part[] = [];
  const values = new Float64Array(3);

  const endObject = () => {
    if (id === undefined) return;
    model.objects.set(id, {
      vertices: vertices.slice(0, vertexLength),
      triangles: triangles.slice(0, triangleLength),
      components,
    });
    id = undefined;
  };

  while (scan.next()) {
    if (scan.closing) {
      if (scan.is('object')) endObject();
    } else if (scan.is('vertex')) {
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
    } else if (scan.is('triangle')) {
      if (id === undefined) continue;
      scan.numbers(V123, values);
      // Negated so that NaN fails too.
      if (!(values[0] >= 0 && values[1] >= 0 && values[2] >= 0)) continue;
      if (triangleLength + 3 > triangles.length) {
        const grown = new Uint32Array(triangles.length * 2);
        grown.set(triangles);
        triangles = grown;
      }
      triangles[triangleLength++] = values[0];
      triangles[triangleLength++] = values[1];
      triangles[triangleLength++] = values[2];
    } else if (scan.is('object')) {
      endObject();
      id = scan.attrs().id;
      components = [];
      vertexLength = 0;
      triangleLength = 0;
      if (scan.selfClosing) endObject();
    } else if (scan.is('component')) {
      if (id !== undefined) pushPart(components, scan.attrs());
    } else if (scan.is('item')) {
      pushPart(model.items, scan.attrs());
    } else if (scan.is('model')) {
      model.unit = UNITS[scan.attrs().unit ?? 'millimeter'] ?? 1;
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
