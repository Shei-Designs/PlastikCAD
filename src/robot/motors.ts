// The motors a joint can be given: the hobby servos, gearmotors and steppers
// a printed robot is built with, each with the torque and speed its datasheet
// gives and a rough reflected rotor inertia for the simulators. Picking one
// fills the joint's figures in; the id stays on the joint so the exports can
// use the rest. Figures checked against the makers' sheets 2026-11-01
// (TowerPro, Pololu, Adafruit, Robotis, Feetech, StepperOnline): the
// gearmotors are Pololu's 12 V (25D, 37D) and 6 V HPCB (N20) variants at
// stall; no maker publishes rotor inertia for servos or gearmotors, so those
// armatures are estimates; a stepper's speed depends on its driver.
import { tr } from '../i18n';
import type { SceneNode } from '../model/types';
import type { RobotJoint } from './types';

export interface Motor {
  id: string;
  name: string;
  kind: 'servo' | 'smart servo' | 'gearmotor' | 'stepper';
  /** Stall torque (holding torque for a stepper), N·m. */
  torque: number;
  /** No-load speed at the output, °/s. */
  speed: number;
  /** The rotor's inertia seen at the output, through the gears, kg·m²: rough, for the simulators' stability. */
  armature: number;
  /** How far a positional servo turns each way, degrees; none for a motor that turns on. */
  range?: number;
  /** The motor's id in the parts library's motor mounts, when it has one. */
  part?: string;
}

export const MOTORS: Motor[] = [
  { id: 'sg90', name: tr('SG90 micro servo'), kind: 'servo', torque: 0.18, speed: 600, armature: 4e-4, range: 90, part: 'sg90' },
  { id: 'mg996r', name: tr('MG996R standard servo'), kind: 'servo', torque: 0.92, speed: 350, armature: 2e-3, range: 80, part: 'mg996r' },
  { id: 'fs90r', name: tr('FS90R continuous servo'), kind: 'servo', torque: 0.13, speed: 660, armature: 4e-4 },
  { id: 'ax12a', name: 'Dynamixel AX-12A', kind: 'smart servo', torque: 1.5, speed: 354, armature: 1e-3, range: 150 },
  { id: 'xl430', name: 'Dynamixel XL430-W250', kind: 'smart servo', torque: 1.4, speed: 342, armature: 1e-3, range: 180 },
  { id: 'sts3215', name: 'Feetech STS3215', kind: 'smart servo', torque: 1.9, speed: 270, armature: 1e-3, range: 180 },
  { id: 'n20-100', name: tr('N20 gearmotor, 100:1'), kind: 'gearmotor', torque: 0.15, speed: 1980, armature: 2e-5, part: 'n20' },
  { id: 'tt-48', name: tr('TT gearmotor, 48:1'), kind: 'gearmotor', torque: 0.08, speed: 1200, armature: 2.3e-5, part: 'tt' },
  { id: '25d-75', name: tr('25 mm gearmotor, 75:1'), kind: 'gearmotor', torque: 0.83, speed: 600, armature: 2.8e-4, part: '25d' },
  { id: '37d-70', name: tr('37 mm gearmotor, 70:1'), kind: 'gearmotor', torque: 2.6, speed: 900, armature: 5e-4, part: '37d' },
  { id: '28byj48', name: tr('28BYJ-48 geared stepper'), kind: 'stepper', torque: 0.03, speed: 90, armature: 4e-5, part: '28byj48' },
  { id: 'nema8', name: tr('NEMA 8 stepper'), kind: 'stepper', torque: 0.014, speed: 600, armature: 2e-7, part: 'nema8' },
  { id: 'nema11', name: tr('NEMA 11 stepper'), kind: 'stepper', torque: 0.06, speed: 600, armature: 9e-7, part: 'nema11' },
  { id: 'nema14', name: tr('NEMA 14 stepper'), kind: 'stepper', torque: 0.18, speed: 600, armature: 1.4e-6, part: 'nema14' },
  { id: 'nema17', name: tr('NEMA 17 stepper'), kind: 'stepper', torque: 0.4, speed: 600, armature: 5.4e-6, part: 'nema17' },
  { id: 'nema23', name: tr('NEMA 23 stepper'), kind: 'stepper', torque: 1.2, speed: 600, armature: 3e-5, part: 'nema23' },
];

export const motorOf = (id: string | undefined): Motor | undefined => (id ? MOTORS.find((m) => m.id === id) : undefined);

/** What a joint takes from a motor: its torque and speed, and damping that costs a twentieth of the torque at full speed. */
export function motorFigures(m: Motor): Pick<RobotJoint, 'motor' | 'effort' | 'velocity' | 'damping'> {
  return { motor: m.id, effort: m.torque, velocity: m.speed, damping: Number(((0.05 * m.torque) / ((m.speed * Math.PI) / 180)).toPrecision(3)) };
}

/** The parts library's motor mount generators, whose `motor` parameter names a motor. */
const MOUNTS = new Set(['stepper-mount', 'gearmotor-mount', 'servo-mount', 'dc-motor-mount']);

/** The motor a mount from the parts library stands for, if the table has it. */
export function motorForPart(node: SceneNode): Motor | undefined {
  if (node.type !== 'part' || !MOUNTS.has(node.part)) return undefined;
  const id = node.params.motor;
  return typeof id === 'string' ? MOTORS.find((m) => m.part === id) : undefined;
}
