import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PALETTE, paramMax, polygonExtent, shapeDef } from '../geometry/shapes';
import { boundsSize, tidyVec, unionBounds } from '../model/math';
import { countShapes } from '../model/ops';
import { TEXT_FONTS } from '../model/types';
import type { SceneNode, ShapeNode, TextAlign, TextNode } from '../model/types';
import { geometry } from '../state/geometry';
import { editText, setColor, setHole, setPrefs, shownScene, updateNode, updateSelected, useEditor } from '../state/store';
import { ExportPanel } from './ExportPanel';
import { formatNumber, SliderField } from './Fields';
import { getGenerator } from '../parts/generators';
import { PartFields } from './PartFields';
import { Versions } from './Versions';

const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

const SHORTCUTS: [string, string][] = [
  ['Orbit', 'Right drag'],
  ['Pan', 'Middle drag · Shift+right drag'],
  ['Zoom', 'Wheel'],
  ['Move', 'Drag · arrow keys'],
  ['Raise or lower', `Arrow handle · ${MOD}↑↓`],
  ['Height', 'Top grip pulls up, bottom grip pulls down'],
  ['Type a value', 'Click a grip instead of dragging it'],
  ['Duplicate', `${MOD}D`],
  ['Group / ungroup', `${MOD}G / ${MOD}Shift+G`],
  ['Solid / hole', 'S / H'],
  ['Flip on an axis', 'X / Y / Z'],
  ['Turn 90° about an axis', 'Shift+X / Y / Z (Alt: the other way)'],
  ['Align (anchor dots)', 'L · click an object to anchor'],
  ['Align by key', 'Alt+arrows / PgUp / PgDn; +Shift centers'],
  ['Center on X and Y', 'Alt+C'],
  ['Drop onto the plate', 'D'],
  ['Fit to view', 'F'],
  ['Save a version', `${MOD}Shift+V`],
];

const kindOf = (node: SceneNode): string =>
  node.type === 'group'
    ? `Group of ${countShapes(node.children)} shape${countShapes(node.children) === 1 ? '' : 's'}`
    : node.type === 'import'
      ? 'Imported model'
      : node.type === 'text'
        ? 'Lettering: solid to emboss, hole to engrave'
        : node.type === 'part'
          ? getGenerator(node.part).summary
          : shapeDef(node.shape).summary;

