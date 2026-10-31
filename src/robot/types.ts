// A robot laid over a design: every top-level object is a link, and joints
// say how the links move against each other. Nothing here changes the design;
// a design without a robot is just a design. Everything is in the design's
// units (mm, degrees, grams); the exporters turn them into SI.
import type { Vec3 } from '../model/types';

export type JointType = 'fixed' | 'revolute' | 'continuous' | 'prismatic';

export const JOINT_TYPES: { id: JointType; name: string; help: string }[] = [
  { id: 'revolute', name: 'Revolute', help: 'Turns about the axis between two limits.' },
  { id: 'continuous', name: 'Continuous', help: 'Turns about the axis without limits, like a wheel.' },
  { id: 'prismatic', name: 'Prismatic', help: 'Slides along the axis between two limits.' },
  { id: 'fixed', name: 'Fixed', help: 'Holds the child still against its parent.' },
];

/** How a link's mass is known: weighed, or figured from its material and how it is printed. */
export type MassSpec =
  | { kind: 'measured'; grams: number }
  | {
      kind: 'material';
      /** Id in `MATERIALS`. */
      material: string;
      /** Percent of the inside that is filled, for printed materials; 100 for solid ones. */
      infill: number;
      /** Thickness of the solid skin of a printed part, in mm: walls plus top and bottom layers. */
      shell: number;
    };

export type CollisionKind = 'hull' | 'box' | 'cylinder' | 'sphere' | 'mesh' | 'none';

export const COLLISION_KINDS: { id: CollisionKind; name: string; help: string }[] = [
  { id: 'hull', name: 'Convex hull', help: 'The shape wrapped tight, with no hollows: fast and close.' },
  { id: 'box', name: 'Box', help: "The object's box, turned as it is: fastest, roomier." },
  { id: 'cylinder', name: 'Cylinder', help: "A cylinder filling the object's box along its own Z: wheels, rollers, shafts." },
  { id: 'sphere', name: 'Sphere', help: "A ball filling the object's box: balls and casters." },
  { id: 'mesh', name: 'Exact mesh', help: 'The visual shape itself: slow, and most simulators approximate it anyway.' },
  { id: 'none', name: 'None', help: 'Passes through everything.' },
];

/** The robot's settings for one top-level object. An object with none is a link with the defaults. */
export interface RobotLink {
  /** Id of the top-level scene node. */
  node: string;
  /** Name in the exported file, when it should differ from the object's name. */
  name?: string;
  mass: MassSpec;
  collision: CollisionKind;
  /** Coefficient of friction of the surface, for the simulator's contact model. */
  friction: number;
}

export interface RobotJoint {
  id: string;
  name: string;
  type: JointType;
  /** Node ids of the links it joins. */
  parent: string;
  child: string;
  /**
   * Where the joint sits and which way its axis points, in the child's own
   * frame (its center, turned as it is, unscaled), so that moving or turning
   * the child carries its joint along. Both in mm; the axis is a unit vector.
   */
  origin: Vec3;
  axis: Vec3;
  /** Range of motion: degrees for a revolute joint, mm for a prismatic one. Not used by fixed and continuous joints. */
  lower: number;
  upper: number;
  /** Most the actuator can do: N·m or N, and degrees/s or mm/s. */
  effort: number;
  velocity: number;
  damping: number;
  friction: number;
  /** Follows another joint (a linkage's passive joint): angle = multiplier × that joint's angle + offset. */
  mimic?: { joint: string; multiplier: number; offset: number };
  /** Id in `MOTORS` of the motor the figures came from; none once they are typed by hand. */
  motor?: string;
}

export type SensorKind = 'camera' | 'depth' | 'lidar' | 'imu' | 'touch';

export const SENSOR_KINDS: { id: SensorKind; name: string; help: string }[] = [
  { id: 'camera', name: 'Camera', help: 'A color camera looking along its X axis.' },
  { id: 'depth', name: 'Depth camera', help: 'A camera that also gives the distance to everything it sees, as a point cloud.' },
  { id: 'lidar', name: 'Lidar', help: 'A laser scanner sweeping a plane about its Z axis.' },
  { id: 'imu', name: 'IMU', help: 'Measures turn rate and acceleration, for odometry.' },
  { id: 'touch', name: 'Touch', help: 'Feels the force of whatever the link presses on: a foot on the floor.' },
];

/** A sensor fixed to a link, as a frame of its own with a Gazebo sensor in it. */
export interface RobotSensor {
  id: string;
  name: string;
  kind: SensorKind;
  /** Node id of the link it sits on. */
  link: string;
  /** Where it sits and how it is turned, in the link's own frame (mm, degrees), like a joint. A camera looks along its X, a lidar sweeps about its Z. */
  origin: Vec3;
  rot: Vec3;
  /** Hz. */
  rate: number;
  /** Cameras: field of view in degrees, picture size in pixels, nearest and farthest seen in mm. */
  camera: { hfov: number; width: number; height: number; near: number; far: number };
  /** Lidars: rays per sweep, the sweep's width in degrees, nearest and farthest seen in mm. */
  lidar: { samples: number; hfov: number; min: number; max: number };
}

