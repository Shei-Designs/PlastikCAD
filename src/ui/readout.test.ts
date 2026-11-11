import { describe, expect, it } from 'vitest';
import { placeReadout } from './readout';

const view = { width: 800, height: 600 };
const size = { width: 120, height: 24 };

describe('placeReadout', () => {
  it('sits right and below a mouse pointer', () => {
    expect(placeReadout({ x: 100, y: 100 }, size, view, false)).toEqual({ left: 116, top: 116 });
  });

  it('goes to the other side where it would run off the right or the bottom', () => {
    expect(placeReadout({ x: 790, y: 100 }, size, view, false)).toEqual({ left: 790 - 16 - 120, top: 116 });
    expect(placeReadout({ x: 100, y: 590 }, size, view, false)).toEqual({ left: 116, top: 590 - 16 - 24 });
  });

  it('sits above a finger, centered on it', () => {
    expect(placeReadout({ x: 400, y: 300 }, size, view, true)).toEqual({ left: 340, top: 300 - 44 - 24 });
  });

  it('goes below the finger when there is no room above', () => {
    expect(placeReadout({ x: 400, y: 30 }, size, view, true)).toEqual({ left: 340, top: 74 });
  });

  it('never leaves the view', () => {
    for (const touch of [false, true]) {
      for (const at of [{ x: 0, y: 0 }, { x: 800, y: 600 }, { x: 0, y: 600 }, { x: 800, y: 0 }, { x: -50, y: 900 }]) {
        const { left, top } = placeReadout(at, size, view, touch);
        expect(left).toBeGreaterThanOrEqual(6);
        expect(top).toBeGreaterThanOrEqual(6);
        expect(left + size.width).toBeLessThanOrEqual(view.width - 6);
        expect(top + size.height).toBeLessThanOrEqual(view.height - 6);
      }
    }
  });

  it('keeps to the left margin in a view narrower than the readout', () => {
    expect(placeReadout({ x: 50, y: 50 }, { width: 300, height: 24 }, { width: 200, height: 200 }, false).left).toBe(6);
  });
});
