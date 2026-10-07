// The settings of a Gearwright part: a picker for the kind, its parameter
// groups as tabs, and the dimensions it works out (pitch diameter and the like).
import { useEffect, useId, useMemo, useState } from 'react';
import { CATEGORIES, GENERATORS, getGenerator } from '../parts/generators';
import { defaultParams } from '../parts/generators/types';
import type { BooleanParam, ParamDef, Params, SelectParam } from '../parts/generators/types';
import { QUALITY } from '../parts/types';
import type { PartNode, PartQuality } from '../model/types';
import { editPart } from '../state/store';
import { SliderField } from './Fields';
import { Hint } from './Hint';
import { ResetIcon } from './icons';
import { partThumbnail } from './partThumbnails';

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

const DIMENSIONS = 'Dimensions';

const QUALITIES: { id: PartQuality; label: string }[] = [
  { id: 'draft', label: 'Draft' },
  { id: 'normal', label: 'Normal' },
  { id: 'fine', label: 'Fine' },
];

export function PartFields({ node }: { node: PartNode }) {
  const id = useId();
  const def = getGenerator(node.part);
  const family = CATEGORIES.find((c) => c.id === def.category)!;
  const kin = GENERATORS.filter((g) => g.category === def.category);
  const locked = Boolean(node.locked);
  // Generators are pure functions: the figures are worked out here, the mesh in the worker.
  const built = useMemo(() => {
    try {
      return def.build(node.params, QUALITY.draft);
    } catch {
      return null;
    }
  }, [def, node.params]);
  const groups = def.groups.filter((g) => g.params.some((d) => !d.visible || d.visible(node.params)));
  const tabs = [...groups.map((g) => g.title), ...(built?.info.length ? [DIMENSIONS] : [])];
  const [tab, setTab] = useState(tabs[0]);
  // Another part, or another kind: back to the first tab.
  useEffect(() => setTab(tabs[0]), [node.id, def.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = tabs.includes(tab) ? tab : tabs[0];
  const group = groups.find((g) => g.title === current);
  const change = (key: string, v: Params[string]) => void editPart(node.id, { params: { [key]: v } });

  return (
    <>
      <fieldset className="group">
        <legend>
          {family.label}
          <button type="button" className="legend-button" title="Reset to defaults" aria-label="Reset to defaults" disabled={locked} onClick={() => void editPart(node.id, { part: def.id, params: defaultParams(def) })}>
            <ResetIcon />
          </button>
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
        <p className="field-note">{def.summary}</p>
        <div className="field">
          <label id={`${id}-detail`}>
            Detail
            <Hint text="How finely the curves are tessellated. Draft is quickest while working; Fine is worth it for the export." />
          </label>
          <div className="segmented" role="radiogroup" aria-labelledby={`${id}-detail`}>
            {QUALITIES.map((q) => (
              <button key={q.id} type="button" role="radio" aria-checked={q.id === node.quality} className={q.id === node.quality ? 'on' : ''} disabled={locked} onClick={() => void editPart(node.id, { quality: q.id })}>
                {q.label}
              </button>
            ))}
          </div>
        </div>
      </fieldset>

      <fieldset className="group">
        <legend>Settings</legend>
        {built?.warnings.map((w) => (
          <p key={w} className="field-note warn">
            {w}
          </p>
        ))}
        {tabs.length > 1 && (
          <div className="segmented tabs-row" role="tablist">
            {tabs.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={t === current} className={t === current ? 'on' : ''} onClick={() => setTab(t)}>
                {t === DIMENSIONS ? 'Dims' : t}
              </button>
            ))}
          </div>
        )}
        {group &&
          group.params.filter((d) => !d.visible || d.visible(node.params)).map((d) => <Field key={d.key} def={d} params={node.params} onChange={change} />)}
        {current === DIMENSIONS && built && (
          <dl className="facts">
            {built.info.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </fieldset>
    </>
  );
}
