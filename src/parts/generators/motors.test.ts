import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { QUALITY } from '../types';
import { ALL_MOTORS, MOTORS, dcMotor, gearmotor, servo, stepper } from './motors';
import { defaultParams } from './types';
import type { GeneratorDef, Params } from './types';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.normal;
const params = (def: GeneratorDef, over: Params = {}): Params => ({ ...defaultParams(def), ...over });
const made = (def: GeneratorDef, over: Params = {}) => {
  const r = def.build(params(def, over), q);
  return { ...r, stats: evaluate(r.solid).stats };
};
const extent = (s: { min: number[]; max: number[] }, axis: number) => s.max[axis] - s.min[axis];
const disc = (d: number) => (Math.PI / 4) * d * d;

describe('motor mounts', () => {
  it('builds every motor in every form', () => {
    for (const def of MOTORS) {
      const sel = def.groups[0].params[0];
      const ids = sel.type === 'select' ? sel.options.map((o) => o.value) : [];
      for (const motor of ids)
        for (const form of ['plate', 'holes', 'body', 'bracket']) {
          const r = made(def, { motor, form });
          expect(r.stats.volume, `${motor} ${form}`).toBeGreaterThan(0);
        }
      expect(def.build(defaultParams(def), q).outline?.length).toBeGreaterThan(0);
    }
    for (const m of ALL_MOTORS) expect(m.holes.length > 0 || m.id === '130', m.id).toBe(true);
  });

  it('makes a NEMA 17 plate with four M3 holes on 31 mm and a bore for the pilot', () => {
    const r = made(stepper, { motor: 'nema17', form: 'plate', thickness: 4, margin: 6, clearance: 0.3, boltFit: 'clearance' });
    expect(r.warnings).toEqual([]);
    // The face is 42.3 square, wider than the holes plus margins (31 + 12 = 43): the plate is 43 square.
    expect(extent(r.stats, 0)).toBeCloseTo(43, 1);
    expect(extent(r.stats, 2)).toBeCloseTo(4, 6);
    const area = 43 * 43 - 4 * disc(3.4) - disc(22.6);
    expect(r.stats.volume / (area * 4)).toBeGreaterThan(0.97);
    expect(r.stats.volume / (area * 4)).toBeLessThan(1.0);
    expect(r.info.find((i) => i.label === 'Bolt pattern')?.value).toBe('4 × M3, 31.00 × 31.00 mm');
    // Six holes round the shaft are named by the circle they are on, whatever its size.
    for (const m of ALL_MOTORS.filter((x) => x.holes.length === 6)) {
      const family = MOTORS.find((def) => def.groups[0].params[0].type === 'select' && def.groups[0].params[0].options.some((o) => o.value === m.id))!;
      const circle = 2 * Math.hypot(m.holes[0][0], m.holes[0][1]);
      expect(made(family, { motor: m.id, form: 'plate' }).info.find((i) => i.label === 'Bolt pattern')?.value).toBe(`6 × ${m.screw}, on a ${Number(circle.toFixed(2))} mm circle`);
    }
    expect(made(gearmotor, { motor: '37d', form: 'plate' }).info.find((i) => i.label === 'Bolt pattern')?.value).toBe('6 × M3, on a 31 mm circle');
    // Tapped holes are smaller, so the plate keeps more.
    const tapped = made(stepper, { motor: 'nema17', form: 'plate', boltFit: 'tap' });
    expect(tapped.stats.volume).toBeGreaterThan(r.stats.volume);
  });

  it('cuts the pattern as pins, and models the motor with its pilot and D shaft', () => {
    const holes = made(stepper, { motor: 'nema17', form: 'holes', holeLength: 20, clearance: 0 });
    expect(extent(holes.stats, 2)).toBeCloseTo(20, 6);
    expect(holes.stats.volume / ((4 * disc(3.4) + disc(22)) * 20)).toBeGreaterThan(0.98);
    const body = made(stepper, { motor: 'nema17', form: 'body' });
    expect(extent(body.stats, 0)).toBeCloseTo(42.3, 2);
    expect(body.stats.min[2]).toBeCloseTo(-40, 6);
    expect(body.stats.max[2]).toBeCloseTo(24, 6);
    const longer = made(stepper, { motor: 'nema17', form: 'body', length: 48 });
    expect(longer.stats.min[2]).toBeCloseTo(-48, 6);
  });

  it('stands a bracket up on a slotted foot with gussets', () => {
    const r = made(stepper, { motor: 'nema17', form: 'bracket', thickness: 4, footLength: 30, slotLength: 10, gusset: true });
    expect(r.stats.min[2]).toBeCloseTo(0, 6);
    expect(extent(r.stats, 2)).toBeCloseTo(43, 1);
    expect(extent(r.stats, 1)).toBeCloseTo(34, 1);
    expect(extent(r.stats, 0)).toBeCloseTo(43, 1);
    const plain = made(stepper, { motor: 'nema17', form: 'bracket', thickness: 4, footLength: 30, slotLength: 0, gusset: false });
    expect(plain.stats.volume).toBeLessThan(r.stats.volume);
    // Round holes instead of slots take less out of the foot.
    const slotted = made(stepper, { motor: 'nema17', form: 'bracket', thickness: 4, footLength: 30, slotLength: 10, gusset: false });
    expect(plain.stats.volume).toBeGreaterThan(slotted.stats.volume);
  });

  it("drops a servo's body through the plate and seats its tabs", () => {
    const plate = made(servo, { motor: 'sg90', form: 'plate', thickness: 3, clearance: 0.3 });
    expect(extent(plate.stats, 0)).toBeCloseTo(40, 1);
    const cutout = (22.5 + 0.6) * (11.8 + 0.6);
    expect(plate.stats.volume).toBeLessThan((40 * 12.8 - cutout) * 3);
    const body = made(servo, { motor: 'sg90', form: 'body' });
    expect(body.stats.min[2]).toBeCloseTo(-16, 6);
    expect(body.stats.max[2]).toBeCloseTo(6.7 + 8, 6);
    expect(extent(body.stats, 0)).toBeCloseTo(32.2, 2);
  });

  it('puts the 28BYJ-48 shaft 8 mm off the middle of its body, the ears across that middle, and refuses a bracket for a motor that has none', () => {
    const r = made(stepper, { motor: '28byj48', form: 'body' });
    expect(r.stats.max[2]).toBeCloseTo(10, 6);
    expect(r.stats.max[0]).toBeCloseTo(21, 2);
    // The Ø28 can sits 8 below the shaft, which is at the origin: from -22 to 6.
    expect(r.stats.min[1]).toBeCloseTo(-22, 2);
    expect(r.stats.max[1]).toBeCloseTo(6, 2);
    // The plate reaches a margin past the ear holes: 35 between them, plus 6 each side.
    const plate = made(stepper, { motor: '28byj48', form: 'plate', margin: 6 });
    expect(extent(plate.stats, 0)).toBeCloseTo(47, 1);
    // A 130 has no screw holes: the plate carries only the bore.
    const motorOptions = (dcMotor.groups[0].params[0] as { options: { value: string; note?: string }[] }).options;
    expect(motorOptions.find((o) => o.value === '130')?.note).toMatch(/No screw holes/);
    const b = made(dcMotor, { motor: '130', form: 'bracket' });
    expect(b.warnings.some((w) => w.includes('bracket'))).toBe(true);
  });
});

