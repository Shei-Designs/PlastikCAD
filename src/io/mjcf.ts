// Writes a robot as MJCF, MuJoCo's own format: a tree of bodies, each with
// its inertia, mesh geoms and the joint it hangs by; loops closed by
// connect constraints, followers by joint constraints, actuators on the
// driven joints. SI units, radians. Mesh files sit under `meshes/`.
import { APP_NAME } from '../appInfo';
import type { Vec3 } from '../model/types';
import type { Tensor } from '../robot/inertia';
import { lidarAngles } from '../robot/types';
import type { JointType, World } from '../robot/types';
import { escapeXml, fmt } from './format';
import type { Naming, UrdfGeometry } from './urdf';

export interface MjcfBody {
  name: string;
  /** In the parent body's frame (the frames are parallel), m. */
  pos: Vec3;
  inertial: { mass: number; origin: Vec3; inertia: Tensor } | null;
  visual: { geometry: UrdfGeometry; origin?: Vec3; rpy?: Vec3; color?: [number, number, number] }[];
  collision: { geometry: UrdfGeometry; origin?: Vec3; rpy?: Vec3 }[];
  friction?: number;
  /** The joint this body hangs by; none for the base, or a body welded to its parent. */
  joint?: MjcfJoint;
  children: MjcfBody[];
  cameras?: { name: string; pos: Vec3; rpy: Vec3; hfov: number; aspect: number }[];
  /** Sites for IMUs: a gyro and an accelerometer each. */
  imus?: { name: string; pos: Vec3; rpy: Vec3 }[];
  /** Touch sensors: a sphere site of `size` radius, m, summing the contact forces inside it. */
  touches?: { name: string; pos: Vec3; size: number }[];
  /** Lidars: a fan of `rays` rangefinders about the sensor's Z, `hfov` radians wide and centred on its X, each reading up to `max` m. */
  lidars?: { name: string; pos: Vec3; rpy: Vec3; rays: number; hfov: number; max: number }[];
}

export interface MjcfJoint {
  name: string;
  type: JointType;
  /** In the body's frame. */
  axis: Vec3;
  limit?: { lower: number; upper: number; effort: number; velocity: number };
  dynamics?: { damping: number; friction: number };
  /** The motor's reflected rotor inertia, kg·m². */
  armature?: number;
  /** Where the joint stands in the home pose, radians or meters; zero when absent. */
  start?: number;
}

export interface MjcfModel {
  name: string;
  base: MjcfBody;
  /** The base floats (a rover) or is welded to the world (an arm). */
  floating: boolean;
  /** How much higher (m) a floating base stands in the home pose than in the pose the bodies are written in. */
  lift?: number;
  /** Loops: two bodies pinned together at a point given in the first body's frame. */
  connects: { body1: string; body2: string; anchor: Vec3 }[];
  /** Followers: joint1 = offset + multiplier × joint2. */
  followers: { joint: string; leader: string; multiplier: number; offset: number }[];
  /** Position servos over these joints, velocity motors over the wheels. */
  servos: string[];
  wheels: string[];
  /** The floor: level, bumpy around a flat start, tilted, or level with steps or a ramp ahead. */
  world: World;
  /** Which way the robot faces, a unit vector in the design's axes: the steps and the ramp stand that way. */
  forward: Vec3;
}

/** A block of a world's course: its center and full size (along the robot's way, across it, up) in meters, turned to face `yaw` and tipped up ahead by `pitch`, radians. */
export interface WorldBlock {
  pos: Vec3;
  size: Vec3;
  yaw: number;
  pitch: number;
}

/** How far ahead of the robot a course begins, m. */
const COURSE_AHEAD = 0.3;
const COURSE_WIDTH = 1;
const STEP_RISE = 0.01;
const STEP_DEPTH = 0.12;
const STEPS = 3;
const RAMP_PITCH = (10 * Math.PI) / 180;
const RAMP_LENGTH = 0.6;
const RAMP_THICKNESS = 0.02;
const TOP_LENGTH = 0.6;

