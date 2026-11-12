import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../model/types';
import { onlyFacets, pastStepLimit, tooDetailed } from './stepLimit';

const node = (type: string, name: string, children?: SceneNode[]): SceneNode => ({ id: name, type, name, ...(children ? { children } : {}) }) as unknown as SceneNode;

describe('what a STEP file can hold', () => {
  const [scan, label, box, gear] = [node('import', 'Scan'), node('text', 'Label'), node('shape', 'Box'), node('part', 'Gear')];

  it('knows an imported mesh, lettering and a group that holds one for facets, and nothing else', () => {
    expect([scan, label, box, gear].map(onlyFacets)).toEqual([true, true, false, false]);
    expect(onlyFacets(node('group', 'Plain', [box, gear]))).toBe(false);
    expect(onlyFacets(node('group', 'Drilled scan', [box, node('group', 'Inner', [scan])]))).toBe(true);
  });

  it('names the objects known to be facets when together they are past the limit, and none while they fit', () => {
    const triangles = (n: SceneNode): number => ({ Scan: 40, Label: 30, Box: 500, Gear: 900 })[n.name] ?? 0;
    // The box and the gear may yet be rebuilt: they do not count.
    expect(pastStepLimit([scan, label, box, gear], triangles, 70)).toEqual([]);
    expect(pastStepLimit([scan, label, box, gear], triangles, 69)).toEqual(['Scan', 'Label']);
    expect(pastStepLimit([label, box, gear], triangles, 29)).toEqual(['Label']);
    expect(pastStepLimit([box, gear], triangles, 1)).toEqual([]);
  });

  it('says which objects, three by name and the rest by number', () => {
    expect(tooDetailed(['Scan'])).toBe('Too detailed for a STEP file: "Scan".');
    expect(tooDetailed(['A', 'B', 'C'])).toBe('Too detailed for a STEP file: "A", "B", "C".');
    expect(tooDetailed(['A', 'B', 'C', 'D', 'E'])).toBe('Too detailed for a STEP file: "A", "B", "C" and 2 more.');
  });
});
