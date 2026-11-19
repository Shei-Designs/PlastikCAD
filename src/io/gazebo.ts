// The Gazebo side of a robot: sensors, the drive and joint-state plugins,
// written as SDF elements. The same elements go into an SDF model as they
// are, and into a URDF inside <gazebo> blocks, which Gazebo merges when it
// reads the URDF. Everything in SI; the caller converts from the design.
import type { Vec3 } from '../model/types';
import type { SensorKind } from '../robot/types';
import { escapeXml, fmt } from './format';
import { CROWN } from './usd';

export interface GazeboSensor {
  /** Name of the sensor and of the frame (link) it sits in. */
  name: string;
  frame: string;
  kind: SensorKind;
  rate: number;
  /** Radians, pixels, meters. */
  camera: { hfov: number; width: number; height: number; near: number; far: number };
  /** Rays, radians, meters. */
  lidar: { samples: number; hfov: number; min: number; max: number };
  /** Where it sits in the link, m and radians; at the link's origin when left out (the frame is the sensor's own). */
  pose?: { xyz: Vec3; rpy: Vec3 };
  /** A touch sensor: the name of the collision it feels (the link's). */
  collision?: string;
  /** How many collisions the link has, when more than one: Gazebo names those after the first "…_collision_1", "…_collision_2". */
  collisions?: number;
}

const pad = (text: string, indent: string): string =>
  text
    .split('\n')
    .map((l) => (l ? indent + l : l))
    .join('\n');

/** One <sensor> element, its pose at the frame's origin (the frame is the sensor's own link). */
export function sensorXml(s: GazeboSensor): string {
  const type = s.kind === 'camera' ? 'camera' : s.kind === 'depth' ? 'depth_camera' : s.kind === 'lidar' ? 'gpu_lidar' : s.kind === 'touch' ? 'contact' : 'imu';
  const topic = sensorTopic(s);
  const lines = [`<sensor name="${escapeXml(s.name)}" type="${type}">`, ...(s.pose ? [`  <pose>${[...s.pose.xyz, ...s.pose.rpy].map((x) => fmt(x, 6)).join(' ')}</pose>`] : []), `  <always_on>true</always_on>`, `  <update_rate>${fmt(s.rate, 3)}</update_rate>`, `  <visualize>true</visualize>`, `  <topic>${topic}</topic>`, `  <gz_frame_id>${escapeXml(s.frame)}</gz_frame_id>`];
  if (s.kind === 'camera' || s.kind === 'depth') {
    lines.push(
      '  <camera>',
      `    <horizontal_fov>${fmt(s.camera.hfov, 6)}</horizontal_fov>`,
      `    <image><width>${s.camera.width}</width><height>${s.camera.height}</height></image>`,
      `    <clip><near>${fmt(s.camera.near, 4)}</near><far>${fmt(s.camera.far, 4)}</far></clip>`,
      '  </camera>',
    );
  } else if (s.kind === 'lidar') {
    // A full circle stops one step short of where it began, as `lidarAngles` has it, or its first and last rays are the same ray.
    const lastStep = s.lidar.hfov >= 2 * Math.PI - 1e-6 && s.lidar.samples > 1 ? s.lidar.hfov / s.lidar.samples : 0;
    lines.push(
      '  <lidar>',
      '    <scan>',
      `      <horizontal><samples>${s.lidar.samples}</samples><resolution>1</resolution><min_angle>${fmt(-s.lidar.hfov / 2, 6)}</min_angle><max_angle>${fmt(s.lidar.hfov / 2 - lastStep, 6)}</max_angle></horizontal>`,
      '    </scan>',
      `    <range><min>${fmt(s.lidar.min, 4)}</min><max>${fmt(s.lidar.max, 4)}</max><resolution>0.01</resolution></range>`,
      '  </lidar>',
    );
  }
  // Gazebo's Contact system takes its topic from inside <contact>; the sensor's own <topic> is ignored.
  if (s.kind === 'touch') {
    const first = s.collision ?? `${s.frame}_collision`;
    const names = Array.from({ length: s.collisions ?? 1 }, (_, i) => (i ? `${first}_${i}` : first));
    lines.push('  <contact>', ...names.map((n) => `    <collision>${escapeXml(n)}</collision>`), `    <topic>${topic}</topic>`, '  </contact>');
  }
  lines.push('</sensor>');
  return lines.join('\n');
}

