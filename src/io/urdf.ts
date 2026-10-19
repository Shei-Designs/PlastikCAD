// Writes a robot as URDF (Unified Robot Description Format), the file ROS 2,
// RViz, Gazebo, Isaac Sim and MuJoCo all read. Everything here is already in
// SI (meters, kilograms, radians, kg·m²): the caller converts from the design.
import { APP_NAME } from '../app';
import type { Vec3 } from '../model/types';
import type { Tensor } from '../robot/inertia';
import type { JointType } from '../robot/types';
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
}

export interface UrdfLink {
  name: string;
  inertial: UrdfInertial | null;
  visual: (UrdfShape & { color?: [number, number, number] })[];
  collision: UrdfShape[];
  /** Coefficient of friction of the surface, written for Gazebo. */
  friction?: number;
}

export interface UrdfJoint {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  /** The child frame in the parent frame, m. */
  origin: Vec3;
  axis: Vec3;
  /** Radians or meters; effort N·m or N; velocity rad/s or m/s. */
  limit?: { lower: number; upper: number; effort: number; velocity: number };
  dynamics?: { damping: number; friction: number };
  mimic?: { joint: string; multiplier: number; offset: number };
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

const originXml = (origin: Vec3 | undefined, indent: string): string => (origin && origin.some((x) => x !== 0) ? `${indent}<origin xyz="${vec(origin)}" rpy="0 0 0"/>\n` : '');

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
    lines.push(originXml(v.origin, '      ').trimEnd());
    lines.push(`      <geometry>${geometryXml(v.geometry)}</geometry>`);
    if (v.color) lines.push(`      <material name="${materialName(v.color, materials)}"/>`);
    lines.push('    </visual>');
  }
  for (const c of link.collision) {
    lines.push('    <collision>');
    lines.push(originXml(c.origin, '      ').trimEnd());
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
  const lines = [`  <joint name="${escapeXml(j.name)}" type="${j.type}">`, `    <parent link="${escapeXml(j.parent)}"/>`, `    <child link="${escapeXml(j.child)}"/>`, `    <origin xyz="${vec(j.origin)}" rpy="0 0 0"/>`];
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

export function writeUrdf(name: string, links: UrdfLink[], joints: UrdfJoint[]): string {
  const materials = new Map<string, string>();
  const body = links.map((l) => linkXml(l, materials));
  const head = [...materials].map(([n, rgba]) => `  <material name="${n}">\n    <color rgba="${rgba}"/>\n  </material>`);
  // Gazebo reads friction from its own block beside the link.
  const gazebo = links.filter((l) => l.friction !== undefined && l.collision.length > 0).map((l) => `  <gazebo reference="${escapeXml(l.name)}">\n    <mu1>${fmt(l.friction!, 4)}</mu1>\n    <mu2>${fmt(l.friction!, 4)}</mu2>\n  </gazebo>`);
  return [`<?xml version="1.0"?>`, `<!-- Made with ${APP_NAME}. Units: meters, kilograms, radians. -->`, `<robot name="${escapeXml(name)}">`, ...head, ...body, ...joints.map(jointXml), ...gazebo, '</robot>', ''].join('\n');
}

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

/** Each name made different from the ones before it: a repeat gets _2, _3… */
export function uniqueNames<T>(items: T[], nameOf: (item: T) => string): Map<T, string> {
  const taken = new Set<string>();
  const out = new Map<T, string>();
  for (const item of items) {
    const base = nameOf(item);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    taken.add(name);
    out.set(item, name);
  }
  return out;
}