/**
 * The blocks a world puts ahead of the robot, facing the way it faces: three
 * low steps, each a box from its riser to the course's end so the treads
 * join; or a ramp (a thin slab tipped up, its top surface meeting the floor at
 * the start) onto a flat top as high as it climbs. Nothing for the floors.
 */
export function worldBlocks(world: World, forward: Vec3): WorldBlock[] {
  const n = Math.hypot(forward[0], forward[1]) || 1;
  const f: Vec3 = [forward[0] / n, forward[1] / n, 0];
  const yaw = Math.atan2(f[1], f[0]);
  const at = (along: number, z: number): Vec3 => [f[0] * along, f[1] * along, z];
  if (world === 'steps') {
    const end = COURSE_AHEAD + STEPS * STEP_DEPTH + TOP_LENGTH;
    return Array.from({ length: STEPS }, (_, k) => {
      const start = COURSE_AHEAD + k * STEP_DEPTH;
      const height = (k + 1) * STEP_RISE;
      return { pos: at((start + end) / 2, height / 2), size: [end - start, COURSE_WIDTH, height], yaw, pitch: 0 };
    });
  }
  if (world === 'ramp') {
    const c = Math.cos(RAMP_PITCH);
    const s = Math.sin(RAMP_PITCH);
    const height = RAMP_LENGTH * s;
    const topStart = COURSE_AHEAD + RAMP_LENGTH * c;
    return [
      { pos: at(COURSE_AHEAD + (RAMP_LENGTH / 2) * c + (RAMP_THICKNESS / 2) * s, (RAMP_LENGTH / 2) * s - (RAMP_THICKNESS / 2) * c), size: [RAMP_LENGTH, COURSE_WIDTH, RAMP_THICKNESS], yaw, pitch: RAMP_PITCH },
      { pos: at(topStart + TOP_LENGTH / 2, height / 2), size: [TOP_LENGTH, COURSE_WIDTH, height], yaw, pitch: 0 },
    ];
  }
  return [];
}

/** Terrain for the rough floor: smooth bumps from a few sines, flat within `clear` of the middle so the robot starts level. 0..1 per cell, row by row. */
export function terrain(n: number, clear = 0.25): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i / (n - 1) - 0.5;
      const y = j / (n - 1) - 0.5;
      const bumps = 0.5 + 0.25 * Math.sin(12.9 * x + 1.3) * Math.cos(9.7 * y) + 0.15 * Math.sin(23 * x * y + 0.7) + 0.1 * Math.cos(17 * y + 5 * x);
      const r = Math.hypot(x, y);
      const ramp = Math.min(1, Math.max(0, (r - clear) / 0.15));
      out.push(Math.min(1, Math.max(0, bumps * ramp)));
    }
  }
  return out;
}

/** The free base's joint, and the site at its origin with the readings taken there. */
const FREE_JOINT = 'root';
const BASE_SITE = 'base_site';
const BASE_SENSORS = { quat: 'base_quat', gyro: 'base_gyro', velocity: 'base_vel', acceleration: 'base_acc' };

/**
 * MuJoCo keeps a set of names for each kind of thing; `world` is its own body. Every joint has two readings, every
 * sensor its sites and readings, and the robot's sensors are told apart by name whatever their kind.
 */
export const MJCF_NAMES: Naming = {
  reserved: ['body/world', `joint/${FREE_JOINT}`, `site/${BASE_SITE}`, ...Object.values(BASE_SENSORS).map((n) => `sensor/${n}`)],
  link: (name) => [`body/${name}`],
  joint: (name) => [`joint/${name}`, `sensor/${name}_pos`, `sensor/${name}_vel`],
  sensor: (name, kind, rays) => [
    `robot/${name}`,
    ...(kind === 'camera' || kind === 'depth'
      ? [`camera/${name}`]
      : kind === 'imu'
        ? [`site/${name}`, `sensor/${name}_gyro`, `sensor/${name}_accel`]
        : kind === 'touch'
          ? [`site/${name}_site`, `sensor/${name}`]
          : Array.from({ length: rays }, (_, i) => [`site/${name}_ray${i}`, `sensor/${name}_${i}`]).flat()),
  ],
};

/** How far the slope is tilted about X, radians. */
const SLOPE = 0.14;

