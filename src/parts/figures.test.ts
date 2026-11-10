import { describe, expect, it } from 'vitest';
import type { PartNode } from '../model/types';
import { partFigures } from './figures';
import { getGenerator } from './generators';
import { defaultParams } from './generators/types';

const part = (id: string, over: Partial<PartNode> = {}): PartNode => ({ id: 'p', type: 'part', name: 'Part', part: id, params: defaultParams(getGenerator(id)), natural: [1, 1, 1], size: [1, 1, 1], pos: [0, 0, 0], rot: [0, 0, 0], hole: false, color: '#ffffff', ...over });

describe('partFigures', () => {
  it('works a part out once, however often it is moved, turned or repainted', () => {
    const gear = part('spur');
    const figures = partFigures(gear);
    expect(figures.info.length).toBeGreaterThan(0);
    // Every step of a drag is a new node with the same parameters.
    expect(partFigures({ ...gear, pos: [5, 0, 0] })).toBe(figures);
    expect(partFigures({ ...gear, id: 'q', rot: [0, 0, 30], color: '#ff0000', params: { ...gear.params } })).toBe(figures);
  });

  it('works it out again for other parameters or another part', () => {
    const gear = part('spur');
    const figures = partFigures(gear);
    const more = partFigures({ ...gear, params: { ...gear.params, teeth: 41 } });
    expect(more).not.toBe(figures);
    expect(more.info).not.toEqual(figures.info);
    expect(partFigures(part('ring'))).not.toBe(figures);
    // And remembers the first all the same.
    expect(partFigures(part('spur'))).toBe(figures);
  });

  it('has nothing to say about a part it cannot build', () => {
    expect(partFigures(part('spur', { part: 'no-such-part' }))).toEqual({ info: [], warnings: [] });
  });
});
