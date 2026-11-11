// Every number parameter of every part, pushed to its minimum and its maximum with the other
// parameters at their defaults, must still build a finite solid. Where a part has a "make" or
// "form" choice every form is swept, since most parameters only matter for one of them.
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../testing';
import { QUALITY } from '../types';
import { GENERATORS } from './index';
import { defaultParams } from './types';
import type { GeneratorDef, NumberParam, Params } from './types';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.draft;

/** The default parameters, once per form the part can be made in. */
function variants(def: GeneratorDef): { label: string; params: Params }[] {
  const base = defaultParams(def);
  const sel = def.groups.flatMap((g) => g.params).find((d) => d.type === 'select' && (d.key === 'form' || d.key === 'make'));
  if (!sel || sel.type !== 'select') return [{ label: '', params: base }];
  return sel.options.map((o) => ({ label: o.value, params: { ...base, [sel.key]: o.value } }));
}

function numbers(def: GeneratorDef, p: Params): NumberParam[] {
  const out: NumberParam[] = [];
  for (const g of def.groups) for (const d of g.params) if (d.type === 'number' && (d.visible?.(p) ?? true)) out.push(d);
  return out;
}

// One test to a parameter, not one to a part: a part with many numbers and a slow build (the throated wheel, cut
// by its worm) took fourteen seconds as one test here and thirty-one on a slow CI runner, a second past the limit.
// Each of these builds two solids and is done in a second or two wherever it runs.
describe('parameter boundaries', () => {
  for (const def of GENERATORS) {
    for (const v of variants(def)) {
      for (const d of numbers(def, v.params)) {
        it(`${def.id}${v.label ? ` (${v.label})` : ''} builds at the min and max of ${d.key}`, () => {
          const failures: string[] = [];
          for (const end of ['min', 'max'] as const) {
            const label = `${d.key}=${d[end]}`;
            try {
              const r = def.build({ ...v.params, [d.key]: d[end] }, q);
              const s = evaluate(r.solid).stats;
              const finite = [...s.min, ...s.max].every(Number.isFinite);
              if (!finite) failures.push(`${label}: bounds not finite`);
              else if (!(s.volume > 0)) failures.push(`${label}: volume ${s.volume}`);
            } catch (e) {
              failures.push(`${label}: ${(e as Error).message}`);
            }
          }
          expect(failures).toEqual([]);
        });
      }
    }
  }
});
