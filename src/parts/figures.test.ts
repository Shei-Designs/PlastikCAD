import { describe, expect, it } from 'vitest';
import type { PartNode } from '../model/types';
import { partFigures } from './figures';
import { getGenerator } from './generators';
import { defaultParams } from './generators/types';
import { inUnit } from '../units';

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

  it('gives the lengths a part is sized by in inches as well, and a standard\'s own figures in millimeters alone', () => {
    const row = (id: string, label: string) => partFigures(part(id)).info.find((i) => i.label === label)!;
    // 20 teeth of module 2.
    expect(row('spur', 'Pitch diameter')).toEqual({ label: 'Pitch diameter', value: '40.00 mm', inches: '1.5748 in' });
    expect(row('helical', 'Transverse module').inches).toBeUndefined();
    expect(row('rack', 'Tooth pitch').inches).toBeUndefined();
    expect(row('rack', 'Length').inches).toMatch(/^\d+\.\d{4} in$/);
    expect(row('gt2-pulley', 'Belt pitch')).toEqual({ label: 'Belt pitch', value: '2.000 mm' });
    expect(row('sprocket', 'Chain pitch').inches).toBeUndefined();
    expect(row('worm', 'Axial pitch').inches).toBeUndefined();
    expect(row('worm', 'Lead').inches).toBeUndefined();
    // A count and an angle are no lengths.
    expect(row('bevel', 'Pitch cone angle').inches).toBeUndefined();
  });

  it('warns in the user\'s unit of a length the user set, and in millimeters of a standard\'s own figure', () => {
    const warnings = (id: string, params: Record<string, number | string | boolean>) => {
      const node = part(id);
      return partFigures({ ...node, params: { ...node.params, ...params } }).warnings;
    };
    // More backlash than teeth of module 0.5 can lose: a length of the user's.
    const [backlash] = warnings('spur', { module: 0.5, backlash: 1 });
    expect(backlash).toBe('Backlash was limited to 0.63 mm so the teeth keep two flanks.');
    expect(inUnit(backlash, 'in')).toBe('Backlash was limited to 0.0247 in so the teeth keep two flanks.');
    // A metric thread's pitch is the standard's: millimeters in both.
    const [pitch] = warnings('metric-bolt', { size: 'M8', pitch: 6 });
    expect(pitch).toBe('The pitch was limited to 4 mm for this diameter.');
    expect(inUnit(pitch, 'in')).toBe(pitch);
  });

  it('has nothing to say about a part it cannot build', () => {
    expect(partFigures(part('spur', { part: 'no-such-part' }))).toEqual({ info: [], warnings: [] });
  });
});
