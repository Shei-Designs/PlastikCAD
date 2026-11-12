// Writes a robot as a USD stage for Isaac Sim, in USDA text: a PhysX
// articulation of rigid-body links with their meshes, masses and joints, the
// drives on the joints, the sensors as Isaac's own prims, a floor and lights,
// and a ROS 2 action graph that drives the robot from cmd_vel and publishes
// joint states, odometry, TF and every sensor. File > Open, Play, and the
// robot runs; nothing has to be imported or scripted on the Isaac side.
// Meters, Z up, degrees where USD Physics wants them.
import { APP_NAME } from '../appInfo';
import type { MeshData } from '../geometry/mesh';
import { rotation } from '../model/math';
import type { Mat } from '../model/math';
import type { Vec3 } from '../model/types';
import type { Tensor } from '../robot/inertia';
import type { DriveKind, JointType, SensorKind } from '../robot/types';
import { fmt } from './format';
import type { Naming } from './urdf';

export type UsdCollision =
  /** A mesh in the link's frame; `convex` for a hull, else PhysX decomposes it. */
  | { mesh: MeshData; convex: boolean }
  | { box: Vec3; origin: Vec3; rpy: Vec3 }
  | { cylinder: { radius: number; length: number }; origin: Vec3; rpy: Vec3 }
  | { sphere: { radius: number }; origin: Vec3; rpy: Vec3 };

export interface UsdLink {
  name: string;
  /** Where the link's frame sits in the world, m; every frame is parallel to the design's axes unless `rot` turns it. */
  pos: Vec3;
  /** How the link is turned in the pose the simulation begins in (w, x, y, z); absent for a link that is not. */
  rot?: [number, number, number, number];
  inertial: { mass: number; origin: Vec3; inertia: Tensor } | null;
  /** Meshes in the link's frame, m, each one color. */
  visual: { mesh: MeshData; color: [number, number, number] }[];
  collision: UsdCollision[];
  friction: number;
}

export interface UsdJoint {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  /** The child's frame in the parent's, m: where the joint sits. */
  origin: Vec3;
  /** In the (parallel) frames of both links. */
  axis: Vec3;
  /** Radians or meters; effort N·m or N; velocity rad/s or m/s. */
  limit?: { lower: number; upper: number; effort: number; velocity: number };
  dynamics?: { damping: number; friction: number };
  mimic?: { joint: string; multiplier: number; offset: number };
  /** Reflected rotor inertia, kg·m². */
  armature?: number;
  /** Closes a loop: kept out of the articulation tree, as a plain joint between two of its bodies. */
  loop: boolean;
  /** What the joint's drive is told: a speed (a wheel), a position (a servo), an effort (a joint commanded by torque, which the drive does not hold), or nothing. */
  drive: 'velocity' | 'position' | 'effort' | null;
  /** Where the joint stands when the simulation begins, radians or meters: the links are written posed so, and a servo holds it. */
  start?: number;
}

export interface UsdSensor {
  name: string;
  kind: SensorKind;
  link: string;
  /** In the link's frame, m and radians. A camera looks along its X, a lidar sweeps about its Z. */
  xyz: Vec3;
  rpy: Vec3;
  rate: number;
  camera: { hfov: number; width: number; height: number; near: number; far: number };
  lidar: { samples: number; hfov: number; min: number; max: number };
  /** A touch sensor's reach, m. */
  touch: number;
}

export interface UsdDrive {
  kind: DriveKind;
  /** The driven wheels' joints, left side then right (differential, mecanum). */
  left: string[];
  right: string[];
  /** Ackermann: the steering joints, left then right, and every wheel as Isaac's controller lists them: front left, front right, rear left, rear right. */
  steer: string[];
  ackermannWheels?: string[];
  wheelRadius: number;
  wheelSeparation: number;
  wheelBase?: number;
  /** rad/s. */
  maxWheelSpeed: number;
  /** rad. */
  steeringLimit?: number;
}

export interface UsdModel {
  name: string;
  /** The base link's name. */
  root: string;
  /** Bolted to the world, or standing free. */
  fixedBase: boolean;
  links: UsdLink[];
  /** Tree joints first, parents before children, then the loops. */
  joints: UsdJoint[];
  sensors: UsdSensor[];
  drive: UsdDrive | null;
  /** Joints a joint_command topic positions: an arm's. */
  controlled: string[];
}

const DEG = 180 / Math.PI;
const FLOOR_FRICTION = 1;
/** USD's default film back, mm; the focal length is chosen against it for the field of view asked. */
const APERTURE = 20.955;

type Quat = [number, number, number, number]; // w, x, y, z

const v3 = (v: Vec3, d = 6): string => `(${fmt(v[0], d)}, ${fmt(v[1], d)}, ${fmt(v[2], d)})`;
const q4 = (q: Quat): string => `(${q.map((x) => fmt(x, 6)).join(', ')})`;
const str = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** A prim name USD accepts: letters, digits and underscores, not starting with a digit. */
export const usdName = (raw: string): string => {
  const s = raw.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(s) ? `_${s}` : s || '_';
};

/** The prims the stage puts under /World beside the robot's. */
const WORLD_PRIMS = ['physicsScene', 'Dome', 'Sun', 'Ground', 'Looks', 'PhysicsMaterials', 'ROS2'];
/** The scope under the robot's prim that holds its joints, beside its links, and the joint that bolts a fixed base down. */
const JOINTS_SCOPE = 'Joints';
const ROOT_JOINT = 'root_joint';

/** The robot's prim under /World, clear of the stage's own prims there. */
export const robotPrim = (name: string): string => {
  const prim = usdName(name);
  return WORLD_PRIMS.includes(prim) ? `${prim}_2` : prim;
};

/** Links are prims under the robot's, joints under its joints scope, sensors under their links beside the link's meshes. */
export const USD_NAMES: Naming = {
  reserved: [`link/${JOINTS_SCOPE}`, `link/${ROOT_JOINT}`, /^sensor\/(visual|collision)_\d+$/],
  link: (name) => [`link/${name}`],
  joint: (name) => [`joint/${name}`],
  sensor: (name) => [`sensor/${name}`],
};

/** The quaternion of a rotation matrix (column-major 3×3 in `m`). */
function quatOf(m: Mat): Quat {
  const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = m;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [s / 4, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [(m21 - m12) / s, s / 4, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m02 - m20) / s, (m01 + m10) / s, s / 4, (m12 + m21) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, s / 4];
  }
  return q.map((x) => (Math.abs(x) < 1e-9 ? 0 : x)) as Quat;
}

