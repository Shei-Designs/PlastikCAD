// Reading and writing design files. A design is a single JSON document that
// holds the scene and any imported data. It is laid out to diff well, so
// designs can also live in a git repository: keys come in a fixed order, one
// node property per line, numbers kept short.
import { FILE_FORMAT, FILE_VERSION, LEGACY_FORMAT } from '../app';
import { SHAPES, clampParams, defaultParams } from '../geometry/shapes';
import { GENERATORS, RENAMED_PARTS, getGenerator } from '../parts/generators';
import { sanitizeParams } from '../parts/generators/types';
import { newId, usedAssets } from './ops';
import { TEXT_FONTS } from './types';
import type { Asset, Doc, OutlineShape, PartParamValue, Scene, SceneNode, ShapeKind, Texture, Vec3 } from './types';
import { COLLISION_KINDS, JOINT_TYPES, SENSOR_KINDS, defaultSensor } from '../robot/types';
import type { CollisionKind, JointType, MassSpec, Robot, RobotJoint, RobotLink, RobotSensor, SensorKind } from '../robot/types';

export function emptyDoc(): Doc {
  return { id: newId(), name: 'Untitled', scene: [], assets: {} };
}

/** Longest note kept on an object. */
export const MAX_NOTE = 2000;
/** Longest thumbnail written into a file. */
export const MAX_THUMB = 200_000;
/** How much of a file holds its header: everything before the scene, the thumbnail included. */
export const HEAD_BYTES = 256 * 1024;

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

/** Fixed key order, so that the same node always serializes to the same text. */
export function canonical(node: SceneNode): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    shape: node.type === 'shape' ? node.shape : undefined,
    asset: node.type === 'import' || node.type === 'picture' ? node.asset : undefined,
    mapping: node.type === 'picture' ? node.mapping : undefined,
    angle: node.type === 'picture' ? node.angle : undefined,
    part: node.type === 'part' ? node.part : undefined,
    params: node.type === 'part' ? sortKeys(node.params) : node.type === 'shape' && Object.keys(node.params).length ? sortKeys(node.params) : undefined,
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
    texture: node.texture ? { asset: node.texture.asset, mode: node.texture.mode, scale: node.texture.scale, turn: node.texture.turn || undefined } : undefined,
    hidden: node.hidden || undefined,
    locked: node.locked || undefined,
    ghost: node.ghost || undefined,
    note: node.note || undefined,
    mixed: node.type === 'group' && node.mixed ? true : undefined,
    children: node.type === 'group' ? node.children.map(canonical) : undefined,
  };
}

const sortKeys = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/** Imported data that nothing in the scene refers to any more is not written. */
export function liveAssets(doc: Doc): Record<string, Asset> {
  const used = usedAssets(doc.scene);
  return sortKeys(Object.fromEntries(Object.entries(doc.assets).filter(([key]) => used.has(key))));
}

/**
 * The header comes first, each field on a line of its own, so that a projects
 * folder can be listed by reading the start of each file (`readHeader`).
 */
export function serializeDoc(doc: Doc): string {
  const file = {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    units: 'mm',
    id: doc.id,
    name: doc.name,
    revision: doc.revision,
    parent: doc.parent,
    device: doc.device,
    saved: doc.saved,
    thumb: doc.thumb,
    scene: doc.scene.map(canonical),
    assets: liveAssets(doc),
    // After the scene: a robot's links carry "name" lines of their own, which must not pass for the header's.
    robot: doc.robot ? canonicalRobot(doc.robot) : undefined,
  };
  return pretty(file, 0) + '\n';
}

