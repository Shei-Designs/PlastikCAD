// Writes a robot as URDF (Unified Robot Description Format), the file ROS 2,
// RViz, Gazebo, Isaac Sim and MuJoCo all read. Everything here is already in
// SI (meters, kilograms, radians, kg·m²): the caller converts from the design.
import { APP_NAME } from '../appInfo';
import type { Vec3 } from '../model/types';
import type { Tensor } from '../robot/inertia';
import type { JointType, SensorKind } from '../robot/types';
import { escapeXml, fmt } from './format';

export interface UrdfInertial {
  /** kg. */
  mass: number;
  /** Center of mass in the link's frame, m. */
  origin: Vec3;
  /** About the center of mass, kg·m²: xx, yy, zz, xy, xz, yz. */
  inertia: Tensor;
}

export type UrdfGeometry = { mesh: string } | { box: Vec3 } | { cylinder: { radius: number; length: number } } | { sphere: { radius: number } };

export interface UrdfShape {
  geometry: UrdfGeometry;
  /** Where the shape sits in the link's frame, m; the link's origin if left out. */
  origin?: Vec3;
  /** How it is turned there: roll, pitch, yaw in radians (about the fixed X, then Y, then Z). */
  rpy?: Vec3;
}

export interface UrdfLink {
  name: string;
  inertial: UrdfInertial | null;
  visual: (UrdfShape & { color?: [number, number, number] })[];
  collision: UrdfShape[];
  /** Coefficient of friction of the surface, written for Gazebo. */
  friction?: number;
  /** Gazebo sensor elements fixed in this link (see `sensorXml`), written in a <gazebo> block for it. */
  sensors?: string[];
}

export interface UrdfExtras {
  /** Model-level Gazebo plugin elements (the drive, the joint state publisher). */
  plugins?: string[];
  /**
   * Joints under ros2_control, with position commands; a block is written and the Gazebo plugin for it, reading
   * `controllersYaml`. `starts` is where each joint that does not begin at zero stands when the simulation begins
   * (radians or meters): Gazebo puts it there, and the controller holds what it finds.
   */
  control?: { joints: string[]; controllersYaml: string; starts?: Record<string, number> };
  /**
   * Write xacro instead: the package name as a property, the Gazebo blocks
   * behind a `use_gazebo` argument and ros2_control behind `use_ros2_control`,
   * so one file serves RViz alone, Gazebo, and a real robot.
   */
  xacro?: { package: string };
  /** The base link when the robot is bolted to the world, and where its frame is there (m): a `world` link and a fixed joint hold it. */
  fixedToWorld?: { link: string; at: Vec3 };
  /** A root link facing the robot's forward along +X, as ROS expects, on the floor `height` m under the base link, which is turned by `turn` radians about Z in it. */
  footprint?: { name: string; joint: string; base: string; turn: number; height: number };
}

export interface UrdfJoint {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  /** The child frame in the parent frame, m, and how it is turned there (radians); a sensor's frame is the one joint that turns. */
  origin: Vec3;
  rpy?: Vec3;
  axis: Vec3;
  /** Radians or meters; effort N·m or N; velocity rad/s or m/s. */
  limit?: { lower: number; upper: number; effort: number; velocity: number };
  dynamics?: { damping: number; friction: number };
  mimic?: { joint: string; multiplier: number; offset: number };
  /** Where the joint stands when a simulation begins, radians or meters from the pose the file is written in; absent at zero. */
  start?: number;
  /** The motor's reflected rotor inertia, kg·m²; only MuJoCo takes it (as the joint's armature). */
  armature?: number;
  /** Keep this fixed joint in Gazebo instead of folding its child into the parent, for a child whose collision a sensor names. */
  preserve?: boolean;
}

const vec = (v: Vec3): string => v.map((x) => fmt(x, 6)).join(' ');
/** Inertia and small masses need more figures than lengths do. */
const num = (x: number): string => fmt(x, 9);

