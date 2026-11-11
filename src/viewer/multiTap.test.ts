import { describe, expect, it } from 'vitest';
import { TAP_MAX_MS, TAP_SLOP, TAP_STAGGER_MS, TapWatch, tapOf } from './multiTap';
import type { Contact } from './multiTap';

const touch = (down: number, up: number, travel = 0): Contact => ({ pointerType: 'touch', down, up, travel });

describe('tapOf', () => {
  it('takes two fingers tapped as undo', () => {
    expect(tapOf([touch(0, 120), touch(30, 140)], false)).toBe('undo');
  });

  it('takes three fingers tapped as redo', () => {
    expect(tapOf([touch(0, 150), touch(20, 160), touch(45, 140)], false)).toBe('redo');
  });

  it('takes one finger, or four, as nothing', () => {
    expect(tapOf([], false)).toBeNull();
    expect(tapOf([touch(0, 100)], false)).toBeNull();
    expect(tapOf([touch(0, 100), touch(10, 110), touch(20, 120), touch(30, 130)], false)).toBeNull();
  });

  it('leaves two fingers that moved to the camera: a pinch', () => {
    expect(tapOf([touch(0, 200, 40), touch(20, 200, 38)], false)).toBeNull();
    // One finger sliding is enough, and a wobble is not.
    expect(tapOf([touch(0, 200), touch(20, 200, TAP_SLOP + 1)], false)).toBeNull();
    expect(tapOf([touch(0, 200, TAP_SLOP), touch(20, 200, TAP_SLOP)], false)).toBe('undo');
  });

  it('leaves two fingers held too long alone', () => {
    expect(tapOf([touch(0, TAP_MAX_MS), touch(20, TAP_MAX_MS - 10)], false)).toBe('undo');
    expect(tapOf([touch(0, TAP_MAX_MS + 1), touch(20, 200)], false)).toBeNull();
    expect(tapOf([touch(0, 100), touch(20, TAP_MAX_MS + 1)], false)).toBeNull();
  });

  it('leaves fingers that went down too far apart in time alone', () => {
    expect(tapOf([touch(0, 280), touch(TAP_STAGGER_MS, 290)], false)).toBe('undo');
    expect(tapOf([touch(0, 280), touch(TAP_STAGGER_MS + 1, 290)], false)).toBeNull();
  });

  it('wants the fingers down together: one tapping twice beside another is not three', () => {
    expect(tapOf([touch(0, 250), touch(10, 90), touch(120, 200)], false)).toBeNull();
    expect(tapOf([touch(0, 60), touch(80, 140)], false)).toBeNull();
  });

  it('does nothing while an edit is under way', () => {
    expect(tapOf([touch(0, 120), touch(30, 140)], true)).toBeNull();
    expect(tapOf([touch(0, 150), touch(20, 160), touch(45, 140)], true)).toBeNull();
  });

  it('never counts a pen or a mouse', () => {
    expect(tapOf([{ ...touch(0, 120), pointerType: 'pen' }, touch(30, 140)], false)).toBeNull();
    expect(tapOf([{ ...touch(0, 120), pointerType: 'mouse' }, { ...touch(30, 140), pointerType: 'mouse' }], false)).toBeNull();
    expect(tapOf([touch(0, 120), touch(30, 140), { ...touch(40, 150), pointerType: 'pen' }], false)).toBeNull();
  });
});

describe('TapWatch', () => {
  /** A finger goes down, as the first on the plate when `first`: finger 1 at x 160, finger 2 at 220, and so on. */
  const down = (w: TapWatch, id: number, time: number, first = false, editing = false, x = 100 + id * 60, y = 100) => w.down(id, 'touch', x, y, time, first, editing);

  it('answers when the last finger lifts, and not before', () => {
    const w = new TapWatch();
    down(w, 1, 0, true);
    down(w, 2, 25);
    expect(w.up(1, 110)).toBeNull();
    expect(w.up(2, 130)).toBe('undo');
  });

  it('counts three fingers', () => {
    const w = new TapWatch();
    down(w, 1, 0, true);
    down(w, 2, 20);
    down(w, 3, 40);
    expect(w.up(3, 120)).toBeNull();
    expect(w.up(1, 130)).toBeNull();
    expect(w.up(2, 150)).toBe('redo');
  });

  it('measures how far each finger got from where it landed', () => {
    const w = new TapWatch();
    down(w, 1, 0, true);
    down(w, 2, 20);
    // Out and back again is still a slide.
    w.move(2, 220 + 3 * TAP_SLOP, 100);
    w.move(2, 220, 100);
    w.up(1, 100);
    expect(w.up(2, 110)).toBeNull();
  });

  it('allows a wobble', () => {
    const w = new TapWatch();
    down(w, 1, 0, true);
    down(w, 2, 20);
    w.move(1, 163, 104);
    w.move(2, 218, 97);
    w.up(1, 100);
    expect(w.up(2, 110)).toBe('undo');
  });

  it('does nothing for a second tap while a drag of an object is under way', () => {
    const w = new TapWatch();
    // One finger drags an object; another taps beside it, twice.
    down(w, 1, 0, true);
    w.move(1, 300, 100);
    down(w, 2, 1000, false, true);
    expect(w.up(2, 1080)).toBeNull();
    down(w, 2, 1200, false, true);
    expect(w.up(2, 1280)).toBeNull();
    expect(w.up(1, 2000)).toBeNull();
  });

  it('does nothing for two fingers tapped beside a mouse or pen that is dragging', () => {
    const w = new TapWatch();
    down(w, 1, 0, true, true);
    down(w, 2, 20, false, true);
    w.up(1, 100);
    expect(w.up(2, 110)).toBeNull();
    // The next tap, with the drag over, counts again.
    down(w, 3, 1000, true);
    down(w, 4, 1020);
    w.up(3, 1100);
    expect(w.up(4, 1110)).toBe('undo');
  });

  it('starts afresh for each time on the plate', () => {
    const w = new TapWatch();
    down(w, 1, 0, true);
    expect(w.up(1, 80)).toBeNull();
    down(w, 2, 500, true);
    down(w, 3, 520);
    w.up(2, 600);
    expect(w.up(3, 610)).toBe('undo');
  });

  it('takes a finger the system took away as no tap', () => {
    const w = new TapWatch();
    down(w, 1, 0, true);
    down(w, 2, 20);
    w.cancel(1);
    expect(w.up(2, 100)).toBeNull();
  });

  it('forgets a finger that never said it lifted once a first finger lands', () => {
    const w = new TapWatch();
    down(w, 1, 0, true);
    // Its lift goes unheard. The next two fingers are a tap of two, not of three.
    down(w, 2, 5000, true);
    down(w, 3, 5020);
    w.up(2, 5100);
    expect(w.up(3, 5110)).toBe('undo');
  });

  it('leaves a late second finger and a long hold alone', () => {
    const late = new TapWatch();
    down(late, 1, 0, true);
    down(late, 2, TAP_STAGGER_MS + 30);
    late.up(1, 250);
    expect(late.up(2, 260)).toBeNull();
    const long = new TapWatch();
    down(long, 1, 0, true);
    down(long, 2, 20);
    long.up(1, TAP_MAX_MS + 100);
    expect(long.up(2, TAP_MAX_MS + 110)).toBeNull();
  });
});
