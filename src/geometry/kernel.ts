// Solid modeling backend: turns scene nodes into meshes with the Manifold
// kernel, which guarantees watertight (printable) output from boolean
// operations. Runs inside the geometry worker (and directly under vitest).
import Module from 'manifold-3d';
import type { CrossSection, Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { geomKey, textAssetKey } from '../model/geomKey';
import { apply, determinant, emptyBounds, expandBounds, isEmptyBounds, nodeMatrix, unionBounds } from '../model/math';
import type { Bounds, Mat } from '../model/math';
import type { Asset, GroupNode, ImportNode, MeshAsset, OutlineAsset, PartNode, PictureNode, Polygon, SceneNode } from '../model/types';
import type { BuildResult, ExportResult } from '../worker/protocol';
import { CREASE_ANGLE, creasedNormals } from './mesh';
import type { MeshData } from './mesh';
import { buildSolid } from '../parts/evaluate';
import { getGenerator } from '../parts/generators';
import { sanitizeParams } from '../parts/generators/types';
import { QUALITY } from '../parts/types';
import { buildShape } from './shapes';
import type { Keep } from './shapes';

let kernel: ManifoldToplevel | null = null;
let loading: Promise<ManifoldToplevel> | null = null;

/** Load the WASM kernel. `wasmUrl` is only needed in the browser, where the bundler relocates the file. */
export function initKernel(wasmUrl?: string): Promise<ManifoldToplevel> {
  loading ??= Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined).then((m) => {
    m.setup();
    kernel = m;
    return m;
  });
  return loading;
}


// ---------------------------------------------------------------------------
// Imported data

const assets = new Map<string, Asset>();

/** Adds imported data to the table that import nodes refer to. */
export function setAssets(incoming: Record<string, Asset>): void {
  let replaced = false;
  for (const [id, asset] of Object.entries(incoming)) {
    const old = assets.get(id);
    if (old && !sameAsset(old, asset)) replaced = true;
    assets.set(id, asset);
  }
  // Keys of import nodes (and of the groups around them) only name the asset, so
  // anything built from the old data would be stale.
  if (replaced) clearCache();
}

function sameAsset(a: Asset, b: Asset): boolean {
  if (a === b) return true;
  if (a.kind === 'mesh') return b.kind === 'mesh' && a.positions === b.positions && a.triangles === b.triangles;
  if (a.kind === 'image') return b.kind === 'image' && a.data === b.data;
  return b.kind === 'outline' && JSON.stringify(a.shapes) === JSON.stringify(b.shapes);
}

// Decoded in pieces: one binary string for a whole large mesh would double its memory use.
// A multiple of four characters, so every piece decodes on its own.
const BASE64_CHUNK = 4 * 16384;

/** Base64 to bytes, using `atob`, which browsers, workers and node all have (unlike `Buffer`). */
export function decodeBase64(text: string): Uint8Array {
  const s = /[^A-Za-z0-9+/]/.test(text) ? text.replace(/[\s=]+/g, '') : text;
  const bytes = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += BASE64_CHUNK) {
    const bin = atob(s.slice(i, i + BASE64_CHUNK));
    for (let j = 0; j < bin.length; j++) bytes[o++] = bin.charCodeAt(j);
  }
  return bytes;
}

// Design files store typed arrays little-endian, which is also the byte order
// of every platform this app runs on, so the bytes are reinterpreted in place.
// The buffer is freshly made, hence always aligned.
function decodeMesh(asset: MeshAsset): MeshData {
  const p = decodeBase64(asset.positions);
  const t = decodeBase64(asset.triangles);
  return {
    positions: new Float32Array(p.buffer, 0, Math.floor(p.length / 12) * 3),
    triangles: new Uint32Array(t.buffer, 0, Math.floor(t.length / 12) * 3),
  };
}

// ---------------------------------------------------------------------------
// Built geometry, cached by geometry key

type Deletable = { delete(): void };

/** The geometry of a node as built: at its built size, centered on the origin. */
type Built =
  | { solid: Manifold; triangles: number }
  /** An imported mesh that is not watertight. It can be shown and exported as it is, but not combined. */
  | { solid: null; open: MeshData; triangles: number };

// Least recently used first (a Map iterates in insertion order; using an entry re-inserts it).
const cache = new Map<string, Built>();
const MAX_ENTRIES = 400;
/**
 * Every edit to a group makes a new key, so a few groups around a large import
 * would otherwise hold hundreds of copies of it (some hundred bytes a triangle).
 */
