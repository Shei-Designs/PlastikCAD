// Every number parameter of every part, pushed to its minimum and its maximum with the other
// parameters at their defaults, must still build a finite solid. Where a part has a "make" or
// "form" choice every form is swept, since most parameters only matter for one of them.
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../evaluate';
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

describe('parameter boundaries', () => {
  for (const def of GENERATORS) {
    it(`${def.id} builds at every visible number's min and max`, () => {
      const failures: string[] = [];
      for (const v of variants(def)) {
        for (const d of numbers(def, v.params)) {
          for (const end of ['min', 'max'] as const) {
            const label = `${def.id} ${v.label} ${d.key}=${d[end]}`;
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
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
