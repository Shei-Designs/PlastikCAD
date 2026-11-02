// Writes a robot as an SDF model, the format Gazebo reads natively. Unlike
// URDF it holds loops, so every joint goes in. Every link's pose is given in
// the model frame with no turn (the frames are parallel), and each joint's
// pose in its child's frame. SI units.
import { APP_NAME } from '../appInfo';
import type { Vec3 } from '../model/types';
import type { Tensor } from '../robot/inertia';
import type { JointType } from '../robot/types';
import { escapeXml, fmt } from './format';
import { pad, surfaceXml } from './gazebo';
import type { UrdfGeometry } from './urdf';

export interface SdfLink {
  name: string;
  /** Where the link's frame sits in the model, m. */
  pose: Vec3;
  inertial: { mass: number; origin: Vec3; inertia: Tensor } | null;
  visual: { geometry: UrdfGeometry; origin?: Vec3; rpy?: Vec3; color?: [number, number, number] }[];
  collision: { geometry: UrdfGeometry; origin?: Vec3; rpy?: Vec3 }[];
  friction?: number;
  /** Sensor elements fixed in this link (see `sensorXml`). */
  sensors?: string[];
}

export interface SdfJoint {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  /** The joint's place in the child link's frame, m. */
  pose: Vec3;
  /** In the model frame. */
  axis: Vec3;
  limit?: { lower: number; upper: number; effort: number; velocity: number };
  dynamics?: { damping: number; friction: number };
  mimic?: { joint: string; multiplier: number; offset: number };
}

const vec = (v: Vec3): string => v.map((x) => fmt(x, 6)).join(' ');
const num = (x: number): string => fmt(x, 9);

function geometryXml(g: UrdfGeometry): string {
  if ('mesh' in g) return `<geometry><mesh><uri>${escapeXml(g.mesh)}</uri></mesh></geometry>`;
  if ('box' in g) return `<geometry><box><size>${vec(g.box)}</size></box></geometry>`;
  if ('cylinder' in g) return `<geometry><cylinder><radius>${fmt(g.cylinder.radius, 6)}</radius><length>${fmt(g.cylinder.length, 6)}</length></cylinder></geometry>`;
  return `<geometry><sphere><radius>${fmt(g.sphere.radius, 6)}</radius></sphere></geometry>`;
}

const poseXml = (origin?: Vec3, rpy?: Vec3): string => (origin?.some((x) => x !== 0) || rpy?.some((x) => x !== 0) ? `<pose>${vec(origin ?? [0, 0, 0])} ${vec(rpy ?? [0, 0, 0])}</pose>` : '');

function linkXml(l: SdfLink): string {
  const lines = [`  <link name="${escapeXml(l.name)}">`, `    <pose>${vec(l.pose)} 0 0 0</pose>`];
  if (l.inertial) {
    const [xx, yy, zz, xy, xz, yz] = l.inertial.inertia;
    lines.push(
      '    <inertial>',
      `      <pose>${vec(l.inertial.origin)} 0 0 0</pose>`,
      `      <mass>${num(l.inertial.mass)}</mass>`,
      `      <inertia><ixx>${num(xx)}</ixx><ixy>${num(xy)}</ixy><ixz>${num(xz)}</ixz><iyy>${num(yy)}</iyy><iyz>${num(yz)}</iyz><izz>${num(zz)}</izz></inertia>`,
      '    </inertial>',
    );
  }
  l.visual.forEach((v, i) => {
    lines.push(`    <visual name="${escapeXml(l.name)}_visual${i ? `_${i}` : ''}">`);
    const pose = poseXml(v.origin, v.rpy);
    if (pose) lines.push(`      ${pose}`);
    lines.push(`      ${geometryXml(v.geometry)}`);
    if (v.color) {
      const rgba = `${v.color.map((c) => fmt(c, 4)).join(' ')} 1`;
      lines.push(`      <material><ambient>${rgba}</ambient><diffuse>${rgba}</diffuse></material>`);
    }
    lines.push('    </visual>');
  });
  l.collision.forEach((c, i) => {
    lines.push(`    <collision name="${escapeXml(l.name)}_collision${i ? `_${i}` : ''}">`);
    const pose = poseXml(c.origin, c.rpy);
    if (pose) lines.push(`      ${pose}`);
    lines.push(`      ${geometryXml(c.geometry)}`);
    if (l.friction !== undefined) lines.push(`      ${surfaceXml(l.friction)}`);
    lines.push('    </collision>');
  });
  for (const s of l.sensors ?? []) lines.push(pad(s, '    '));
  lines.push('  </link>');
  return lines.join('\n');
}

