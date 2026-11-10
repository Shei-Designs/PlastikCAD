import { Ray, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Mat } from '../model/math';
import { makeShape } from '../model/ops';
import type { ShapeNode, Vec3 } from '../model/types';
import { alongAxis, angleAbout, baseEdgeOn, bestBaseAxis, boxAxis, pointOf, resizePoint, resized, snapTo, snapTurn, stretched } from './dragMath';
import type { GripBox } from './dragMath';

/** A ray straight down onto the point (x, y) of the plate. */
const down = (x: number, y: number) => new Ray(new Vector3(x, y, 100), new Vector3(0, 0, -1));
/** A ray from `from` through `to`. */
const through = (from: Vec3, to: Vec3) => new Ray(new Vector3(...from), new Vector3(...to).sub(new Vector3(...from)).normalize());

const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
/** Turned a quarter about Z (X goes to +Y), centered at (10, 20, 30). */
const TURNED: Mat = [0, 1, 0, -1, 0, 0, 0, 0, 1, 10, 20, 30];

const box = (size: Vec3, at: Vec3 = [0, 0, 0], rot: Vec3 = [0, 0, 0]): ShapeNode => ({ ...makeShape('box'), size, pos: at, rot });
/** A grip box square to the axes, centered at `center`. */
const gripAt = (size: Vec3, center: Vec3 = [0, 0, 0]): GripBox => ({ matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, ...center] as Mat, size, own: null });

describe('pointOf and boxAxis', () => {
  it('places a local point by the columns and the origin', () => {
    expect(pointOf(IDENTITY, [1, 2, 3]).toArray()).toEqual([1, 2, 3]);
    expect(pointOf(TURNED, [1, 0, 0]).toArray()).toEqual([10, 21, 30]);
    expect(pointOf(TURNED, [0, 2, 5]).toArray()).toEqual([8, 20, 35]);
  });

  it('reads an axis of the box out of its matrix', () => {
    const turned: GripBox = { matrix: TURNED, size: [1, 1, 1], own: null };
    expect(boxAxis(turned, 0).toArray()).toEqual([0, 1, 0]);
    expect(boxAxis(turned, 2).toArray()).toEqual([0, 0, 1]);
  });
});

describe('alongAxis', () => {
  it('gives how far along the line the pointer is', () => {
    expect(alongAxis(down(3, 7), new Vector3(0, 0, 0), new Vector3(1, 0, 0))).toBeCloseTo(3);
    expect(alongAxis(down(3, 7), new Vector3(1, 0, 0), new Vector3(1, 0, 0))).toBeCloseTo(2);
    expect(alongAxis(down(3, 7), new Vector3(0, 0, 0), new Vector3(0, 1, 0))).toBeCloseTo(7);
  });

  it('follows a slanted ray to the nearest point of the line', () => {
    // From above and behind, aimed at (0, 0, 12) on the Z axis.
    expect(alongAxis(through([0, -50, 40], [0, 0, 12]), new Vector3(0, 0, 0), new Vector3(0, 0, 1))).toBeCloseTo(12);
  });

  it('says nothing when the line is seen end-on', () => {
    expect(alongAxis(down(3, 7), new Vector3(0, 0, 0), new Vector3(0, 0, 1))).toBeNull();
  });
});

describe('resizePoint', () => {
  const grip = gripAt([20, 10, 6], [5, 5, 3]);

  it('puts a corner grip on the base plane, relative to the center', () => {
    const p = resizePoint(down(17, 12), grip, 1, 1);
    expect(p?.toArray()).toEqual([12, 7, 0]);
  });

  it('follows one axis for an edge grip and holds the other at the grip', () => {
    expect(resizePoint(down(17, 99), grip, 1, 0)?.toArray()).toEqual([12, 0, 0]);
    expect(resizePoint(down(99, 12), grip, 0, -1)?.toArray()).toEqual([0, 7, 0]);
  });

  it('holds a corner grip to one axis when asked', () => {
    expect(resizePoint(down(17, 99), grip, 1, 1, 0)?.toArray()).toEqual([12, 5, 0]);
    expect(resizePoint(down(99, 12), grip, -1, 1, 1)?.toArray()).toEqual([-10, 7, 0]);
  });

  it('gives up on a corner grip when the base is seen edge-on', () => {
    const level = through([-100, 0, 0], [0, 0, 0]);
    expect(baseEdgeOn(level, grip)).toBe(true);
    expect(resizePoint(level, grip, 1, 1)).toBeNull();
    expect(baseEdgeOn(down(0, 0), grip)).toBe(false);
  });

  it('picks the base axis squarer to the view', () => {
    // Looking along X, the pointer can follow Y but not X.
    expect(bestBaseAxis(through([-100, 0, 0], [0, 0, 0]), grip)).toBe(1);
    expect(bestBaseAxis(through([0, -100, 0], [0, 0, 0]), grip)).toBe(0);
  });
});

