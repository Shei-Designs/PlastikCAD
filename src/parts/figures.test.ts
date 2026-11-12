import { describe, expect, it } from 'vitest';
import type { PartNode } from '../model/types';
import { partFigures } from './figures';
import { getGenerator } from './generators';
import { BOARDS } from './generators/boards';
import { CUTOUTS } from './generators/cutouts';
import { FAN_PARTS } from './generators/fans';
import { MOTORS } from './generators/motors';
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

  it('gives every length of a part in inches as well, a standard\'s own figures among them', () => {
    const row = (id: string, label: string) => partFigures(part(id)).info.find((i) => i.label === label)!;
    // 20 teeth of module 2.
    expect(row('spur', 'Pitch diameter')).toEqual({ label: 'Pitch diameter', value: '40.00 mm', inches: '1.5748 in' });
    expect(row('helical', 'Transverse module').inches).toMatch(/^0\.\d{4} in$/);
    expect(row('rack', 'Length').inches).toMatch(/^\d+\.\d{4} in$/);
    expect(row('gt2-pulley', 'Belt pitch')).toEqual({ label: 'Belt pitch', value: '2.000 mm', inches: '0.0787 in' });
    expect(row('sprocket', 'Chain pitch').inches).toMatch(/ in$/);
    expect(row('worm', 'Lead').inches).toMatch(/ in per turn$/);
    // A count and an angle are no lengths.
    expect(row('bevel', 'Pitch cone angle').inches).toBeUndefined();
  });

  it('gives the figures of hardware in inches as well, whose names stay as they are', () => {
    const rowsOf = (id: string) => new Map(partFigures(part(id)).info.map((i) => [i.label, i]));
    const fan = rowsOf('fan');
    expect(fan.get('Fan')).toEqual({ label: 'Fan', value: '40 × 40 mm', inches: '1.5748 × 1.5748 in' });
    expect(fan.get('Screw holes')?.inches).toMatch(/^4 × Ø0\.\d+ in, 1\.\d+ in apart$/);
    for (const id of [...FAN_PARTS, ...MOTORS, ...BOARDS, ...CUTOUTS].map((g) => g.id).concat('extrusion')) {
      for (const item of rowsOf(id).values()) {
        // Every row that names millimeters has what it reads in inches beside it.
        if (/\bmm\b/.test(item.value)) expect(item.inches, `${id}: ${item.label}`).toMatch(/\bin\b/);
        if (item.inches !== undefined) expect(item.inches, `${id}: ${item.label}`).not.toMatch(/\bmm\b/);
      }
    }
  });

  it('warns of lengths in the unit the user works in, a standard\'s own figure among them', () => {
    const warnings = (id: string, params: Record<string, number | string | boolean>) => {
      const node = part(id);
      return partFigures({ ...node, params: { ...node.params, ...params } }).warnings;
    };
    // More backlash than teeth of module 0.5 can lose.
    const [backlash] = warnings('spur', { module: 0.5, backlash: 1 });
    expect(backlash).toBe('Backlash was limited to 0.63 mm so the teeth keep two flanks.');
    expect(inUnit(backlash, 'in')).toBe('Backlash was limited to 0.0247 in so the teeth keep two flanks.');
    // A coarser pitch than an M8 thread can have.
    const [pitch] = warnings('metric-bolt', { size: 'M8', pitch: 6 });
    expect(pitch).toBe('The pitch was limited to 4 mm for this diameter.');
    expect(inUnit(pitch, 'in')).toBe('The pitch was limited to 0.1575 in for this diameter.');
  });

  it('has nothing to say about a part it cannot build', () => {
    expect(partFigures(part('spur', { part: 'no-such-part' }))).toEqual({ info: [], warnings: [] });
  });
});
