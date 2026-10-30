// Reads a robot in from URDF, the other way round from `src/robot/export.ts`:
// every link with a shape becomes an object standing where the file puts it,
// the joints hang the objects from the base as the file has them, and the
// Gazebo blocks give the friction, the sensors and the drive. Links without
// a shape (frames, a `world` link, a `base_footprint`) are folded into the
// link they are fixed to, since in the design every link is an object. The
// file is in meters and radians; the design gets millimeters and degrees.
import { defaultParams } from '../geometry/shapes';
import type { MeshData } from '../geometry/mesh';
import { apply, boxBounds, eulerOf, IDENTITY, invert, multiply, rotation, tidyVec } from '../model/math';
import type { Mat } from '../model/math';
import { newId } from '../model/ops';
import type { Asset, SceneNode, ShapeKind, Vec3 } from '../model/types';
import { jointFit } from '../robot/defaults';
import { jointInChild, linkNodes, sensorInLink } from '../robot/model';
import { DEFAULT_MASS, defaultJoint, defaultLink, defaultSensor } from '../robot/types';
import type { CollisionKind, DriveKind, DriveRole, JointType, Robot, RobotJoint, RobotLink, RobotSensor, SensorKind } from '../robot/types';
import { encodeFloat32, encodeUint32 } from './base64';
import { centerMesh, IMPORT_EXTENSIONS, importFile } from './import';
import type { Companion } from './import';
import { urdfName } from './urdf';
import { MeshBuilder } from './weld';
import { childOf, childrenOf, localName, xmlTree } from './xml';
import type { XmlElement } from './xml';

/** What a URDF file becomes: objects, their meshes, and the robot over them. */
export interface ImportedRobot {
  /** The robot's name in the file, made readable. */
  name: string;
  scene: SceneNode[];
  assets: Record<string, Asset>;
  robot: Robot;
  warnings: string[];
  /** Mesh files the URDF names that did not come along and could be read if they did. */
  missing: string[];
}

const MM = 1000;
const DEG = 180 / Math.PI;
/** The default color of an imported object that brought none, as in the store. */
const IMPORT_COLOR = '#8fa3bf';
/** A link that moves but has no shape of its own gets a small box to stand for it, mm. */
const PLACEHOLDER = 10;

type Geometry = { mesh: string; scale: Vec3 } | { box: Vec3 } | { cylinder: { radius: number; length: number } } | { sphere: { radius: number } };

/** A visual or collision shape in its link's frame, mm. */
interface Shape {
  geometry: Geometry;
  pose: Mat;
  color?: string;
}

interface Link {
  name: string;
  visuals: Shape[];
  collisions: Shape[];
  grams: number | null;
}

interface Joint {
  name: string;
  type: string;
  parent: string;
  child: string;
  /** The child's frame in the parent's, mm. */
  pose: Mat;
  /** In the child's frame. */
  axis: Vec3;
  limit?: { lower?: number; upper?: number; effort?: number; velocity?: number };
  dynamics?: { damping?: number; friction?: number };
  mimic?: { joint: string; multiplier: number; offset: number };
}

const numbers = (text: string | undefined): number[] => (text ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
const vec3 = (text: string | undefined, fallback: Vec3): Vec3 => {
  const v = numbers(text);
  return v.length === 3 && v.every(Number.isFinite) ? (v as Vec3) : fallback;
};
const num = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const v = Number(text.trim());
  return Number.isFinite(v) ? v : undefined;
};

/** A frame from a position in meters and roll, pitch, yaw in radians, as a matrix in mm and the design's turn. */
function frame(xyz: Vec3, rpy: Vec3): Mat {
  const m = rotation(rpy.map((r) => r * DEG) as Vec3);
  m[9] = xyz[0] * MM;
  m[10] = xyz[1] * MM;
  m[11] = xyz[2] * MM;
  return m;
}

/** The `<origin xyz rpy>` of an element, the identity when it has none. */
const originOf = (element: XmlElement | undefined): Mat => {
  const origin = element && childOf(element, 'origin');
  return frame(vec3(origin?.attrs.xyz, [0, 0, 0]), vec3(origin?.attrs.rpy, [0, 0, 0]));
};