const MAX_TRIANGLES = 2_000_000;
/**
 * Keys used by the current (or latest) operation. They are never evicted: their
 * solids may be in use, and a design too big for the cache would otherwise be
 * rebuilt from scratch on every request.
 */
const touched = new Set<string>();

function evict(): void {
  let triangles = 0;
  for (const built of cache.values()) triangles += built.triangles;
  for (const [key, built] of cache) {
    if (cache.size <= MAX_ENTRIES && triangles <= MAX_TRIANGLES) break;
    if (touched.has(key)) continue;
    cache.delete(key);
    triangles -= built.triangles;
    built.solid?.delete();
  }
}

/** Frees all cached geometry. The imported data is kept. */
export function clearCache(): void {
  for (const built of cache.values()) built.solid?.delete();
  cache.clear();
  touched.clear();
}

/** Number of nodes whose geometry is being kept for reuse. */
export const cacheSize = (): number => cache.size;

/**
 * Runs `fn` and then deletes every kernel object it handed to `keep`, except
 * the one it returned (if it returned one). WASM memory is not garbage
 * collected, so every temporary has to go through here.
 */
function scoped<T>(fn: (keep: Keep) => T): T {
  const garbage: Deletable[] = [];
  let result: T | undefined;
  try {
    result = fn((o) => {
      garbage.push(o);
      return o;
    });
    return result;
  } finally {
    for (const o of garbage) if (o !== result) o.delete();
  }
}

/** One request from the outside. The cache is only trimmed once it is over, so no solid is deleted while in use. */
function operation<T>(fn: (k: ManifoldToplevel) => T): T {
  if (!kernel) throw new Error('Geometry kernel is not initialized');
  touched.clear();
  try {
    return fn(kernel);
  } finally {
    evict();
  }
}

/** Manifold's JS binding takes a full 4x4 matrix (column-major); it silently misreads a 3x4 one. */
const mat4 = (m: Mat): Mat4 => [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, m[9], m[10], m[11], 1];

/** Forces evaluation (the kernel is lazy) and makes sure the result is usable. */
function checked(m: Manifold): Manifold {
  const status = m.status();
  if (status !== 'NoError') throw new Error(`Geometry kernel error: ${status}`);
  return m;
}

/**
 * Set for the length of an export at fine detail: curved shapes and parts are
 * then built with more facets than are shown, under keys of their own.
 */
let refining = false;

function builtOf(k: ManifoldToplevel, node: SceneNode, key = (refining ? 'fine:' : '') + geomKey(node)): Built {
  let entry = cache.get(key);
  if (entry) cache.delete(key);
  else entry = construct(k, node);
  cache.set(key, entry);
  touched.add(key);
  return entry;
}

function construct(k: ManifoldToplevel, node: SceneNode): Built {
  switch (node.type) {
    case 'shape':
      return solidEntry(scoped((keep) => checked(buildShape(k, node, keep, refining))));
    case 'group':
      return solidEntry(scoped((keep) => groupSolid(k, node, keep)));
    case 'import': {
      const asset = assets.get(node.asset);
      if (!asset || asset.kind === 'image') throw new Error(`The imported data of "${node.name}" is missing from this design.`);
      return asset.kind === 'mesh' ? meshEntry(k, node, asset) : solidEntry(outlineSolid(k, node, asset));
    }
    case 'part':
      return solidEntry(scoped((keep) => partSolid(k, node, keep)));
    case 'text': {
      // The outlines of lettering are sent along like imported drawings (see `textAssetKey`).
      const asset = assets.get(textAssetKey(node));
      if (asset?.kind !== 'outline') throw new Error(`"${node.name}" has no letters that can be drawn.`);
      return solidEntry(outlineSolid(k, node, asset));
    }
    case 'picture':
      return solidEntry(scoped((keep) => pictureSheet(k, node, keep)));
  }
}

/** How thick the sheet of a picture is, in units of its size: thin enough to sit against a surface, thick enough to pick. */
export const SHEET = 0.02;

/**
 * The sheet a picture is shown on, at unit size: a flat square facing +Z, or a
 * band around Z of radius 1/2 covering `angle` degrees, its middle facing the
 * front (-Y).
 */
