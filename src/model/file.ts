// Reading and writing design files. A design is a single JSON document that
// holds the scene and any imported data. It is laid out to diff well, so
// designs can also live in a git repository: keys come in a fixed order, one
// node property per line, numbers kept short.
import { clampAngle } from '../text/curve';
import type { TextCurve } from '../text/curve';
import { FILE_FORMAT, FILE_VERSION, LEGACY_FORMAT } from '../appInfo';
import { inEveryLanguage, tr } from '../i18n';
import { SHAPES, clampParams, defaultParams } from '../geometry/shapes';
import { GENERATORS, RENAMED_PARTS, getGenerator } from '../parts/generators';
import { sanitizeParams } from '../parts/generators/types';
import { newId, usedAssets } from './ops';
import { TEXT_FONTS } from './types';
import type { Asset, Doc, OutlineShape, PartParamValue, Scene, SceneNode, ShapeKind, Texture, Vec3 } from './types';
import { COLLISION_KINDS, DRIVE_KINDS, JOINT_TYPES, SENSOR_KINDS, WORLDS, defaultSensor } from '../robot/types';
import type { CollisionKind, Drive, DriveRole, JointType, MassSpec, Robot, RobotJoint, RobotLink, RobotSensor, SensorKind } from '../robot/types';

export function emptyDoc(): Doc {
  return { id: newId(), name: tr('Untitled'), scene: [], assets: {} };
}

/** Whether a design still has the name a new one is given, in whichever language it was given. */
export const isUntitled = (name: string): boolean => inEveryLanguage('Untitled').includes(name);

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

/** A design file's text from what it holds, laid out as `serializeDoc` lays it out. */
export const formatFile = (file: unknown): string => pretty(file, 0) + '\n';

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
    curve: node.type === 'text' ? node.curve : undefined,
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
  return formatFile(file);
}

/** Fixed key order, links and joints sorted by id, so that the same robot always serializes to the same text. */
export function canonicalRobot(robot: Robot): Record<string, unknown> {
  const byId = <T>(key: (item: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));
  return {
    root: robot.root ?? undefined,
    base: robot.base,
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
      motor: j.motor,
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
    drive: robot.drive ? { kind: robot.drive.kind, roles: Object.fromEntries(Object.entries(robot.drive.roles).sort(([a], [b]) => a.localeCompare(b))) } : undefined,
    control: robot.control ? undefined : false,
    world: robot.world && robot.world !== 'flat' ? robot.world : undefined,
    scripts: robot.scripts === false ? false : undefined,
  };
}

// --- reading -------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const KINDS = new Set<string>(SHAPES.map((s) => s.kind));
/** Groups within groups, past which a design is refused rather than read recursively. */
const MAX_NESTING = 64;

const NEWER = tr('This design was saved by a newer version of the app. Update to open it.');

/**
 * What reading a design a newer version of the app saved ends in. The file is in a later version
 * of the format, or names something this build does not know. It is not opened as it is: its next
 * save would lose that for good, here and on every device the save syncs to. `parseDocWithout`
 * reads such a file all the same, leaving out what is not known, for a copy to be made of.
 */
export class NewerVersion extends Error {
  constructor() {
    super(NEWER);
  }
}

/**
 * From this version of the format on, a file is read strictly: a kind of
 * object, part, option or sensor this build does not know, or a field it has
 * no name for, can only have come from a newer build, and dropping it or
 * putting a default in its place would lose it at the next save. Such a file
 * is refused (`NewerVersion`). Older files are read as they always were, what
 * they name that the app no longer has left out.
 */
const STRICT_FROM = 3;
/** Whether the file being read is one to be strict with; set by `parseFile` for the reading that follows it. */
let strict = false;
/** Set while a file is read for a copy without what this build does not know (`parseDocWithout`): each such thing is counted in `left` and passed over. */
let stripping = false;
let left = 0;

/** Something in a strict file that this build does not know: the file is refused, or, read for a copy, the thing counted and left out. */
function notKnown(): void {
  if (!strict) return;
  if (!stripping) throw new NewerVersion();
  left++;
}

/** A value that names one of a fixed set: itself when it is one, else undefined, which in a strict file can only mean a newer build wrote it. */
function oneOf<T extends string>(value: unknown, known: (v: string) => boolean): T | undefined {
  if (typeof value !== 'string') return undefined;
  if (known(value)) return value as T;
  notKnown();
  return undefined;
}