/** Roll, pitch, yaw in radians (about the fixed X, then Y, then Z) as a quaternion. */
const quatOfRpy = (rpy: Vec3): Quat => quatOf(rotation(rpy.map((r) => r * DEG) as Vec3));

/** The quaternion turning +X onto `axis`: a joint's frame, whose axis USD Physics takes as X. */
/** The turn of a 3×3 matrix held by columns (its first nine numbers), as a quaternion. */
export function quatOfMatrix(m: readonly number[]): Quat {
  const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = m;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [s / 4, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [(m21 - m12) / s, s / 4, (m01 + m10) / s, (m02 + m20) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m02 - m20) / s, (m01 + m10) / s, s / 4, (m12 + m21) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, s / 4];
}

function quatToAxis(axis: Vec3): Quat {
  const n = Math.hypot(...axis) || 1;
  const [x, y, z] = [axis[0] / n, axis[1] / n, axis[2] / n];
  if (x > 1 - 1e-9) return [1, 0, 0, 0];
  if (x < -1 + 1e-9) return [0, 0, 0, 1]; // half a turn about Z
  // Rotation about X × axis by the angle between them.
  const [cx, cy, cz] = [0, -z, y];
  const cn = Math.hypot(cx, cy, cz);
  const angle = Math.acos(x);
  const s = Math.sin(angle / 2) / cn;
  return [Math.cos(angle / 2), cx * s, cy * s, cz * s];
}

/** A camera prim looks down its -Z with +Y up; the sensor's frame looks along +X with +Z up. */
const CAMERA_BASIS: Mat = [0, -1, 0, 0, 0, 1, -1, 0, 0, 0, 0, 0];
const mul = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

/**
 * The principal moments and axes of an inertia tensor (xx, yy, zz, xy, xz, yz)
 * by Jacobi rotations: USD Physics wants the diagonal inertia and the turn that
 * puts it in the body's frame.
 */
export function principalAxes(t: Tensor): { moments: Vec3; axes: Quat } {
  const a = [
    [t[0], t[3], t[4]],
    [t[3], t[1], t[5]],
    [t[4], t[5], t[2]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-18) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const tt = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(tt * tt + 1);
      const s = tt * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  // Columns of v are the axes; make the frame right-handed.
  const det = v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) - v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0]) + v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0]);
  if (det < 0) for (let k = 0; k < 3; k++) v[k][2] = -v[k][2];
  const m: Mat = [v[0][0], v[1][0], v[2][0], v[0][1], v[1][1], v[2][1], v[0][2], v[1][2], v[2][2], 0, 0, 0];
  return { moments: [Math.max(a[0][0], 0), Math.max(a[1][1], 0), Math.max(a[2][2], 0)], axes: quatOf(m) };
}

const indent = (lines: string[], depth: number): string[] => lines.map((l) => (l ? '    '.repeat(depth) + l : l));

/** A mesh as the body of a Mesh prim: its points, its triangles, its extent. */
function meshLines(mesh: MeshData): string[] {
  const p = mesh.positions;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const points: string[] = [];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[i + k]);
      max[k] = Math.max(max[k], p[i + k]);
    }
    points.push(`(${fmt(p[i], 5)}, ${fmt(p[i + 1], 5)}, ${fmt(p[i + 2], 5)})`);
  }
  const n = mesh.triangles.length / 3;
  return [
    `float3[] extent = [${points.length ? `${v3(min as Vec3, 5)}, ${v3(max as Vec3, 5)}` : '(0, 0, 0), (0, 0, 0)'}]`,
    `int[] faceVertexCounts = [${Array.from({ length: n }, () => '3').join(', ')}]`,
    `int[] faceVertexIndices = [${Array.from(mesh.triangles).join(', ')}]`,
    `point3f[] points = [${points.join(', ')}]`,
    `uniform token subdivisionScheme = "none"`,
  ];
}