describe('angleAbout', () => {
  it('measures the pointer round a design axis', () => {
    expect(angleAbout(down(1, 1), 2, [0, 0, 0])).toBeCloseTo(45);
    expect(angleAbout(down(0, 5), 2, [0, 0, 0])).toBeCloseTo(90);
    expect(angleAbout(down(-3, 0), 2, [0, 0, 0])).toBeCloseTo(180);
  });

  it('measures from the pivot', () => {
    expect(angleAbout(down(11, 21), 2, [10, 20, 0])).toBeCloseTo(45);
  });

  it('measures round an axis of the frame it is given', () => {
    // The frame's X is the design's Y, so the same pointer reads a quarter turn less.
    const turn: Mat = [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0];
    expect(angleAbout(down(0, 5), 2, [0, 0, 0], turn)).toBeCloseTo(0);
  });

  it('gives up when the axis is seen side-on', () => {
    expect(angleAbout(down(1, 1), 0, [0, 0, 0])).toBeNull();
  });
});

describe('snapTo and snapTurn', () => {
  it('brings a length to the grid, or leaves it when there is none', () => {
    expect(snapTo(12.4, 5)).toBe(10);
    expect(snapTo(12.6, 5)).toBe(15);
    expect(snapTo(-0.7, 0.5)).toBe(-0.5);
    expect(snapTo(12.345, 0)).toBe(12.345);
  });

  it('takes a turn the short way round and steps it', () => {
    expect(snapTurn(22, 15)).toBe(15);
    expect(snapTurn(23, 15)).toBe(30);
    expect(snapTurn(190, 15)).toBe(-165);
    expect(snapTurn(-200, 45)).toBe(180);
    expect(snapTurn(359.2, 1)).toBe(-1);
    expect(snapTurn(4, 15)).toBe(0);
  });
});

describe('resized', () => {
  it('grows from the anchored side', () => {
    const next = resized(box([10, 10, 10], [0, 0, 5]), [20, 10, 10], [-1, 0, 0]);
    expect(next.size).toEqual([20, 10, 10]);
    expect(next.pos).toEqual([5, 0, 5]);
  });

  it('keeps the middle when nothing is anchored', () => {
    const next = resized(box([10, 10, 10], [1, 2, 3]), [20, 30, 40], [0, 0, 0]);
    expect(next.pos).toEqual([1, 2, 3]);
  });

  it('shifts along the object’s own axes when it is turned', () => {
    // Turned a quarter about Z: its own X runs along the design's Y.
    const next = resized(box([10, 10, 10], [0, 0, 5], [0, 0, 90]), [20, 10, 10], [-1, 0, 0]);
    expect(next.pos[0]).toBeCloseTo(0);
    expect(next.pos[1]).toBeCloseTo(5);
  });

  it('keeps the base still when the top grip is pulled', () => {
    const next = resized(box([10, 10, 10], [0, 0, 5]), [10, 10, 30], [0, 0, -1]);
    expect(next.pos).toEqual([0, 0, 15]);
  });
});

describe('stretched', () => {
  it('resizes the one object on its own box', () => {
    const own = box([10, 10, 10], [0, 0, 5]);
    const out = stretched({ matrix: IDENTITY, size: [10, 10, 10], own }, [own], [20, 10, 10], [-1, 0, 0]);
    expect(out).toHaveLength(1);
    expect(out[0].size).toEqual([20, 10, 10]);
    expect(out[0].pos).toEqual([5, 0, 5]);
  });

  it('stretches several about the fixed side of the box round them', () => {
    const a = box([10, 10, 10], [-10, 0, 5]);
    const b = box([10, 10, 10], [10, 0, 5]);
    // The box round both is 30 wide; doubled, with its -X side staying at x = -15.
    const out = stretched(gripAt([30, 10, 10], [0, 0, 5]), [a, b], [60, 10, 10], [-1, 0, 0]);
    expect(out.map((n) => n.size)).toEqual([
      [20, 10, 10],
      [20, 10, 10],
    ]);
    expect(out.map((n) => n.pos)).toEqual([
      [-5, 0, 5],
      [35, 0, 5],
    ]);
  });

  it('never makes anything thinner than the least size', () => {
    const out = stretched(gripAt([10, 10, 10], [0, 0, 5]), [box([10, 10, 10], [0, 0, 5])], [10, 10, 0.001], [0, 0, -1]);
    expect(out[0].size[2]).toBe(0.1);
  });
});