const rotationOf = (m: Mat): Mat => [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], 0, 0, 0];
const translationOf = (m: Mat): Vec3 => [m[9], m[10], m[11]];

/** A name as the file has it, made readable: underscores become spaces. */
export const readable = (raw: string): string => raw.replace(/_+/g, ' ').trim() || raw;

const hexOf = (rgba: string | undefined): string | undefined => {
  const v = numbers(rgba);
  if (v.length < 3 || !v.slice(0, 3).every(Number.isFinite)) return undefined;
  return `#${v
    .slice(0, 3)
    .map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
};

function geometryOf(element: XmlElement | undefined): Geometry | null {
  const g = element && childOf(element, 'geometry');
  if (!g) return null;
  const mesh = childOf(g, 'mesh');
  if (mesh?.attrs.filename) return { mesh: mesh.attrs.filename, scale: vec3(mesh.attrs.scale, [1, 1, 1]) };
  const box = childOf(g, 'box');
  if (box) return { box: vec3(box.attrs.size, [0.1, 0.1, 0.1]).map((x) => x * MM) as Vec3 };
  const cylinder = childOf(g, 'cylinder');
  if (cylinder) return { cylinder: { radius: (num(cylinder.attrs.radius) ?? 0.05) * MM, length: (num(cylinder.attrs.length) ?? 0.1) * MM } };
  const sphere = childOf(g, 'sphere');
  if (sphere) return { sphere: { radius: (num(sphere.attrs.radius) ?? 0.05) * MM } };
  return null;
}

/** The mesh files the URDF names, as written (`package://…`, `file://…`, or a path), so that the caller can fetch them before reading the robot. */
export function urdfMeshFiles(bytes: Uint8Array): string[] {
  const root = xmlTree(bytes);
  const out = new Set<string>();
  const walk = (el: XmlElement) => {
    if (localName(el.name) === 'mesh' && el.attrs.filename) out.add(el.attrs.filename);
    for (const c of el.children) walk(c);
  };
  if (root) walk(root);
  return [...out];
}

/** The path inside the package: `package://pkg/meshes/a.stl` → `meshes/a.stl`; a plain or `file://` path as it is, without a leading slash. */
export function meshPath(filename: string): string {
  const slashes = filename.replace(/\\/g, '/');
  const scheme = /^(package|model):\/\/[^/]+\/(.*)$/.exec(slashes);
  if (scheme) return scheme[2];
  return slashes.replace(/^file:\/\//, '').replace(/^\/+/, '');
}

const extensionOf = (name: string): string => /\.([^./\\]+)$/.exec(name)?.[1].toLowerCase() ?? '';

/** The companion a mesh reference names: by the longest tail of its path that a companion's name ends with, down to the bare file name, ignoring case. */
function findMesh(companions: Companion[], filename: string): Companion | undefined {
  const parts = meshPath(filename).toLowerCase().split('/').filter(Boolean);
  for (let from = 0; from < parts.length; from++) {
    const tail = parts.slice(from).join('/');
    const found = companions.find((c) => {
      const name = c.name.replace(/\\/g, '/').toLowerCase();
      return name === tail || name.endsWith(`/${tail}`);
    });
    if (found) return found;
  }
  return undefined;
}

// --- shapes ------------------------------------------------------------------

/** Adds a mesh to the builder, each vertex carried through `m`; a mirroring transform has the triangles turned round to keep them facing out. */
function addMesh(builder: MeshBuilder, mesh: MeshData, m: Mat): void {
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7]) + m[6] * (m[1] * m[5] - m[2] * m[4]);
  const index = new Uint32Array(mesh.positions.length / 3);
  for (let i = 0; i < index.length; i++) {
    const p = apply(m, [mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]]);
    index[i] = builder.vertex(p[0], p[1], p[2]);
  }
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    if (det < 0) builder.triangle(index[t[i]], index[t[i + 2]], index[t[i + 1]]);
    else builder.triangle(index[t[i]], index[t[i + 1]], index[t[i + 2]]);
  }
}