function pictureSheet(k: ManifoldToplevel, node: PictureNode, keep: Keep): Manifold {
  if (node.mapping === 'flat') return checked(keep(k.Manifold.cube([1, 1, SHEET], true)));
  const span = (Math.min(360, Math.max(1, node.angle)) * Math.PI) / 180;
  const n = Math.max(2, Math.ceil((span / (2 * Math.PI)) * 96));
  const outer: [number, number][] = [];
  const inner: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 - span / 2 + (span * i) / n;
    outer.push([0.5 * Math.cos(a), 0.5 * Math.sin(a)]);
    inner.push([(0.5 - SHEET) * Math.cos(a), (0.5 - SHEET) * Math.sin(a)]);
  }
  const contours = span >= 2 * Math.PI - 1e-9 ? [outer.slice(0, n), inner.slice(0, n).reverse()] : [[...outer, ...inner.reverse()]];
  const section = keep(new k.CrossSection(contours, 'EvenOdd'));
  return checked(keep(keep(section.extrude(1, 0, 0, [1, 1])).translate([0, 0, -0.5])));
}

const solidEntry = (solid: Manifold): Built => ({ solid, triangles: solid.numTri() });

/** The node's built solid in its parent's coordinates. */
function placed(k: ManifoldToplevel, node: SceneNode, keep: Keep): Manifold {
  const { solid } = builtOf(k, node);
  if (!solid) {
    throw new Error(`"${node.name}" is not a watertight mesh, so it cannot be combined with other shapes.`);
  }
  // A mirrored (negative determinant) matrix is fine: the kernel turns the triangles back outwards.
  return keep(solid.transform(mat4(nodeMatrix(node))));
}

/** The solid nodes merged, minus the holes; null if there are no solid nodes. Hidden nodes take part too. */
function combine(k: ManifoldToplevel, nodes: SceneNode[], keep: Keep): Manifold | null {
  const solids: Manifold[] = [];
  const holes: Manifold[] = [];
  // Pictures lie on the surface; they are neither added nor cut.
  for (const node of nodes) if (node.type !== 'picture') (node.hole ? holes : solids).push(placed(k, node, keep));
  if (solids.length === 0) return null;
  const body = solids.length === 1 ? solids[0] : keep(k.Manifold.union(solids));
  return holes.length === 0 ? body : keep(k.Manifold.difference([body, ...holes]));
}

function groupSolid(k: ManifoldToplevel, node: GroupNode, keep: Keep): Manifold {
  const result = combine(k, node.children, keep);
  if (!result) throw new Error('This group has nothing left: it only contains holes.');
  if (checked(result).isEmpty()) throw new Error('This group has nothing left: its holes remove everything.');
  return result;
}

/** A parametric part as its generator makes it: standing on the plate, its axis or corner at the origin. */
function partAsBuilt(k: ManifoldToplevel, node: PartNode, keep: Keep): Manifold {
  // A design saved with an older set of parameters gets the defaults for whatever it lacks.
  const def = getGenerator(node.part);
  const built = def.build(sanitizeParams(def, node.params), refining ? QUALITY.fine : QUALITY.normal);
  const solid = checked(buildSolid(k, built.solid, keep));
  if (solid.isEmpty()) throw new Error(`"${node.name}" came out empty with these settings.`);
  return solid;
}

/** A parametric part, moved from standing on the plate to being centered on its box like every other node. */
function partSolid(k: ManifoldToplevel, node: PartNode, keep: Keep): Manifold {
  const solid = partAsBuilt(k, node, keep);
  const { min, max } = solid.boundingBox();
  return keep(solid.translate([-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -(min[2] + max[2]) / 2]));
}

/** A part's box in its generator's frame, which says where the generator's origin sits in the box. */
export function partBox(node: PartNode): Bounds | null {
  return operation((k) => scoped((keep) => toBounds(partAsBuilt(k, node, keep).boundingBox())));
}