const colorKey = (c: [number, number, number]): string => `color_${c.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
const frictionKey = (f: number): string => `friction_${fmt(f, 3).replace(/[.-]/g, '_')}`;

function materialPrim(name: string, color: [number, number, number]): string[] {
  return [
    `def Material "${name}"`,
    '{',
    `    token outputs:surface.connect = </World/Looks/${name}/PreviewSurface.outputs:surface>`,
    '',
    '    def Shader "PreviewSurface"',
    '    {',
    '        uniform token info:id = "UsdPreviewSurface"',
    `        color3f inputs:diffuseColor = ${v3(color, 4)}`,
    '        float inputs:metallic = 0',
    '        float inputs:roughness = 0.5',
    '        token outputs:surface',
    '    }',
    '}',
  ];
}

function physicsMaterialPrim(name: string, friction: number): string[] {
  return [
    `def Material "${name}" (`,
    '    prepend apiSchemas = ["PhysicsMaterialAPI"]',
    ')',
    '{',
    `    float physics:dynamicFriction = ${fmt(friction, 3)}`,
    '    float physics:restitution = 0',
    `    float physics:staticFriction = ${fmt(friction, 3)}`,
    '}',
  ];
}

const xformOps = (pos: Vec3, rot?: Quat): string[] => [
  ...(rot ? [`quatf xformOp:orient = ${q4(rot)}`] : []),
  `double3 xformOp:translate = ${v3(pos)}`,
  `uniform token[] xformOpOrder = ["xformOp:translate"${rot ? ', "xformOp:orient"' : ''}]`,
];

function collisionPrim(c: UsdCollision, i: number, material: string): string[] {
  const head = (type: string, extra: string[] = []) => [`def ${type} "collision_${i}" (`, `    prepend apiSchemas = [${['"PhysicsCollisionAPI"', ...extra, '"MaterialBindingAPI"'].join(', ')}]`, ')', '{'];
  const common = [`rel material:binding:physics = </World/PhysicsMaterials/${material}>`, 'uniform token purpose = "guide"'];
  if ('mesh' in c) {
    return [...head('Mesh', ['"PhysicsMeshCollisionAPI"']), ...indent([...common, `uniform token physics:approximation = "${c.convex ? 'convexHull' : 'convexDecomposition'}"`, ...meshLines(c.mesh)], 1), '}'];
  }
  const rot = quatOfRpy(c.rpy);
  if ('box' in c) {
    return [...head('Cube'), ...indent([...common, 'double size = 1', `float3 xformOp:scale = ${v3(c.box)}`, `quatf xformOp:orient = ${q4(rot)}`, `double3 xformOp:translate = ${v3(c.origin)}`, 'uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient", "xformOp:scale"]'], 1), '}'];
  }
  if ('cylinder' in c) {
    return [...head('Cylinder'), ...indent([...common, 'uniform token axis = "Z"', `double height = ${fmt(c.cylinder.length)}`, `double radius = ${fmt(c.cylinder.radius)}`, ...xformOps(c.origin, rot)], 1), '}'];
  }
  return [...head('Sphere'), ...indent([...common, `double radius = ${fmt(c.sphere.radius)}`, ...xformOps(c.origin, rot)], 1), '}'];
}

/**
 * The attributes of a one-beam spinning lidar, as Isaac's generic lidar schema wants them: its rate and reach, and
 * the rays of a full turn. Isaac's laser scan is always the whole circle (a narrower valid window silences it), so a
 * partial sweep keeps the design's angular step over 360°, and the scan has 360/hfov times as many rays.
 */
function lidarLines(s: UsdSensor): string[] {
  const hfov = Math.min(Math.max(s.lidar.hfov * DEG, 1), 360);
  const rays = Math.max(1, Math.round((Math.max(1, s.lidar.samples) * 360) / hfov));
  const hz = Math.max(1, Math.round(s.rate));
  const u = (n: number) => String(Math.max(0, Math.round(n)));
  return [
    'bool omni:sensor:Core:accumulateOutputs = 1',
    'float omni:sensor:Core:aspectRatio = 1',
    'float omni:sensor:Core:azimuthErrorMean = 0',
    'float omni:sensor:Core:azimuthErrorStd = 0',
    'float omni:sensor:Core:beamWaistHorM = 0.002',
    'float omni:sensor:Core:beamWaistVerM = 0.002',
    'float omni:sensor:Core:bitDepthResolution = 65536',
    'float omni:sensor:Core:calibrationGain = 40',
    'float[] omni:sensor:Core:customFrameOfReferenceTrafo = [0, 0, 0, 0, 0, 0]',
    'float omni:sensor:Core:divergenceHorDeg = 0',
    'float omni:sensor:Core:divergenceVerDeg = 0',
    'float omni:sensor:Core:effectiveApertureSizeM = 0.01',
    'token omni:sensor:Core:elementsCoordsType = "SPHERICAL"',
    'float omni:sensor:Core:elevationErrorMean = 0',
    'float omni:sensor:Core:elevationErrorStd = 0',
    'float[] omni:sensor:Core:emitterState:s001:azimuthDeg = [0]',
    'uint[] omni:sensor:Core:emitterState:s001:bank = []',
    'uint[] omni:sensor:Core:emitterState:s001:channelId = [1]',
    'float[] omni:sensor:Core:emitterState:s001:distanceCorrectionM = [0]',
    'float[] omni:sensor:Core:emitterState:s001:elevationDeg = [0]',
    'float[] omni:sensor:Core:emitterState:s001:emitterPeakPowerW = [0]',
    'uint[] omni:sensor:Core:emitterState:s001:fireTimeNs = [0]',
    'float[] omni:sensor:Core:emitterState:s001:focalDistM = [0]',
    'float[] omni:sensor:Core:emitterState:s001:focalSlope = [0]',
    'float[] omni:sensor:Core:emitterState:s001:horOffsetM = [0]',
    'bool omni:sensor:Core:emitterState:s001:isROIState = 0',
    'uint[] omni:sensor:Core:emitterState:s001:rangeId = []',
    'bool[] omni:sensor:Core:emitterState:s001:roi = []',
    'float[] omni:sensor:Core:emitterState:s001:vertOffsetM = [0]',
    'string omni:sensor:Core:emitterStatesFile = ""',
    `float omni:sensor:Core:farRangeM = ${fmt(s.lidar.max, 3)}`,
    'float omni:sensor:Core:focusDistM = 0.15',
    'bool omni:sensor:Core:instantLidar = 0',
    'float[] omni:sensor:Core:intensityMappingDecoding = []',
    'float[] omni:sensor:Core:intensityMappingEncoding = []',
    'token omni:sensor:Core:intensityMappingType = "LINEAR"',
    'token omni:sensor:Core:intensityProcessing = "NORMALIZATION"',
    'float omni:sensor:Core:intensityScalePercent = 255',
    'float omni:sensor:Core:maxAzimuthROI = 400',
    'uint omni:sensor:Core:maxReturns = 1',
    'float omni:sensor:Core:minAzimuthROI = 400',
    'float omni:sensor:Core:minDistBetweenEchosM = 0.4',
    'float omni:sensor:Core:minReflectance = 0.1',
    `float omni:sensor:Core:minReflectionRangeM = ${fmt(s.lidar.max, 3)}`,
    'float omni:sensor:Core:Msquared = 1.4',
    `float omni:sensor:Core:nearRangeM = ${fmt(Math.max(s.lidar.min, 0.01), 3)}`,
    'uint omni:sensor:Core:numberOfChannels = 1',
    'uint omni:sensor:Core:numberOfEmitters = 1',
    'uint omni:sensor:Core:numLines = 0',
    'uint[] omni:sensor:Core:numRaysPerLine = []',
    'float[] omni:sensor:Core:originErrorMean = [0, 0, 0]',
    'float[] omni:sensor:Core:originErrorStd = [0, 0, 0]',
    'token omni:sensor:Core:outputFrameOfReference = "SENSOR"',
    'token omni:sensor:Core:outputMotionCompensationState = "NONCOMPENSATED"',
    `uint omni:sensor:Core:patternFiringRateHz = ${u(rays * hz)}`,
    'float omni:sensor:Core:peakPowerW = 0.002',
    'float omni:sensor:Core:pixelPitch = 40',
    'uint omni:sensor:Core:pulseTimeNs = 6',
    'float omni:sensor:Core:quantumEfficiency = 0.9',
    'float omni:sensor:Core:rangeAccuracyM = 0.005',
    'uint omni:sensor:Core:rangeCount = 0',
    'float omni:sensor:Core:rangeOffsetM = 0',
    'float omni:sensor:Core:rangeResolutionM = 0.001',
    'float[] omni:sensor:Core:rangesMaxM = []',
    'float[] omni:sensor:Core:rangesMinM = []',
    'token omni:sensor:Core:rayType = "IDEALIZED"',
    'float omni:sensor:Core:reflectionPowerFraction = 0.5',
    `uint omni:sensor:Core:reportRateBaseHz = ${u(rays * hz)}`,
    'token omni:sensor:Core:rotationDirection = "CW"',
    `uint omni:sensor:Core:scanRateBaseHz = ${u(hz)}`,
    'token omni:sensor:Core:scanType = "ROTARY"',
    'bool omni:sensor:Core:skipDroppingInvalidPoints = 0',
    'float omni:sensor:Core:startAzimuthOffsetDeg = 0',
    'uint omni:sensor:Core:stateResolutionStep = 1',
    'uint omni:sensor:Core:tiledSubSampling = 0',
    'float omni:sensor:Core:transmissionPowerFraction = 1',
    'float omni:sensor:Core:validEndAzimuthDeg = 360',
    'float omni:sensor:Core:validStartAzimuthDeg = 0',
    'float omni:sensor:Core:waveLengthNm = 903',
    'uchar[] omni:sensor:encryption:params = []',
    `string omni:sensor:marketName = ${str(`${APP_NAME} lidar`)}`,
    `string omni:sensor:modelName = ${str(s.name)}`,
    `string omni:sensor:modelVendor = ${str(APP_NAME)}`,
    'string omni:sensor:modelVersion = "1.0.0"',
    `float omni:sensor:tickRate = ${fmt(hz)}`,
  ];
}

function sensorPrim(s: UsdSensor): string[] {
  const rot = quatOfRpy(s.rpy);
  switch (s.kind) {
    case 'camera':
    case 'depth': {
      const focal = APERTURE / (2 * Math.tan(Math.min(Math.max(s.camera.hfov, 0.02), 3.1) / 2));
      return [
        `def Camera "${s.name}"`,
        '{',
        ...indent(
          [
            `float2 clippingRange = (${fmt(Math.max(s.camera.near, 0.001), 4)}, ${fmt(Math.max(s.camera.far, s.camera.near + 0.01), 3)})`,
            `float focalLength = ${fmt(focal, 4)}`,
            `float horizontalAperture = ${fmt(APERTURE, 3)}`,
            `float verticalAperture = ${fmt((APERTURE * s.camera.height) / Math.max(s.camera.width, 1), 3)}`,
            ...xformOps(s.xyz, mul(rot, quatOf(CAMERA_BASIS))),
          ],
          1,
        ),
        '}',
      ];
    }
    case 'lidar':
      return [`def OmniLidar "${s.name}" (`, '    prepend apiSchemas = ["OmniSensorGenericLidarCoreAPI"]', ')', '{', ...indent([...lidarLines(s), ...xformOps(s.xyz, rot)], 1), '}'];
    case 'imu':
      return [`def IsaacImuSensor "${s.name}"`, '{', ...indent(['int angularVelocityFilterWidth = 1', 'int linearAccelerationFilterWidth = 1', 'int orientationFilterWidth = 1', ...xformOps(s.xyz, rot)], 1), '}'];
    case 'touch':
      return [`def IsaacContactSensor "${s.name}"`, '{', ...indent(['float4 color = (1, 0.5, 0, 1)', `float radius = ${fmt(s.touch, 4)}`, 'float2 threshold = (0.001, 100000)', ...xformOps(s.xyz, rot)], 1), '}'];
  }
}

function linkPrim(l: UsdLink, sensors: UsdSensor[], touched: boolean): string[] {
  const apis = ['"PhysicsRigidBodyAPI"', ...(l.inertial ? ['"PhysicsMassAPI"'] : []), ...(touched ? ['"PhysxContactReportAPI"'] : [])];
  const body: string[] = [];
  if (l.inertial) {
    const { moments, axes } = principalAxes(l.inertial.inertia);
    body.push(`point3f physics:centerOfMass = ${v3(l.inertial.origin)}`, `float3 physics:diagonalInertia = ${v3(moments, 9)}`, `float physics:mass = ${fmt(l.inertial.mass, 6)}`, `quatf physics:principalAxes = ${q4(axes)}`);
  }
  if (touched) body.push('float physxContactReport:threshold = 0');
  body.push(...xformOps(l.pos, l.rot));
  l.visual.forEach((v, i) => {
    body.push('', `def Mesh "visual_${i}" (`, '    prepend apiSchemas = ["MaterialBindingAPI"]', ')', '{', ...indent([`rel material:binding = </World/Looks/${colorKey(v.color)}>`, ...meshLines(v.mesh)], 1), '}');
  });
  l.collision.forEach((c, i) => body.push('', ...collisionPrim(c, i, frictionKey(l.friction))));
  for (const s of sensors) body.push('', ...sensorPrim(s));
  return [`def Xform "${l.name}" (`, `    prepend apiSchemas = [${apis.join(', ')}]`, ')', '{', ...indent(body, 1), '}'];
}

/** `leader` is the joint a follower follows. */
function jointPrim(j: UsdJoint, robot: string, leader?: UsdJoint): string[] {
  const type = j.type === 'fixed' ? 'PhysicsFixedJoint' : j.type === 'prismatic' ? 'PhysicsPrismaticJoint' : 'PhysicsRevoluteJoint';
  const moving = j.type !== 'fixed';
  const drive = j.type === 'prismatic' ? 'linear' : 'angular';
  const mimicApi = j.mimic ? [`"PhysxMimicJointAPI:${j.type === 'prismatic' ? 'transX' : 'rotX'}"`] : [];
  const apis = ['"PhysxJointAPI"', ...(moving ? [`"PhysicsDriveAPI:${drive}"`, `"PhysicsJointStateAPI:${drive}"`] : []), ...mimicApi];
  const body: string[] = [`rel physics:body0 = </World/${robot}/${j.parent}>`, `rel physics:body1 = </World/${robot}/${j.child}>`, `point3f physics:localPos0 = ${v3(j.origin)}`, 'point3f physics:localPos1 = (0, 0, 0)'];
  if (moving) {
    const q = quatToAxis(j.axis);
    body.push(`quatf physics:localRot0 = ${q4(q)}`, `quatf physics:localRot1 = ${q4(q)}`, 'uniform token physics:axis = "X"');
    if (j.limit && j.type !== 'continuous') {
      const scale = j.type === 'prismatic' ? 1 : DEG;
      body.push(`float physics:lowerLimit = ${fmt(j.limit.lower * scale, 4)}`, `float physics:upperLimit = ${fmt(j.limit.upper * scale, 4)}`);
    }
    // The drive: a wheel is told a speed and resists with its damping alone; a servo holds a position, stiff
    // enough to reach it within a tenth of a radian (or a tenth of a meter) at full effort, damped to settle;
    // a joint nothing drives keeps its own damping. USD Physics takes an angular drive's gains per degree.
    const effort = j.limit?.effort ?? 1;
    const velocity = j.limit?.velocity || 1;
    const perUnit = j.type === 'prismatic' ? 1 : 1 / DEG;
    const [stiffness, damping] = j.drive === 'velocity' ? [0, effort / velocity] : j.drive === 'position' ? [effort / 0.1, effort / 0.1 / 20] : [0, Math.max(j.dynamics?.damping ?? 0, 0)];
    body.push(
      `float drive:${drive}:physics:damping = ${fmt(damping * perUnit, 9)}`,
      `float drive:${drive}:physics:maxForce = ${fmt(effort, 6)}`,
      `float drive:${drive}:physics:stiffness = ${fmt(stiffness * perUnit, 9)}`,
      `uniform token drive:${drive}:physics:type = "force"`,
      // A servo is asked to hold the joint where the simulation begins; the joint's state says it is there.
      `float drive:${drive}:physics:targetPosition = ${j.drive === 'position' && j.start ? fmt(j.start * (j.type === 'prismatic' ? 1 : DEG), 4) : '0'}`,
      `float drive:${drive}:physics:targetVelocity = 0`,
    );
    // A joint commanded by torque says so, for whoever reads the stage: its drive has no gains to tell it by.
    if (j.drive === 'effort') body.push('custom token robot:command = "effort"');
    if (j.start) body.push(`float state:${drive}:physics:position = ${fmt(j.start * (j.type === 'prismatic' ? 1 : DEG), 4)}`);
    if (j.dynamics) body.push(`float physxJoint:jointFriction = ${fmt(j.dynamics.friction, 6)}`);
    if (j.armature) body.push(`float physxJoint:armature = ${fmt(j.armature, 9)}`);
    if (j.mimic) {
      const axis = j.type === 'prismatic' ? 'transX' : 'rotX';
      const leaderAxis = (leader?.type ?? j.type) === 'prismatic' ? 'transX' : 'rotX';
      // PhysX holds this joint + gearing × the leader + offset = 0, a turning joint's place in degrees.
      const degrees = (type: JointType) => (type === 'prismatic' ? 1 : DEG);
      const gearing = (-j.mimic.multiplier * degrees(j.type)) / degrees(leader?.type ?? j.type);
      body.push(`rel physxMimicJoint:${axis}:referenceJoint = </World/${robot}/${JOINTS_SCOPE}/${j.mimic.joint}>`, `uniform token physxMimicJoint:${axis}:referenceJointAxis = "${leaderAxis}"`, `float physxMimicJoint:${axis}:gearing = ${fmt(gearing, 9)}`, `float physxMimicJoint:${axis}:offset = ${fmt(-j.mimic.offset * degrees(j.type), 6)}`);
    }
  }
  if (j.loop) body.push('bool physxJoint:excludeFromArticulation = 1');
  return [`def ${type} "${j.name}" (`, `    prepend apiSchemas = [${apis.join(', ')}]`, ')', '{', ...indent(body, 1), '}'];
}

// --- the ROS 2 action graph ---------------------------------------------------

type Attr = { type: string; value?: string; from?: string; rel?: string };
interface GraphNode {
  name: string;
  type: string;
  version: number;
  attrs: Record<string, Attr>;
}

const EXEC: Attr = { type: 'uint' };
const text = (s: string): Attr => ({ type: 'string', value: str(s) });
const num = (type: string, v: number): Attr => ({ type, value: fmt(v, 6) });
const tokens = (list: string[]): Attr => ({ type: 'token[]', value: `[${list.map(str).join(', ')}]` });
const from = (type: string, source: string): Attr => ({ type, from: source });
const target = (path: string): Attr => ({ type: 'rel', rel: path });

function nodePrim(n: GraphNode, graph: string): string[] {
  const body: string[] = [];
  for (const [name, a] of Object.entries(n.attrs).sort(([x], [y]) => x.localeCompare(y))) {
    if (a.rel !== undefined) {
      body.push(`custom rel ${name} = <${a.rel}> (`, '    customData = {', '        dictionary omni = {', '            dictionary graph = {', '                string relType = "target"', '            }', '        }', '    }', ')');
      continue;
    }
    const exec = a.type === 'uint' && (name === 'inputs:execIn' || name.startsWith('outputs:exec'));
    body.push(`custom ${a.type} ${name}${a.value !== undefined ? ` = ${a.value}` : ''}${exec ? ' (\n        customData = {\n            bool isExecution = 1\n        }\n    )' : ''}`);
    if (a.from) body.push(`prepend ${a.type} ${name}.connect = <${graph}/${a.from}>`);
  }
  body.push(`token node:type = "${n.type}"`, `int node:typeVersion = ${n.version}`);
  return [`def OmniGraphNode "${n.name}"`, '{', ...indent(body, 1), '}'];
}

/** The graph: the robot driven from ROS 2 and everything it knows published back, as Isaac's own tutorials wire it. */
function rosGraph(model: UsdModel, robotPath: string, linkPath: (link: string) => string): string[] {
  const graph = '/World/ROS2';
  const base = linkPath(model.root);
  const nodes: GraphNode[] = [
    { name: 'tick', type: 'omni.graph.action.OnPlaybackTick', version: 2, attrs: { 'outputs:tick': EXEC } },
    { name: 'context', type: 'isaacsim.ros2.bridge.ROS2Context', version: 2, attrs: { 'outputs:context': { type: 'uint64' } } },
    { name: 'time', type: 'isaacsim.core.nodes.IsaacReadSimulationTime', version: 1, attrs: { 'outputs:simulationTime': { type: 'double' } } },
    { name: 'clock', type: 'isaacsim.ros2.bridge.ROS2PublishClock', version: 1, attrs: { 'inputs:execIn': from('uint', 'tick.outputs:tick'), 'inputs:context': from('uint64', 'context.outputs:context'), 'inputs:timeStamp': from('double', 'time.outputs:simulationTime') } },
    {
      name: 'joint_states',
      type: 'isaacsim.ros2.bridge.ROS2PublishJointState',
      version: 1,
      attrs: { 'inputs:execIn': from('uint', 'tick.outputs:tick'), 'inputs:context': from('uint64', 'context.outputs:context'), 'inputs:timeStamp': from('double', 'time.outputs:simulationTime'), 'inputs:targetPrim': target(robotPath), 'inputs:topicName': text('joint_states') },
    },
    {
      name: 'tf',
      type: 'isaacsim.ros2.bridge.ROS2PublishTransformTree',
      version: 1,
      attrs: { 'inputs:execIn': from('uint', 'tick.outputs:tick'), 'inputs:context': from('uint64', 'context.outputs:context'), 'inputs:timeStamp': from('double', 'time.outputs:simulationTime'), 'inputs:targetPrims': target(robotPath), 'inputs:parentPrim': target(base) },
    },
  ];
  if (!model.fixedBase) {
    nodes.push(
      { name: 'odometry', type: 'isaacsim.core.nodes.IsaacComputeOdometry', version: 1, attrs: { 'inputs:execIn': from('uint', 'tick.outputs:tick'), 'inputs:chassisPrim': target(base), 'outputs:execOut': EXEC, 'outputs:position': { type: 'vector3d' }, 'outputs:orientation': { type: 'quatd' }, 'outputs:linearVelocity': { type: 'vector3d' }, 'outputs:angularVelocity': { type: 'vector3d' } } },
      {
        name: 'odom',
        type: 'isaacsim.ros2.bridge.ROS2PublishOdometry',
        version: 1,
        attrs: {
          'inputs:execIn': from('uint', 'odometry.outputs:execOut'),
          'inputs:context': from('uint64', 'context.outputs:context'),
          'inputs:timeStamp': from('double', 'time.outputs:simulationTime'),
          'inputs:position': from('vector3d', 'odometry.outputs:position'),
          'inputs:orientation': from('quatd', 'odometry.outputs:orientation'),
          'inputs:linearVelocity': from('vector3d', 'odometry.outputs:linearVelocity'),
          'inputs:angularVelocity': from('vector3d', 'odometry.outputs:angularVelocity'),
          'inputs:chassisFrameId': text(model.root),
          'inputs:odomFrameId': text('odom'),
          'inputs:topicName': text('odom'),
        },
      },
      {
        name: 'odom_tf',
        type: 'isaacsim.ros2.bridge.ROS2PublishRawTransformTree',
        version: 1,
        attrs: {
          'inputs:execIn': from('uint', 'odometry.outputs:execOut'),
          'inputs:context': from('uint64', 'context.outputs:context'),
          'inputs:timeStamp': from('double', 'time.outputs:simulationTime'),
          'inputs:translation': from('vector3d', 'odometry.outputs:position'),
          'inputs:rotation': from('quatd', 'odometry.outputs:orientation'),
          'inputs:parentFrameId': text('odom'),
          'inputs:childFrameId': text(model.root),
        },
      },
    );
  }
  const d = model.drive;
  if (d && (d.kind === 'differential' || d.kind === 'mecanum')) {
    // cmd_vel → wheel speeds for the left and right sides → every wheel of each side.
    const wheels = [...d.left, ...d.right];
    nodes.push(
      { name: 'cmd_vel', type: 'isaacsim.ros2.bridge.ROS2SubscribeTwist', version: 1, attrs: { 'inputs:execIn': from('uint', 'tick.outputs:tick'), 'inputs:context': from('uint64', 'context.outputs:context'), 'inputs:topicName': text('cmd_vel'), 'outputs:execOut': EXEC, 'outputs:linearVelocity': { type: 'vector3d' }, 'outputs:angularVelocity': { type: 'vector3d' } } },
      { name: 'linear', type: 'omni.graph.nodes.BreakVector3', version: 1, attrs: { 'inputs:tuple': from('vector3d', 'cmd_vel.outputs:linearVelocity'), 'outputs:x': { type: 'double' } } },
      { name: 'angular', type: 'omni.graph.nodes.BreakVector3', version: 1, attrs: { 'inputs:tuple': from('vector3d', 'cmd_vel.outputs:angularVelocity'), 'outputs:z': { type: 'double' } } },
      {
        name: 'differential',
        type: 'isaacsim.robot.wheeled_robots.DifferentialController',
        version: 1,
        attrs: {
          'inputs:execIn': from('uint', 'cmd_vel.outputs:execOut'),
          'inputs:linearVelocity': from('double', 'linear.outputs:x'),
          'inputs:angularVelocity': from('double', 'angular.outputs:z'),
          'inputs:wheelRadius': num('double', d.wheelRadius),
          'inputs:wheelDistance': num('double', d.wheelSeparation),
          'inputs:maxWheelSpeed': num('double', d.maxWheelSpeed),
          'inputs:maxLinearSpeed': num('double', d.maxWheelSpeed * d.wheelRadius),
          'inputs:maxAngularSpeed': num('double', (2 * d.maxWheelSpeed * d.wheelRadius) / Math.max(d.wheelSeparation, 1e-3)),
          'outputs:velocityCommand': { type: 'double[]' },
        },
      },
      { name: 'left', type: 'omni.graph.nodes.ArrayIndex', version: 1, attrs: { 'inputs:array': from('double[]', 'differential.outputs:velocityCommand'), 'inputs:index': num('int', 0), 'outputs:value': { type: 'double' } } },
      { name: 'right', type: 'omni.graph.nodes.ArrayIndex', version: 1, attrs: { 'inputs:array': from('double[]', 'differential.outputs:velocityCommand'), 'inputs:index': num('int', 1), 'outputs:value': { type: 'double' } } },
      {
        name: 'speeds',
        type: 'omni.graph.nodes.ConstructArray',
        version: 1,
        attrs: {
          'inputs:arraySize': num('int', wheels.length),
          'inputs:arrayType': { type: 'token', value: '"double[]"' },
          ...Object.fromEntries(wheels.map((_, i) => [`inputs:input${i}`, from('double', i < d.left.length ? 'left.outputs:value' : 'right.outputs:value')])),
          'outputs:array': { type: 'double[]' },
        },
      },
      { name: 'wheels', type: 'isaacsim.core.nodes.IsaacArticulationController', version: 1, attrs: { 'inputs:execIn': from('uint', 'tick.outputs:tick'), 'inputs:targetPrim': target(robotPath), 'inputs:jointNames': tokens(wheels), 'inputs:velocityCommand': from('double[]', 'speeds.outputs:array') } },
    );
  } else if (d && d.kind === 'ackermann') {
    // ackermann_cmd (speed and steering angle) → the steering joints' angles and the wheels' speeds.
    nodes.push(
      { name: 'ackermann_cmd', type: 'isaacsim.ros2.bridge.ROS2SubscribeAckermannDrive', version: 1, attrs: { 'inputs:execIn': from('uint', 'tick.outputs:tick'), 'inputs:context': from('uint64', 'context.outputs:context'), 'inputs:topicName': text('ackermann_cmd'), 'outputs:execOut': EXEC, 'outputs:speed': { type: 'double' }, 'outputs:steeringAngle': { type: 'double' } } },
      {
        name: 'ackermann',
        type: 'isaacsim.robot.wheeled_robots.AckermannController',
        version: 2,
        attrs: {
          'inputs:execIn': from('uint', 'ackermann_cmd.outputs:execOut'),
          'inputs:speed': from('double', 'ackermann_cmd.outputs:speed'),
          'inputs:steeringAngle': from('double', 'ackermann_cmd.outputs:steeringAngle'),
          'inputs:wheelBase': num('double', d.wheelBase ?? d.wheelSeparation),
          'inputs:trackWidth': num('double', d.wheelSeparation),
          'inputs:frontWheelRadius': num('double', d.wheelRadius),
          'inputs:backWheelRadius': num('double', d.wheelRadius),
          'inputs:maxWheelVelocity': num('double', d.maxWheelSpeed),
          'inputs:maxWheelRotation': num('double', d.steeringLimit ?? 0.6),
          'outputs:execOut': EXEC,
          'outputs:wheelAngles': { type: 'double[]' },
          'outputs:wheelRotationVelocity': { type: 'double[]' },
        },
      },
      { name: 'steering', type: 'isaacsim.core.nodes.IsaacArticulationController', version: 1, attrs: { 'inputs:execIn': from('uint', 'ackermann.outputs:execOut'), 'inputs:targetPrim': target(robotPath), 'inputs:jointNames': tokens(d.steer), 'inputs:positionCommand': from('double[]', 'ackermann.outputs:wheelAngles') } },
      { name: 'wheels', type: 'isaacsim.core.nodes.IsaacArticulationController', version: 1, attrs: { 'inputs:execIn': from('uint', 'ackermann.outputs:execOut'), 'inputs:targetPrim': target(robotPath), 'inputs:jointNames': tokens(d.ackermannWheels ?? [...d.left, ...d.right]), 'inputs:velocityCommand': from('double[]', 'ackermann.outputs:wheelRotationVelocity') } },
    );
  }
  if (model.controlled.length) {
    // joint_command (sensor_msgs/JointState) positions the arm's joints, by name.
    nodes.push(
      { name: 'joint_command', type: 'isaacsim.ros2.bridge.ROS2SubscribeJointState', version: 2, attrs: { 'inputs:execIn': from('uint', 'tick.outputs:tick'), 'inputs:context': from('uint64', 'context.outputs:context'), 'inputs:topicName': text('joint_command'), 'outputs:execOut': EXEC, 'outputs:jointNames': { type: 'token[]' }, 'outputs:positionCommand': { type: 'double[]' }, 'outputs:velocityCommand': { type: 'double[]' }, 'outputs:effortCommand': { type: 'double[]' } } },
      {
        name: 'servos',
        type: 'isaacsim.core.nodes.IsaacArticulationController',
        version: 1,
        attrs: { 'inputs:execIn': from('uint', 'joint_command.outputs:execOut'), 'inputs:targetPrim': target(robotPath), 'inputs:jointNames': from('token[]', 'joint_command.outputs:jointNames'), 'inputs:positionCommand': from('double[]', 'joint_command.outputs:positionCommand'), 'inputs:velocityCommand': from('double[]', 'joint_command.outputs:velocityCommand'), 'inputs:effortCommand': from('double[]', 'joint_command.outputs:effortCommand') },
      },
    );
  }
  for (const s of model.sensors) {
    const prim = `${linkPath(s.link)}/${s.name}`;
    const n = s.name;
    if (s.kind === 'camera' || s.kind === 'depth') {
      nodes.push(
        { name: `${n}_render`, type: 'isaacsim.core.nodes.IsaacCreateRenderProduct', version: 3, attrs: { 'inputs:execIn': from('uint', 'tick.outputs:tick'), 'inputs:cameraPrim': target(prim), 'inputs:width': num('uint', s.camera.width), 'inputs:height': num('uint', s.camera.height), 'outputs:execOut': EXEC, 'outputs:renderProductPath': { type: 'token' } } },
        {
          name: `${n}_image`,
          type: 'isaacsim.ros2.bridge.ROS2CameraHelper',
          version: 4,
          attrs: { 'inputs:execIn': from('uint', `${n}_render.outputs:execOut`), 'inputs:context': from('uint64', 'context.outputs:context'), 'inputs:renderProductPath': from('token', `${n}_render.outputs:renderProductPath`), 'inputs:frameId': text(n), 'inputs:topicName': text(s.kind === 'depth' ? `${n}/depth` : `${n}/image`), 'inputs:type': { type: 'token', value: s.kind === 'depth' ? '"depth"' : '"rgb"' } },
        },
        {
          name: `${n}_info`,
          type: 'isaacsim.ros2.bridge.ROS2CameraInfoHelper',
          version: 1,
          attrs: { 'inputs:execIn': from('uint', `${n}_render.outputs:execOut`), 'inputs:context': from('uint64', 'context.outputs:context'), 'inputs:renderProductPath': from('token', `${n}_render.outputs:renderProductPath`), 'inputs:frameId': text(n), 'inputs:topicName': text(`${n}/camera_info`) },
        },
      );
    } else if (s.kind === 'lidar') {
      nodes.push(
        { name: `${n}_render`, type: 'isaacsim.core.nodes.IsaacCreateRenderProduct', version: 3, attrs: { 'inputs:execIn': from('uint', 'tick.outputs:tick'), 'inputs:cameraPrim': target(prim), 'outputs:execOut': EXEC, 'outputs:renderProductPath': { type: 'token' } } },
        {
          name: `${n}_scan`,
          type: 'isaacsim.ros2.bridge.ROS2RtxLidarHelper',
          version: 3,
          attrs: { 'inputs:execIn': from('uint', `${n}_render.outputs:execOut`), 'inputs:context': from('uint64', 'context.outputs:context'), 'inputs:renderProductPath': from('token', `${n}_render.outputs:renderProductPath`), 'inputs:frameId': text(n), 'inputs:topicName': text(`${n}/scan`), 'inputs:type': { type: 'token', value: '"laser_scan"' }, 'inputs:fullScan': { type: 'bool', value: '1' } },
        },
      );
    } else if (s.kind === 'imu') {
      nodes.push(
        { name: `${n}_read`, type: 'isaacsim.sensors.physics.IsaacReadIMU', version: 1, attrs: { 'inputs:execIn': from('uint', 'tick.outputs:tick'), 'inputs:imuPrim': target(prim), 'inputs:readGravity': { type: 'bool', value: '1' }, 'outputs:execOut': EXEC, 'outputs:angVel': { type: 'vector3d' }, 'outputs:linAcc': { type: 'vector3d' }, 'outputs:orientation': { type: 'quatd' } } },
        {
          name: `${n}_imu`,
          type: 'isaacsim.ros2.bridge.ROS2PublishImu',
          version: 1,
          attrs: {
            'inputs:execIn': from('uint', `${n}_read.outputs:execOut`),
            'inputs:context': from('uint64', 'context.outputs:context'),
            'inputs:timeStamp': from('double', 'time.outputs:simulationTime'),
            'inputs:angularVelocity': from('vector3d', `${n}_read.outputs:angVel`),
            'inputs:linearAcceleration': from('vector3d', `${n}_read.outputs:linAcc`),
            'inputs:orientation': from('quatd', `${n}_read.outputs:orientation`),
            'inputs:frameId': text(n),
            'inputs:topicName': text(`${n}/imu`),
          },
        },
      );
    }
  }
  return ['def OmniGraph "ROS2"', '{', ...indent(['token evaluationMode = "Automatic"', 'token evaluator:type = "execution"', 'token fabricCacheBacking = "StageWithoutHistory"', 'int2 fileFormatVersion = (1, 9)', 'token pipelineStage = "pipelineStageSimulation"', ...nodes.flatMap((n) => ['', ...nodePrim(n, graph)])], 1), '}'];
}

/** The stage as USDA text. */
export function writeUsda(model: UsdModel): string {
  const robot = robotPrim(model.name);
  const robotPath = `/World/${robot}`;
  const linkPath = (link: string) => `${robotPath}/${link}`;
  const colors = new Map<string, [number, number, number]>();
  const frictions = new Map<string, number>([[frictionKey(FLOOR_FRICTION), FLOOR_FRICTION]]);
  for (const l of model.links) {
    for (const v of l.visual) colors.set(colorKey(v.color), v.color);
    frictions.set(frictionKey(l.friction), l.friction);
  }
  const touched = new Set(model.sensors.filter((s) => s.kind === 'touch').map((s) => s.link));
  const sensorsOf = (link: string) => model.sensors.filter((s) => s.link === link);

  const world: string[] = [
    'def PhysicsScene "physicsScene"',
    '{',
    '    vector3f physics:gravityDirection = (0, 0, -1)',
    '    float physics:gravityMagnitude = 9.81',
    '}',
    '',
    'def DomeLight "Dome"',
    '{',
    '    float inputs:intensity = 1000',
    '}',
    '',
    'def DistantLight "Sun"',
    '{',
    '    float inputs:angle = 1',
    '    float inputs:intensity = 3000',
    '    float3 xformOp:rotateXYZ = (-50, 20, 0)',
    '    uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]',
    '}',
    '',
    // The floor: a plane that stops things, under a wide grey slab to look at.
    'def Xform "Ground"',
    '{',
    '    def Plane "collision" (',
    '        prepend apiSchemas = ["PhysicsCollisionAPI", "MaterialBindingAPI"]',
    '    )',
    '    {',
    '        uniform token axis = "Z"',
    `        rel material:binding:physics = </World/PhysicsMaterials/${frictionKey(FLOOR_FRICTION)}>`,
    '        uniform token purpose = "guide"',
    '    }',
    '',
    '    def Mesh "floor" (',
    '        prepend apiSchemas = ["MaterialBindingAPI"]',
    '    )',
    '    {',
    '        float3[] extent = [(-10, -10, 0), (10, 10, 0)]',
    '        int[] faceVertexCounts = [4]',
    '        int[] faceVertexIndices = [0, 1, 2, 3]',
    '        rel material:binding = </World/Looks/floor>',
    '        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)]',
    '        point3f[] points = [(-10, -10, 0), (10, -10, 0), (10, 10, 0), (-10, 10, 0)]',
    '        uniform token subdivisionScheme = "none"',
    '    }',
    '}',
    '',
    'def Scope "Looks"',
    '{',
    ...indent([...materialPrim('floor', [0.42, 0.44, 0.45]), ...[...colors].flatMap(([k, c]) => ['', ...materialPrim(k, c)])], 1),
    '}',
    '',
    'def Scope "PhysicsMaterials"',
    '{',
    ...indent([...frictions].flatMap(([k, f], i) => [...(i ? [''] : []), ...physicsMaterialPrim(k, f)]), 1),
    '}',
    '',
    `def Xform "${robot}" (`,
    '    prepend apiSchemas = ["PhysicsArticulationRootAPI", "PhysxArticulationAPI"]',
    ')',
    '{',
    ...indent(
      [
        'bool physxArticulation:enabledSelfCollisions = 0',
        ...(model.fixedBase
          ? ['', `def PhysicsFixedJoint "${ROOT_JOINT}"`, '{', `    rel physics:body1 = <${linkPath(model.root)}>`, `    point3f physics:localPos0 = ${v3(model.links.find((l) => l.name === model.root)?.pos ?? [0, 0, 0])}`, '    point3f physics:localPos1 = (0, 0, 0)', '}']
          : []),
        ...model.links.flatMap((l) => ['', ...linkPrim(l, sensorsOf(l.name), touched.has(l.name))]),
        '',
        `def Scope "${JOINTS_SCOPE}"`,
        '{',
        ...indent(model.joints.flatMap((j, i) => [...(i ? [''] : []), ...jointPrim(j, robot, j.mimic && model.joints.find((o) => o.name === j.mimic!.joint))]), 1),
        '}',
      ],
      1,
    ),
    '}',
    '',
    ...rosGraph(model, robotPath, linkPath),
  ];

  return [
    '#usda 1.0',
    '(',
    `    doc = ${str(`${model.name}, made with ${APP_NAME}. Meters, Z up. Open in Isaac Sim and press Play; the ROS 2 graph drives it and publishes its sensors.`)}`,
    '    defaultPrim = "World"',
    '    metersPerUnit = 1',
    '    upAxis = "Z"',
    ')',
    '',
    'def Xform "World"',
    '{',
    ...indent(world, 1),
    '}',
    '',
  ].join('\n');
}