/** A primitive as triangles, centered, in mm: for links that mix primitives and meshes. */
function tessellate(g: Exclude<Geometry, { mesh: string }>): MeshData {
  const positions: number[] = [];
  const triangles: number[] = [];
  const push = (p: Vec3): number => {
    positions.push(p[0], p[1], p[2]);
    return positions.length / 3 - 1;
  };
  if ('box' in g) {
    const [w, d, h] = g.box.map((x) => x / 2);
    for (const z of [-h, h]) for (const y of [-d, d]) for (const x of [-w, w]) push([x, y, z]);
    triangles.push(0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 5, 0, 5, 4, 1, 3, 7, 1, 7, 5, 3, 2, 6, 3, 6, 7, 2, 0, 4, 2, 4, 6);
  } else if ('cylinder' in g) {
    const n = 32;
    const r = g.cylinder.radius;
    const h = g.cylinder.length / 2;
    const bottom = push([0, 0, -h]);
    const top = push([0, 0, h]);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      push([r * Math.cos(a), r * Math.sin(a), -h]);
      push([r * Math.cos(a), r * Math.sin(a), h]);
    }
    for (let i = 0; i < n; i++) {
      const b0 = 2 + 2 * i;
      const b1 = 2 + 2 * ((i + 1) % n);
      triangles.push(bottom, b1, b0, top, b0 + 1, b1 + 1, b0, b1, b1 + 1, b0, b1 + 1, b0 + 1);
    }
  } else {
    const rings = 16;
    const segments = 32;
    const r = g.sphere.radius;
    for (let i = 0; i <= rings; i++) {
      const phi = (Math.PI * i) / rings;
      for (let j = 0; j < segments; j++) {
        const theta = (2 * Math.PI * j) / segments;
        push([r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi)]);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segments; j++) {
        const a = i * segments + j;
        const b = i * segments + ((j + 1) % segments);
        const c = a + segments;
        const d = b + segments;
        if (i > 0) triangles.push(a, c, b);
        if (i < rings - 1) triangles.push(b, c, d);
      }
    }
  }
  return { positions: Float32Array.from(positions), triangles: Uint32Array.from(triangles) };
}

type LinkShape = { kind: 'mesh'; mesh: MeshData; color?: string } | { kind: 'shape'; shape: ShapeKind; size: Vec3; pose: Mat; color?: string };

/**
 * The object a link becomes: its one primitive, as a shape; or all its
 * visuals as one mesh in the link's frame. A link whose visuals cannot be
 * read shows its collision shapes instead.
 */