/** The Gazebo topic a sensor publishes on. */
export const sensorTopic = (s: { name: string; kind: SensorKind }): string => (s.kind === 'camera' ? `${s.name}/image` : s.kind === 'depth' ? `${s.name}/depth` : s.kind === 'lidar' ? `${s.name}/scan` : s.kind === 'touch' ? `${s.name}/contacts` : `${s.name}/imu`);

/** The drive as a Gazebo plugin wants it: joint names by part, and the geometry in meters (radians for the steering reach). */
export type GazeboDrive = {
  /** Name of the base link, the odometry's child frame. */
  baseFrame: string;
  wheelRadius: number;
  wheelSeparation: number;
} & (
  | { kind: 'differential'; leftJoints: string[]; rightJoints: string[] }
  | { kind: 'ackermann'; leftJoints: string[]; rightJoints: string[]; leftSteer: string; rightSteer: string; wheelBase: number; kingpinWidth: number; steeringLimit: number }
  | { kind: 'mecanum'; frontLeft: string; frontRight: string; rearLeft: string; rearRight: string; wheelBase: number }
);

/** The drive plugin: velocity commands in on cmd_vel, odometry and its transform out. */
export function driveXml(d: GazeboDrive): string {
  const odometry = [
    '  <topic>cmd_vel</topic>',
    '  <odom_topic>odom</odom_topic>',
    '  <tf_topic>tf</tf_topic>',
    '  <frame_id>odom</frame_id>',
    `  <child_frame_id>${escapeXml(d.baseFrame)}</child_frame_id>`,
    '  <odom_publish_frequency>50</odom_publish_frequency>',
  ];
  const m = (v: number) => fmt(v, 5);
  if (d.kind === 'ackermann') {
    return [
      '<plugin filename="gz-sim-ackermann-steering-system" name="gz::sim::systems::AckermannSteering">',
      ...d.leftJoints.map((j) => `  <left_joint>${escapeXml(j)}</left_joint>`),
      ...d.rightJoints.map((j) => `  <right_joint>${escapeXml(j)}</right_joint>`),
      `  <left_steering_joint>${escapeXml(d.leftSteer)}</left_steering_joint>`,
      `  <right_steering_joint>${escapeXml(d.rightSteer)}</right_steering_joint>`,
      `  <kingpin_width>${m(d.kingpinWidth)}</kingpin_width>`,
      `  <steering_limit>${m(d.steeringLimit)}</steering_limit>`,
      `  <wheel_base>${m(d.wheelBase)}</wheel_base>`,
      `  <wheel_separation>${m(d.wheelSeparation)}</wheel_separation>`,
      `  <wheel_radius>${m(d.wheelRadius)}</wheel_radius>`,
      ...odometry,
      '</plugin>',
    ].join('\n');
  }
  if (d.kind === 'mecanum') {
    return [
      '<plugin filename="gz-sim-mecanum-drive-system" name="gz::sim::systems::MecanumDrive">',
      `  <front_left_joint>${escapeXml(d.frontLeft)}</front_left_joint>`,
      `  <front_right_joint>${escapeXml(d.frontRight)}</front_right_joint>`,
      `  <back_left_joint>${escapeXml(d.rearLeft)}</back_left_joint>`,
      `  <back_right_joint>${escapeXml(d.rearRight)}</back_right_joint>`,
      `  <wheelbase>${m(d.wheelBase)}</wheelbase>`,
      `  <wheel_separation>${m(d.wheelSeparation)}</wheel_separation>`,
      `  <wheel_radius>${m(d.wheelRadius)}</wheel_radius>`,
      ...odometry,
      '</plugin>',
    ].join('\n');
  }
  return [
    '<plugin filename="gz-sim-diff-drive-system" name="gz::sim::systems::DiffDrive">',
    ...d.leftJoints.map((j) => `  <left_joint>${escapeXml(j)}</left_joint>`),
    ...d.rightJoints.map((j) => `  <right_joint>${escapeXml(j)}</right_joint>`),
    `  <wheel_separation>${m(d.wheelSeparation)}</wheel_separation>`,
    `  <wheel_radius>${m(d.wheelRadius)}</wheel_radius>`,
    ...odometry,
    '</plugin>',
  ].join('\n');
}

