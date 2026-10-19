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
}

export interface Robot {
  /** Name of the robot, and of the package it is exported as. */
  name: string;
  /** Node id of the base link, which everything else hangs from. Null until chosen. */
  root: string | null;
  links: RobotLink[];
  joints: RobotJoint[];
}

export const emptyRobot = (name = 'robot'): Robot => ({ name, root: null, links: [], joints: [] });

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