function outlineSolid(k: ManifoldToplevel, node: SceneNode, asset: OutlineAsset): Manifold {
  return scoped((keep) => {
    const parts: CrossSection[] = [];
    for (const shape of asset.shapes) {
      // The binding takes a list that starts with a contour of fewer than three points for a single contour.
      const contours = shape.contours.filter((c) => c.length >= 3);
      if (contours.length > 0) parts.push(keep(new k.CrossSection(contours, shape.evenodd ? 'EvenOdd' : 'NonZero')));
    }
    const section = parts.length === 1 ? parts[0] : keep(k.CrossSection.union(parts));
    if (section.isEmpty()) throw new Error(`"${node.name}" has no filled areas to extrude.`);
    // 1 mm thick, centered like the artwork itself already is. Not with the binding's own `center`
    // option, which leaks the uncentered solid. (Polygons going into and out of a CrossSection leak
    // a little too, some bytes a point; that is tolerable once per asset, and nothing here repeats it.)
    return checked(keep(keep(section.extrude(1, 0, 0, [1, 1])).translate([0, 0, -0.5])));
  });
}

function meshEntry(k: ManifoldToplevel, node: ImportNode, asset: MeshAsset): Built {
  const data = decodeMesh(asset);
  const count = data.positions.length / 3;
  if (data.triangles.length === 0) throw new Error(`"${node.name}" contains no triangles.`);
  if (data.triangles.some((v) => v >= count)) throw new Error(`The mesh of "${node.name}" is damaged.`);
  const solid = meshSolid(k, data.positions, data.triangles);
  if (!solid) return { solid: null, open: data, triangles: data.triangles.length / 3 };
  if (solid.volume() >= 0) return solidEntry(solid);
  // Closed, but inside out (the file lists its triangles clockwise): turn every triangle over.
  solid.delete();
  const turned = data.triangles.slice();
  for (let i = 0; i < turned.length; i += 3) {
    turned[i + 1] = data.triangles[i + 2];
    turned[i + 2] = data.triangles[i + 1];
  }
  const fixed = meshSolid(k, data.positions, turned);
  return fixed ? solidEntry(fixed) : { solid: null, open: data, triangles: data.triangles.length / 3 };
}

/** A solid from an indexed triangle mesh, or null if the mesh is not watertight. */
function meshSolid(k: ManifoldToplevel, positions: Float32Array, triangles: Uint32Array): Manifold | null {
  let solid: Manifold | null = null;
  try {
    const mesh = new k.Mesh({ numProp: 3, vertProperties: positions, triVerts: triangles });
    // Files rarely share vertices between faces; this joins the ones that coincide. (It leaves our arrays alone.)
    mesh.merge();
    solid = new k.Manifold(mesh);
    if (solid.status() === 'NoError' && !solid.isEmpty()) return solid;
  } catch {
    // The kernel rejects meshes with open or over-shared edges by throwing.
  }
  solid?.delete();
  return null;
}

// ---------------------------------------------------------------------------
// Mesh helpers

const toBounds = (box: { min: ArrayLike<number>; max: ArrayLike<number> }): Bounds => ({
  min: [box.min[0], box.min[1], box.min[2]],
  max: [box.max[0], box.max[1], box.max[2]],
});

function boundsOfPositions(positions: Float32Array): Bounds {
  const b = emptyBounds();
  for (let i = 0; i < positions.length; i += 3) expandBounds(b, [positions[i], positions[i + 1], positions[i + 2]]);
  return b;
}

/** Indexed triangles of a solid, in arrays of their own (safe to transfer out of the worker). */
function meshOf(solid: Manifold): MeshData {
  const raw = solid.getMesh();
  const n = raw.numProp;
  const positions =
    n === 3
      ? raw.vertProperties.slice()
      : Float32Array.from({ length: (raw.vertProperties.length / n) * 3 }, (_, i) => {
          return raw.vertProperties[Math.floor(i / 3) * n + (i % 3)];
        });
  return { positions, triangles: raw.triVerts.slice() };
}

/** A copy of an open mesh, moved to where its node is. Mirroring turns the triangles over, so they are turned back. */
function transformed(mesh: MeshData, m: Mat): MeshData {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions.set(apply(m, [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]), i);
  }
  const triangles = mesh.triangles.slice();
  if (determinant(m) < 0) {
    for (let i = 0; i < triangles.length; i += 3) {
      triangles[i + 1] = mesh.triangles[i + 2];
      triangles[i + 2] = mesh.triangles[i + 1];
    }
  }
  return { positions, triangles };
}