/** A record of a strict file has these fields and no others: any more is something a newer build wrote. */
function only(record: Record<string, unknown>, known: ReadonlySet<string>): void {
  if (strict && Object.keys(record).some((key) => !known.has(key))) notKnown();
}

/** The fields this build writes for an object: those of `canonical`, whatever the object. */
const NODE_FIELDS: ReadonlySet<string> = new Set(Object.keys(canonical({ id: '', name: '', pos: [0, 0, 0], rot: [0, 0, 0], size: [1, 1, 1], hole: false, color: '', type: 'shape', shape: 'box', params: {} })));
const TEXTURE_FIELDS = new Set(['asset', 'mode', 'scale', 'turn']);
const CURVE_FIELDS = new Set(['kind', 'angle', 'flip', 'thickness']);
/** The fields this build writes for a robot and what is in it (see `canonicalRobot`; a test holds the two together). */
export const ROBOT_FIELDS = {
  robot: new Set(['root', 'base', 'links', 'joints', 'sensors', 'drive', 'control', 'world', 'scripts']),
  link: new Set(['node', 'name', 'mass', 'collision', 'friction']),
  mass: new Set(['kind', 'grams', 'material', 'infill', 'shell']),
  joint: new Set(['id', 'name', 'type', 'parent', 'child', 'origin', 'axis', 'lower', 'upper', 'effort', 'velocity', 'damping', 'friction', 'mimic', 'motor']),
  mimic: new Set(['joint', 'multiplier', 'offset']),
  sensor: new Set(['id', 'name', 'kind', 'link', 'origin', 'rot', 'rate', 'camera', 'lidar']),
  camera: new Set(['hfov', 'width', 'height', 'near', 'far']),
  lidar: new Set(['samples', 'hfov', 'min', 'max']),
  // `left` and `right` are how files once held the two sides of a differential drive.
  drive: new Set(['kind', 'roles', 'left', 'right']),
} as const;
/** The fields of a design file itself (`versions` is what files of the first version of the format carried). */
const FILE_FIELDS = new Set(['format', 'version', 'units', 'id', 'name', 'revision', 'parent', 'device', 'saved', 'thumb', 'scene', 'assets', 'robot', 'versions']);

/** A text curve as saved, if it is one: a kind, an angle in range, a side and a thickness. */
function curveOf(raw: unknown): TextCurve | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  only(c, CURVE_FIELDS);
  const kind = oneOf<'bend' | 'arc'>(c.kind, (k) => k === 'bend' || k === 'arc');
  if (!kind) return null;
  const angle = typeof c.angle === 'number' && Number.isFinite(c.angle) ? clampAngle(c.angle) : null;
  const thickness = typeof c.thickness === 'number' && Number.isFinite(c.thickness) && c.thickness > 0 ? c.thickness : null;
  if (angle === null || thickness === null) return null;
  return { kind, angle, flip: c.flip === true, thickness };
}

function vec3(v: unknown, fallback: Vec3, positive = false): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) return fallback;
  const out = v.map((x, i) => (typeof x === 'number' && Number.isFinite(x) && (!positive || x > 0) ? x : fallback[i]));
  return out as Vec3;
}