/** Fixed key order, links and joints sorted by id, so that the same robot always serializes to the same text. */
export function canonicalRobot(robot: Robot): Record<string, unknown> {
  const byId = <T>(key: (item: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));
  return {
    root: robot.root ?? undefined,
    links: [...robot.links].sort(byId((l: RobotLink) => l.node)).map((l) => ({
      node: l.node,
      name: l.name,
      mass: l.mass.kind === 'measured' ? { kind: 'measured', grams: l.mass.grams } : { kind: 'material', material: l.mass.material, infill: l.mass.infill, shell: l.mass.shell },
      collision: l.collision,
      friction: l.friction,
    })),
    joints: [...robot.joints].sort(byId((j: RobotJoint) => j.id)).map((j) => ({
      id: j.id,
      name: j.name,
      type: j.type,
      parent: j.parent,
      child: j.child,
      origin: j.origin,
      axis: j.axis,
      lower: j.lower,
      upper: j.upper,
      effort: j.effort,
      velocity: j.velocity,
      damping: j.damping,
      friction: j.friction,
      mimic: j.mimic ? { joint: j.mimic.joint, multiplier: j.mimic.multiplier, offset: j.mimic.offset } : undefined,
    })),
    sensors: robot.sensors.length
      ? [...robot.sensors].sort(byId((x: RobotSensor) => x.id)).map((x) => ({
          id: x.id,
          name: x.name,
          kind: x.kind,
          link: x.link,
          origin: x.origin,
          rot: x.rot,
          rate: x.rate,
          camera: x.kind === 'camera' || x.kind === 'depth' ? { hfov: x.camera.hfov, width: x.camera.width, height: x.camera.height, near: x.camera.near, far: x.camera.far } : undefined,
          lidar: x.kind === 'lidar' ? { samples: x.lidar.samples, hfov: x.lidar.hfov, min: x.lidar.min, max: x.lidar.max } : undefined,
        }))
      : undefined,
    drive: robot.drive ? { left: [...robot.drive.left].sort(), right: [...robot.drive.right].sort() } : undefined,
    control: robot.control ? undefined : false,
  };
}

// --- reading -------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const KINDS = new Set<string>(SHAPES.map((s) => s.kind));
/** Groups within groups, past which a design is refused rather than read recursively. */
const MAX_NESTING = 64;

function vec3(v: unknown, fallback: Vec3, positive = false): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) return fallback;
  const out = v.map((x, i) => (typeof x === 'number' && Number.isFinite(x) && (!positive || x > 0) ? x : fallback[i]));
  return out as Vec3;
}

function readNode(raw: unknown, assets: Record<string, Asset>, depth: number): SceneNode | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  if (depth > MAX_NESTING) throw new Error('This design is nested too deeply.');
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
    ...(raw.ghost === true ? { ghost: true } : {}),
    ...(readTexture(raw.texture, assets) ?? {}),
    ...(typeof raw.note === 'string' && raw.note.trim() ? { note: raw.note.slice(0, MAX_NOTE) } : {}),
  };
  if (raw.type === 'shape' && raw.shape === 'tube') {
    // The tube shape is gone; an old one becomes what it always was: a cylinder with a cylinder cut out.
    const wall = isRecord(raw.params) && typeof raw.params.wall === 'number' ? raw.params.wall : 2;
    const sides = isRecord(raw.params) && typeof raw.params.sides === 'number' ? raw.params.sides : 64;
    const [w, d, h] = base.size;
    // Hidden, locked, ghosted, textured and flipped belong to the group, as makeGroup would have it, not to its halves.
    const { flip: _flip, hidden: _hidden, locked: _locked, ghost: _ghost, texture: _texture, ...plain } = base;
    const cylinder = (size: Vec3) => clampParams({ shape: 'cylinder', params: { sides, radius: 0 }, size });
    const bore: Vec3 = [Math.max(w - 2 * wall, 0.1), Math.max(d - 2 * wall, 0.1), h * 2];
    const outer: SceneNode = { ...plain, id: `${base.id}o`, name: 'Outer', pos: [0, 0, 0], rot: [0, 0, 0], hole: false, type: 'shape', shape: 'cylinder', params: cylinder(base.size) };
    const inner: SceneNode = { ...outer, id: `${base.id}i`, name: 'Bore', hole: true, size: bore, params: cylinder(bore) };
    return { ...base, type: 'group', natural: base.size, children: [outer, inner] };
  }
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
    if (typeof raw.asset !== 'string' || assets[raw.asset]?.kind === undefined || assets[raw.asset].kind === 'image') return null;
    return { ...base, type: 'import', asset: raw.asset, natural: vec3(raw.natural, base.size, true) };
  }
  if (raw.type === 'picture') {
    if (typeof raw.asset !== 'string' || assets[raw.asset]?.kind !== 'image') return null;
    const angle = typeof raw.angle === 'number' && Number.isFinite(raw.angle) ? Math.min(360, Math.max(1, raw.angle)) : 120;
    const { texture: _dropped, ...plain } = base;
    return { ...plain, type: 'picture', asset: raw.asset, mapping: raw.mapping === 'wrap' ? 'wrap' : 'flat', angle, hole: false, natural: [1, 1, 1] };
  }
  if (raw.type === 'part') {
    if (typeof raw.part !== 'string') return null;
    let rawParams = isRecord(raw.params) ? (raw.params as Record<string, PartParamValue>) : undefined;
    let part = raw.part;
    // An own key only: a part called "constructor" is not a renamed one.
    const renamed = hasOwn(RENAMED_PARTS, part) ? RENAMED_PARTS[part] : undefined;
    if (renamed) {
      rawParams = renamed.params(rawParams ?? {});
      part = renamed.part;
    }
    if (!GENERATORS.some((g) => g.id === part)) return null;
    const def = getGenerator(part);
    return {
      ...base,
      type: 'part',
      part,
      params: sanitizeParams(def, rawParams),
      natural: vec3(raw.natural, base.size, true),
    };
  }
  if (raw.type === 'text') {
    if (typeof raw.text !== 'string' || raw.text.trim() === '') return null;
    return {
      ...base,
      type: 'text',
      text: raw.text,
      font: TEXT_FONTS.some((f) => f.id === raw.font) ? (raw.font as string) : TEXT_FONTS[0].id,
      align: raw.align === 'center' || raw.align === 'right' ? raw.align : 'left',
      natural: vec3(raw.natural, base.size, true),
    };
  }
  if (raw.type === 'group') {
    const children = readScene(raw.children, assets, depth + 1);
    if (children.length === 0) return null;
    // Groups from before `mixed` existed were drawn in one color, and still are.
    return { ...base, type: 'group', ...(raw.mixed === true ? { mixed: true } : {}), natural: vec3(raw.natural, base.size, true), children };
  }
  return null;
}