const geometryXml = (g: UrdfGeometry): string => {
  if ('mesh' in g) return `<mesh filename="${escapeXml(g.mesh)}"/>`;
  if ('box' in g) return `<box size="${vec(g.box)}"/>`;
  if ('cylinder' in g) return `<cylinder radius="${fmt(g.cylinder.radius, 6)}" length="${fmt(g.cylinder.length, 6)}"/>`;
  return `<sphere radius="${fmt(g.sphere.radius, 6)}"/>`;
};

const originXml = (origin: Vec3 | undefined, rpy: Vec3 | undefined, indent: string): string => {
  const moved = origin?.some((x) => x !== 0);
  const turned = rpy?.some((x) => x !== 0);
  return moved || turned ? `${indent}<origin xyz="${vec(origin ?? [0, 0, 0])}" rpy="${vec(rpy ?? [0, 0, 0])}"/>\n` : '';
};

function linkXml(link: UrdfLink, materials: Map<string, string>): string {
  const lines: string[] = [`  <link name="${escapeXml(link.name)}">`];
  if (link.inertial) {
    const [xx, yy, zz, xy, xz, yz] = link.inertial.inertia;
    lines.push(
      '    <inertial>',
      `      <origin xyz="${vec(link.inertial.origin)}" rpy="0 0 0"/>`,
      `      <mass value="${num(link.inertial.mass)}"/>`,
      `      <inertia ixx="${num(xx)}" ixy="${num(xy)}" ixz="${num(xz)}" iyy="${num(yy)}" iyz="${num(yz)}" izz="${num(zz)}"/>`,
      '    </inertial>',
    );
  }
  for (const v of link.visual) {
    lines.push('    <visual>');
    lines.push(originXml(v.origin, v.rpy, '      ').trimEnd());
    lines.push(`      <geometry>${geometryXml(v.geometry)}</geometry>`);
    if (v.color) lines.push(`      <material name="${materialName(v.color, materials)}"/>`);
    lines.push('    </visual>');
  }
  for (const c of link.collision) {
    lines.push('    <collision>');
    lines.push(originXml(c.origin, c.rpy, '      ').trimEnd());
    lines.push(`      <geometry>${geometryXml(c.geometry)}</geometry>`);
    lines.push('    </collision>');
  }
  lines.push('  </link>');
  return lines.filter((l) => l !== '').join('\n');
}

/** Colors are shared materials, named after their hex digits, declared once at the top. */
function materialName(color: [number, number, number], materials: Map<string, string>): string {
  const hex = color.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('');
  const name = `color_${hex}`;
  if (!materials.has(name)) materials.set(name, `${color.map((c) => fmt(c, 4)).join(' ')} 1`);
  return name;
}

function jointXml(j: UrdfJoint): string {
  const lines = [`  <joint name="${escapeXml(j.name)}" type="${j.type}">`, `    <parent link="${escapeXml(j.parent)}"/>`, `    <child link="${escapeXml(j.child)}"/>`, `    <origin xyz="${vec(j.origin)}" rpy="${vec(j.rpy ?? [0, 0, 0])}"/>`];
  if (j.type !== 'fixed') lines.push(`    <axis xyz="${vec(j.axis)}"/>`);
  if (j.limit && j.type !== 'fixed') {
    const range = j.type === 'continuous' ? '' : ` lower="${fmt(j.limit.lower, 6)}" upper="${fmt(j.limit.upper, 6)}"`;
    lines.push(`    <limit${range} effort="${fmt(j.limit.effort, 6)}" velocity="${fmt(j.limit.velocity, 6)}"/>`);
  }
  if (j.dynamics && j.type !== 'fixed') lines.push(`    <dynamics damping="${fmt(j.dynamics.damping, 6)}" friction="${fmt(j.dynamics.friction, 6)}"/>`);
  if (j.mimic) lines.push(`    <mimic joint="${escapeXml(j.mimic.joint)}" multiplier="${fmt(j.mimic.multiplier, 6)}" offset="${fmt(j.mimic.offset, 6)}"/>`);
  lines.push('  </joint>');
  return lines.join('\n');
}

