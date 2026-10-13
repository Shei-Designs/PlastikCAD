// The settings of a parametric part: a picker for the kind, its parameter
// groups as tabs, and the dimensions it works out (pitch diameter and the like).
import { useId, useMemo } from 'react';
import { CATEGORIES, GENERATORS, getGenerator } from '../parts/generators';
import { defaultParams, sanitizeParams } from '../parts/generators/types';
import type { BooleanParam, ParamDef, Params, SelectParam } from '../parts/generators/types';
import { QUALITY } from '../parts/types';
import type { PartNode } from '../model/types';
import { mateKinds } from '../parts/mates';
import { editPart, startMate, useEditor } from '../state/store';
import { SliderField } from './Fields';
import { Hint } from './Hint';
import { ResetIcon } from './icons';
import { partThumbnail } from './partThumbnails';
import { Sections } from './Sections';
import type { Section } from './Sections';

function SelectField({ def, value, onChange }: { def: SelectParam; value: string; onChange: (v: string) => void }) {
  const id = useId();
  const compact = def.options.length <= 3 && def.options.every((o) => o.label.length <= 14);
  return (
    <div className="field">
      <label htmlFor={compact ? undefined : id} id={`${id}-label`}>
        {def.label}
        {def.help && <Hint text={def.help} />}
      </label>
      {compact ? (
        <div className="segmented" role="radiogroup" aria-labelledby={`${id}-label`}>
          {def.options.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function BooleanField({ def, value, onChange }: { def: BooleanParam; value: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="field inline">
      <label htmlFor={id}>
        {def.label}
        {def.help && <Hint text={def.help} />}
      </label>
      <input id={id} className="switch" type="checkbox" role="switch" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

function Field({ def, params, onChange }: { def: ParamDef; params: Params; onChange: (key: string, v: Params[string]) => void }) {
  const value = params[def.key];
  switch (def.type) {
    case 'number':
      return <SliderField label={def.label} help={def.help} value={Number(value)} min={def.min} max={def.max} step={def.step} integer={def.integer} unit={def.unit} onChange={(v) => onChange(def.key, v)} />;
    case 'select':
      return <SelectField def={def} value={String(value)} onChange={(v) => onChange(def.key, v)} />;
    case 'boolean':
      return <BooleanField def={def} value={Boolean(value)} onChange={(v) => onChange(def.key, v)} />;
  }
}

/** `more` are sections that follow the part's own, such as its texture. */
export function PartFields({ node, more }: { node: PartNode; more: Section[] }) {
  const def = getGenerator(node.part);
  const family = CATEGORIES.find((c) => c.id === def.category)!;
  const kin = GENERATORS.filter((g) => g.category === def.category);
  const locked = Boolean(node.locked);
  // Generators are pure functions: the figures are worked out here, the mesh in the worker.
  const built = useMemo(() => {
    try {
      return def.build(sanitizeParams(def, node.params), QUALITY.draft);
    } catch {
      return null;
    }
  }, [def, node.params]);
  const groups = def.groups.filter((g) => g.params.some((d) => !d.visible || d.visible(node.params)));
  const change = (key: string, v: Params[string]) => void editPart(node.id, { params: { [key]: v } });
  const canMate = mateKinds(def.id).length > 0;
  const mating = useEditor((s) => s.mating !== null);
  const sections: Section[] = groups.map((g) => ({
    title: g.title,
    content: g.params.filter((d) => !d.visible || d.visible(node.params)).map((d) => <Field key={d.key} def={d} params={node.params} onChange={change} />),
  }));
  if (built?.info.length) {
    sections.push({
      title: 'Dimensions',
      tab: 'Dims',
      content: (
        <dl className="facts">
          {built.info.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      ),
    });
  }
  if (canMate && sections.length) {
    sections[0].after = (
      <button type="button" className="primary mate-button" disabled={mating} onClick={() => startMate(node.id)}>
        Add mating gear…
      </button>
    );
  }
  sections.push(...more);

  const reset = (
    <button type="button" className="legend-button" title="Reset to defaults" aria-label="Reset to defaults" disabled={locked} onClick={() => void editPart(node.id, { part: def.id, params: defaultParams(def) })}>
      <ResetIcon />
    </button>
  );
  return (
    <>
      {kin.length > 1 && (
        <fieldset className="group">
          <legend>
            {family.label}
            {reset}
          </legend>
          <ul className="shape-grid part-types" role="radiogroup" aria-label="Kind of part">
            {kin.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={g.id === def.id}
                  className={g.id === def.id ? 'shape selected' : 'shape'}
                  title={g.summary}
                  disabled={locked}
                  onClick={() => {
                    if (g.id !== def.id) void editPart(node.id, { part: g.id });
                  }}
                >
                  <span className="thumb">{partThumbnail(g)}</span>
                  <span className="shape-name">{g.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      <Sections
        legend="Settings"
        extra={kin.length === 1 ? reset : undefined}
        reset={`${node.id}:${def.id}`}
        note={built?.warnings.map((w) => (
          <p key={w} className="field-note warn">
            {w}
          </p>
        ))}
        sections={sections}
      />
    </>
  );
}
