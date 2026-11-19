// A car's steering angles and wheel speeds, as the test drive and the MuJoCo export's drive.py work them out, and as
// Gazebo's and Isaac Sim's controllers do: the car turns about a point on the line of the wheels that do not steer.
// Each knuckle is turned square to the line from it to that point, so the inner one turns further, and each driven
// wheel runs at the speed of its own place, so the outer ones run faster.

/** What a car's command needs, m and radians: as drive.json carries it. */
export interface CarGeometry {
  /** From the wheels that do not steer to the steering knuckles. */
  wheelBase: number;
  /** Between the two steering knuckles. */
  kingpinWidth: number;
  /** How far a knuckle turns each way. */
  steeringLimit: number;
  /** Each driven wheel's actuator: along the car's forward and to its left, from the middle of the wheels that do not steer. */
  places: Record<string, [number, number]>;
}

/** The sharpest curvature (1/m) the car can follow: its inner knuckle at its limit. */
export function sharpest(g: CarGeometry): number {
  const t = Math.tan(g.steeringLimit);
  return t / (g.wheelBase + (g.kingpinWidth / 2) * t);
}

/**
 * The knuckles' angles (left positive, radians) and each driven wheel's speed at its rim (m/s) for a speed `v` (m/s,
 * at the middle of the wheels that do not steer) along a curve of curvature `c` (1/m, left positive).
 */
export function ackermann(g: CarGeometry, v: number, c: number): { left: number; right: number; speeds: Record<string, number> } {
  const angle = (y: number) => Math.atan2(g.wheelBase * c, 1 - y * c);
  const speeds = Object.fromEntries(Object.entries(g.places).map(([name, [x, y]]) => [name, v * Math.sign(1 - y * c) * Math.hypot(1 - y * c, x * c)]));
  return { left: angle(g.kingpinWidth / 2), right: angle(-g.kingpinWidth / 2), speeds };
}
