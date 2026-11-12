import { describe, expect, it } from 'vitest';
import type { ShapeNode } from '../model/types';
import { collisionPrimitive, primitiveMesh } from './collision';

const node = (over: Partial<ShapeNode>): ShapeNode => ({ id: 'a', name: 'A', type: 'shape', shape: 'box', params: {}, hole: false, color: '#888888', pos: [0, 0, 0], rot: [0, 0, 0], size: [20, 20, 20], ...over });
const round = (v: number[]) => v.map((x) => +x.toFixed(3));
/** The box around a mesh's points. */
const boundsOfPositions = (p: Float32Array): { min: number[]; max: number[] } => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  p.forEach((v, i) => {
    min[i % 3] = Math.min(min[i % 3], v);
    max[i % 3] = Math.max(max[i % 3], v);
  });
  return { min, max };
};

describe('the primitive a link collides as', () => {
  it("is the object's box, a cylinder along its own Z or a ball, each filling the box", () => {
    const n = node({ size: [10, 20, 30], pos: [5, 6, 7], rot: [0, 0, 90] });
    expect(collisionPrimitive(n, 'box')).toEqual({ shape: { box: [10, 20, 30] }, at: [5, 6, 7], rot: [0, 0, 90] });
    expect(collisionPrimitive(n, 'cylinder').shape).toEqual({ cylinder: { radius: 10, length: 30 } });
    expect(collisionPrimitive(n, 'sphere').shape).toEqual({ sphere: { radius: 15 } });
  });

  it('is drawn where it stands and turned as it is', () => {
    // A quarter turn about Z lays the box's 10 along Y and its 20 along X.
    const n = node({ size: [10, 20, 30], pos: [5, 6, 7], rot: [0, 0, 90] });
    const box = boundsOfPositions(primitiveMesh(collisionPrimitive(n, 'box')).positions);
    expect(round(box.min)).toEqual([-5, 1, -8]);
    expect(round(box.max)).toEqual([15, 11, 22]);
    const ball = boundsOfPositions(primitiveMesh(collisionPrimitive(n, 'sphere')).positions);
    expect(round(ball.min)).toEqual([-10, -9, -8]);
    expect(round(ball.max)).toEqual([20, 21, 22]);
    // A cylinder turned onto its side lies along X.
    const lying = boundsOfPositions(primitiveMesh(collisionPrimitive(node({ size: [10, 10, 40], rot: [0, 90, 0] }), 'cylinder')).positions);
    expect(round(lying.min)).toEqual([-20, -5, -5]);
    expect(round(lying.max)).toEqual([20, 5, 5]);
  });
});