function NameField({ node }: { node: SceneNode }) {
  const [text, setText] = useState(node.name);
  useEffect(() => setText(node.name), [node.name]);
  return (
    <input
      className="name-input"
      aria-label="Name"
      spellCheck={false}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const clean = text.trim();
        if (clean && clean !== node.name) updateNode(node.id, { name: clean });
        else setText(node.name);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(node.name);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function Appearance({ nodes }: { nodes: SceneNode[] }) {
  const hole = nodes.every((n) => n.hole);
  const solid = nodes.every((n) => !n.hole);
  const color = solid && nodes.every((n) => n.color === nodes[0].color) ? nodes[0].color : null;
  return (
    <fieldset className="group">
      <legend>Material</legend>
      <div className="field">
        <div className="segmented" role="radiogroup" aria-label="Solid or hole">
          <button type="button" role="radio" aria-checked={solid} className={solid ? 'on' : ''} title="Adds material (S)" onClick={() => setHole(false)}>
            Solid
          </button>
          <button type="button" role="radio" aria-checked={hole} className={hole ? 'on' : ''} title="Cuts material away from what it is grouped with (H)" onClick={() => setHole(true)}>
            Hole
          </button>
        </div>
      </div>
      <div className="swatch-row" role="group" aria-label="Color">
        {PALETTE.map((c) => (
          <button
            key={c.value}
            type="button"
            className={c.value === color ? 'swatch on' : 'swatch'}
            style={{ background: c.value }}
            title={c.name}
            aria-label={c.name}
            aria-pressed={c.value === color}
            onClick={() => setColor(c.value)}
          />
        ))}
        <CustomColor color={color} custom={color !== null && !PALETTE.some((c) => c.value === color)} />
      </div>
    </fieldset>
  );
}

/** A swatch for any other color: it opens the system color picker, and shows the color it last gave. */
function CustomColor({ color, custom }: { color: string | null; custom: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={custom ? 'swatch custom on' : 'swatch custom'}
        style={custom && color ? { background: color } : undefined}
        title="Any color…"
        aria-label="Any color"
        aria-pressed={custom}
        onClick={() => input.current?.click()}
      />
      <input ref={input} type="color" className="swatch-input" aria-hidden tabIndex={-1} value={color ?? '#8fa3bf'} onChange={(e) => setColor(e.target.value)} />
    </>
  );
}

/** Sets a shape parameter. A regular polygon stays regular when its number of sides changes. */
function withParam(node: ShapeNode, key: string, value: number): ShapeNode {
  const next = { ...node, params: { ...node.params, [key]: value } };
  if (key !== 'sides' || (node.shape !== 'prism' && node.shape !== 'pyramid')) return next;
  const before = polygonExtent(node.params.sides);
  const regular = Math.abs(node.size[1] / node.size[0] - before[1] / before[0]) < 1e-3;
  if (!regular) return next;
  const after = polygonExtent(value);
  return { ...next, size: tidyVec([node.size[0], (node.size[0] * after[1]) / after[0], node.size[2]]) };
}

function ShapeParams({ node }: { node: SceneNode }) {
  if (node.type !== 'shape') return null;
  const def = shapeDef(node.shape);
  if (def.params.length === 0) return null;
  return (
    <fieldset className="group">
      <legend>{def.name}</legend>
      {def.params.map((p) => (
        <SliderField
          key={p.key}
          label={p.label}
          help={p.help}
          value={node.params[p.key] ?? p.default}
          min={p.min}
          max={Math.max(p.min, Math.min(p.max, paramMax(node.shape, p.key, node.size)))}
          step={p.step}
          integer={p.integer}
          unit={p.unit}
          onChange={(v) => updateSelected((n) => (n.type === 'shape' ? withParam(n, p.key, v) : n), `param:${node.id}:${p.key}`)}
        />
      ))}
    </fieldset>
  );
}

const ALIGNMENTS: { id: TextAlign; label: string }[] = [
  { id: 'left', label: 'Left' },
  { id: 'center', label: 'Center' },
  { id: 'right', label: 'Right' },
];

function TextFields({ node }: { node: TextNode }) {
  const id = useId();
  // What is being typed may briefly be nothing at all, which the node itself never is.
  const [draft, setDraft] = useState(node.text);
  useEffect(() => setDraft(node.text), [node.id, node.text]);
  const locked = Boolean(node.locked);
  return (
    <fieldset className="group">
      <legend>Text</legend>
      <div className="field">
        <textarea
          className="text-input area"
          rows={2}
          aria-label="Text"
          spellCheck={false}
          disabled={locked}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            void editText(node.id, { text: e.target.value });
          }}
          onBlur={() => setDraft(node.text)}
        />
      </div>
      <div className="field">
        <label htmlFor={id}>Font</label>
        <select id={id} value={node.font} disabled={locked} onChange={(e) => void editText(node.id, { font: e.target.value })}>
          {TEXT_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      {node.text.includes('\n') && (
        <div className="field">
          <div className="segmented" role="radiogroup" aria-label="Alignment of the lines">
            {ALIGNMENTS.map((a) => (
              <button key={a.id} type="button" role="radio" aria-checked={a.id === node.align} className={a.id === node.align ? 'on' : ''} disabled={locked} onClick={() => void editText(node.id, { align: a.id })}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </fieldset>
  );
}

function Overview() {
  const scene = useEditor(shownScene);
  useSyncExternalStore(geometry.subscribe, geometry.getRevision);
  const visible = scene.filter((n) => !n.hidden && !n.hole);
  const size = visible.length ? boundsSize(unionBounds(visible.map((n) => geometry.bounds(n)))) : null;
  return (
    <>
      <header className="params-head">
        <div>
          <h1>Nothing selected</h1>
          <p>{scene.length === 0 ? 'Pick a shape on the left and click on the plate.' : 'Click an object to edit it, or drag a box around several.'}</p>
        </div>
      </header>
      {size && (
        <fieldset className="group">
          <legend>Design</legend>
          <dl className="facts">
            <div>
              <dt>Objects</dt>
              <dd>{scene.length}</dd>
            </div>
            <div>
              <dt>Overall size</dt>
              <dd>{tidyVec(size).map((v) => formatNumber(v, 1)).join(' × ')} mm</dd>
            </div>
          </dl>
        </fieldset>
      )}
      <fieldset className="group">
        <legend>Shortcuts</legend>
        <dl className="facts keys">
          {SHORTCUTS.map(([what, keys]) => (
            <div key={what}>
              <dt>{what}</dt>
              <dd>{keys}</dd>
            </div>
          ))}
        </dl>
      </fieldset>
    </>
  );
}

function Design() {
  const scene = useEditor((s) => s.doc.scene);
  const selection = useEditor((s) => s.selection);
  const viewing = useEditor((s) => s.viewing);
  const nodes = useMemo(() => scene.filter((n) => selection.includes(n.id)), [scene, selection]);
  useSyncExternalStore(geometry.subscribe, geometry.getRevision);

  if (viewing || nodes.length === 0) return <Overview />;
  if (nodes.length > 1) {
    return (
      <>
        <header className="params-head">
          <div>
            <h1>{nodes.length} objects</h1>
            <p>Group them to merge the solids and cut the holes.</p>
          </div>
        </header>
        <Appearance nodes={nodes} />
      </>
    );
  }
  const node = nodes[0];
  return (
    <>
      <header className="params-head">
        <div className="grow">
          <NameField node={node} />
          <p>{kindOf(node)}{node.locked ? ' · locked' : ''}</p>
        </div>
      </header>
      {node.type === 'text' && <TextFields node={node} />}
      <Appearance nodes={nodes} />
      <ShapeParams node={node} />
      {node.type === 'part' && <PartFields node={node} />}
    </>
  );
}

export function Inspector() {
  const panel = useEditor((s) => s.prefs.panel);
  const versions = useEditor((s) => s.doc.versions.length);
  return (
    <aside className="inspector">
      <div className="tabs">
        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={panel === 'design'} className={panel === 'design' ? 'on' : ''} onClick={() => setPrefs({ panel: 'design' })}>
            Design
          </button>
          <button type="button" role="tab" aria-selected={panel === 'versions'} className={panel === 'versions' ? 'on' : ''} onClick={() => setPrefs({ panel: 'versions' })}>
            Versions{versions ? ` · ${versions}` : ''}
          </button>
        </div>
      </div>
      <div className="params">{panel === 'design' ? <Design /> : <Versions />}</div>
      <ExportPanel />
    </aside>
  );
}