/** A texture whose image is in the design; anything else is left off. */
function readTexture(raw: unknown, assets: Record<string, Asset>): { texture: Texture } | null {
  if (!isRecord(raw) || typeof raw.asset !== 'string' || assets[raw.asset]?.kind !== 'image') return null;
  const scale = typeof raw.scale === 'number' && Number.isFinite(raw.scale) && raw.scale > 0 ? raw.scale : 50;
  const turn = typeof raw.turn === 'number' && Number.isFinite(raw.turn) ? raw.turn : 0;
  return { texture: { asset: raw.asset, mode: raw.mode === 'tile' || raw.mode === 'own' ? raw.mode : 'wrap', scale, turn } };
}

function readScene(raw: unknown, assets: Record<string, Asset>, depth = 0): Scene {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Scene = [];
  for (const item of raw) {
    const node = readNode(item, assets, depth);
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
    // Assigning this key would swap the prototype of `out` rather than add an asset.
    if (key === '__proto__' || !isRecord(value)) continue;
    if (value.kind === 'mesh' && typeof value.positions === 'string' && typeof value.triangles === 'string') {
      out[key] = { kind: 'mesh', positions: value.positions, triangles: value.triangles, ...(typeof value.uv === 'string' && value.uv ? { uv: value.uv } : {}) };
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
    } else if (value.kind === 'image' && typeof value.data === 'string' && (value.mime === 'image/png' || value.mime === 'image/jpeg')) {
      const px = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.round(v) : 0);
      if (px(value.width) && px(value.height)) out[key] = { kind: 'image', name: typeof value.name === 'string' ? value.name : 'Picture', mime: value.mime, data: value.data, width: px(value.width), height: px(value.height) };
    }
  }
  return out;
}

const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const JOINT_KINDS = new Set<string>(JOINT_TYPES.map((t) => t.id));
const COLLISIONS = new Set<string>(COLLISION_KINDS.map((c) => c.id));
const SENSORS = new Set<string>(SENSOR_KINDS.map((k) => k.id));