export function writeUrdf(name: string, links: UrdfLink[], joints: UrdfJoint[], extras: UrdfExtras = {}): string {
  const materials = new Map<string, string>();
  const xacro = extras.xacro;
  // In xacro the package is a property, so the meshes follow a rename.
  const inPackage = (text: string): string => (xacro ? text.split(`package://${xacro.package}/`).join('package://${package}/') : text);
  const body = links.map((l) => inPackage(linkXml(l, materials)));
  if (extras.fixedToWorld) body.unshift(`  <link name="${WORLD_LINK}"/>`);
  const fp = extras.footprint;
  if (fp) body.unshift(`  <link name="${escapeXml(fp.name)}"/>`);
  const jointLines = [
    ...(extras.fixedToWorld ? [`  <joint name="${WORLD_JOINT}" type="fixed">\n    <parent link="${WORLD_LINK}"/>\n    <child link="${escapeXml(extras.fixedToWorld.link)}"/>\n    <origin xyz="${vec(extras.fixedToWorld.at)}" rpy="0 0 0"/>\n  </joint>`] : []),
    ...(fp ? [`  <joint name="${escapeXml(fp.joint)}" type="fixed">\n    <parent link="${escapeXml(fp.name)}"/>\n    <child link="${escapeXml(fp.base)}"/>\n    <origin xyz="0 0 ${fmt(fp.height, 6)}" rpy="0 0 ${fmt(fp.turn, 6)}"/>\n  </joint>`] : []),
    ...joints.map(jointXml),
  ];
  const head = [...materials].map(([n, rgba]) => `  <material name="${n}">\n    <color rgba="${rgba}"/>\n  </material>`);
  // Gazebo reads friction and sensors from blocks of its own beside the links, and plugins from blocks of the robot's.
  const gazebo: string[] = [];
  for (const l of links) {
    const inner: string[] = [];
    if (l.friction !== undefined && l.collision.length > 0) inner.push(`    <mu1>${fmt(l.friction, 4)}</mu1>`, `    <mu2>${fmt(l.friction, 4)}</mu2>`);
    for (const s of l.sensors ?? []) inner.push(indent(s, '    '));
    if (inner.length) gazebo.push(`  <gazebo reference="${escapeXml(l.name)}">`, ...inner, '  </gazebo>');
  }
  for (const j of joints) if (j.preserve) gazebo.push(`  <gazebo reference="${escapeXml(j.name)}">`, '    <preserveFixedJoint>true</preserveFixedJoint>', '  </gazebo>');
  for (const p of extras.plugins ?? []) gazebo.push('  <gazebo>', indent(p, '    '), '  </gazebo>');
  const control: string[] = [];
  if (extras.control && extras.control.joints.length) {
    const starts = extras.control.starts ?? {};
    control.push(
      '  <ros2_control name="GazeboSimSystem" type="system">',
      '    <hardware>',
      '      <plugin>gz_ros2_control/GazeboSimSystem</plugin>',
      '    </hardware>',
      ...extras.control.joints.flatMap((j) => [`    <joint name="${escapeXml(j)}">`, '      <command_interface name="position"/>', starts[j] ? `      <state_interface name="position">\n        <param name="initial_value">${fmt(starts[j], 6)}</param>\n      </state_interface>` : '      <state_interface name="position"/>', '      <state_interface name="velocity"/>', '    </joint>']),
      '  </ros2_control>',
      '  <gazebo>',
      '    <plugin filename="gz_ros2_control-system" name="gz_ros2_control::GazeboSimROS2ControlPlugin">',
      `      <parameters>${xacro ? '$(find ${package})/config/controllers.yaml' : escapeXml(extras.control.controllersYaml)}</parameters>`,
      '    </plugin>',
      '  </gazebo>',
    );
  }
  if (!xacro) return [`<?xml version="1.0"?>`, `<!-- Made with ${APP_NAME}. Units: meters, kilograms, radians. -->`, `<robot name="${escapeXml(name)}">`, ...head, ...body, ...jointLines, ...gazebo, ...control, '</robot>', ''].join('\n');
  const guarded = (arg: string, lines: string[]): string[] => (lines.length ? [`  <xacro:if value="$(arg ${arg})">`, ...lines.map((l) => (l ? `  ${l}` : l)), '  </xacro:if>'] : []);
  return [
    `<?xml version="1.0"?>`,
    `<!-- Made with ${APP_NAME}. Units: meters, kilograms, radians. -->`,
    `<!-- xacro ${xacro.package}.urdf.xacro use_gazebo:=false   leaves out the Gazebo blocks (RViz, or a real robot); use_ros2_control:=false the controllers. -->`,
    `<robot name="${escapeXml(name)}" xmlns:xacro="http://www.ros.org/wiki/xacro">`,
    `  <xacro:property name="package" value="${escapeXml(xacro.package)}"/>`,
    '  <xacro:arg name="use_gazebo" default="true"/>',
    '  <xacro:arg name="use_ros2_control" default="true"/>',
    ...head,
    ...body,
    ...jointLines,
    ...guarded('use_gazebo', gazebo),
    ...guarded('use_ros2_control', control),
    '</robot>',
    '',
  ].join('\n');
}