describe('motor edge cases', () => {
  it('leaves the shaft out when it is shorter than the pilot boss', () => {
    for (const [def, motor, pilotTop] of [
      [stepper, 'nema17', 2],
      [gearmotor, '37d', 6],
    ] as const) {
      const r = made(def, { motor, form: 'body', shaftLength: 0.5 });
      expect([...r.stats.min, ...r.stats.max].every(Number.isFinite), motor).toBe(true);
      expect(r.stats.volume).toBeGreaterThan(0);
      expect(r.stats.max[2], motor).toBeCloseTo(pilotTop, 6);
      expect(r.warnings.some((w) => w.includes('shaft'))).toBe(true);
    }
    expect(made(stepper, { motor: 'nema17', form: 'body', shaftLength: 2.5 }).stats.max[2]).toBeCloseTo(2.5, 6);
  });

  it('keeps the foot slots inside a short foot', () => {
    const r = made(stepper, { motor: 'nema17', form: 'bracket', thickness: 4, footLength: 5, slotLength: 10 });
    expect(r.stats.max[1]).toBeLessThanOrEqual(5 + 1e-6);
    expect(r.stats.min[1]).toBeGreaterThanOrEqual(-4 - 1e-6);
    expect(r.warnings.some((w) => w.includes('slots'))).toBe(true);
  });
});