export const defaultSensor = (id: string, name: string, kind: SensorKind, link: string, origin: Vec3): RobotSensor => ({
  id,
  name,
  kind,
  link,
  origin,
  rot: [0, 0, 0],
  rate: kind === 'imu' || kind === 'touch' ? 100 : kind === 'lidar' ? 10 : 30,
  camera: { hfov: 80, width: 640, height: 480, near: 50, far: 10000 },
  lidar: { samples: 360, hfov: 360, min: 100, max: 12000 },
});

export type DriveKind = 'differential' | 'ackermann' | 'mecanum';

/** What a joint does in the drive: a driven wheel on a side, a steering joint on a side, or a wheel at a corner. */
export type DriveRole = 'left' | 'right' | 'steer-left' | 'steer-right' | 'front-left' | 'front-right' | 'rear-left' | 'rear-right';

export const DRIVE_KINDS: { id: DriveKind; name: string; help: string; roles: { id: DriveRole; name: string }[] }[] = [
  {
    id: 'differential',
    name: 'Differential',
    help: 'Turns the left and right wheels together from velocity commands (cmd_vel) and reports odometry. A track is all of its wheels on one side.',
    roles: [
      { id: 'left', name: 'Left' },
      { id: 'right', name: 'Right' },
    ],
  },
  {
    id: 'ackermann',
    name: 'Ackermann',
    help: 'Drives the wheels on each side and steers like a car: one steering joint each side turns a front wheel mount.',
    roles: [
      { id: 'left', name: 'Drive left' },
      { id: 'right', name: 'Drive right' },
      { id: 'steer-left', name: 'Steer left' },
      { id: 'steer-right', name: 'Steer right' },
    ],
  },
  {
    id: 'mecanum',
    name: 'Mecanum',
    help: 'Four rollered wheels, one at each corner, that move the robot any way.',
    roles: [
      { id: 'front-left', name: 'Front left' },
      { id: 'front-right', name: 'Front right' },
      { id: 'rear-left', name: 'Rear left' },
      { id: 'rear-right', name: 'Rear right' },
    ],
  },
];

/** How the robot moves on its wheels: the kind, and what each wheel or steering joint does, by joint id. */
export interface Drive {
  kind: DriveKind;
  roles: Record<string, DriveRole>;
}

/** The joint ids with a role in the drive. */
export const driveJoints = (drive: Drive | undefined): string[] => (drive ? Object.keys(drive.roles) : []);
/** The joint ids with `role` in the drive. */
export const withRole = (drive: Drive | undefined, role: DriveRole): string[] => (drive ? Object.entries(drive.roles).filter(([, r]) => r === role).map(([id]) => id) : []);

/** A robot is named after its design: the exports take the design's name. */
export interface Robot {
  /** Node id of the base link, which everything else hangs from. Null until chosen. */
  root: string | null;
  /** Whether the base stands free on the floor (a rover, a walker) or is bolted to the world (an arm on a bench). */
  base: 'free' | 'fixed';
  links: RobotLink[];
  joints: RobotJoint[];
  sensors: RobotSensor[];
  drive?: Drive;
  /** Write ros2_control for every actuated joint not driven as a wheel, with a trajectory controller over them. */
  control: boolean;
  /** The floor the MuJoCo model stands on; flat when left out. Gazebo's world stays flat. */
  world?: World;
  /** Write the starter scripts (drive, Gymnasium environment, training) into the MuJoCo export; yes when left out. */
  scripts?: boolean;
}

export type World = 'flat' | 'rough' | 'slope';
/**
 * A lidar's rays as angles from its X about its Z, radians: from the right-hand
 * end of the sweep round to the left, as a laser scan lists them. A full circle
 * stops one step short of where it began.
 */
export function lidarAngles(rays: number, hfov: number): number[] {
  const full = hfov >= 2 * Math.PI - 1e-6;
  const step = rays > 1 ? hfov / (full ? rays : rays - 1) : 0;
  return Array.from({ length: rays }, (_, i) => -hfov / 2 + i * step);
}

export const WORLDS: { id: World; name: string; help: string }[] = [
  { id: 'flat', name: 'Flat', help: 'A level floor.' },
  { id: 'rough', name: 'Rough', help: 'Gentle bumps a few centimeters high around a flat start; for walkers and rovers.' },
  { id: 'slope', name: 'Slope', help: 'A floor tilted eight degrees.' },
];

export const emptyRobot = (): Robot => ({ root: null, base: 'free', links: [], joints: [], sensors: [], control: true });

export const DEFAULT_MASS: MassSpec = { kind: 'material', material: 'pla', infill: 20, shell: 1.2 };

/** The settings of a link no one has touched. */
export const defaultLink = (node: string): RobotLink => ({ node, mass: DEFAULT_MASS, collision: 'hull', friction: 0.8 });

export const defaultJoint = (id: string, name: string, parent: string, child: string, origin: Vec3): RobotJoint => ({
  id,
  name,
  type: 'revolute',
  parent,
  child,
  origin,
  axis: [0, 0, 1],
  lower: -90,
  upper: 90,
  effort: 10,
  velocity: 90,
  damping: 0.1,
  friction: 0,
});