function readNode(raw: unknown, assets: Record<string, Asset>, depth: number): SceneNode | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  if (depth > MAX_NESTING) throw new Error(tr('This design is nested too deeply.'));
  only(raw, NODE_FIELDS);
  const base = {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : tr('Object'),
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
    const outer: SceneNode = { ...plain, id: `${base.id}o`, name: tr('Outer'), pos: [0, 0, 0], rot: [0, 0, 0], hole: false, type: 'shape', shape: 'cylinder', params: cylinder(base.size) };
    const inner: SceneNode = { ...outer, id: `${base.id}i`, name: tr('Bore'), hole: true, size: bore, params: cylinder(bore) };
    return { ...base, type: 'group', natural: base.size, children: [outer, inner] };
  }
  if (raw.type === 'shape') {
    const shape = oneOf<ShapeKind>(raw.shape, (k) => KINDS.has(k));
    if (!shape) return null;
    const params = { ...defaultParams(shape) };
    if (isRecord(raw.params)) {
      // A setting this build's shape does not have.
      only(raw.params, new Set(Object.keys(params)));
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
    const mapping = oneOf<'wrap' | 'flat'>(raw.mapping, (m) => m === 'wrap' || m === 'flat') ?? 'flat';
    const angle = typeof raw.angle === 'number' && Number.isFinite(raw.angle) ? Math.min(360, Math.max(1, raw.angle)) : 120;
    const { texture: _dropped, ...plain } = base;
    return { ...plain, type: 'picture', asset: raw.asset, mapping, angle, hole: false, natural: [1, 1, 1] };
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
    if (!oneOf(part, (id) => GENERATORS.some((g) => g.id === id))) return null;
    const def = getGenerator(part);
    // A setting this build's part does not have would be dropped, and a choice it does not offer would come back as the first one that it does.
    if (rawParams) only(rawParams, new Set(def.groups.flatMap((g) => g.params.map((d) => d.key))));
    for (const g of def.groups) for (const d of g.params) if (d.type === 'select') oneOf(rawParams?.[d.key], (v) => d.options.some((o) => o.value === v));
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
      font: oneOf(raw.font, (id) => TEXT_FONTS.some((f) => f.id === id)) ?? TEXT_FONTS[0].id,
      align: oneOf<'left' | 'center' | 'right'>(raw.align, (a) => a === 'left' || a === 'center' || a === 'right') ?? 'left',
      ...(curveOf(raw.curve) ? { curve: curveOf(raw.curve)! } : {}),
      natural: vec3(raw.natural, base.size, true),
    };
  }
  if (raw.type === 'group') {
    const children = readScene(raw.children, assets, depth + 1);
    if (children.length === 0) return null;
    // Groups from before `mixed` existed were drawn in one color, and still are.
    return { ...base, type: 'group', ...(raw.mixed === true ? { mixed: true } : {}), natural: vec3(raw.natural, base.size, true), children };
  }
  // The kinds read above are all there are.
  oneOf(raw.type, () => false);
  return null;
}

/** A texture whose image is in the design; anything else is left off. */
function readTexture(raw: unknown, assets: Record<string, Asset>): { texture: Texture } | null {
  if (!isRecord(raw) || typeof raw.asset !== 'string' || assets[raw.asset]?.kind !== 'image') return null;
  only(raw, TEXTURE_FIELDS);
  const scale = typeof raw.scale === 'number' && Number.isFinite(raw.scale) && raw.scale > 0 ? raw.scale : 50;
  const turn = typeof raw.turn === 'number' && Number.isFinite(raw.turn) ? raw.turn : 0;
  return { texture: { asset: raw.asset, mode: oneOf<Texture['mode']>(raw.mode, (m) => m === 'tile' || m === 'own' || m === 'wrap') ?? 'wrap', scale, turn } };
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
      if (px(value.width) && px(value.height)) out[key] = { kind: 'image', name: typeof value.name === 'string' ? value.name : tr('Picture'), mime: value.mime, data: value.data, width: px(value.width), height: px(value.height) };
    } else {
      // The three kinds read above are all there are.
      oneOf(value.kind, () => false);
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
    only(x, ROBOT_FIELDS.sensor);
    if (isRecord(x.camera)) only(x.camera, ROBOT_FIELDS.camera);
    if (isRecord(x.lidar)) only(x.lidar, ROBOT_FIELDS.lidar);
    const kind = oneOf<SensorKind>(x.kind, (k) => SENSORS.has(k));
    if (!kind) continue;
    seen.add(x.id);
    const base = defaultSensor(x.id, typeof x.name === 'string' && x.name.trim() ? x.name : 'sensor', kind, x.link, vec3(x.origin, [0, 0, 0]));
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
  if (isRecord(raw)) only(raw, ROBOT_FIELDS.mass);
  if (isRecord(raw) && raw.kind === 'measured') return { kind: 'measured', grams: Math.max(0, finite(raw.grams, 0)) };
  const r = isRecord(raw) ? raw : {};
  oneOf(r.kind, (k) => k === 'material');
  return { kind: 'material', material: typeof r.material === 'string' ? r.material : 'pla', infill: Math.min(100, Math.max(0, finite(r.infill, 20))), shell: Math.max(0, finite(r.shell, 1.2)) };
}

