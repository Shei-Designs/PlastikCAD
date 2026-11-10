import { describe, expect, it } from 'vitest';
import { pressOwner } from './gesture';
import type { GestureState, PressEvent } from './gesture';

const idle: GestureState = { phase: 'none', pointerId: -1, pointerType: '', cameraTouches: 0 };
const finger = (pointerId: number, isPrimary = false): PressEvent => ({ pointerId, pointerType: 'touch', isPrimary });
const mouse: PressEvent = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
const pen: PressEvent = { pointerId: 7, pointerType: 'pen', isPrimary: true };
const pressed = (phase: GestureState['phase'], pointerType = 'touch', pointerId = 10): GestureState => ({ phase, pointerId, pointerType, cameraTouches: phase === 'tap' ? 1 : 0 });

describe('pressOwner', () => {
  it('gives a first press to the viewer, whatever the pointer', () => {
    expect(pressOwner(idle, finger(10, true))).toBe('viewer');
    expect(pressOwner(idle, mouse)).toBe('viewer');
    expect(pressOwner(idle, pen)).toBe('viewer');
  });

  it('hands both fingers to the camera when a second lands during a pending move', () => {
    expect(pressOwner(pressed('pending'), finger(11))).toBe('camera-handover');
  });

  it('drops the tap when a second finger lands beside one resting on empty space', () => {
    expect(pressOwner(pressed('tap'), finger(11))).toBe('camera-drop-tap');
  });

  it('keeps a second finger out of an edit already under way, and from the camera', () => {
    expect(pressOwner(pressed('editing'), finger(11))).toBe('nobody');
  });

  it('gives the camera a second finger that lands on an object while the first is orbiting', () => {
    expect(pressOwner({ ...idle, cameraTouches: 1 }, finger(11))).toBe('camera');
    expect(pressOwner({ ...idle, cameraTouches: 2 }, finger(12))).toBe('camera');
  });

  it('leaves a mouse and a pen as they were', () => {
    // No finger is down for the camera to be following, as far as a mouse or a pen is concerned.
    expect(pressOwner({ ...idle, cameraTouches: 1 }, mouse)).toBe('viewer');
    expect(pressOwner({ ...idle, cameraTouches: 1 }, pen)).toBe('viewer');
    // A finger beside a mouse or pen press is a stray, pending or not; so is a pen beside a finger's.
    expect(pressOwner(pressed('pending', 'mouse', 1), finger(11, true))).toBe('nobody');
    expect(pressOwner(pressed('pending', 'pen', 7), finger(11, true))).toBe('nobody');
    expect(pressOwner(pressed('editing', 'mouse', 1), finger(11, true))).toBe('nobody');
    expect(pressOwner(pressed('pending'), pen)).toBe('nobody');
    expect(pressOwner(pressed('tap'), mouse)).toBe('nobody');
  });

  it('starts afresh when the pressed pointer goes down again: its release was never heard', () => {
    expect(pressOwner(pressed('editing', 'mouse', 1), mouse)).toBe('viewer-afresh');
    expect(pressOwner(pressed('pending'), finger(10, true))).toBe('viewer-afresh');
  });

  it('starts afresh on a first finger while another is thought to be pressing', () => {
    expect(pressOwner(pressed('editing'), finger(11, true))).toBe('viewer-afresh');
    expect(pressOwner(pressed('tap'), finger(11, true))).toBe('viewer-afresh');
  });

  it('forgets fingers the camera never heard lift once a first finger lands', () => {
    expect(pressOwner({ ...idle, cameraTouches: 2 }, finger(12, true))).toBe('viewer');
  });
});
