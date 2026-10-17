// Solid modeling backend: turns scene nodes into meshes with the Manifold
// kernel, which guarantees watertight (printable) output from boolean
// operations. Runs inside the geometry worker (and directly under vitest).
import Module from 'manifold-3d';
import type { CrossSection, Manifold, ManifoldToplevel, Mat4, Mesh } from 'manifold-3d';
import { geomKey, textAssetKey } from '../model/geomKey';
import { paintOf } from '../model/ops';
import { apply, determinant, emptyBounds, expandBounds, isEmptyBounds, nodeMatrix, unionBounds } from '../model/math';
import type { Bounds, Mat } from '../model/math';
import type { Asset, GroupNode, ImportNode, MeshAsset, OutlineAsset, PartNode, PictureNode, Polygon, SceneNode } from '../model/types';
import type { BuildResult, ColoredExport, ColoredObject, ColoredPart, ExportResult } from '../worker/protocol';
import { CREASE_ANGLE, creasedNormals, NO_SOURCE } from './mesh';
import type { Faces, MeshData, MeshWithUV } from './mesh';
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
  loading ??= Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined)
    .then((m) => {
      m.setup();
      patchBinding(m);
      kernel = m;
      return m;
    })
    .catch((e: unknown) => {
      // So that the next call tries again instead of handing out the same failure.
      loading = null;
      throw e;
    });
  return loading;
}

type Vec2Arg = number | [number, number];
type PolygonsVec = { delete(): void };
type RawCrossSection = { _ToPolygons(): PolygonsVec };
type RawModule = {
  _Extrude(polygons: PolygonsVec, height: number, divisions: number, twist: number, scaleTop: { x: number; y: number }): Manifold;
  _Revolve(polygons: PolygonsVec, segments: number, degrees: number): Manifold;
};

/**
 * Mends the JS binding: its `extrude` and `revolve` copy the section's polygons
 * into a kernel vector that they never free, some bytes a point on every call,
 * which adds up over the rebuilds of a part. (Its `CrossSection` constructor
 * and `toPolygons` leak a little too; those are only used once per asset.)
 */
export function patchBinding(m: ManifoldToplevel): void {
  const raw = m as unknown as RawModule;
  // `m.CrossSection` is a wrapper function whose prototype merely inherits from the class's own,
  // where the methods live (and where the instances look them up).
  const proto = Object.getPrototypeOf(m.CrossSection.prototype) as RawCrossSection & Record<string, unknown>;
  const vec2 = (v: Vec2Arg) => (typeof v === 'number' ? { x: v, y: v } : { x: v[0], y: v[1] });
  proto.extrude = function (this: RawCrossSection, height: number, divisions = 0, twist = 0, scaleTop: Vec2Arg = [1, 1], center = false) {
    const polygons = this._ToPolygons();
    try {
      const solid = raw._Extrude(polygons, height, divisions, twist, vec2(scaleTop));
      if (!center) return solid;
      const centered = solid.translate([0, 0, -height / 2]);
      solid.delete();
      return centered;
    } finally {
      polygons.delete();
    }
  };
  proto.revolve = function (this: RawCrossSection, segments = 0, degrees = 360) {
    const polygons = this._ToPolygons();
    try {
      return raw._Revolve(polygons, segments, degrees);
    } finally {
      polygons.delete();
    }
  };
}

/**
 * The class behind `k.Manifold`. The wrapper around it throws when a mesh is
 * not manifold, without freeing the solid it made; this one makes it anyway,
 * and `status()` says what is wrong with it.
 */