/** The drive of a file: its kind and each joint's role, or the two sides of the differential drive files once held. Undefined without a kind or a joint. */
function readDrive(raw: unknown, joints: Set<string>): Drive | undefined {
  if (!isRecord(raw)) return undefined;
  only(raw, ROBOT_FIELDS.drive);
  const roles: Record<string, DriveRole> = {};
  const kinds = DRIVE_KINDS.find((k) => k.id === oneOf(raw.kind, (id) => DRIVE_KINDS.some((d) => d.id === id)));
  if (kinds && isRecord(raw.roles)) {
    for (const [id, role] of Object.entries(raw.roles)) if (joints.has(id) && oneOf(role, (r) => kinds.roles.some((known) => known.id === r))) roles[id] = role as DriveRole;
    return { kind: kinds.id, roles };
  }
  const side = (v: unknown, role: DriveRole) => {
    if (Array.isArray(v)) for (const id of v) if (typeof id === 'string' && joints.has(id)) roles[id] = role;
  };
  side(raw.left, 'left');
  side(raw.right, 'right');
  return Object.keys(roles).length ? { kind: 'differential', roles } : undefined;
}

/** The robot of a file, with anything that names an object the scene no longer has left off. Undefined when there is none. */
function readRobot(raw: unknown, scene: Scene): Robot | undefined {
  if (!isRecord(raw)) return undefined;
  only(raw, ROBOT_FIELDS.robot);
  const ids = new Set(scene.map((n) => n.id));
  const links: RobotLink[] = [];
  const seenLinks = new Set<string>();
  if (Array.isArray(raw.links)) {
    for (const l of raw.links) {
      if (!isRecord(l) || typeof l.node !== 'string' || !ids.has(l.node) || seenLinks.has(l.node)) continue;
      only(l, ROBOT_FIELDS.link);
      seenLinks.add(l.node);
      links.push({
        node: l.node,
        ...(typeof l.name === 'string' && l.name.trim() ? { name: l.name } : {}),
        mass: readMass(l.mass),
        collision: oneOf<CollisionKind>(l.collision, (c) => COLLISIONS.has(c)) ?? 'hull',
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
      only(j, ROBOT_FIELDS.joint);
      if (isRecord(j.mimic)) only(j.mimic, ROBOT_FIELDS.mimic);
      seenJoints.add(j.id);
      const axis = vec3(j.axis, [0, 0, 1]);
      joints.push({
        id: j.id,
        name: typeof j.name === 'string' && j.name.trim() ? j.name : 'joint',
        type: oneOf<JointType>(j.type, (t) => JOINT_KINDS.has(t)) ?? 'revolute',
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
        ...(typeof j.motor === 'string' ? { motor: j.motor } : {}),
      });
    }
  }
  // A follower whose leader is gone follows nothing.
  for (const j of joints) if (j.mimic && !seenJoints.has(j.mimic.joint)) delete j.mimic;
  const drive = readDrive(raw.drive, seenJoints);
  const world = oneOf<NonNullable<Robot['world']>>(raw.world, (w) => WORLDS.some((known) => known.id === w));
  return {
    root: typeof raw.root === 'string' && ids.has(raw.root) ? raw.root : null,
    // Files from before the setting: a robot with a drive stood free, any other was welded down.
    base: oneOf<Robot['base']>(raw.base, (b) => b === 'fixed' || b === 'free') ?? (isRecord(raw.drive) ? 'free' : 'fixed'),
    links,
    joints,
    sensors: readSensors(raw.sensors, ids),
    ...(drive ? { drive } : {}),
    control: raw.control !== false,
    ...(world && world !== 'flat' ? { world } : {}),
    ...(raw.scripts === false ? { scripts: false } : {}),
  };
}

function parseFile(text: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(tr('This file is not a design: it could not be read as JSON.'));
  }
  if (!isRecord(raw) || (raw.format !== FILE_FORMAT && raw.format !== LEGACY_FORMAT)) throw new Error(tr('This file is not a design made with this app.'));
  if (typeof raw.version !== 'number') throw new Error(tr('This file is not a design made with this app: it does not say which version of the format it is in.'));
  // A later version of the format may be laid out in another way: for a copy it is read as far as it can be.
  if (raw.version > FILE_VERSION && !stripping) throw new NewerVersion();
  strict = raw.version >= STRICT_FROM;
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
  // Something of the design itself that a newer build wrote.
  only(raw, FILE_FIELDS);
  const assets = readAssets(raw.assets);
  const thumb = readThumb(raw.thumb);
  const doc: Doc = { id: readId(raw.id), name: readName(raw.name, tr('Untitled')), scene: readScene(raw.scene, assets), assets };
  if (thumb) doc.thumb = thumb;
  const robot = readRobot(raw.robot, doc.scene);
  if (robot) doc.robot = robot;
  const revision = readRevision(raw.revision);
  if (revision) doc.revision = revision;
  const parent = readRevision(raw.parent);
  if (parent) doc.parent = parent;
  const device = readRevision(raw.device);
  if (device) doc.device = device;
  // Kept as the app writes it, in UTC, whatever offset it came with.
  const saved = savedTime(raw.saved);
  if (saved !== null) doc.saved = new Date(saved).toISOString();
  return doc;
}

/**
 * A design a newer version of the app saved, read for a copy of it: what this build does not know
 * is left out (an object of a kind it has not got) or set to what it does know (a choice it does
 * not offer), and `left` says how many such things there were. The copy is this build's own from
 * then on; the file it was read from is not for writing back to.
 */
export function parseDocWithout(text: string): { doc: Doc; left: number } {
  stripping = true;
  left = 0;
  try {
    return { doc: parseDoc(text), left };
  } finally {
    stripping = false;
  }
}

const readRevision = (raw: unknown): string | null => (typeof raw === 'string' && /^[a-z0-9]{8,32}$/.test(raw) ? raw : null);

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * When a design says it was saved, in ms since the epoch, or null when it does
 * not say so in a way every device reads alike. Only the form the app writes
 * is taken (ISO 8601 with its offset, as `toISOString` gives it) and it is
 * worked out here rather than left to `Date.parse`, which takes other
 * spellings on one engine and not on another, and reads some of them in the
 * device's own time zone. A time no design could have been saved at (before
 * 2000, or centuries on) is not believed either.
 */
