import { describe, expect, it } from 'vitest';
import type { Polygon, Vec2 } from '../model/types';
import { traceArcs } from './arcs';
import type { Side } from './arcs';

/** Corners on a circle, from `from` through `sweep` degrees in `steps` sides. */
function arc(center: Vec2, radius: number, from: number, sweep: number, steps: number, whole = false): Polygon {
  const out: Polygon = [];
  for (let i = 0; i < (whole ? steps : steps + 1); i++) {
    const a = ((from + (sweep * i) / steps) * Math.PI) / 180;
    out.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]);
  }
  return out;
}

const sidesOf = (contour: Polygon): Side[] => {
  const traced = traceArcs(contour);
  if ('circle' in traced) throw new Error('a circle, not sides');
  return traced.sides;
};
const degrees = (side: Side): number => Math.round(((side.arc?.sweep ?? 0) * 180) / Math.PI);

describe('traceArcs', () => {
  it('reads a hole of many sides as a circle, whichever way round it goes', () => {
    for (const sweep of [360, -360]) {
      const traced = traceArcs(arc([5, -3], 4, 10, sweep, 48, true));
      if (!('circle' in traced)) throw new Error('expected a circle');
      expect(traced.circle.center[0]).toBeCloseTo(5, 9);
      expect(traced.circle.center[1]).toBeCloseTo(-3, 9);
      expect(traced.circle.radius).toBeCloseTo(4, 9);
    }
  });

  it('takes a circle made with its flats on the true circle, as the app makes cylinders, at the size it measures across', () => {
    // 64 sides around a circle of radius 10: a flat at each end of both axes, the corners a little outside.
    const outer = 10 / Math.cos(Math.PI / 64);
    const flats = arc([2, 1], outer, 180 / 64, 360, 64, true);
    const traced = traceArcs(flats);
    if (!('circle' in traced)) throw new Error('expected a circle');
    expect(traced.circle.radius).toBeCloseTo(10, 9);
    expect(traced.circle.center[0]).toBeCloseTo(2, 9);
    // The same polygon with a corner on each axis is a circle through its corners.
    const corners = traceArcs(arc([2, 1], outer, 0, 360, 64, true));
    expect('circle' in corners && corners.circle.radius).toBeCloseTo(outer, 9);
  });

  it('leaves a hexagon and a twelve-sided hole as the polygons they are', () => {
    for (const n of [6, 12]) {
      const sides = sidesOf(arc([0, 0], 10, 0, 360, n, true));
      expect(sides).toHaveLength(n);
      expect(sides.every((s) => !s.arc)).toBe(true);
    }
  });

  it('reads a rounded square as four lines and four quarter arcs, wherever the list of corners starts', () => {
    // 40 by 30 with corners of radius 5, counterclockwise from the bottom edge.
    const corners: Polygon = [...arc([15, -10], 5, -90, 90, 8), ...arc([15, 10], 5, 0, 90, 8), ...arc([-15, 10], 5, 90, 90, 8), ...arc([-15, -10], 5, 180, 90, 8)];
    for (const shift of [0, 3, 13]) {
      const contour = [...corners.slice(shift), ...corners.slice(0, shift)];
      const traced = traceArcs(contour);
      if ('circle' in traced) throw new Error('not a circle');
      const arcs = traced.sides.filter((s) => s.arc);
      // Begun in the middle of a corner or not, each corner is one arc.
      expect(arcs.length).toBe(4);
      expect(arcs.reduce((sum, s) => sum + s.arc!.sweep, 0)).toBeCloseTo(2 * Math.PI, 9);
      for (const s of arcs) expect(s.arc!.radius).toBeCloseTo(5, 9);
      expect(traced.sides.filter((s) => !s.arc)).toHaveLength(4);
      // The sides lead back to where they began.
      expect(traced.sides[traced.sides.length - 1].to).toEqual(traced.start);
    }
    expect(sidesOf(corners).map(degrees)).toEqual([0, 90, 0, 90, 0, 90, 0, 90]);
  });

  it('writes more than half a turn as two arcs, and keeps the way each goes round', () => {
    // A keyhole: three quarters of a circle and a square notch, clockwise.
    const contour: Polygon = [...arc([0, 0], 10, 135, -270, 36), [0, 20]];
    const sides = sidesOf(contour);
    const arcs = sides.filter((s) => s.arc);
    expect(arcs.map(degrees)).toEqual([-135, -135]);
    expect(sides.filter((s) => !s.arc)).toHaveLength(2);
  });

  it('keeps to the corners of a curve that is not round: any arc it finds there passes them within two microns', () => {
    // An ellipse of 20 by 10. Where it is nearly round for a stretch, that stretch may be read as an arc.
    const ellipse: Polygon = Array.from({ length: 48 }, (_, i): Vec2 => [20 * Math.cos((i * Math.PI) / 24), 10 * Math.sin((i * Math.PI) / 24)]);
    const traced = traceArcs(ellipse);
    if ('circle' in traced) throw new Error('an ellipse is no circle');
    let i = ellipse.findIndex((p) => p === traced.start);
    for (const side of traced.sides) {
      let steps = 0;
      do {
        i = (i + 1) % 48;
        steps++;
        if (side.arc) expect(Math.abs(Math.hypot(ellipse[i][0] - side.arc.center[0], ellipse[i][1] - side.arc.center[1]) - side.arc.radius)).toBeLessThanOrEqual(0.002);
      } while (ellipse[i] !== side.to);
      if (!side.arc) expect(steps).toBe(1);
      else expect(steps).toBeGreaterThanOrEqual(4);
    }
    expect(ellipse[i]).toBe(traced.start);
    // The sharp ends are no arcs: most of it stays as it was.
    expect(traced.sides.filter((s) => !s.arc).length).toBeGreaterThan(24);
  });

  it('passes every corner between the ends of an arc within two microns', () => {
    // A circle whose corners are off by a micron here and there, as the kernel's arithmetic leaves them.
    const rough = arc([0, 0], 25, 0, 360, 72, true).map(([x, y], i): Vec2 => [x + (i % 3 === 0 ? 0.001 : 0), y - (i % 5 === 0 ? 0.001 : 0)]);
    const traced = traceArcs(rough);
    if (!('circle' in traced)) throw new Error('expected a circle');
    for (const [x, y] of rough) expect(Math.abs(Math.hypot(x - traced.circle.center[0], y - traced.circle.center[1]) - traced.circle.radius)).toBeLessThanOrEqual(0.002);
  });

  it('copes with nothing, a point and a line', () => {
    expect(traceArcs([])).toEqual({ start: [0, 0], sides: [] });
    expect(traceArcs([[1, 2]])).toEqual({ start: [1, 2], sides: [] });
    expect(traceArcs([[0, 0], [5, 0]])).toEqual({ start: [0, 0], sides: [{ to: [5, 0] }] });
  });
});
