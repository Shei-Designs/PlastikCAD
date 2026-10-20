// Writes a robot as MJCF, MuJoCo's own format: a tree of bodies, each with
// its inertia, mesh geoms and the joint it hangs by; loops closed by
// connect constraints, followers by joint constraints, actuators on the
// driven joints. SI units, radians. Mesh files sit under `meshes/`.
import { APP_NAME } from '../app';
import type { Vec3 } from '../model/types';
import type { Tensor } from '../robot/inertia';
import type { JointType } from '../robot/types';
import { escapeXml, fmt } from './format';
import type { UrdfGeometry } from './urdf';

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
}

export interface MjcfJoint {
  name: string;
  type: JointType;
  /** In the body's frame. */
  axis: Vec3;
  limit?: { lower: number; upper: number; effort: number; velocity: number };
  dynamics?: { damping: number; friction: number };
}

export interface MjcfModel {
  name: string;
  base: MjcfBody;
  /** The base floats (a rover) or is welded to the world (an arm). */
  floating: boolean;
  /** Loops: two bodies pinned together at a point given in the first body's frame. */
  connects: { body1: string; body2: string; anchor: Vec3 }[];
  /** Followers: joint1 = offset + multiplier × joint2. */
  followers: { joint: string; leader: string; multiplier: number; offset: number }[];
  /** Position servos over these joints, velocity motors over the wheels. */
  servos: string[];
  wheels: string[];
}

const vec = (v: Vec3): string => v.map((x) => fmt(x, 6)).join(' ');

/** Roll, pitch, yaw (radians, about the fixed X, Y, Z) as a MuJoCo quaternion "w x y z". */
export function quatOf(rpy: Vec3): string {
  const [r, p, y] = rpy.map((a) => a / 2);
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(r), Math.sin(r), Math.cos(p), Math.sin(p), Math.cos(y), Math.sin(y)];
  return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy].map((x) => fmt(x, 6)).join(' ');
}

/** Multiplies two "w x y z" quaternions given as arrays. */
const qmul = (a: number[], b: number[]): number[] => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
/** A MuJoCo camera looks down its -Z with +Y up; ours looks along +X with +Z up: the turn between the two. */
const CAMERA_TURN = [0.5, -0.5, 0.5, -0.5];

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
    const lines = [`${indent}<body name="${escapeXml(b.name)}" pos="${vec(b.pos)}">`];
    if (b === model.base && model.floating) lines.push(`${indent}  <freejoint name="root"/>`);
    if (b.joint && b.joint.type !== 'fixed') {
      const j = b.joint;
      const hinge = j.type !== 'prismatic';
      const range = j.limit && j.type !== 'continuous' ? ` range="${fmt(j.limit.lower, 6)} ${fmt(j.limit.upper, 6)}" limited="true"` : '';
      const dyn = j.dynamics ? ` damping="${fmt(j.dynamics.damping, 6)}" frictionloss="${fmt(j.dynamics.friction, 6)}"` : '';
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
      // MuJoCo takes the vertical field of view.
      const fovy = (2 * Math.atan(Math.tan(cam.hfov / 2) / cam.aspect) * 180) / Math.PI;
      lines.push(`${indent}  <camera name="${escapeXml(cam.name)}" pos="${vec(cam.pos)}" quat="${q}" fovy="${fmt(fovy, 3)}"/>`);
    }
    for (const imu of b.imus ?? []) lines.push(`${indent}  <site name="${escapeXml(imu.name)}" pos="${vec(imu.pos)}" quat="${quatOf(imu.rpy)}" size="0.005"/>`);
    for (const child of b.children) lines.push(...bodyXml(child, `${indent}  `));
    lines.push(`${indent}</body>`);
    return lines;
  };
  const body = bodyXml(model.base, '    ');
  const imus = collect(model.base, (b) => b.imus ?? []);
  const actuators = [
    ...model.servos.map((j) => `    <position name="${escapeXml(j)}_servo" joint="${escapeXml(j)}" kp="50" ctrllimited="false"/>`),
    ...model.wheels.map((j) => `    <velocity name="${escapeXml(j)}_motor" joint="${escapeXml(j)}" kv="1"/>`),
  ];
  const equality = [
    ...model.connects.map((c) => `    <connect body1="${escapeXml(c.body1)}" body2="${escapeXml(c.body2)}" anchor="${vec(c.anchor)}"/>`),
    ...model.followers.map((f) => `    <joint joint1="${escapeXml(f.joint)}" joint2="${escapeXml(f.leader)}" polycoef="${fmt(f.offset, 6)} ${fmt(f.multiplier, 6)} 0 0 0"/>`),
  ];
  return [
    `<!-- Made with ${APP_NAME}. Units: meters, kilograms, radians. -->`,
    `<mujoco model="${escapeXml(model.name)}">`,
    '  <compiler angle="radian" meshdir="meshes" autolimits="true"/>',
    '  <option timestep="0.002" gravity="0 0 -9.81"/>',
    '  <default>',
    '    <default class="visual"><geom contype="0" conaffinity="0" group="2"/></default>',
    '    <default class="collision"><geom group="3" rgba="0.6 0.6 0.9 0.3"/></default>',
    '  </default>',
    '  <asset>',
    ...[...meshes].map(([n, file]) => `    <mesh name="${n}" file="${escapeXml(file)}"/>`),
    ...[...materials].map(([n, rgba]) => `    <material name="${n}" rgba="${rgba}"/>`),
    '    <texture name="grid" type="2d" builtin="checker" rgb1="0.2 0.3 0.4" rgb2="0.1 0.15 0.2" width="300" height="300"/>',
    '    <material name="floor" texture="grid" texrepeat="8 8" reflectance="0.1"/>',
    '  </asset>',
    '  <worldbody>',
    '    <light pos="0 0 3" dir="0 0 -1" directional="true"/>',
    '    <geom name="floor" type="plane" size="5 5 0.1" material="floor" friction="1 0.005 0.0001"/>',
    ...body,
    '  </worldbody>',
    ...(actuators.length ? ['  <actuator>', ...actuators, '  </actuator>'] : []),
    ...(equality.length ? ['  <equality>', ...equality, '  </equality>'] : []),
    ...(imus.length ? ['  <sensor>', ...imus.flatMap((imu) => [`    <gyro name="${escapeXml(imu.name)}_gyro" site="${escapeXml(imu.name)}"/>`, `    <accelerometer name="${escapeXml(imu.name)}_accel" site="${escapeXml(imu.name)}"/>`]), '  </sensor>'] : []),
    '</mujoco>',
    '',
  ].join('\n');
}

function collect<T>(body: MjcfBody, pick: (b: MjcfBody) => T[]): T[] {
  return [...pick(body), ...body.children.flatMap((c) => collect(c, pick))];
}
