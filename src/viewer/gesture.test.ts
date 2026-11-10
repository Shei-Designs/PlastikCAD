import { describe, expect, it } from 'vitest';
import { NO_PEN, PALM_GRACE_MS, PEN_STALE_MS, penAbout, penHeard, pressOwner } from './gesture';
import type { GestureState, PenState, PressEvent } from './gesture';

/** When the presses below happen, on the clock the pen is timed by. */
const NOW = 10_000;
const idle: GestureState = { phase: 'none', pointerId: -1, pointerType: '', cameraTouches: 0, pen: NO_PEN };
const finger = (pointerId: number, isPrimary = false, time = NOW): PressEvent => ({ pointerId, pointerType: 'touch', isPrimary, time });
const mouse: PressEvent = { pointerId: 1, pointerType: 'mouse', isPrimary: true, time: NOW };
const pen: PressEvent = { pointerId: 7, pointerType: 'pen', isPrimary: true, time: NOW };
const pressed = (phase: GestureState['phase'], pointerType = 'touch', pointerId = 10): GestureState => ({ phase, pointerId, pointerType, cameraTouches: phase === 'tap' ? 1 : 0, pen: NO_PEN });
/** The pen after what it did, each at its time. */
const penAfter = (...heard: [what: Parameters<typeof penHeard>[1], time: number][]): PenState => heard.reduce((state, [what, time]) => penHeard(state, what, time), NO_PEN);

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

describe('pressOwner with a pen about', () => {
  const penDown = penAfter(['near', NOW - 500], ['down', NOW - 300]);
  const penHovering = penAfter(['near', NOW - 500], ['near', NOW - 20]);

  it('ignores a touch while the pen is down', () => {
    expect(pressOwner({ ...idle, pen: penDown }, finger(10, true))).toBe('palm');
    // However long the tip has rested without a word.
    expect(pressOwner({ ...idle, pen: penAfter(['down', NOW - 60_000]) }, finger(10, true))).toBe('palm');
  });

  it('ignores a touch while the pen hovers in range', () => {
    expect(pressOwner({ ...idle, pen: penHovering }, finger(10, true))).toBe('palm');
    // Lifted and still over the screen, it hovers again.
    expect(pressOwner({ ...idle, pen: penAfter(['down', NOW - 900], ['up', NOW - 800], ['near', NOW - 790], ['near', NOW - 10]) }, finger(10, true))).toBe('palm');
  });

  it('ignores a touch just after the pen lifted or left, and takes one after the grace period', () => {
    const lifted = penAfter(['down', 1000], ['up', 2000]);
    expect(pressOwner({ ...idle, pen: lifted }, finger(10, true, 2000 + PALM_GRACE_MS - 1))).toBe('palm');
    expect(pressOwner({ ...idle, pen: lifted }, finger(10, true, 2000 + PALM_GRACE_MS))).toBe('viewer');
    const left = penAfter(['near', 1000], ['gone', 2000]);
    expect(pressOwner({ ...idle, pen: left }, finger(10, true, 2000 + PALM_GRACE_MS - 1))).toBe('palm');
    expect(pressOwner({ ...idle, pen: left }, finger(10, true, 2000 + PALM_GRACE_MS))).toBe('viewer');
  });

  it('ignores every finger of a pinch that lands while the pen is about', () => {
    expect(pressOwner({ ...idle, pen: penHovering }, finger(10, true))).toBe('palm');
    // The first was not taken, so nothing is pressed and the camera follows none.
    expect(pressOwner({ ...idle, pen: penHovering }, finger(11))).toBe('palm');
  });

  it('leaves a finger already orbiting alone when the pen arrives, and takes the pen as any press', () => {
    const orbiting: GestureState = { ...idle, cameraTouches: 1, pen: penHovering };
    // Only a press is asked about: the finger that is down is not, and so goes on.
    expect(pressOwner(orbiting, pen)).toBe('viewer');
    // A hand that lands beside it now is the pen's.
    expect(pressOwner(orbiting, finger(11))).toBe('palm');
  });

  it('leaves a finger already editing alone when the pen arrives', () => {
    expect(pressOwner({ ...pressed('editing'), pen: penDown }, pen)).toBe('nobody');
    expect(pressOwner({ ...pressed('editing'), pen: penDown }, finger(11))).toBe('palm');
  });

  it('never takes a mouse or the pen itself for a palm', () => {
    expect(pressOwner({ ...idle, pen: penDown }, mouse)).toBe('viewer');
    expect(pressOwner({ ...idle, pen: penHovering }, pen)).toBe('viewer');
  });

  it('takes a hovering pen that has said nothing for a while as gone', () => {
    const silent = penAfter(['near', 1000]);
    expect(pressOwner({ ...idle, pen: silent }, finger(10, true, 1000 + PEN_STALE_MS))).toBe('palm');
    expect(pressOwner({ ...idle, pen: silent }, finger(10, true, 1000 + PEN_STALE_MS + 1))).toBe('viewer');
  });
});

describe('penHeard', () => {
  it('knows nothing of a pen before it is heard', () => {
    expect(penAbout(NO_PEN, 0)).toBe(false);
    expect(penAbout(NO_PEN, NOW)).toBe(false);
  });

  it('has a lifted pen say again that it is near', () => {
    // A tablet that reports no hover says nothing after the lift: the grace period is all there is.
    const lifted = penAfter(['near', 900], ['down', 1000], ['up', 2000]);
    expect(lifted).toMatchObject({ down: false, near: false, left: 2000 });
    expect(penAbout(penHeard(lifted, 'near', 2010), 2000 + PALM_GRACE_MS + 100)).toBe(true);
  });

  it('keeps a pressed pen down when it is said to have left', () => {
    const state = penAfter(['down', 1000], ['gone', 1500]);
    expect(state.down).toBe(true);
    expect(penAbout(state, 9000)).toBe(true);
  });
});