export function rawManifold(k: ManifoldToplevel): new (mesh: Mesh) => Manifold {
  return (Object.getPrototypeOf(k.Manifold.prototype) as { constructor: new (mesh: Mesh) => Manifold }).constructor;
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

/** Drops the imported data of designs that are no longer open, and anything built from it. */
export function forgetAssets(keep: Iterable<string>): void {
  const wanted = new Set(keep);
  let dropped = false;
  for (const id of [...assets.keys()]) {
    if (wanted.has(id)) continue;
    assets.delete(id);
    dropped = true;
  }
  if (dropped) clearCache();
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
function decodeMesh(asset: MeshAsset): MeshWithUV {
  const p = decodeBase64(asset.positions);
  const t = decodeBase64(asset.triangles);
  const mesh: MeshWithUV = {
    positions: new Float32Array(p.buffer, 0, Math.floor(p.length / 12) * 3),
    triangles: new Uint32Array(t.buffer, 0, Math.floor(t.length / 12) * 3),
  };
  if (asset.uv) {
    const u = decodeBase64(asset.uv);
    const uv = new Float32Array(u.buffer, 0, Math.floor(u.length / 8) * 2);
    // Only coordinates that cover every corner are of use.
    if (uv.length === mesh.triangles.length * 2 && uv.every(Number.isFinite)) mesh.uv = uv;
  }
  return mesh;
}

// ---------------------------------------------------------------------------
// Built geometry, cached by geometry key

type Deletable = { delete(): void };

/** A part of a group, by the kernel's id for its faces and the path of ids (from the group's children down) to it. */
interface Source {
  id: number;
  path: string[];
}

/** The geometry of a node as built: at its built size, centered on the origin. */
type Built =
  /** `sources` for a group: the parts its faces came from, so each can be shown in its own color. */
  | { solid: Manifold; triangles: number; sources?: Source[] }
  /** An imported mesh that is not watertight. It can be shown and exported as it is, but not combined. */
  | { solid: null; open: MeshWithUV; triangles: number };

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
    case 'group': {
      const sources: Source[] = [];
      const solid = scoped((keep) => groupSolid(k, node, keep, sources));
      return { solid, triangles: solid.numTri(), sources };
    }
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

/**
 * The solid nodes merged, minus the holes; null if there are no solid nodes.
 * Hidden nodes take part too. With `sources`, every node goes in under an id
 * of its own, which the kernel carries through to the faces of the result; a
 * group keeps the ids of its own parts instead, so that they can be told
 * apart all the way down (whoever colors the faces decides where to stop).
 */
function combine(k: ManifoldToplevel, nodes: SceneNode[], keep: Keep, sources?: Source[]): Manifold | null {
  const solids: Manifold[] = [];
  const holes: Manifold[] = [];
  // Pictures lie on the surface; they are neither added nor cut.
  for (const node of nodes) {
    if (node.type === 'picture') continue;
    let solid = placed(k, node, keep);
    if (sources) {
      const entry = node.type === 'group' ? builtOf(k, node) : null;
      const inner = entry?.solid ? entry.sources : undefined;
      if (inner) {
        for (const s of inner) sources.push({ id: s.id, path: [node.id, ...s.path] });
      } else {
        solid = keep(solid.asOriginal());
        sources.push({ id: solid.originalID(), path: [node.id] });
      }
    }
    (node.hole ? holes : solids).push(solid);
  }
  if (solids.length === 0) return null;
  const body = solids.length === 1 ? solids[0] : keep(k.Manifold.union(solids));
  return holes.length === 0 ? body : keep(k.Manifold.difference([body, ...holes]));
}

function groupSolid(k: ManifoldToplevel, node: GroupNode, keep: Keep, sources?: Source[]): Manifold {
  const result = combine(k, node.children, keep, sources);
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
  // NaN or infinite coordinates would get through the kernel and poison every normal around them.
  if (!data.positions.every(Number.isFinite)) throw new Error(`The mesh of "${node.name}" is damaged: some points have no position.`);
  const solid = meshSolid(k, data.positions, data.triangles, data.uv);
  if (!solid) return { solid: null, open: data, triangles: data.triangles.length / 3 };
  if (solid.volume() >= 0) return solidEntry(solid);
  // Closed, but inside out (the file lists its triangles clockwise): turn every triangle over.
  solid.delete();
  const turned = data.triangles.slice();
  const uv = data.uv?.slice();
  for (let i = 0; i < turned.length; i += 3) {
    turned[i + 1] = data.triangles[i + 2];
    turned[i + 2] = data.triangles[i + 1];
    if (uv && data.uv) {
      uv.set(data.uv.subarray((i + 2) * 2, (i + 3) * 2), (i + 1) * 2);
      uv.set(data.uv.subarray((i + 1) * 2, (i + 2) * 2), (i + 2) * 2);
    }
  }
  const fixed = meshSolid(k, data.positions, turned, uv);
  return fixed ? solidEntry(fixed) : { solid: null, open: data, triangles: data.triangles.length / 3 };
}

/** Properties per vertex of a solid made from a mesh with texture coordinates: xyz and uv. */
const UV_PROPS = 5;

/**
 * A solid from an indexed triangle mesh, or null if the mesh is not
 * watertight. Texture coordinates (per corner) ride along as vertex
 * properties: every corner becomes a vertex of its own, and the kernel joins
 * those at one place into one, so the coordinates survive anything it does.
 */
function meshSolid(k: ManifoldToplevel, positions: Float32Array, triangles: Uint32Array, uv?: Float32Array): Manifold | null {
  let mesh: Mesh;
  if (uv) {
    const props = new Float32Array(triangles.length * UV_PROPS);
    for (let c = 0; c < triangles.length; c++) {
      props.set(positions.subarray(triangles[c] * 3, triangles[c] * 3 + 3), c * UV_PROPS);
      props[c * UV_PROPS + 3] = uv[c * 2];
      props[c * UV_PROPS + 4] = uv[c * 2 + 1];
    }
    mesh = new k.Mesh({ numProp: UV_PROPS, vertProperties: props, triVerts: Uint32Array.from({ length: triangles.length }, (_, i) => i) });
  } else {
    mesh = new k.Mesh({ numProp: 3, vertProperties: positions, triVerts: triangles });
  }
  // Files rarely share vertices between faces; this joins the ones that coincide. (It leaves our arrays alone.)
  mesh.merge();
  // A mesh with open or over-shared edges comes out with an error status (and would leak if the wrapper threw).
  const solid = new (rawManifold(k))(mesh);
  if (solid.status() === 'NoError' && !solid.isEmpty()) return solid;
  solid.delete();
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

/** A solid's triangles in runs that share an origin: run `r` is triangles `index[r] / 3` up to `index[r + 1] / 3`. */
interface Runs {
  index: Uint32Array;
  ids: Uint32Array;
}

/** Indexed triangles of a solid, in arrays of their own (safe to transfer out of the worker), with any texture coordinates per corner. */
function meshOf(solid: Manifold): MeshWithUV & { runs: Runs } {
  const raw = solid.getMesh();
  const n = raw.numProp;
  const positions =
    n === 3
      ? raw.vertProperties.slice()
      : Float32Array.from({ length: (raw.vertProperties.length / n) * 3 }, (_, i) => {
          return raw.vertProperties[Math.floor(i / 3) * n + (i % 3)];
        });
  const triangles = raw.triVerts.slice();
  const out: MeshWithUV & { runs: Runs } = { positions, triangles, runs: { index: raw.runIndex.slice(), ids: raw.runOriginalID.slice() } };
  if (n >= UV_PROPS) {
    const uv = new Float32Array(triangles.length * 2);
    for (let c = 0; c < triangles.length; c++) {
      uv[c * 2] = raw.vertProperties[triangles[c] * n + 3];
      uv[c * 2 + 1] = raw.vertProperties[triangles[c] * n + 4];
    }
    out.uv = uv;
  }
  return out;
}

/** Which part each triangle came from, given the runs of a group's mesh and the ids its parts went in under. */
function facesOf(mesh: MeshData & { runs: Runs }, sources: Source[]): Faces | undefined {
  if (sources.length === 0 || sources.length >= NO_SOURCE) return undefined;
  const byId = new Map(sources.map((s, i) => [s.id, i]));
  const count = mesh.triangles.length / 3;
  const source = new Uint16Array(count).fill(NO_SOURCE);
  const { index, ids } = mesh.runs;
  for (let r = 0; r < ids.length; r++) {
    const i = byId.get(ids[r]);
    if (i === undefined) continue;
    const to = r + 1 < index.length ? index[r + 1] / 3 : count;
    source.fill(i, index[r] / 3, Math.min(to, count));
  }
  return { source, sources: sources.map((s) => s.path) };
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
      const { positions, triangles, uv } = entry.open;
      const render = creasedNormals(positions, triangles, CREASE_ANGLE);
      if (uv) render.uv = uv.slice();
      return {
        key,
        render,
        bounds: boundsOfPositions(positions),
        triangles: entry.triangles,
        volume: 0,
        watertight: false,
      };
    }
    const mesh = meshOf(entry.solid);
    const render = creasedNormals(mesh.positions, mesh.triangles, CREASE_ANGLE);
    // Only an imported mesh's own coordinates mean anything; a group's are a jumble of its parts'.
    if (mesh.uv && node.type === 'import') render.uv = mesh.uv;
    const result: BuildResult = {
      key,
      render,
      bounds: toBounds(entry.solid.boundingBox()),
      triangles: entry.triangles,
      volume: entry.solid.volume(),
      watertight: true,
    };
    const faces = entry.sources && facesOf(mesh, entry.sources);
    if (faces) result.faces = faces;
    return result;
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

/**
 * The nodes placed in the design, each as one closed part per color: a
 * painted object is one part; a mixed group is one per color, its holes cut
 * from all of them and the parts kept from overlapping (the first color wins
 * where they would), so that a slicer can give each its own material. Holes,
 * hidden nodes and pictures are left out. An open mesh goes out as it is.
 * With `local` the parts stay in the nodes' own built frames (see `builtSize`).
 */
export function exportColored(nodes: SceneNode[], fine = false, local = false): ColoredExport {
  refining = fine;
  try {
    return operation((k) =>
      scoped((keep): ColoredExport => {
        const warnings: string[] = [];
        const objects: ColoredObject[] = [];
        for (const node of nodes) {
          if (node.hole || node.hidden || node.type === 'picture') continue;
          const entry = builtOf(k, node);
          if (!entry.solid) {
            const mesh = local ? { positions: entry.open.positions.slice(), triangles: entry.open.triangles.slice() } : transformed(entry.open, nodeMatrix(node));
            objects.push({ name: node.name, parts: [{ color: node.color, mesh }] });
            warnings.push(`"${node.name}" is not watertight and was exported as-is.`);
            continue;
          }
          const matrix = mat4(nodeMatrix(node));
          const parts: ColoredPart[] = coloredParts(k, node, keep).map((p) => ({ color: p.color, mesh: meshOf(local ? p.solid : keep(p.solid.transform(matrix))) }));
          if (parts.length) objects.push({ name: node.name, parts });
        }
        if (objects.length === 0) throw new Error('There is nothing to export.');
        return { objects, warnings };
      }),
    );
  } finally {
    refining = false;
  }
}

/** A node's solid in its built frame, split by color (see `exportColored`); the solids are the cache's own or kept. */
function coloredParts(k: ManifoldToplevel, node: SceneNode, keep: Keep): { color: string; solid: Manifold }[] {
  if (node.type !== 'group' || !node.mixed) {
    const { solid } = builtOf(k, node);
    if (!solid) throw new Error(`"${node.name}" is not a watertight mesh, so it cannot be combined with other shapes.`);
    return [{ color: paintOf(node), solid }];
  }
  // In the order their colors first appear: the first solid's color wins where parts overlap.
  const regions = new Map<string, Manifold[]>();
  const holes: Manifold[] = [];
  for (const child of node.children) {
    if (child.type === 'picture') continue;
    if (child.hole) {
      holes.push(placed(k, child, keep));
      continue;
    }
    const matrix = mat4(nodeMatrix(child));
    for (const part of coloredParts(k, child, keep)) {
      const list = regions.get(part.color) ?? [];
      list.push(keep(part.solid.transform(matrix)));
      regions.set(part.color, list);
    }
  }
  const out: { color: string; solid: Manifold }[] = [];
  let taken: Manifold | null = null;
  for (const [color, solids] of regions) {
    let solid = solids.length === 1 ? solids[0] : keep(k.Manifold.union(solids));
    if (holes.length) solid = keep(k.Manifold.difference([solid, ...holes]));
    if (taken) solid = keep(k.Manifold.difference([solid, taken]));
    if (checked(solid).isEmpty()) continue;
    out.push({ color, solid });
    taken = taken ? keep(k.Manifold.union([taken, solid])) : solid;
  }
  return out;
}

/** With `local`, the nodes' geometry is left in their own built frames (see `builtSize`) instead of being placed. */
function exportAt(nodes: SceneNode[], outline: boolean, local: boolean): ExportResult {
  return operation((k) =>
    scoped((keep): ExportResult => {
      const warnings: string[] = [];
      const solids: Manifold[] = [];
      const parts: MeshData[] = [];
      // The parts of a group exported on its own, in place, can keep their colors; an imported mesh its coordinates.
      let sources: Source[] | undefined;
      let uv: Float32Array | undefined;
      for (const node of nodes) {
        // A picture on its own is a sheet with nothing solid about it; the pictures on an object go out with the object's skin.
        if (node.hole || node.hidden || (node.type === 'picture' && !local)) continue;
        const entry = builtOf(k, node);
        if (entry.solid) {
          solids.push(local ? entry.solid : keep(entry.solid.transform(mat4(nodeMatrix(node)))));
          sources = local && nodes.length === 1 && entry.solid ? entry.sources : undefined;
          continue;
        }
        // A copy even when left in place: the worker hands the result's arrays over to the main thread,
        // which would strip the cache's own.
        parts.push(local ? { positions: entry.open.positions.slice(), triangles: entry.open.triangles.slice() } : transformed(entry.open, nodeMatrix(node)));
        if (local && nodes.length === 1 && entry.open.uv) uv = entry.open.uv.slice();
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
      let faces: Faces | undefined;
      if (solids.length > 0) {
        const merged = checked(solids.length === 1 ? solids[0] : keep(k.Manifold.union(solids)));
        const mesh = meshOf(merged);
        parts.unshift(mesh);
        if (sources) faces = facesOf(mesh, sources);
        if (local && nodes.length === 1 && nodes[0].type === 'import' && mesh.uv) uv = mesh.uv;
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
      if (faces) result.faces = faces;
      if (uv) result.uv = uv;
      return result;
    }),
  );
}