function readSensors(raw: unknown, ids: Set<string>): RobotSensor[] {
  const out: RobotSensor[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const x of raw) {
    if (!isRecord(x) || typeof x.id !== 'string' || seen.has(x.id) || typeof x.link !== 'string' || !ids.has(x.link)) continue;
    if (typeof x.kind !== 'string' || !SENSORS.has(x.kind)) continue;
    seen.add(x.id);
    const base = defaultSensor(x.id, typeof x.name === 'string' && x.name.trim() ? x.name : 'sensor', x.kind as SensorKind, x.link, vec3(x.origin, [0, 0, 0]));
    const cam = isRecord(x.camera) ? x.camera : {};
    const lid = isRecord(x.lidar) ? x.lidar : {};
    out.push({
      ...base,
      rot: vec3(x.rot, [0, 0, 0]),
      rate: Math.max(0.1, finite(x.rate, base.rate)),
      camera: {
        hfov: Math.min(179, Math.max(1, finite(cam.hfov, base.camera.hfov))),
        width: Math.max(1, Math.round(finite(cam.width, base.camera.width))),
        height: Math.max(1, Math.round(finite(cam.height, base.camera.height))),
        near: Math.max(1, finite(cam.near, base.camera.near)),
        far: Math.max(2, finite(cam.far, base.camera.far)),
      },
      lidar: {
        samples: Math.max(2, Math.round(finite(lid.samples, base.lidar.samples))),
        hfov: Math.min(360, Math.max(1, finite(lid.hfov, base.lidar.hfov))),
        min: Math.max(1, finite(lid.min, base.lidar.min)),
        max: Math.max(2, finite(lid.max, base.lidar.max)),
      },
    });
  }
  return out;
}

function readMass(raw: unknown): MassSpec {
  if (isRecord(raw) && raw.kind === 'measured') return { kind: 'measured', grams: Math.max(0, finite(raw.grams, 0)) };
  const r = isRecord(raw) ? raw : {};
  return { kind: 'material', material: typeof r.material === 'string' ? r.material : 'pla', infill: Math.min(100, Math.max(0, finite(r.infill, 20))), shell: Math.max(0, finite(r.shell, 1.2)) };
}

/** The robot of a file, with anything that names an object the scene no longer has left off. Undefined when there is none. */
function readRobot(raw: unknown, scene: Scene): Robot | undefined {
  if (!isRecord(raw)) return undefined;
  const ids = new Set(scene.map((n) => n.id));
  const links: RobotLink[] = [];
  const seenLinks = new Set<string>();
  if (Array.isArray(raw.links)) {
    for (const l of raw.links) {
      if (!isRecord(l) || typeof l.node !== 'string' || !ids.has(l.node) || seenLinks.has(l.node)) continue;
      seenLinks.add(l.node);
      links.push({
        node: l.node,
        ...(typeof l.name === 'string' && l.name.trim() ? { name: l.name } : {}),
        mass: readMass(l.mass),
        collision: typeof l.collision === 'string' && COLLISIONS.has(l.collision) ? (l.collision as CollisionKind) : 'hull',
        friction: Math.max(0, finite(l.friction, 0.8)),
      });
    }
  }
  const joints: RobotJoint[] = [];
  const seenJoints = new Set<string>();
  if (Array.isArray(raw.joints)) {
    for (const j of raw.joints) {
      if (!isRecord(j) || typeof j.id !== 'string' || seenJoints.has(j.id)) continue;
      if (typeof j.parent !== 'string' || typeof j.child !== 'string' || !ids.has(j.parent) || !ids.has(j.child)) continue;
      seenJoints.add(j.id);
      const axis = vec3(j.axis, [0, 0, 1]);
      joints.push({
        id: j.id,
        name: typeof j.name === 'string' && j.name.trim() ? j.name : 'joint',
        type: typeof j.type === 'string' && JOINT_KINDS.has(j.type) ? (j.type as JointType) : 'revolute',
        parent: j.parent,
        child: j.child,
        origin: vec3(j.origin, [0, 0, 0]),
        axis: axis.some((x) => x !== 0) ? axis : [0, 0, 1],
        lower: finite(j.lower, -90),
        upper: finite(j.upper, 90),
        effort: Math.max(0, finite(j.effort, 10)),
        velocity: Math.max(0, finite(j.velocity, 90)),
        damping: Math.max(0, finite(j.damping, 0)),
        friction: Math.max(0, finite(j.friction, 0)),
        ...(isRecord(j.mimic) && typeof j.mimic.joint === 'string' ? { mimic: { joint: j.mimic.joint, multiplier: finite(j.mimic.multiplier, 1), offset: finite(j.mimic.offset, 0) } } : {}),
      });
    }
  }
  // A follower whose leader is gone follows nothing.
  for (const j of joints) if (j.mimic && !seenJoints.has(j.mimic.joint)) delete j.mimic;
  const jointList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string' && seenJoints.has(id)) : []);
  const drive = isRecord(raw.drive) ? { left: jointList(raw.drive.left), right: jointList(raw.drive.right) } : undefined;
  return {
    root: typeof raw.root === 'string' && ids.has(raw.root) ? raw.root : null,
    links,
    joints,
    sensors: readSensors(raw.sensors, ids),
    ...(drive && (drive.left.length || drive.right.length) ? { drive } : {}),
    control: raw.control !== false,
  };
}