function jointXml(j: SdfJoint): string {
  const lines = [`  <joint name="${escapeXml(j.name)}" type="${j.type === 'continuous' ? 'revolute' : j.type}">`, `    <pose relative_to="${escapeXml(j.child)}">${vec(j.pose)} 0 0 0</pose>`, `    <parent>${escapeXml(j.parent)}</parent>`, `    <child>${escapeXml(j.child)}</child>`];
  if (j.type !== 'fixed') {
    lines.push('    <axis>', `      <xyz expressed_in="__model__">${vec(j.axis)}</xyz>`);
    if (j.limit) {
      // A continuous joint is a revolute one without limits in SDF.
      const range = j.type === 'continuous' ? '' : `<lower>${fmt(j.limit.lower, 6)}</lower><upper>${fmt(j.limit.upper, 6)}</upper>`;
      lines.push(`      <limit>${range}<effort>${fmt(j.limit.effort, 6)}</effort><velocity>${fmt(j.limit.velocity, 6)}</velocity></limit>`);
    }
    if (j.dynamics) lines.push(`      <dynamics><damping>${fmt(j.dynamics.damping, 6)}</damping><friction>${fmt(j.dynamics.friction, 6)}</friction></dynamics>`);
    if (j.mimic) lines.push(`      <mimic joint="${escapeXml(j.mimic.joint)}"><multiplier>${fmt(j.mimic.multiplier, 6)}</multiplier><offset>${fmt(j.mimic.offset, 6)}</offset></mimic>`);
    lines.push('    </axis>');
  }
  lines.push('  </joint>');
  return lines.join('\n');
}

/** `plugins` are model-level plugin elements (the drive, the joint state publisher). */
/** `fixedToWorld` names the base link when the robot is bolted to the world by a fixed joint. */
/** `footprint` is a frame on the base link facing the robot's forward along +X, as ROS expects; the base is turned by `turn` radians about Z in it. */
export function writeSdf(name: string, links: SdfLink[], joints: SdfJoint[], plugins: string[] = [], fixedToWorld?: string, footprint?: { name: string; base: string; turn: number }): string {
  return [
    '<?xml version="1.0"?>',
    `<!-- Made with ${APP_NAME}. Units: meters, kilograms, radians. -->`,
    '<sdf version="1.11">',
    `<model name="${escapeXml(name)}">`,
    '  <self_collide>false</self_collide>',
    ...links.map(linkXml),
    ...(footprint ? [`  <frame name="${escapeXml(footprint.name)}" attached_to="${escapeXml(footprint.base)}"><pose>0 0 0 0 0 ${fmt(-footprint.turn || 0, 6)}</pose></frame>`] : []),
    ...(fixedToWorld ? [`  <joint name="world_joint" type="fixed">\n    <parent>world</parent>\n    <child>${escapeXml(fixedToWorld)}</child>\n  </joint>`] : []),
    ...joints.map(jointXml),
    ...plugins.map((p) => pad(p, '  ')),
    '</model>',
    '</sdf>',
    '',
  ].join('\n');
}

export function modelConfig(name: string, description: string): string {
  return `<?xml version="1.0"?>
<model>
  <name>${escapeXml(name)}</name>
  <version>1.0</version>
  <sdf version="1.11">model.sdf</sdf>
  <author><name>${APP_NAME}</name></author>
  <description>${escapeXml(description)}</description>
</model>
`;
}