/** The mass and inertia of the pin that closes a loop: a 1 g ball 10 mm across, light against any link it joins. */
export const PIN = { mass: 1e-3, inertia: [1e-8, 1e-8, 1e-8, 0, 0, 0] as [number, number, number, number, number, number] };

/**
 * Welds `pin`, a link of `model`, to `link` of the same model when the world begins. Gazebo's default physics
 * takes a model's joints as a tree and refuses the one that closes a loop, so that joint carries a pin instead
 * of its child, and this weld, a constraint the physics does take, holds the pin to the child.
 */
export function weldXml(link: string, model: string, pin: string): string {
  return `<plugin filename="gz-sim-detachable-joint-system" name="gz::sim::systems::DetachableJoint">\n  <parent_link>${escapeXml(link)}</parent_link>\n  <child_model>${escapeXml(model)}</child_model>\n  <child_link>${escapeXml(pin)}</child_link>\n</plugin>`;
}

/**
 * Publishes every joint's position, for robot_state_publisher when ros2_control is not in charge. Given `joints`,
 * only theirs: a model with joints the robot does not own (a mecanum wheel's rollers) keeps those to itself.
 */
export function jointStateXml(topic = 'joint_states', joints?: string[]): string {
  return `<plugin filename="gz-sim-joint-state-publisher-system" name="gz::sim::systems::JointStatePublisher">\n  <topic>${topic}</topic>${(joints ?? []).map((j) => `\n  <joint_name>${escapeXml(j)}</joint_name>`).join('')}\n</plugin>`;
}

/** A mecanum wheel's roller for Gazebo: what `rollerXml` writes. Meters, kilograms; the frames are the wheel link's. */
export interface GazeboRoller {
  name: string;
  joint: string;
  wheel: string;
  at: Vec3;
  axis: Vec3;
  inertial: { mass: number; inertia: [number, number, number, number, number, number] };
  balls: { at: Vec3; radius: number }[];
  friction: number;
  /** What a roller's hinge holds still against, N·m: without it a robot at rest on two wheels of a diagonal rolls on for good. */
  bearing?: number;
  /** A wheel that stands in for a track's belt: a cylinder about the hinge, turned from standing along Z (roll, pitch, yaw). */
  cylinder?: { radius: number; length: number; rpy: Vec3 };
  /** Such a wheel of a track in the drive: the most its motor does, and what the hinge resists by. */
  driven?: { effort: number; velocity: number; damping: number; friction: number };
}

/**
 * A roller of a mecanum wheel, as the SDF link and joint Gazebo gets: a body on a free hinge to its wheel, placed
 * and turned from the wheel link's frame, colliding as a row of balls. The same two elements go into an SDF model
 * as they are and into a URDF inside a <gazebo> block, where Gazebo alone reads them: the rollers are the
 * simulator's business, and no frame or joint of the robot's own. A wheel that stands in for a track's belt is
 * written the same way: a cylinder on a hinge to its track, which the drive turns.
 */