function parseFile(text: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not a design: it could not be read as JSON.');
  }
  if (!isRecord(raw) || (raw.format !== FILE_FORMAT && raw.format !== LEGACY_FORMAT)) throw new Error('This file is not a design made with this app.');
  if (typeof raw.version !== 'number' || raw.version > FILE_VERSION) {
    throw new Error('This design was saved by a newer version of the app. Update to open it.');
  }
  return raw;
}

const readName = (raw: unknown, fallback: string): string => (typeof raw === 'string' && raw.trim() ? raw : fallback);
/** Files from before projects had ids get a fresh one. */
const readId = (raw: unknown): string => (typeof raw === 'string' && /^[a-z0-9]{8,32}$/.test(raw) ? raw : newId());
const readThumb = (raw: unknown): string | undefined =>
  typeof raw === 'string' && raw.length <= MAX_THUMB && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(raw) ? raw : undefined;

/** Throws an Error fit to show the user when the text is not a design file. */
export function parseDoc(text: string): Doc {
  const raw = parseFile(text);
  const assets = readAssets(raw.assets);
  const thumb = readThumb(raw.thumb);
  const doc: Doc = { id: readId(raw.id), name: readName(raw.name, 'Untitled'), scene: readScene(raw.scene, assets), assets };
  if (thumb) doc.thumb = thumb;
  const robot = readRobot(raw.robot, doc.scene);
  if (robot) doc.robot = robot;
  const revision = readRevision(raw.revision);
  if (revision) doc.revision = revision;
  const parent = readRevision(raw.parent);
  if (parent) doc.parent = parent;
  const device = readRevision(raw.device);
  if (device) doc.device = device;
  if (typeof raw.saved === 'string' && !Number.isNaN(Date.parse(raw.saved))) doc.saved = raw.saved;
  return doc;
}

const readRevision = (raw: unknown): string | null => (typeof raw === 'string' && /^[a-z0-9]{8,32}$/.test(raw) ? raw : null);

export interface DocHeader {
  /** Null when the file carries no id (saved before projects had them). */
  id: string | null;
  name: string;
  /** Null when the file was saved before revisions were stamped. */
  revision: string | null;
  thumb: string | null;
}

/**
 * The header of a design from the start of its text, which need not be the
 * whole file: `serializeDoc` puts each header field on its own line before
 * the scene. Null when the text is not the start of a design file.
 */
export function readHeader(head: string): DocHeader | null {
  if (!/^\{\s*\n\s*"format": "(?:plastikcad|bashcad)",/.test(head)) return null;
  // Only what comes before the scene is the header: the objects in it have ids and names of their own.
  const sceneAt = head.search(/^\s*"scene":/m);
  const header = sceneAt < 0 ? head : head.slice(0, sceneAt);
  const field = (name: string): string | null => {
    const match = new RegExp(`^\\s*"${name}": ("(?:[^"\\\\]|\\\\.)*")\\s*,?$`, 'm').exec(header);
    if (!match) return null;
    try {
      return JSON.parse(match[1]) as string;
    } catch {
      return null;
    }
  };
  const id = field('id');
  const name = field('name');
  if (name === null && sceneAt < 0) return null;
  return { id: readRevision(id), name: readName(name, 'Untitled'), revision: readRevision(field('revision')), thumb: readThumb(field('thumb') ?? undefined) ?? null };
}

/**
 * The versions a design saved by version 1 of the format carries, each as a
 * design of its own, oldest first. Version 2 stopped keeping them; this is
 * how what an old file holds can be saved out before it is dropped.
 */
export function legacyVersions(text: string): Doc[] {
  const raw = parseFile(text);
  if (raw.version !== 1 || !Array.isArray(raw.versions)) return [];
  const assets = readAssets(raw.assets);
  const name = readName(raw.name, 'Untitled');
  const out: Doc[] = [];
  for (const v of raw.versions) {
    if (!isRecord(v)) continue;
    const scene = readScene(v.scene, assets);
    if (scene.length === 0) continue;
    const label = readName(v.label, `Version ${out.length + 1}`);
    out.push({ id: newId(), name: `${name} - ${label}`, scene, assets });
  }
  return out;
}