const vec = (v: Vec3): string => v.map((x) => fmt(x, 6)).join(' ');
/** A gain or limit to four figures, whatever its size (a toy's motor is a few millinewton-meters). */
const sig = (x: number): string => String(Number(x.toPrecision(4)));

/** The simulation's step, s. */
const TIMESTEP = 0.002;
/** A position servo pushes with its full effort from this far off its target, rad. */
const SERVO_BAND = 0.5;
/** The app's joint defaults in SI, for a joint exported without limits. */
const DEFAULT_EFFORT = 10;
const DEFAULT_VELOCITY = Math.PI / 2;

/** A body's moment of inertia about an axis `u` through `at` (both in the body's frame), kg·m²: its own about its center of mass, plus its mass at the center's distance from the line. */
function inertiaAbout(inertial: NonNullable<MjcfBody['inertial']>, at: Vec3, u: Vec3): number {
  const [ixx, iyy, izz, ixy, ixz, iyz] = inertial.inertia;
  const [ux, uy, uz] = u;
  const own = ixx * ux * ux + iyy * uy * uy + izz * uz * uz + 2 * (ixy * ux * uy + ixz * ux * uz + iyz * uy * uz);
  const c = inertial.origin.map((x, i) => x - at[i]);
  const along = c[0] * ux + c[1] * uy + c[2] * uz;
  return own + inertial.mass * Math.max(c[0] ** 2 + c[1] ** 2 + c[2] ** 2 - along * along, 0);
}

/** Every body's origin in the base's frame (the frames are parallel), by body. */
function placeBodies(base: MjcfBody): Map<MjcfBody, Vec3> {
  const out = new Map<MjcfBody, Vec3>();
  const walk = (b: MjcfBody, at: Vec3) => {
    out.set(b, at);
    for (const c of b.children) walk(c, [at[0] + c.pos[0], at[1] + c.pos[1], at[2] + c.pos[2]]);
  };
  walk(base, [0, 0, 0]);
  return out;
}

/**
 * The inertia a joint works against, kg·m²: the heavier of the two sides it
 * separates (the body it hangs and everything below, or everything else)
 * about its axis. A knee carries the body as much as the shin; a wheel's
 * motor pushes the rover.
 */
function inertiaAboutJoint(b: MjcfBody, placed: Map<MjcfBody, Vec3>): number {
  if (!b.joint) return 0;
  const n = Math.hypot(...b.joint.axis) || 1;
  const u = b.joint.axis.map((x) => x / n) as Vec3;
  const pivot = placed.get(b)!;
  const below = new Set(collect(b, (x) => [x]));
  // The motor's own rotor, through its gears, turns with the joint whichever side moves.
  let child = b.joint.armature ?? 0;
  let rest = child;
  for (const [body, at] of placed) {
    if (!body.inertial) continue;
    const i = inertiaAbout(body.inertial, [pivot[0] - at[0], pivot[1] - at[1], pivot[2] - at[2]], u);
    if (below.has(body)) child += i;
    else rest += i;
  }
  return Math.max(child, rest);
}

/**
 * An actuator's gains and limits from the joint's effort and velocity, held
 * back where the part is too light for them: the joint's velocity feedback
 * (kv) is integrated implicitly and safe at any size, but a position gain or
 * a torque the time step cannot follow would blow the simulation up, so kp is
 * kept under what the inertia can take in a step, and the torque under what
 * takes the part to full speed in one. Velocity feedback at full effort over
 * the velocity limit makes a motor that stalls at its speed limit, like a
 * real one.
 */
/** Whether a joint can take an actuator: it moves, and has an effort and a speed to be moved by. Without them the gains are not numbers. */
export const drivable = (j: Pick<MjcfJoint, 'type' | 'limit'> | undefined): boolean =>
  Boolean(j && j.type !== 'fixed' && (!j.limit || (j.limit.effort > 0 && j.limit.velocity > 0 && Number.isFinite(j.limit.effort) && Number.isFinite(j.limit.velocity))));

