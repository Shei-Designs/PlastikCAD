// Reading and writing design files. A design is a single JSON document that
// holds the working scene, every saved version and any imported data. It is
// laid out to diff well, so designs can also live in a git repository: keys
// come in a fixed order, one node property per line, numbers kept short.
import { FILE_FORMAT, FILE_VERSION } from '../app';
import { SHAPES, clampParams, defaultParams } from '../geometry/shapes';
import { usedAssets } from './ops';
import { TEXT_FONTS } from './types';
import type { Asset, Doc, OutlineShape, Scene, SceneNode, ShapeKind, Vec3, Version } from './types';

export function emptyDoc(): Doc {
  return { name: 'Untitled', scene: [], versions: [], head: null, assets: {} };
}

const INDENT = '  ';

/** JSON with objects spread over lines and arrays of plain values (vectors, contours) kept on one. */
function pretty(value: unknown, depth: number): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const pad = INDENT.repeat(depth + 1);
  const end = INDENT.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isPlain)) return JSON.stringify(value);
    return `[\n${value.map((v) => pad + pretty(v, depth + 1)).join(',\n')}\n${end}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${pretty(v, depth + 1)}`).join(',\n')}\n${end}}`;
}

function isPlain(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  return Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((w) => typeof w !== 'object')));
}

/** Fixed key order, so that the same node always serialises to the same text. */
function canonical(node: SceneNode): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    shape: node.type === 'shape' ? node.shape : undefined,
    params: node.type === 'shape' && Object.keys(node.params).length ? sortKeys(node.params) : undefined,
    asset: node.type === 'import' ? node.asset : undefined,
    text: node.type === 'text' ? node.text : undefined,
    font: node.type === 'text' ? node.font : undefined,
    align: node.type === 'text' && node.align !== 'left' ? node.align : undefined,
    natural: node.type === 'shape' ? undefined : node.natural,
    pos: node.pos,
    rot: node.rot,
    size: node.size,
    flip: node.flip?.some(Boolean) ? node.flip : undefined,
    hole: node.hole || undefined,
    color: node.color,
    hidden: node.hidden || undefined,
    locked: node.locked || undefined,
    children: node.type === 'group' ? node.children.map(canonical) : undefined,
  };
}

const sortKeys = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/** Imported data that nothing refers to any more (in the scene or any version) is not written. */
export function liveAssets(doc: Doc): Record<string, Asset> {
  const used = usedAssets(doc.scene);
  for (const v of doc.versions) usedAssets(v.scene, used);
  return sortKeys(Object.fromEntries(Object.entries(doc.assets).filter(([key]) => used.has(key))));
}

export function serializeDoc(doc: Doc): string {
  const file = {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    units: 'mm',
    name: doc.name,
    head: doc.head,
    scene: doc.scene.map(canonical),
    versions: doc.versions.map((v) => ({
      id: v.id,
      parent: v.parent,
      label: v.label,
      time: v.time,
      scene: v.scene.map(canonical),
      thumb: v.thumb,
    })),
    assets: liveAssets(doc),
  };
  return pretty(file, 0) + '\n';
}

// --- reading -------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KINDS = new Set<string>(SHAPES.map((s) => s.kind));

function vec3(v: unknown, fallback: Vec3, positive = false): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) return fallback;
  const out = v.map((x, i) => (typeof x === 'number' && Number.isFinite(x) && (!positive || x > 0) ? x : fallback[i]));
  return out as Vec3;
}

function readNode(raw: unknown, assets: Record<string, Asset>): SceneNode | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  const base = {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : 'Object',
    pos: vec3(raw.pos, [0, 0, 0]),
    rot: vec3(raw.rot, [0, 0, 0]),
    size: vec3(raw.size, [20, 20, 20], true),
    hole: raw.hole === true,
    color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '#8fa3bf',
    ...(Array.isArray(raw.flip) && raw.flip.length === 3 && raw.flip.some(Boolean)
      ? { flip: raw.flip.map(Boolean) as [boolean, boolean, boolean] }
      : {}),
    ...(raw.hidden === true ? { hidden: true } : {}),
    ...(raw.locked === true ? { locked: true } : {}),
  };
  if (raw.type === 'shape') {
    if (typeof raw.shape !== 'string' || !KINDS.has(raw.shape)) return null;
    const shape = raw.shape as ShapeKind;
    const params = { ...defaultParams(shape) };
    if (isRecord(raw.params)) {
      for (const key of Object.keys(params)) {
        const v = raw.params[key];
        if (typeof v === 'number' && Number.isFinite(v)) params[key] = v;
      }
    }
    return { ...base, type: 'shape', shape, params: clampParams({ shape, params, size: base.size }) };
  }
  if (raw.type === 'import') {
    if (typeof raw.asset !== 'string' || !assets[raw.asset]) return null;
    return { ...base, type: 'import', asset: raw.asset, natural: vec3(raw.natural, base.size, true) };
  }
  if (raw.type === 'text') {
    if (typeof raw.text !== 'string' || raw.text.trim() === '') return null;
    return {
      ...base,
      type: 'text',
      text: raw.text,
      font: TEXT_FONTS.some((f) => f.id === raw.font) ? (raw.font as string) : TEXT_FONTS[0].id,
      align: raw.align === 'centre' || raw.align === 'right' ? raw.align : 'left',
      natural: vec3(raw.natural, base.size, true),
    };
  }
  if (raw.type === 'group') {
    const children = readScene(raw.children, assets);
    if (children.length === 0) return null;
    return { ...base, type: 'group', natural: vec3(raw.natural, base.size, true), children };
  }
  return null;
}

function readScene(raw: unknown, assets: Record<string, Asset>): Scene {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Scene = [];
  for (const item of raw) {
    const node = readNode(item, assets);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function readAssets(raw: unknown): Record<string, Asset> {
  const out: Record<string, Asset> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    if (value.kind === 'mesh' && typeof value.positions === 'string' && typeof value.triangles === 'string') {
      out[key] = { kind: 'mesh', positions: value.positions, triangles: value.triangles };
    } else if (value.kind === 'outline' && Array.isArray(value.shapes)) {
      const shapes: OutlineShape[] = [];
      for (const s of value.shapes) {
        if (!isRecord(s) || !Array.isArray(s.contours)) continue;
        const contours = s.contours.filter(
          (c): c is [number, number][] =>
            Array.isArray(c) && c.length >= 3 && c.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x))),
        );
        if (contours.length) shapes.push({ contours, evenodd: s.evenodd === true });
      }
      if (shapes.length) out[key] = { kind: 'outline', shapes };
    }
  }
  return out;
}

/** Throws an Error fit to show the user when the text is not a design file. */
export function parseDoc(text: string): Doc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not a design: it could not be read as JSON.');
  }
  if (!isRecord(raw) || raw.format !== FILE_FORMAT) throw new Error('This file is not a design made with this app.');
  if (typeof raw.version !== 'number' || raw.version > FILE_VERSION) {
    throw new Error('This design was saved by a newer version of the app. Update to open it.');
  }
  const assets = readAssets(raw.assets);
  const versions: Version[] = [];
  const ids = new Set<string>();
  if (Array.isArray(raw.versions)) {
    for (const v of raw.versions) {
      if (!isRecord(v) || typeof v.id !== 'string' || ids.has(v.id)) continue;
      ids.add(v.id);
      versions.push({
        id: v.id,
        parent: typeof v.parent === 'string' ? v.parent : null,
        label: typeof v.label === 'string' ? v.label : '',
        time: typeof v.time === 'string' ? v.time : new Date(0).toISOString(),
        scene: readScene(v.scene, assets),
        ...(typeof v.thumb === 'string' && v.thumb.startsWith('data:image/') ? { thumb: v.thumb } : {}),
      });
    }
  }
  for (const v of versions) if (v.parent && !ids.has(v.parent)) v.parent = null;
  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Untitled',
    scene: readScene(raw.scene, assets),
    versions,
    head: typeof raw.head === 'string' && ids.has(raw.head) ? raw.head : null,
    assets,
  };
}
