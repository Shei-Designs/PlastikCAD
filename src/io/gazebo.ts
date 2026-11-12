// The Gazebo side of a robot: sensors, the drive and joint-state plugins,
// written as SDF elements. The same elements go into an SDF model as they
// are, and into a URDF inside <gazebo> blocks, which Gazebo merges when it
// reads the URDF. Everything in SI; the caller converts from the design.
import type { Vec3 } from '../model/types';
import type { SensorKind } from '../robot/types';
import { escapeXml, fmt } from './format';

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

/** Publishes every joint's position, for robot_state_publisher when ros2_control is not in charge. */
export function jointStateXml(topic = 'joint_states'): string {
  return `<plugin filename="gz-sim-joint-state-publisher-system" name="gz::sim::systems::JointStatePublisher">\n  <topic>${topic}</topic>\n</plugin>`;
}

/** Friction of a collision surface, as Gazebo's ODE parameters. */
export function surfaceXml(friction: number): string {
  return `<surface><friction><ode><mu>${fmt(friction, 4)}</mu><mu2>${fmt(friction, 4)}</mu2></ode></friction></surface>`;
}

/**
 * The system plugins an empty world needs for sensors and physics, with the robot's model included when `include` is given.
 * `robot` is the name the robot goes by in the world; the light and the floor keep clear of it.
 */
export function worldXml(name: string, include?: string, robot = name): string {
  const own = (n: string): string => (n === robot ? `${n}_2` : n);
  return `<?xml version="1.0"?>
<sdf version="1.9">
  <world name="${escapeXml(name)}">
    <physics name="default" type="ode"><max_step_size>0.001</max_step_size><real_time_factor>1</real_time_factor></physics>
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
