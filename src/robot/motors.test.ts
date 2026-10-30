import { describe, expect, it } from 'vitest';
import { ALL_MOTORS as MOUNTS } from '../parts/generators/motors';
import { MOTORS, motorFigures, motorForPart } from './motors';

describe('the motor table', () => {
  it('has sound figures and ids, and its parts exist in the library', () => {
    expect(new Set(MOTORS.map((m) => m.id)).size).toBe(MOTORS.length);
    for (const m of MOTORS) {
      expect(m.torque).toBeGreaterThan(0);
      expect(m.speed).toBeGreaterThan(0);
      expect(m.armature).toBeGreaterThan(0);
      if (m.part) expect(MOUNTS.some((mount) => mount.id === m.part)).toBe(true);
    }
  });

  it('gives a joint the motor\'s torque and speed, damped a twentieth at full speed', () => {
    const f = motorFigures(MOTORS.find((m) => m.id === 'sg90')!);
    expect(f).toEqual({ motor: 'sg90', effort: 0.18, velocity: 600, damping: 0.000859 });
  });

  it('reads the motor off a mount from the library', () => {
    const node = { id: 'p', name: 'Mount', type: 'part' as const, part: 'stepper-mount', params: { motor: 'nema17', make: 'plate' }, natural: [1, 1, 1] as [number, number, number], pos: [0, 0, 0] as [number, number, number], rot: [0, 0, 0] as [number, number, number], size: [1, 1, 1] as [number, number, number], hole: false, color: '#fff' };
    expect(motorForPart(node)?.id).toBe('nema17');
    expect(motorForPart({ ...node, params: { motor: '130' } })).toBeUndefined();
  });
});