export function savedTime(raw: unknown): number | null {
  const m = typeof raw === 'string' ? STAMP.exec(raw) : null;
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const ms = Math.floor(Number(`0.${m[7] ?? '0'}`) * 1000);
  const offset = m[8] === 'Z' ? 0 : (m[8][0] === '-' ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(4, 6)));
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  // A day or an hour that does not exist rolls over into the next: such a stamp is not one.
  const back = new Date(utc);
  if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day || back.getUTCHours() !== hour || minute > 59 || second > 59) return null;
  const time = utc - offset * 60_000;
  return time >= Date.UTC(2000, 0, 1) && time < Date.UTC(2200, 0, 1) ? time : null;
}

export interface DocHeader {
  /** Null when the file carries no id (saved before projects had them). */
  id: string | null;
  name: string;
  /** Null when the file was saved before revisions were stamped. */
  revision: string | null;
  /** When the design was last saved, by its own word, in ms since the epoch; null when it does not say. */
  saved: number | null;
  thumb: string | null;
}

/**
 * The header of a design from the start of its text, which need not be the
 * whole file: `serializeDoc` puts each header field on its own line before
 * the scene. Null when the text is not the start of a design file.
 */
export function readHeader(head: string): DocHeader | null {
  // Spaces and tabs only between the start of a line and its field: with any white space allowed there, every blank
  // line of a padded file was a place to start over from, and a quarter of a megabyte of them took a minute to read.
  if (!/^\{[ \t\r]*\n[ \t]*"format": "(?:plastikcad|bashcad)",/.test(head)) return null;
  // Only what comes before the scene is the header: the objects in it have ids and names of their own.
  const sceneAt = head.search(/^[ \t]*"scene":/m);
  const header = sceneAt < 0 ? head : head.slice(0, sceneAt);
  const field = (name: string): string | null => {
    const match = new RegExp(`^[ \\t]*"${name}": ("(?:[^"\\\\]|\\\\.)*")[ \\t]*,?\\r?$`, 'm').exec(header);
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
  return { id: readRevision(id), name: readName(name, tr('Untitled')), revision: readRevision(field('revision')), saved: savedTime(field('saved')), thumb: readThumb(field('thumb') ?? undefined) ?? null };
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
  const name = readName(raw.name, tr('Untitled'));
  const out: Doc[] = [];
  for (const v of raw.versions) {
    if (!isRecord(v)) continue;
    const scene = readScene(v.scene, assets);
    if (scene.length === 0) continue;
    const label = readName(v.label, tr('Version {n}', { n: out.length + 1 }));
    out.push({ id: newId(), name: `${name} - ${label}`, scene, assets });
  }
  return out;
}
