import { describe, expect, it } from 'vitest';
import { clampAngle, curveRadius, curvedSize, textWarp } from './curve';
import type { TextCurve } from './curve';

const bend = (angle: number, flip = false): TextCurve => ({ kind: 'bend', angle, flip, thickness: 1 });
const arc = (angle: number, flip = false): TextCurve => ({ kind: 'arc', angle, flip, thickness: 1 });

describe('textWarp', () => {
  it('bends the letters round a cylinder along their height, back face on the cylinder', () => {
    const warp = textWarp(bend(180), [20, 5], 1);
    const r = 20 / Math.PI;
    // The middle of the back face sits on the cylinder, straight ahead; the reading face a thickness further out.
    expect(warp([0, 0, -0.5])).toEqual([0, 0, r]);
    expect(warp([0, 2, 0.5])[2]).toBeCloseTo(r + 1, 9);
    expect(warp([0, 2, 0.5])[1]).toBe(2);
    // The ends reach a quarter turn round each way.
    const end = warp([10, 0, -0.5]);
    expect(end[0]).toBeCloseTo(r, 9);
    expect(end[2]).toBeCloseTo(0, 9);
    expect(warp([-10, 0, -0.5])[0]).toBeCloseTo(-r, 9);
    // Flipped, the letters stand inward of the cylinder, with the axis on the reading side.
    const inner = textWarp(bend(180, true), [20, 5], 1);
    expect(inner([0, 0, -0.5])).toEqual([0, 0, -r]);
    expect(inner([0, 0, 0.5])[2]).toBeCloseTo(-(r - 1), 9);
  });

  it('lays the letters along an arc in their own plane, baseline on the circle', () => {
    const warp = textWarp(arc(90), [20, 5], 1);
    const r = 20 / (Math.PI / 2);
    // The baseline's middle stays put; the top of the letters rises above it; the depth is untouched.
    expect(warp([0, -2.5, 0.3])).toEqual([0, 0, 0.3]);
    expect(warp([0, 2.5, 0])[1]).toBeCloseTo(5, 9);
    const end = warp([10, -2.5, 0]);
    expect(end[0]).toBeCloseTo(r * Math.SQRT1_2, 9);
    expect(end[1]).toBeCloseTo(r * Math.SQRT1_2 - r, 9);
    // Hanging, the baseline's middle stays put too and the letters' tops point at the centre above, so the ends rise.
    const hang = textWarp(arc(90, true), [20, 5], 1);
    expect(hang([0, 2.5, 0])[1]).toBeCloseTo(5, 9);
    expect(hang([10, -2.5, 0])[1]).toBeCloseTo(r - r * Math.SQRT1_2, 9);
  });
});

describe('curvedSize', () => {
  it('measures the box round bent lettering', () => {
    const r = 20 / Math.PI;
    const size = curvedSize(bend(180), [20, 5], 1);
    expect(size[0]).toBeCloseTo(2 * (r + 1), 3);
    expect(size[1]).toBe(5);
    expect(size[2]).toBeCloseTo(r + 1, 3);
    // Past a half turn the sides come back in: the widest point is the quarter turn.
    expect(curvedSize(bend(270), [20, 5], 1)[0]).toBeCloseTo(2 * (20 / (1.5 * Math.PI) + 1), 3);
  });

  it('measures the box round arced lettering', () => {
    const r = 20 / (Math.PI / 2);
    const size = curvedSize(arc(90), [20, 5], 1);
    expect(size[0]).toBeCloseTo(2 * (r + 5) * Math.SQRT1_2, 3);
    expect(size[1]).toBeCloseTo(5 + r * (1 - Math.SQRT1_2), 3);
    expect(size[2]).toBe(1);
  });

  it('keeps angles short of a full circle and gives the radius from the width', () => {
    expect(clampAngle(0)).toBe(5);
    expect(clampAngle(400)).toBe(355);
    expect(curveRadius(bend(360), 20)).toBeCloseTo(20 / ((355 * Math.PI) / 180), 9);
  });
});
