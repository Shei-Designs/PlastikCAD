import { describe, expect, it } from 'vitest';
import type { Feature } from '../geometry/features';
import type { SceneNode } from '../model/types';
import { picksStand } from './picks';

const node = (id: string): SceneNode => ({ id, pos: [0, 0, 0] }) as unknown as SceneNode;
const corner = (id: string): Feature => ({ kind: 'point', node: id, at: [1, 2, 3] });

describe('picksStand', () => {
  const a = node('a');
  const b = node('b');
  const c = node('c');
  const picks = [corner('a'), corner('b')];

  it('keeps the picks while the scene is the same one', () => {
    const scene = [a, b, c];
    expect(picksStand(picks, scene, scene)).toBe(true);
  });

  it('keeps them when only another object changed', () => {
    expect(picksStand(picks, [a, b, c], [a, b, { ...c, pos: [5, 0, 0] } as SceneNode])).toBe(true);
    expect(picksStand(picks, [a, b, c], [a, b])).toBe(true);
  });

  it('drops them when a picked object was nudged, or put back by an undo', () => {
    const moved = { ...a, pos: [1, 0, 0] } as SceneNode;
    expect(picksStand(picks, [a, b, c], [moved, b, c])).toBe(false);
    expect(picksStand(picks, [moved, b, c], [a, b, c])).toBe(false);
  });

  it('drops them when a picked object is gone', () => {
    expect(picksStand(picks, [a, b, c], [a, c])).toBe(false);
  });

  it('has nothing to drop without picks', () => {
    expect(picksStand([], [a], [])).toBe(true);
  });
});