const indent = (text: string, by: string): string =>
  text
    .split('\n')
    .map((l) => (l ? by + l : l))
    .join('\n');

/** A name URDF and ROS accept: letters, digits and underscores, starting with a letter. */
export function urdfName(raw: string, fallback = 'link'): string {
  const clean = raw
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const named = clean || fallback;
  return /^[A-Za-z]/.test(named) ? named : `${fallback}_${named}`;
}

/**
 * The names a file holds, handed out so that no two things of a kind share one: a name already taken gets _2, _3…
 * Each name is kept as a key with its kind in front ("joint/elbow"), since a file may let a body and a joint share
 * a name but never two joints. `reserved` are the keys the writer uses itself, as text or as a pattern.
 */
export class NameSet {
  private readonly taken = new Set<string>();
  private readonly patterns: RegExp[] = [];

  constructor(reserved: Iterable<string | RegExp> = []) {
    for (const r of reserved) {
      if (typeof r === 'string') this.taken.add(r);
      else this.patterns.push(r);
    }
  }

  private free(key: string): boolean {
    return !this.taken.has(key) && !this.patterns.some((p) => p.test(key));
  }

  /** `base`, or the first of base_2, base_3… whose every key is free; the keys are taken. */
  take(base: string, keys: (name: string) => string[] = (name) => [name]): string {
    let name = base;
    for (let n = 2; !keys(name).every((k) => this.free(k)); n++) name = `${base}_${n}`;
    for (const k of keys(name)) this.taken.add(k);
    return name;
  }
}

/**
 * What a writer names in its file, as keys for a `NameSet`: the names it uses itself, and every name it writes for
 * a link, a joint or a sensor called `name`, the thing's own and the ones made from it (a sensor's frame, a joint's
 * reading). The robot's names are drawn against these, so nothing the user typed lands on one.
 */
export interface Naming {
  reserved: (string | RegExp)[];
  link: (name: string) => string[];
  joint: (name: string) => string[];
  /** `rays` is how many rays a lidar casts. */
  sensor: (name: string, kind: SensorKind, rays: number) => string[];
}

/** Each name made different from the ones before it: a repeat gets _2, _3… `names` holds what is taken already, by the keys `keys` gives a name. */
export function uniqueNames<T>(items: T[], nameOf: (item: T) => string, names = new NameSet(), keys: (name: string, item: T) => string[] = (name) => [name]): Map<T, string> {
  const out = new Map<T, string>();
  for (const item of items) out.set(item, names.take(nameOf(item), (name) => keys(name, item)));
  return out;
}

/** The link that stands for the world, and the joint that bolts a fixed base to it. Gazebo reads `world` so in any robot. */
const WORLD_LINK = 'world';
const WORLD_JOINT = 'world_joint';

/**
 * Links, joints and frames share one set of names: Gazebo turns the URDF into SDF, where they do. Sensors have
 * their own, which their topics come from; the frames a sensor hangs in are links and joints like any other.
 */
const inModel = (name: string): string => `model/${name}`;
export const URDF_NAMES: Naming = {
  reserved: [inModel(WORLD_LINK), inModel(WORLD_JOINT)],
  link: (name) => [inModel(name)],
  joint: (name) => [inModel(name)],
  sensor: (name) => [`sensor/${name}`],
};
