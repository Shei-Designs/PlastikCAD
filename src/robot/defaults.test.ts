import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../model/types';
import { jointDefaults } from './defaults';

const node = (id: string, size: [number, number, number]): SceneNode => ({ id, name: id, type: 'shape', shape: 'box', params: {}, pos: [0, 0, 0], rot: [0, 0, 0], size, hole: false, color: '#ff8800' });
const body = node('body', [120, 80, 30]);
const wheel = node('wheel', [40, 12, 40]);
const grams = (n: SceneNode) => (n.id === 'body' ? 120 : 8.5);

describe('jointDefaults', () => {
  it('fits a limited joint to the heavier side it separates, at a quarter turn a second', () => {
    const fit = jointDefaults([wheel], [body], grams);
    // The body: 120 g at half of 120 mm, five times over.
    expect(fit.effort).toBe(Number((5 * 0.12 * 9.81 * 0.06).toPrecision(3)));
    expect(fit.velocity).toBe(90);
    expect(fit.damping).toBe(Number(((0.05 * fit.effort) / (Math.PI / 2)).toPrecision(3)));
  });

  it('fits a continuous joint to its child alone, at a turn a second, so a free wheel does not brake the robot', () => {
    const fit = jointDefaults([wheel], [body], grams, true);
    expect(fit.effort).toBe(Number((5 * 0.0085 * 9.81 * 0.02).toPrecision(3)));
    expect(fit.velocity).toBe(360);
    expect(fit.damping).toBeLessThan(1e-4);
    expect(fit.damping).toBeLessThan(jointDefaults([wheel], [body], grams).damping / 100);
  });
});