function actuatorGains(b: MjcfBody | undefined, placed: Map<MjcfBody, Vec3>): { kp: number; kv: number; effort: number; velocity: number } {
  const effort = b?.joint?.limit?.effort ?? DEFAULT_EFFORT;
  const velocity = b?.joint?.limit?.velocity ?? DEFAULT_VELOCITY;
  const inertia = b ? inertiaAboutJoint(b, placed) : 0;
  const torque = inertia > 0 ? Math.min(effort, (inertia * velocity) / TIMESTEP) : effort;
  const kp = inertia > 0 ? Math.min(torque / SERVO_BAND, inertia / TIMESTEP ** 2) : torque / SERVO_BAND;
  const kv = inertia > 0 ? Math.min(torque / velocity, 2 * Math.sqrt(kp * inertia)) : torque / velocity;
  return { kp, kv, effort: torque, velocity };
}

/** Roll, pitch, yaw (radians, about the fixed X, Y, Z) as a MuJoCo quaternion "w x y z". */
export function quatOf(rpy: Vec3): string {
  const [r, p, y] = rpy.map((a) => a / 2);
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(r), Math.sin(r), Math.cos(p), Math.sin(p), Math.cos(y), Math.sin(y)];
  return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy].map((x) => fmt(x, 6)).join(' ');
}

/** `v` turned by roll, pitch and yaw about the fixed X, Y and Z axes, in that order. */
function turned(v: Vec3, [r, p, y]: Vec3): Vec3 {
  const [x1, y1, z1] = [v[0], v[1] * Math.cos(r) - v[2] * Math.sin(r), v[1] * Math.sin(r) + v[2] * Math.cos(r)];
  const [x2, y2, z2] = [x1 * Math.cos(p) + z1 * Math.sin(p), y1, -x1 * Math.sin(p) + z1 * Math.cos(p)];
  return [x2 * Math.cos(y) - y2 * Math.sin(y), x2 * Math.sin(y) + y2 * Math.cos(y), z2];
}

/** A lidar's rays in its link's frame: unit directions spread over the sweep, from its right-hand end round to its left, as a laser scan lists them. */
function lidarRays(l: NonNullable<MjcfBody['lidars']>[number]): Vec3[] {
  return lidarAngles(l.rays, l.hfov).map((a) => turned([Math.cos(a), Math.sin(a), 0], l.rpy));
}

/** Multiplies two "w x y z" quaternions given as arrays. */
const qmul = (a: number[], b: number[]): number[] => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
/** A MuJoCo camera looks down its -Z with +Y up; ours looks along +X with +Z up: the turn between the two. */
const CAMERA_TURN = [0.5, 0.5, -0.5, -0.5];