function shapeOf(link: Link, companions: Companion[], warnings: string[], missing: Set<string>): LinkShape | null {
  const primitive = (s: Shape): LinkShape | null => {
    const g = s.geometry;
    if ('box' in g) return { kind: 'shape', shape: 'box', size: g.box, pose: s.pose, color: s.color };
    if ('cylinder' in g) return { kind: 'shape', shape: 'cylinder', size: [g.cylinder.radius * 2, g.cylinder.radius * 2, g.cylinder.length], pose: s.pose, color: s.color };
    if ('sphere' in g) return { kind: 'shape', shape: 'sphere', size: [g.sphere.radius * 2, g.sphere.radius * 2, g.sphere.radius * 2], pose: s.pose, color: s.color };
    return null;
  };
  const build = (shapes: Shape[]): LinkShape | null => {
    if (shapes.length === 1 && !('mesh' in shapes[0].geometry)) return primitive(shapes[0]);
    const builder = new MeshBuilder();
    let color: string | undefined;
    for (const s of shapes) {
      const g = s.geometry;
      if (!('mesh' in g)) {
        addMesh(builder, tessellate(g), s.pose);
        color ??= s.color;
        continue;
      }
      const file = findMesh(companions, g.mesh);
      const name = meshPath(g.mesh).split('/').pop() ?? g.mesh;
      if (!file) {
        if (IMPORT_EXTENSIONS.includes(extensionOf(name))) missing.add(g.mesh);
        else warnings.push(`"${link.name}" is drawn with "${name}", a kind of mesh file that cannot be read.`);
        continue;
      }
      let parts: { mesh: MeshData; color?: string }[];
      try {
        const data = importFile(file.name, file.bytes, companions);
        parts = data.kind === 'model' ? data.parts : [];
      } catch (e) {
        warnings.push(`"${link.name}" is drawn with "${name}", which could not be read: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // The file is in meters, scaled as the URDF says; the design holds mm.
      const scaled: Mat = [...s.pose] as Mat;
      for (let k = 0; k < 3; k++) {
        const f = g.scale[k] * MM;
        scaled[3 * k] *= f;
        scaled[3 * k + 1] *= f;
        scaled[3 * k + 2] *= f;
      }
      for (const part of parts) {
        addMesh(builder, part.mesh, scaled);
        color ??= s.color ?? part.color;
      }
    }
    if (builder.size === 0) return null;
    return { kind: 'mesh', mesh: builder.finish(), color };
  };
  const visual = build(link.visuals);
  if (visual) return visual;
  if (link.collisions.length === 0) return null;
  const collision = build(link.collisions);
  if (collision && link.visuals.length) warnings.push(`"${link.name}" is shown by its collision shape, as its visual could not be read.`);
  return collision;
}

/** The collision setting that fits what the file gives the link. */
function collisionOf(link: Link): CollisionKind {
  if (link.collisions.length === 0) return 'none';
  if (link.collisions.length === 1) {
    const g = link.collisions[0].geometry;
    if ('box' in g) return 'box';
    if ('cylinder' in g) return 'cylinder';
    if ('sphere' in g) return 'sphere';
  }
  return 'hull';
}

// --- the file ----------------------------------------------------------------

function readShape(element: XmlElement, materials: Map<string, string>): Shape | null {
  const geometry = geometryOf(element);
  if (!geometry) return null;
  const material = childOf(element, 'material');
  const color = material ? (hexOf(childOf(material, 'color')?.attrs.rgba) ?? (material.attrs.name ? materials.get(material.attrs.name) : undefined)) : undefined;
  return { geometry, pose: originOf(element), color };
}

function readJoint(element: XmlElement): Joint | null {
  const parent = childOf(element, 'parent')?.attrs.link;
  const child = childOf(element, 'child')?.attrs.link;
  if (!parent || !child) return null;
  const limit = childOf(element, 'limit');
  const dynamics = childOf(element, 'dynamics');
  const mimic = childOf(element, 'mimic');
  return {
    name: element.attrs.name ?? 'joint',
    type: element.attrs.type ?? 'fixed',
    parent,
    child,
    pose: originOf(element),
    axis: vec3(childOf(element, 'axis')?.attrs.xyz, [1, 0, 0]),
    limit: limit ? { lower: num(limit.attrs.lower), upper: num(limit.attrs.upper), effort: num(limit.attrs.effort), velocity: num(limit.attrs.velocity) } : undefined,
    dynamics: dynamics ? { damping: num(dynamics.attrs.damping), friction: num(dynamics.attrs.friction) } : undefined,
    mimic: mimic?.attrs.joint ? { joint: mimic.attrs.joint, multiplier: num(mimic.attrs.multiplier) ?? 1, offset: num(mimic.attrs.offset) ?? 0 } : undefined,
  };
}

const SENSOR_KINDS: Record<string, SensorKind> = { camera: 'camera', depth_camera: 'depth', depth: 'depth', rgbd_camera: 'depth', gpu_lidar: 'lidar', lidar: 'lidar', gpu_ray: 'lidar', ray: 'lidar', imu: 'imu', contact: 'touch' };

/** A Gazebo `<sensor>` as the design holds one, at `host`, placed from `pose` (its frame in the design). */
function readSensor(element: XmlElement, host: SceneNode, pose: Mat): RobotSensor | null {
  const kind = SENSOR_KINDS[element.attrs.type ?? ''];
  if (!kind) return null;
  const own = numbers(childOf(element, 'pose')?.text);
  const placed = own.length === 6 && own.every(Number.isFinite) ? multiply(pose, frame([own[0], own[1], own[2]], [own[3], own[4], own[5]])) : pose;
  const inLink = sensorInLink(translationOf(placed), eulerOf(rotationOf(placed)), host);
  const sensor = defaultSensor(newId(), readable(element.attrs.name ?? kind), kind, host.id, tidyVec(inLink.origin));
  sensor.rot = tidyVec(inLink.rot);
  const rate = num(childOf(element, 'update_rate')?.text);
  if (rate && rate > 0) sensor.rate = rate;
  const camera = childOf(element, 'camera');
  if (camera) {
    const hfov = num(childOf(camera, 'horizontal_fov')?.text);
    const image = childOf(camera, 'image');
    const clip = childOf(camera, 'clip');
    sensor.camera = {
      hfov: hfov ? Number((hfov * DEG).toFixed(1)) : sensor.camera.hfov,
      width: num(image && childOf(image, 'width')?.text) ?? sensor.camera.width,
      height: num(image && childOf(image, 'height')?.text) ?? sensor.camera.height,
      near: clip && num(childOf(clip, 'near')?.text) !== undefined ? num(childOf(clip, 'near')?.text)! * MM : sensor.camera.near,
      far: clip && num(childOf(clip, 'far')?.text) !== undefined ? num(childOf(clip, 'far')?.text)! * MM : sensor.camera.far,
    };
  }
  const lidar = childOf(element, 'lidar') ?? childOf(element, 'ray');
  if (lidar) {
    const horizontal = childOf(lidar, 'scan') && childOf(childOf(lidar, 'scan')!, 'horizontal');
    const range = childOf(lidar, 'range');
    const min = num(horizontal && childOf(horizontal, 'min_angle')?.text);
    const max = num(horizontal && childOf(horizontal, 'max_angle')?.text);
    sensor.lidar = {
      samples: num(horizontal && childOf(horizontal, 'samples')?.text) ?? sensor.lidar.samples,
      hfov: min !== undefined && max !== undefined ? Number(((max - min) * DEG).toFixed(1)) : sensor.lidar.hfov,
      min: range && num(childOf(range, 'min')?.text) !== undefined ? num(childOf(range, 'min')?.text)! * MM : sensor.lidar.min,
      max: range && num(childOf(range, 'max')?.text) !== undefined ? num(childOf(range, 'max')?.text)! * MM : sensor.lidar.max,
    };
  }
  return sensor;
}

/** The wheel and steering joints a Gazebo drive plugin names, by the part each plays. */
function readDrive(plugin: XmlElement): { kind: DriveKind; roles: [DriveRole, string][] } | null {
  const id = `${plugin.attrs.name ?? ''} ${plugin.attrs.filename ?? ''}`.toLowerCase();
  const names = (tag: string): string[] => childrenOf(plugin, tag).map((c) => c.text).filter(Boolean);
  const roles: [DriveRole, string][] = [];
  const take = (role: DriveRole, ...tags: string[]) => tags.forEach((tag) => names(tag).forEach((n) => roles.push([role, n])));
  if (id.includes('mecanum')) {
    take('front-left', 'front_left_joint');
    take('front-right', 'front_right_joint');
    take('rear-left', 'back_left_joint', 'rear_left_joint');
    take('rear-right', 'back_right_joint', 'rear_right_joint');
    return { kind: 'mecanum', roles };
  }
  if (id.includes('ackermann')) {
    take('left', 'left_joint');
    take('right', 'right_joint');
    take('steer-left', 'left_steering_joint');
    take('steer-right', 'right_steering_joint');
    return { kind: 'ackermann', roles };
  }
  if (id.includes('diff')) {
    take('left', 'left_joint');
    take('right', 'right_joint');
    return { kind: 'differential', roles };
  }
  return null;
}

/**
 * Reads a URDF file and the mesh files that came with it (`companions`, named
 * by their path in the package or just their file name). Throws an Error fit
 * to show the user when the file is not a URDF.
 */
export function parseUrdf(bytes: Uint8Array, companions: Companion[] = []): ImportedRobot {
  const root = xmlTree(bytes);
  if (!root || localName(root.name) !== 'robot') throw new Error('This is not a URDF file: it does not hold a <robot>.');
  if (Object.keys(root.attrs).some((a) => a.startsWith('xmlns:xacro')) || root.children.some((c) => c.name.startsWith('xacro:'))) {
    throw new Error('This is a xacro file. Run it through xacro first (xacro robot.urdf.xacro > robot.urdf) and import the URDF it writes.');
  }
  const warnings: string[] = [];
  const missing = new Set<string>();

  // The file's parts.
  const materials = new Map<string, string>();
  for (const m of childrenOf(root, 'material')) {
    const color = hexOf(childOf(m, 'color')?.attrs.rgba);
    if (m.attrs.name && color) materials.set(m.attrs.name, color);
  }
  const links = new Map<string, Link>();
  for (const l of childrenOf(root, 'link')) {
    const name = l.attrs.name;
    if (!name || links.has(name)) continue;
    const kg = num(childOf(l, 'inertial') && childOf(childOf(l, 'inertial')!, 'mass')?.attrs.value);
    links.set(name, {
      name,
      visuals: childrenOf(l, 'visual').map((v) => readShape(v, materials)).filter((s): s is Shape => s !== null),
      collisions: childrenOf(l, 'collision').map((c) => readShape(c, materials)).filter((s): s is Shape => s !== null),
      grams: kg !== undefined && kg > 0 ? Number((kg * MM).toFixed(2)) : null,
    });
  }
  if (links.size === 0) throw new Error('This URDF has no links.');
  const joints = childrenOf(root, 'joint')
    .map(readJoint)
    .filter((j): j is Joint => j !== null && links.has(j.child) && j.parent !== j.child);
  for (const j of joints) if (!links.has(j.parent)) warnings.push(`Joint "${j.name}" hangs "${j.child}" from "${j.parent}", which the file does not have; "${j.child}" stands on its own.`);
  const parentJoint = new Map<string, Joint>();
  for (const j of joints) {
    if (parentJoint.has(j.child)) {
      warnings.push(`"${j.child}" hangs from two joints; "${j.name}" was left out, as URDF allows one.`);
      continue;
    }
    if (links.has(j.parent)) parentJoint.set(j.child, j);
  }

  // Where every link's frame is, from the roots down (mm), parents before children.
  const poses = new Map<string, Mat>();
  const order: string[] = [];
  const roots = [...links.keys()].filter((name) => !parentJoint.has(name));
  const visit = (name: string, pose: Mat) => {
    if (poses.has(name)) return;
    poses.set(name, pose);
    order.push(name);
    for (const j of joints) if (j.parent === name && parentJoint.get(j.child) === j) visit(j.child, multiply(pose, j.pose));
  };
  for (const name of roots) visit(name, IDENTITY);
  for (const name of links.keys()) if (!poses.has(name)) warnings.push(`"${name}" hangs in a loop of joints and was left out.`);

  // Every link with a shape is an object; one that moves without a shape gets a small box to stand for it.
  const shapes = new Map<string, LinkShape>();
  for (const name of order) {
    const link = links.get(name)!;
    const shape = shapeOf(link, companions, warnings, missing);
    const joint = parentJoint.get(name);
    if (shape) shapes.set(name, shape);
    else if (joint && isMoving(joint.type)) {
      shapes.set(name, { kind: 'shape', shape: 'box', size: [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER], pose: IDENTITY });
      warnings.push(`"${name}" moves but has no shape; a small box stands for it.`);
    } else if (link.grams && link.grams > 0 && !joint) warnings.push(`"${name}" has mass but no shape; its mass was dropped.`);
  }
  const kept = (name: string): boolean => shapes.has(name);
  /** The nearest link up the chain that is an object. */
  const ancestor = (name: string): string | null => {
    for (let j = parentJoint.get(name); j; j = parentJoint.get(j.parent)) if (kept(j.parent)) return j.parent;
    return null;
  };
  const keptOrder = order.filter(kept);
  if (keptOrder.length === 0) throw new Error('No link in this URDF has a shape that can be shown.');
  const base = keptOrder[0];
  // The design's frame is the base link's; a frame-only root above it (world, base_footprint) is folded away.
  const toDesign = invert(poses.get(base)!);
  const designPose = (name: string): Mat => multiply(toDesign, poses.get(name)!);

  // The objects.
  const scene: SceneNode[] = [];
  const assets: Record<string, Asset> = {};
  const nodeOf = new Map<string, SceneNode>();
  for (const name of keptOrder) {
    const shape = shapes.get(name)!;
    const id = newId();
    const common = { id, name: readable(name), hole: false, color: shape.color ?? IMPORT_COLOR };
    let node: SceneNode;
    if (shape.kind === 'shape') {
      const placed = multiply(designPose(name), shape.pose);
      node = { ...common, type: 'shape', shape: shape.shape, params: defaultParams(shape.shape), pos: tidyVec(translationOf(placed)), rot: eulerOf(rotationOf(placed)), size: tidyVec(shape.size) };
    } else {
      const { size, center } = centerMesh(shape.mesh);
      if (!size.every((v) => v > 0)) {
        warnings.push(`"${name}" is flat or empty and was left out.`);
        continue;
      }
      const asset: Asset = { kind: 'mesh', positions: encodeFloat32(shape.mesh.positions), triangles: encodeUint32(shape.mesh.triangles) };
      const key = `mesh-${id}`;
      assets[key] = asset;
      const pose = designPose(name);
      node = { ...common, type: 'import', asset: key, natural: tidyVec(size), size: tidyVec(size), pos: tidyVec(apply(pose, center)), rot: eulerOf(rotationOf(pose)) };
    }
    scene.push(node);
    nodeOf.set(name, node);
  }
  // Standing on the plate: the lowest point of the robot at z = 0.
  const floor = Math.min(...scene.map((n) => boxBounds(n).min[2]));
  if (Number.isFinite(floor) && Math.abs(floor) > 1e-6) for (const n of scene) n.pos = tidyVec([n.pos[0], n.pos[1], n.pos[2] - floor]);
  const lifted: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, Number.isFinite(floor) ? -floor : 0];
  const inDesign = (name: string): Mat => multiply(lifted, designPose(name));

  // The robot over them.
  const robotLinks: RobotLink[] = [];
  const frictionOf = new Map<string, number>();
  const gazebos = childrenOf(root, 'gazebo');
  for (const g of gazebos) {
    const mu = num(childOf(g, 'mu1')?.text);
    if (g.attrs.reference && mu !== undefined) frictionOf.set(g.attrs.reference, mu);
  }
  for (const name of keptOrder) {
    const link = links.get(name)!;
    const node = nodeOf.get(name);
    if (!node) continue;
    const made: RobotLink = { ...defaultLink(node.id), mass: link.grams ? { kind: 'measured', grams: link.grams } : DEFAULT_MASS, collision: collisionOf(link) };
    const friction = frictionOf.get(name);
    if (friction !== undefined) made.friction = friction;
    if (urdfName(node.name) !== name) made.name = name;
    robotLinks.push(made);
  }

  const robotJoints: RobotJoint[] = [];
  const jointIds = new Map<string, string>();
  const robot: Robot = { root: nodeOf.get(base)!.id, base: roots.includes('world') ? 'fixed' : 'free', links: robotLinks, joints: robotJoints, sensors: [], control: false };
  /** The figures the file leaves out of each joint, to be fitted to what the joint moves once the robot is whole. */
  const unfitted = new Map<string, Set<'effort' | 'velocity' | 'damping'>>();
  const fitLater = (id: string, what: 'effort' | 'velocity' | 'damping') => (unfitted.get(id) ?? unfitted.set(id, new Set()).get(id)!).add(what);
  for (const name of keptOrder) {
    if (name === base) continue;
    const child = nodeOf.get(name);
    if (!child) continue;
    const joint = parentJoint.get(name);
    const above = ancestor(name);
    const parent = above ? nodeOf.get(above) : undefined;
    const pose = inDesign(name);
    const axis = apply(rotationOf(pose), joint?.axis ?? [0, 0, 1]);
    const inChild = jointInChild(translationOf(pose), axis, child);
    const id = newId();
    if (!joint || !parent) {
      // Nothing above it to hang from: fixed to the base where it stands.
      if (joint && isMoving(joint.type)) warnings.push(`Joint "${joint.name}" was dropped: nothing above "${name}" has a shape to hang it from. "${name}" is fixed to the base.`);
      else if (!joint && name !== base) warnings.push(`"${name}" was not attached to anything; it is fixed to the base where it stands.`);
      robotJoints.push({ ...defaultJoint(id, `${readable(name)} joint`, nodeOf.get(base)!.id, child.id, tidyVec(inChild.origin)), type: 'fixed' });
      continue;
    }
    let type: JointType;
    if (joint.type === 'revolute' || joint.type === 'continuous' || joint.type === 'prismatic' || joint.type === 'fixed') type = joint.type;
    else {
      warnings.push(`Joint "${joint.name}" is ${joint.type === 'floating' ? 'floating' : joint.type === 'planar' ? 'planar' : `of type "${joint.type}"`}, which the design cannot hold; it was made fixed.`);
      type = 'fixed';
    }
    const scale = type === 'prismatic' ? MM : DEG;
    const made: RobotJoint = { ...defaultJoint(id, readable(joint.name), parent.id, child.id, tidyVec(inChild.origin)), type, axis: tidyVec(inChild.axis) };
    if (type !== 'fixed') {
      const limit = joint.limit ?? {};
      if (limit.lower !== undefined && limit.upper !== undefined && type !== 'continuous') {
        made.lower = round(limit.lower * scale);
        made.upper = round(limit.upper * scale);
      } else if (type === 'prismatic') {
        made.lower = 0;
        made.upper = 100;
      }
      if (limit.effort !== undefined && limit.effort > 0) made.effort = round(limit.effort);
      else fitLater(id, 'effort');
      if (limit.velocity !== undefined && limit.velocity > 0) made.velocity = round(limit.velocity * scale);
      else fitLater(id, 'velocity');
      if (joint.dynamics?.damping !== undefined) made.damping = round(joint.dynamics.damping);
      else fitLater(id, 'damping');
      if (joint.dynamics?.friction !== undefined) made.friction = round(joint.dynamics.friction);
    }
    jointIds.set(joint.name, id);
    robotJoints.push(made);
  }
  // Followers, once every joint has its id.
  for (const name of keptOrder) {
    const joint = parentJoint.get(name);
    const id = joint && jointIds.get(joint.name);
    if (!joint?.mimic || !id) continue;
    const leader = jointIds.get(joint.mimic.joint);
    const made = robotJoints.find((j) => j.id === id)!;
    if (!leader || made.type === 'fixed') {
      warnings.push(`Joint "${joint.name}" follows "${joint.mimic.joint}", which was not kept; it moves on its own.`);
      continue;
    }
    made.mimic = { joint: leader, multiplier: joint.mimic.multiplier, offset: round(joint.mimic.offset * (made.type === 'prismatic' ? MM : DEG)) };
  }
  // A joint the file gives no figures for gets the ones that fit what it moves.
  const nodes = linkNodes(scene);
  for (const j of robotJoints) {
    const wanted = unfitted.get(j.id);
    if (!wanted) continue;
    const fit = jointFit(robot, nodes, j);
    for (const what of wanted) j[what] = fit[what];
  }

  // Gazebo: sensors on their links, and the drive.
  for (const g of gazebos) {
    const reference = g.attrs.reference;
    if (reference) {
      if (!poses.has(reference)) continue;
      const hostName = kept(reference) ? reference : ancestor(reference);
      const host = hostName ? nodeOf.get(hostName) : undefined;
      for (const s of childrenOf(g, 'sensor')) {
        if (!host) {
          warnings.push(`Sensor "${s.attrs.name ?? s.attrs.type}" sits on "${reference}", which has no shape to carry it; it was left out.`);
          continue;
        }
        const sensor = readSensor(s, host, inDesign(reference));
        if (sensor) robot.sensors.push(sensor);
        else warnings.push(`Sensor "${s.attrs.name ?? ''}" is a ${s.attrs.type ?? 'kind'} the design has no sensor for; it was left out.`);
      }
      continue;
    }
    for (const plugin of childrenOf(g, 'plugin')) {
      const drive = readDrive(plugin);
      if (!drive || robot.drive) continue;
      const roles: Record<string, DriveRole> = {};
      for (const [role, jointName] of drive.roles) {
        const id = jointIds.get(jointName);
        if (id) roles[id] = role;
        else warnings.push(`The drive names joint "${jointName}", which was not kept.`);
      }
      robot.drive = { kind: drive.kind, roles };
    }
  }
  robot.control = hasElement(root, 'ros2_control');

  return { name: readable(root.attrs.name ?? 'Robot'), scene, assets, robot, warnings, missing: [...missing] };
}

const isMoving = (type: string): boolean => type === 'revolute' || type === 'continuous' || type === 'prismatic';
const round = (v: number): number => Number(v.toPrecision(6));
const hasElement = (el: XmlElement, name: string): boolean => localName(el.name) === name || el.children.some((c) => hasElement(c, name));
