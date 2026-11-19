import { describe, expect, it } from 'vitest';
import { ackermann, sharpest } from './ackermann';
import type { CarGeometry } from './ackermann';

// The reference car's figures, m: knuckles 244 mm apart and 320 mm ahead of the rear axle, rear wheels 240 mm apart,
// front wheels 324 mm apart; all four driven, so that every wheel's speed is tried.
const car: CarGeometry = {
  wheelBase: 0.32,
  kingpinWidth: 0.244,
  steeringLimit: Math.PI / 6,
  places: { rl: [0, 0.12], rr: [0, -0.12], fl: [0.32, 0.162], fr: [0.32, -0.162] },
};

describe("a car's steering and wheel speeds", () => {
  it('goes straight with both knuckles square and every wheel at the speed asked', () => {
    const { left, right, speeds } = ackermann(car, 0.3, 0);
    expect([left, right]).toEqual([0, 0]);
    for (const s of Object.values(speeds)) expect(s).toBeCloseTo(0.3, 12);
  });

  it("turns each knuckle as Gazebo's controller does: square to the line from it to the point the car turns about", () => {
    for (const c of [0.5, 1, -0.8]) {
      const R = 1 / c;
      const { left, right } = ackermann(car, 0.3, c);
      // tan δ = L / (R ∓ k/2), the inner knuckle (on the side the car turns to) the nearer the point.
      expect(Math.tan(left)).toBeCloseTo(car.wheelBase / (R - car.kingpinWidth / 2), 12);
      expect(Math.tan(right)).toBeCloseTo(car.wheelBase / (R + car.kingpinWidth / 2), 12);
      const [inner, outer] = c > 0 ? [left, right] : [right, left];
      expect(Math.abs(inner)).toBeGreaterThan(Math.abs(outer));
      expect(Math.sign(inner)).toBe(Math.sign(c));
      expect(Math.sign(outer)).toBe(Math.sign(c));
    }
  });

  it('runs each wheel at the speed of its place: in proportion to how far it is from the point the car turns about', () => {
    const c = 1.2;
    const { speeds } = ackermann(car, 0.3, c);
    for (const [name, [x, y]] of Object.entries(car.places)) expect(speeds[name] / Math.hypot(x, 1 / c - y)).toBeCloseTo(0.3 * c, 12);
    // Turning left, the right wheels run faster, and a front wheel faster than the rear one on its side.
    expect(speeds.rr).toBeGreaterThan(speeds.rl);
    expect(speeds.fr).toBeGreaterThan(speeds.fl);
    expect(speeds.fl).toBeGreaterThan(speeds.rl);
    // Backing up the same curve, every wheel turns backwards as fast.
    const back = ackermann(car, -0.3, c).speeds;
    for (const name of Object.keys(speeds)) expect(back[name]).toBeCloseTo(-speeds[name], 12);
  });

  it('can follow a curve no sharper than its inner knuckle at its limit allows', () => {
    const most = sharpest(car);
    expect(ackermann(car, 0.3, most).left).toBeCloseTo(car.steeringLimit, 12);
    expect(ackermann(car, 0.3, -most).right).toBeCloseTo(-car.steeringLimit, 12);
    expect(Math.abs(ackermann(car, 0.3, most).right)).toBeLessThan(car.steeringLimit);
  });
});