export function writeMjcf(model: MjcfModel): string {
  const meshes = new Map<string, string>();
  const materials = new Map<string, string>();
  const meshName = (file: string): string => {
    const name = file.replace(/^meshes\//, '').replace(/[^A-Za-z0-9_]+/g, '_');
    meshes.set(name, file.replace(/^meshes\//, ''));
    return name;
  };
  const materialName = (color: [number, number, number]): string => {
    const name = `color_${color.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
    materials.set(name, `${color.map((c) => fmt(c, 4)).join(' ')} 1`);
    return name;
  };
  const geomXml = (g: UrdfGeometry, origin: Vec3 | undefined, rpy: Vec3 | undefined, rest: string): string => {
    const at = `${origin?.some((x) => x !== 0) ? ` pos="${vec(origin)}"` : ''}${rpy?.some((x) => x !== 0) ? ` quat="${quatOf(rpy)}"` : ''}`;
    if ('mesh' in g) return `<geom type="mesh" mesh="${meshName(g.mesh)}"${at}${rest}/>`;
    if ('box' in g) return `<geom type="box" size="${vec(g.box.map((x) => x / 2) as Vec3)}"${at}${rest}/>`;
    if ('cylinder' in g) return `<geom type="cylinder" size="${fmt(g.cylinder.radius, 6)} ${fmt(g.cylinder.length / 2, 6)}"${at}${rest}/>`;
    return `<geom type="sphere" size="${fmt(g.sphere.radius, 6)}"${at}${rest}/>`;
  };
  const bodyXml = (b: MjcfBody, indent: string): string[] => {
    // On the slope the robot stands tilted with the floor, about the world's origin, which the floor passes through.
    const lines = [`${indent}<body name="${escapeXml(b.name)}" pos="${vec(b === model.base ? baseAt : b.pos)}"${b === model.base && tilt ? ` quat="${tilt}"` : ''}>`];
    if (b === model.base && model.floating) lines.push(`${indent}  <freejoint name="${FREE_JOINT}"/>`);
    if (b.joint && b.joint.type !== 'fixed') {
      const j = b.joint;
      const hinge = j.type !== 'prismatic';
      const range = j.limit && j.type !== 'continuous' ? ` range="${fmt(j.limit.lower, 6)} ${fmt(j.limit.upper, 6)}" limited="true"` : '';
      const dyn = (j.dynamics ? ` damping="${sig(j.dynamics.damping)}" frictionloss="${sig(j.dynamics.friction)}"` : '') + (j.armature ? ` armature="${sig(j.armature)}"` : '');
      lines.push(`${indent}  <joint name="${escapeXml(j.name)}" type="${hinge ? 'hinge' : 'slide'}" axis="${vec(j.axis)}"${range}${dyn}/>`);
    }
    if (b.inertial) {
      const [xx, yy, zz, xy, xz, yz] = b.inertial.inertia;
      lines.push(`${indent}  <inertial pos="${vec(b.inertial.origin)}" mass="${fmt(b.inertial.mass, 9)}" fullinertia="${[xx, yy, zz, xy, xz, yz].map((v) => fmt(v, 9)).join(' ')}"/>`);
    }
    for (const v of b.visual) lines.push(`${indent}  ${geomXml(v.geometry, v.origin, v.rpy, ` class="visual"${v.color ? ` material="${materialName(v.color)}"` : ''}`)}`);
    for (const c of b.collision) lines.push(`${indent}  ${geomXml(c.geometry, c.origin, c.rpy, ` class="collision"${b.friction !== undefined ? ` friction="${fmt(b.friction, 4)} 0.005 0.0001"` : ''}`)}`);
    for (const cam of b.cameras ?? []) {
      const q = qmul(quatOf(cam.rpy).split(' ').map(Number), CAMERA_TURN).map((x) => fmt(x, 6)).join(' ');
      // MuJoCo takes the vertical field of view, more than nothing and less than half a turn.
      const aspect = cam.aspect > 0 && Number.isFinite(cam.aspect) ? cam.aspect : 1;
      const fovy = Math.min(Math.max((2 * Math.atan(Math.tan(cam.hfov / 2) / aspect) * 180) / Math.PI, 1), 179);
      lines.push(`${indent}  <camera name="${escapeXml(cam.name)}" pos="${vec(cam.pos)}" quat="${q}" fovy="${fmt(fovy, 3)}"/>`);
    }
    for (const imu of b.imus ?? []) lines.push(`${indent}  <site name="${escapeXml(imu.name)}" pos="${vec(imu.pos)}" quat="${quatOf(imu.rpy)}" size="0.005"/>`);
    for (const t of b.touches ?? []) lines.push(`${indent}  <site name="${escapeXml(t.name)}_site" type="sphere" pos="${vec(t.pos)}" size="${sig(t.size)}" rgba="1 0.5 0 0.3"/>`);
    // A lidar is a fan of rangefinders: one site per ray, its Z along the ray.
    for (const l of b.lidars ?? []) lidarRays(l).forEach((ray, i) => lines.push(`${indent}  <site name="${escapeXml(l.name)}_ray${i}" pos="${vec(l.pos)}" zaxis="${vec(ray)}" size="0.002" rgba="1 0 0 0.3"/>`));
    // A site at the base's origin carries its orientation, turn rate and velocity for a controller.
    if (b === model.base && model.floating) lines.push(`${indent}  <site name="${BASE_SITE}" pos="0 0 0" size="0.005"/>`);
    for (const child of b.children) lines.push(...bodyXml(child, `${indent}  `));
    lines.push(`${indent}</body>`);
    return lines;
  };
  const tilt = model.world === 'slope' ? quatOf([SLOPE, 0, 0]) : '';
  const baseAt = tilt ? turned(model.base.pos, [SLOPE, 0, 0]) : model.base.pos;
  const body = bodyXml(model.base, '    ');
  const imus = collect(model.base, (b) => b.imus ?? []);
  const touches = collect(model.base, (b) => b.touches ?? []);
  const lidars = collect(model.base, (b) => b.lidars ?? []);
  // Joints in the order the file gives them, which is the order of qpos.
  const joints = collect(model.base, (b) => (b.joint && b.joint.type !== 'fixed' ? [b.joint] : []));
  // The home pose: every joint at its start, the base raised or lowered to stand on the floor in it, and each
  // position servo asked to hold its joint there (a velocity motor is asked for nothing).
  const [bx, by, bz] = model.base.pos;
  const homeAt = tilt ? turned([bx, by, bz + (model.lift ?? 0)], [SLOPE, 0, 0]) : ([bx, by, bz + (model.lift ?? 0)] as Vec3);
  const home = [...(model.floating ? [`${vec(homeAt)} ${tilt || '1 0 0 0'}`] : []), ...joints.map((j) => fmt(j.start ?? 0, 6))].join(' ');
  const sensors = [
    ...joints.flatMap((j) => [`    <jointpos name="${escapeXml(j.name)}_pos" joint="${escapeXml(j.name)}"/>`, `    <jointvel name="${escapeXml(j.name)}_vel" joint="${escapeXml(j.name)}"/>`]),
    ...(model.floating
      ? [
          `    <framequat name="${BASE_SENSORS.quat}" objtype="site" objname="${BASE_SITE}"/>`,
          `    <gyro name="${BASE_SENSORS.gyro}" site="${BASE_SITE}"/>`,
          `    <velocimeter name="${BASE_SENSORS.velocity}" site="${BASE_SITE}"/>`,
          `    <accelerometer name="${BASE_SENSORS.acceleration}" site="${BASE_SITE}"/>`,
        ]
      : []),
    ...imus.flatMap((imu) => [`    <gyro name="${escapeXml(imu.name)}_gyro" site="${escapeXml(imu.name)}"/>`, `    <accelerometer name="${escapeXml(imu.name)}_accel" site="${escapeXml(imu.name)}"/>`]),
    ...touches.map((t) => `    <touch name="${escapeXml(t.name)}" site="${escapeXml(t.name)}_site"/>`),
    ...lidars.flatMap((l) => Array.from({ length: l.rays }, (_, i) => `    <rangefinder name="${escapeXml(l.name)}_${i}" site="${escapeXml(l.name)}_ray${i}" cutoff="${sig(l.max)}"/>`)),
  ];
  const floor = [
    model.world === 'rough'
      ? '    <geom name="floor" type="hfield" hfield="terrain" material="floor" friction="1 0.005 0.0001"/>'
      : model.world === 'slope'
        ? `    <geom name="floor" type="plane" size="5 5 0.1" euler="${SLOPE} 0 0" material="floor" friction="1 0.005 0.0001"/>`
        : '    <geom name="floor" type="plane" size="5 5 0.1" material="floor" friction="1 0.005 0.0001"/>',
    // A course's blocks stand still in the world, facing the robot's way, tipped up ahead where a ramp is.
    ...worldBlocks(model.world, model.forward).map((b, i) => {
      const q = qmul([Math.cos(b.yaw / 2), 0, 0, Math.sin(b.yaw / 2)], [Math.cos(-b.pitch / 2), 0, Math.sin(-b.pitch / 2), 0]).map((x) => fmt(x, 6)).join(' ');
      return `    <geom name="course${i + 1}" type="box" pos="${vec(b.pos)}" size="${vec(b.size.map((v) => v / 2) as Vec3)}" quat="${q}" material="floor" friction="1 0.005 0.0001"/>`;
    }),
  ];
  const placed = placeBodies(model.base);
  const jointed = new Map(collect(model.base, (b) => (b.joint ? [b] : [])).map((b) => [b.joint!.name, b]));
  const gainsOf = (name: string) => actuatorGains(jointed.get(name), placed);
  // Only a joint the model holds, with an effort and a speed, gets an actuator or a constraint: anything else MuJoCo refuses, or reads as not a number.
  const canDrive = (name: string) => drivable(jointed.get(name)?.joint);
  const moves = (name: string) => jointed.get(name)?.joint?.type !== 'fixed' && jointed.has(name);
  const actuators = [
    ...model.servos.filter(canDrive).map((j) => {
      const g = gainsOf(j);
      return `    <position name="${escapeXml(j)}_servo" joint="${escapeXml(j)}" kp="${sig(g.kp)}" kv="${sig(g.kv)}" forcerange="-${sig(g.effort)} ${sig(g.effort)}"/>`;
    }),
    ...model.wheels.filter(canDrive).map((j) => {
      const g = gainsOf(j);
      return `    <velocity name="${escapeXml(j)}_motor" joint="${escapeXml(j)}" kv="${sig(g.effort / g.velocity)}" ctrlrange="-${sig(g.velocity)} ${sig(g.velocity)}" forcerange="-${sig(g.effort)} ${sig(g.effort)}"/>`;
    }),
  ];
  const startOf = new Map(joints.map((j) => [j.name, j.start ?? 0]));
  const ctrl = [...model.servos.filter(canDrive).map((j) => fmt(startOf.get(j) ?? 0, 6)), ...model.wheels.filter(canDrive).map(() => '0')];
  const equality = [
    ...model.connects.map((c) => `    <connect body1="${escapeXml(c.body1)}" body2="${escapeXml(c.body2)}" anchor="${vec(c.anchor)}"/>`),
    ...model.followers.filter((f) => moves(f.joint) && moves(f.leader)).map((f) => `    <joint joint1="${escapeXml(f.joint)}" joint2="${escapeXml(f.leader)}" polycoef="${fmt(f.offset, 6)} ${fmt(f.multiplier, 6)} 0 0 0"/>`),
  ];
  return [
    `<!-- Made with ${APP_NAME}. Units: meters, kilograms, radians. -->`,
    `<mujoco model="${escapeXml(model.name)}">`,
    '  <compiler angle="radian" meshdir="meshes" autolimits="true"/>',
    `  <option timestep="${TIMESTEP}" gravity="0 0 -9.81" integrator="implicitfast"/>`,
    '  <default>',
    '    <default class="visual"><geom contype="0" conaffinity="0" group="2"/></default>',
    // The robot's shapes meet the floor and the course, never each other, as in the SDF and the USD stage.
    '    <default class="collision"><geom group="3" conaffinity="0" rgba="0.6 0.6 0.9 0.3"/></default>',
    '  </default>',
    '  <asset>',
    ...[...meshes].map(([n, file]) => `    <mesh name="${n}" file="${escapeXml(file)}"/>`),
    ...[...materials].map(([n, rgba]) => `    <material name="${n}" rgba="${rgba}"/>`),
    '    <texture name="grid" type="2d" builtin="checker" rgb1="0.2 0.3 0.4" rgb2="0.1 0.15 0.2" width="300" height="300"/>',
    '    <material name="floor" texture="grid" texrepeat="8 8" reflectance="0.1"/>',
    ...(model.world === 'rough' ? [`    <hfield name="terrain" nrow="64" ncol="64" size="3 3 0.03 0.02" elevation="${terrain(64).map((v) => v.toFixed(3)).join(' ')}"/>`] : []),
    '  </asset>',
    '  <worldbody>',
    '    <light pos="0 0 3" dir="0 0 -1" directional="true"/>',
    ...floor,
    ...body,
    '  </worldbody>',
    ...(actuators.length ? ['  <actuator>', ...actuators, '  </actuator>'] : []),
    ...(equality.length ? ['  <equality>', ...equality, '  </equality>'] : []),
    ...(sensors.length ? ['  <sensor>', ...sensors, '  </sensor>'] : []),
    ...(home ? ['  <keyframe>', `    <key name="home" qpos="${home}"${ctrl.some((c) => c !== '0') ? ` ctrl="${ctrl.join(' ')}"` : ''}/>`, '  </keyframe>'] : []),
    '</mujoco>',
    '',
  ].join('\n');
}

function collect<T>(body: MjcfBody, pick: (b: MjcfBody) => T[]): T[] {
  return [...pick(body), ...body.children.flatMap((c) => collect(c, pick))];
}