function concatenate(parts: MeshData[]): MeshData {
  if (parts.length === 1) return parts[0];
  const positions = new Float32Array(parts.reduce((n, p) => n + p.positions.length, 0));
  const triangles = new Uint32Array(parts.reduce((n, p) => n + p.triangles.length, 0));
  let vertex = 0;
  let index = 0;
  for (const part of parts) {
    positions.set(part.positions, vertex * 3);
    for (let i = 0; i < part.triangles.length; i++) triangles[index++] = part.triangles[i] + vertex;
    vertex += part.positions.length / 3;
  }
  return { positions, triangles };
}

// ---------------------------------------------------------------------------
// Requests

/** Geometry of one node at its built size, centered on the origin (see `builtSize`); `key` is its `geomKey`. */
export function build(key: string, node: SceneNode): BuildResult {
  return operation((k) => {
    const entry = builtOf(k, node, key);
    if (!entry.solid) {
      const { positions, triangles } = entry.open;
      return {
        key,
        render: creasedNormals(positions, triangles, CREASE_ANGLE),
        bounds: boundsOfPositions(positions),
        triangles: entry.triangles,
        volume: 0,
        watertight: false,
      };
    }
    const mesh = meshOf(entry.solid);
    return {
      key,
      render: creasedNormals(mesh.positions, mesh.triangles, CREASE_ANGLE),
      bounds: toBounds(entry.solid.boundingBox()),
      triangles: entry.triangles,
      volume: entry.solid.volume(),
      watertight: true,
    };
  });
}

/**
 * Bounds of what the nodes would make as a group (solids merged, holes cut
 * away), in the nodes' own coordinates. Null if nothing would be left.
 */
export function measure(nodes: SceneNode[]): Bounds | null {
  return operation((k) =>
    scoped((keep) => {
      const visible = nodes.filter((n) => !n.hidden && n.type !== 'picture');
      if (!visible.some((n) => n.hole)) {
        // Nothing is cut away, so the boxes of the parts say it all; no need to merge them.
        const bounds = unionBounds(visible.map((n) => toBounds(placed(k, n, keep).boundingBox())));
        return isEmptyBounds(bounds) ? null : bounds;
      }
      const result = combine(k, visible, keep);
      if (!result || checked(result).isEmpty()) return null;
      return toBounds(result.boundingBox());
    }),
  );
}

/**
 * Everything that is neither a hole nor hidden, merged into one mesh. An
 * imported mesh that is not watertight cannot be merged; its triangles are
 * passed through unchanged, with a warning.
 */
export function exportNodes(nodes: SceneNode[], outline: boolean, fine = false, local = false): ExportResult {
  refining = fine;
  try {
    return exportAt(nodes, outline, local);
  } finally {
    refining = false;
  }
}

/** With `local`, the nodes' geometry is left in their own built frames (see `builtSize`) instead of being placed. */
function exportAt(nodes: SceneNode[], outline: boolean, local: boolean): ExportResult {
  return operation((k) =>
    scoped((keep): ExportResult => {
      const warnings: string[] = [];
      const solids: Manifold[] = [];
      const parts: MeshData[] = [];
      for (const node of nodes) {
        // A picture on its own is a sheet with nothing solid about it; the pictures on an object go out with the object's skin.
        if (node.hole || node.hidden || (node.type === 'picture' && !local)) continue;
        const entry = builtOf(k, node);
        if (entry.solid) {
          solids.push(local ? entry.solid : keep(entry.solid.transform(mat4(nodeMatrix(node)))));
          continue;
        }
        parts.push(local ? entry.open : transformed(entry.open, nodeMatrix(node)));
        warnings.push(
          outline
            ? `"${node.name}" is not watertight: it was exported as-is and is missing from the outline.`
            : `"${node.name}" is not watertight and was exported as-is.`,
        );
      }
      if (solids.length + parts.length === 0) throw new Error('There is nothing to export.');

      const boxes = parts.map((p) => boundsOfPositions(p.positions));
      let volume = 0;
      let contours: Polygon[] = [];
      if (solids.length > 0) {
        const merged = checked(solids.length === 1 ? solids[0] : keep(k.Manifold.union(solids)));
        parts.unshift(meshOf(merged));
        boxes.push(toBounds(merged.boundingBox()));
        volume = merged.volume();
        if (outline) {
          contours = keep(merged.project())
            .toPolygons()
            .map((contour) => contour.map((p): [number, number] => [p[0], p[1]]));
        }
      }
      const result: ExportResult = { mesh: concatenate(parts), bounds: unionBounds(boxes), volume, warnings };
      if (outline) result.outline = contours;
      return result;
    }),
  );
}
