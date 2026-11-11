import type { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../model/types';
import { placePrompt } from './prompt';
import type { HandlePrompt } from './types';

type Field = HandlePrompt['fields'][number];

/** The plate seen from straight above: 2 px to the mm, the origin at (500, 400), +Y up the screen. */
const onScreen = (p: Vector3) => ({ clientX: 500 + p.x * 2, clientY: 400 - p.y * 2 });
const VIEW = { left: 0, right: 1000, top: 0, bottom: 800 };
/** The size of a box, and how near the edge of the view one may come (more at the top, under the toolbar). */
const [BW, BH] = [100, 28];
const MARGIN = 8;
const MARGIN_TOP = 52;

const field = (anchor: Vec3, more: Partial<Field> = {}): Field => ({ tag: 'W', name: 'Width', color: '#fff', value: 10, anchor, clientX: 0, clientY: 0, ...more });
const prompt = (fields: Field[], center: Vec3 = [0, 0, 0]): HandlePrompt => ({ kind: { type: 'resize', sx: 1, sy: 1 }, unit: 'mm', center, fields });
const place = (p: HandlePrompt) => placePrompt(p, onScreen, VIEW).fields;
const overlap = (a: Field, b: Field) => Math.abs(a.clientX - b.clientX) < BW && Math.abs(a.clientY - b.clientY) < BH;

describe('placePrompt', () => {
  it('puts a box on a front edge below the object, centered on the edge', () => {
    // The front edge of a 40 mm square, running along X; the box keeps away from the middle of the base.
    const [f] = place(prompt([field([0, -20, 0], { along: [1, 0, 0], ref: [0, 0, 0] })]));
    expect(f.clientX).toBeCloseTo(500);
    // 40 px down to the edge, a 14 px pad, then half the box.
    expect(f.clientY).toBeCloseTo(440 + 14 + BH / 2);
    expect(f.heading?.[0]).toBeCloseTo(0);
    expect(f.heading?.[1]).toBeCloseTo(1);
  });

  it('puts a box on a side edge beside the object', () => {
    const [f] = place(prompt([field([20, 0, 0], { along: [0, 1, 0], ref: [0, 0, 0] })]));
    expect(f.clientX).toBeCloseTo(540 + 14 + BW / 2);
    expect(f.clientY).toBeCloseTo(400);
  });

  it('goes away from the middle of the object when there is nothing else to keep away from', () => {
    const [f] = place(prompt([field([0, 20, 0])]));
    expect(f.clientX).toBeCloseTo(500);
    expect(f.clientY).toBeCloseTo(360 - 14 - BH / 2);
  });

  it('keeps the side it first went to while the boxes follow the camera', () => {
    // Left to itself the box would go below the edge; it was above when it appeared, and stays there.
    const [f] = place(prompt([field([0, -20, 0], { along: [1, 0, 0], ref: [0, 0, 0], heading: [0, -1] })]));
    expect(f.clientY).toBeCloseTo(440 - 14 - BH / 2);
  });

  it('goes a fixed way out, as far as it is told', () => {
    // Out along +Y (up the screen), 60 px instead of the usual pad.
    const [f] = place(prompt([field([0, 0, 0], { out: [0, 1, 0], pad: 60 })], [0, -50, 0]));
    expect(f.clientX).toBeCloseTo(500);
    expect(f.clientY).toBeCloseTo(400 - 60 - BH / 2);
  });

  it('sits right beside a grip, level with it', () => {
    const [f] = place(prompt([field([0, 0, 0], { beside: true })]));
    expect(f.clientX).toBeCloseTo(500 + 30 + BW / 2);
    expect(f.clientY).toBeCloseTo(400);
  });

  it('goes to the left of a grip near the right edge of the view', () => {
    const [f] = place(prompt([field([220, 0, 0], { beside: true })]));
    expect(f.clientX).toBeCloseTo(940 - 30 - BW / 2);
  });

  it('clears the whole of a handle it must not cover', () => {
    // A ring's extent, 40 px square, up and to the right of the object's middle.
    const keepOut: Vec3[] = [
      [40, 40, 0],
      [60, 40, 0],
      [60, 60, 0],
      [40, 60, 0],
    ];
    const [f] = place(prompt([field([50, 50, 0], { keepOut })]));
    const box = { l: 580, r: 620, t: 280, b: 320 };
    const clear = f.clientX - BW / 2 >= box.r || f.clientX + BW / 2 <= box.l || f.clientY - BH / 2 >= box.b || f.clientY + BH / 2 <= box.t;
    expect(clear).toBe(true);
    // Away from the middle: up and to the right on screen.
    expect(f.clientX).toBeGreaterThan(600);
    expect(f.clientY).toBeLessThan(300);
  });

  it('moves two boxes apart when they would land on each other', () => {
    // Two edges a few pixels apart: both boxes want the same place.
    const fields = place(prompt([field([0, -20, 0], { along: [1, 0, 0], ref: [0, 0, 0] }), field([2, -21, 0], { along: [1, 0, 0], ref: [0, 0, 0] })]));
    expect(overlap(fields[0], fields[1])).toBe(false);
  });

  it('leaves boxes that are already apart where they are', () => {
    const alone = place(prompt([field([0, -20, 0], { along: [1, 0, 0], ref: [0, 0, 0] })]))[0];
    const withOther = place(prompt([field([0, -20, 0], { along: [1, 0, 0], ref: [0, 0, 0] }), field([20, 0, 0], { along: [0, 1, 0], ref: [0, 0, 0] })]))[0];
    expect(withOther.clientX).toBeCloseTo(alone.clientX);
    expect(withOther.clientY).toBeCloseTo(alone.clientY);
  });

  it('brings a box back inside the view, under the toolbar at the top', () => {
    const [top] = place(prompt([field([0, 190, 0])]));
    expect(top.clientY).toBeCloseTo(MARGIN_TOP + BH / 2);
    const [right] = place(prompt([field([240, 0, 0])]));
    expect(right.clientX).toBeCloseTo(1000 - MARGIN - BW / 2);
    const [bottom] = place(prompt([field([0, -195, 0])]));
    expect(bottom.clientY).toBeCloseTo(800 - MARGIN - BH / 2);
  });

  it('says where what each box measures is on screen', () => {
    const [f] = place(prompt([field([0, -20, 0], { span: { from: [-20, -20, 0], to: [20, -20, 0] } })]));
    expect(f.ends).toEqual([
      [460, 440],
      [540, 440],
    ]);
    const [none] = place(prompt([field([0, -20, 0])]));
    expect(none.ends).toBeUndefined();
  });

  it('leaves the prompt it was given alone', () => {
    const given = prompt([field([0, -20, 0], { along: [1, 0, 0], ref: [0, 0, 0] })]);
    place(given);
    expect(given.fields[0].clientX).toBe(0);
    expect(given.fields[0].heading).toBeUndefined();
  });
});