export function rollerXml(r: GazeboRoller): string {
  const v = (a: Vec3) => a.map((x) => fmt(x, 6)).join(' ');
  const n = (x: number) => fmt(x, 12);
  const [xx, yy, zz, xy, xz, yz] = r.inertial.inertia;
  const wheel = escapeXml(r.wheel);
  return [
    `<link name="${escapeXml(r.name)}">`,
    `  <pose relative_to="${wheel}">${v(r.at)} 0 0 0</pose>`,
    `  <inertial><mass>${n(r.inertial.mass)}</mass><inertia><ixx>${n(xx)}</ixx><ixy>${n(xy)}</ixy><ixz>${n(xz)}</ixz><iyy>${n(yy)}</iyy><iyz>${n(yz)}</iyz><izz>${n(zz)}</izz></inertia></inertial>`,
    ...r.balls.map((b, i) => `  <collision name="${escapeXml(r.name)}_collision${i ? `_${i}` : ''}"><pose>${v(b.at)} 0 0 0</pose><geometry><sphere><radius>${fmt(b.radius, 6)}</radius></sphere></geometry>${surfaceXml(r.friction)}</collision>`),
    ...(r.cylinder ? [`  <collision name="${escapeXml(r.name)}_collision"><pose>0 0 0 ${v(r.cylinder.rpy)}</pose><geometry><cylinder><radius>${fmt(r.cylinder.radius, 6)}</radius><length>${fmt(r.cylinder.length, 6)}</length></cylinder></geometry>${surfaceXml(r.friction)}</collision>`] : []),
    '</link>',
    `<joint name="${escapeXml(r.joint)}" type="revolute">`,
    `  <parent>${wheel}</parent>`,
    `  <child>${escapeXml(r.name)}</child>`,
    r.driven
      ? `  <axis><xyz expressed_in="${wheel}">${v(r.axis)}</xyz><limit><effort>${fmt(r.driven.effort, 6)}</effort><velocity>${fmt(r.driven.velocity, 6)}</velocity></limit><dynamics><damping>${fmt(r.driven.damping, 6)}</damping><friction>${fmt(r.driven.friction, 6)}</friction></dynamics></axis>`
      : `  <axis><xyz expressed_in="${wheel}">${v(r.axis)}</xyz>${r.bearing ? `<dynamics><friction>${fmt(r.bearing, 6)}</friction></dynamics>` : ''}</axis>`,
    '</joint>',
  ].join('\n');
}

/**
 * Gazebo's own position controller on one joint, for a model that no ROS controller holds: it takes a position
 * on `/model/<model>/joint/<joint>/0/cmd_pos` and begins by going to `start` (radians or meters). It commands the
 * joint's speed, up to `velocity`, which the physics follows within the joint's effort limit: no gains to tune,
 * and none that a light link could be shaken by.
 */
export function positionXml(joint: string, velocity: number, start = 0): string {
  return [
    '<plugin filename="gz-sim-joint-position-controller-system" name="gz::sim::systems::JointPositionController">',
    `  <joint_name>${escapeXml(joint)}</joint_name>`,
    '  <use_velocity_commands>true</use_velocity_commands>',
    `  <cmd_max>${fmt(velocity, 6)}</cmd_max>`,
    `  <initial_position>${fmt(start, 6)}</initial_position>`,
    '</plugin>',
  ].join('\n');
}

/** The namespace of Gazebo's own attributes, declared on the root of a file that carries one (`gz:expressed_in`). */
export const GZ_NAMESPACE = 'xmlns:gz="http://gazebosim.org/schema"';

/**
 * A wheel that has to slide to let its robot turn (see `skid` in the export): the link whose frame keeps the
 * wheel's heading without turning with it, and a level direction in that frame halfway between the wheel's axle
 * and the way it rolls.
 */
export interface Skid {
  frame: string;
  along: Vec3;
}

/**
 * The two cylinders a wheel that skids collides as in Gazebo: the wheel's own, a little low, and a ridge of its
 * full radius round its middle (see `CROWN`). A cylinder lying exactly flat touches the floor along its whole width,
 * and Gazebo's physics shares its load along that line as it pleases; one a hair off flat (a quarter turn written
 * to six places is) stands on one end. Either way the rover turns about the wrong points: the ROS package and the
 * SDF model, whose quarter turns reach Gazebo rounded differently, turned up to a tenth apart.
 */
export function crowned(radius: number, length: number): { radius: number; length: number; tread: boolean }[] {
  return [
    { radius: radius * (1 - CROWN.drop), length, tread: false },
    { radius, length: length * CROWN.width, tread: true },
  ];
}

/**
 * Friction of a collision surface, as Gazebo's ODE parameters. Gazebo's physics limits the grip along two
 * directions, each on its own: a square, where friction is a circle. Left to itself it lays the square along the
 * world's axes, so a wheel pushed along and across at once holds with up to 1.4 times its grip, and how much
 * depends on which way the robot faces. For a wheel with a `skid` the square is laid on the wheel's diagonals
 * and made to fit inside the circle: the full grip along and across, and what is used one way is not there the other.
 */
export function surfaceXml(friction: number, skid?: Skid): string {
  const mu = skid ? fmt(friction * Math.SQRT1_2, 6) : fmt(friction, 4);
  const fdir = skid ? `<fdir1 gz:expressed_in="${escapeXml(skid.frame)}">${skid.along.map((x) => fmt(x, 6)).join(' ')}</fdir1>` : '';
  return `<surface><friction><ode><mu>${mu}</mu><mu2>${mu}</mu2>${fdir}</ode></friction></surface>`;
}

/**
 * The system plugins an empty world needs for sensors and physics, with the robot's model included when `include` is given.
 * `robot` is the name the robot goes by in the world; the light and the floor keep clear of it. `welded` is for a robot
 * with a loop, which a weld holds shut: the physics' default solver (Dantzig) throws such a robot apart as soon as it
 * also stands on the floor, and the iterative one (PGS) does not.
 */
export function worldXml(name: string, include?: string, robot = name, welded = false): string {
  const own = (n: string): string => (n === robot ? `${n}_2` : n);
  return `<?xml version="1.0"?>
<sdf version="1.9">
  <world name="${escapeXml(name)}">
    <physics name="default" type="ode"><max_step_size>0.001</max_step_size><real_time_factor>1</real_time_factor>${welded ? '<dart><solver><solver_type>pgs</solver_type></solver></dart>' : ''}</physics>
    <plugin filename="gz-sim-physics-system" name="gz::sim::systems::Physics"/>
    <plugin filename="gz-sim-user-commands-system" name="gz::sim::systems::UserCommands"/>
    <plugin filename="gz-sim-scene-broadcaster-system" name="gz::sim::systems::SceneBroadcaster"/>
    <plugin filename="gz-sim-sensors-system" name="gz::sim::systems::Sensors"><render_engine>ogre2</render_engine></plugin>
    <plugin filename="gz-sim-imu-system" name="gz::sim::systems::Imu"/>
    <plugin filename="gz-sim-contact-system" name="gz::sim::systems::Contact"/>
    <light type="directional" name="${own('sun')}">
      <cast_shadows>true</cast_shadows>
      <pose>0 0 10 0 0 0</pose>
      <diffuse>0.8 0.8 0.8 1</diffuse>
      <specular>0.2 0.2 0.2 1</specular>
      <direction>-0.5 0.1 -0.9</direction>
    </light>
    <model name="${own('ground_plane')}">
      <static>true</static>
      <link name="link">
        <collision name="collision"><geometry><plane><normal>0 0 1</normal><size>100 100</size></plane></geometry>${surfaceXml(1)}</collision>
        <visual name="visual"><geometry><plane><normal>0 0 1</normal><size>100 100</size></plane></geometry><material><ambient>0.8 0.8 0.8 1</ambient><diffuse>0.8 0.8 0.8 1</diffuse></material></visual>
      </link>
    </model>${include ? `\n    <include>\n      <uri>model://${escapeXml(include)}</uri>\n      <pose>0 0 0.05 0 0 0</pose>\n    </include>` : ''}
  </world>
</sdf>
`;
}

export { pad };
