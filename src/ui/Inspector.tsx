import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PALETTE, paramMax, polygonExtent, shapeDef } from '../geometry/shapes';
import { boundsSize, tidy, tidyAngle, tidyVec, unionBounds } from '../model/math';
import { countShapes } from '../model/ops';
import type { SceneNode, ShapeNode, Vec3 } from '../model/types';
import { geometry } from '../state/geometry';
import { resizeNode, setColor, setHole, setPrefs, shownScene, updateNode, updateSelected, useEditor } from '../state/store';
import { ExportPanel } from './ExportPanel';
import { formatNumber, NumberBox, SliderField } from './Fields';
import { LinkIcon } from './icons';
import { Versions } from './Versions';

const AXES = ['X', 'Y', 'Z'] as const;
const SIZE_TAGS = ['W', 'D', 'H'] as const;
const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

const SHORTCUTS: [string, string][] = [
  ['Orbit', 'Right drag'],
  ['Pan', 'Middle drag · Shift+right drag'],
  ['Zoom', 'Wheel'],
  ['Move', 'Drag · arrow keys'],
  ['Raise or lower', `Arrow handle · ${MOD}↑↓`],
  ['Duplicate', `${MOD}D`],
  ['Group / ungroup', `${MOD}G / ${MOD}Shift+G`],
  ['Solid / hole', 'S / H'],
  ['Drop onto the plate', 'D'],
  ['Fit to view', 'F'],
  ['Save a version', `${MOD}Shift+V`],
];

const kindOf = (node: SceneNode): string =>
  node.type === 'group'
    ? `Group of ${countShapes(node.children)} shape${countShapes(node.children) === 1 ? '' : 's'}`
    : node.type === 'import'
      ? 'Imported model'
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
  const colour = solid && nodes.every((n) => n.color === nodes[0].color) ? nodes[0].color : null;
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
      <div className="swatch-row" role="group" aria-label="Colour">
        {PALETTE.map((c) => (
          <button
            key={c.value}
            type="button"
            className={c.value === colour ? 'swatch on' : 'swatch'}
            style={{ background: c.value }}
            title={c.name}
            aria-label={c.name}
            aria-pressed={c.value === colour}
            onClick={() => setColor(c.value)}
          />
        ))}
      </div>
    </fieldset>
  );
}

function Transform({ node }: { node: SceneNode }) {
  const [linked, setLinked] = useState(false);
  // Tight bounds change when geometry arrives.
  useSyncExternalStore(geometry.subscribe, geometry.getRevision);
  const low = geometry.bounds(node).min[2];
  const locked = Boolean(node.locked);
  const setPos = (axis: number, value: number) => {
    const pos: Vec3 = [...node.pos];
    // Z is shown as the height of the lowest point above the plate, which is what matters for printing.
    pos[axis] = axis === 2 ? tidy(node.pos[2] + value - low) : value;
    updateNode(node.id, { pos }, `pos:${node.id}:${axis}`);
  };
  const setRot = (axis: number, value: number) => {
    const rot: Vec3 = [...node.rot];
    rot[axis] = tidyAngle(value);
    updateNode(node.id, { rot }, `rot:${node.id}:${axis}`);
  };

  return (
    <>
      <fieldset className="group">
        <legend>
          Size
          <button type="button" className={linked ? 'legend-button on' : 'legend-button'} title="Keep proportions" aria-label="Keep proportions" aria-pressed={linked} onClick={() => setLinked(!linked)}>
            <LinkIcon />
          </button>
        </legend>
        <div className="triple">
          {SIZE_TAGS.map((tag, axis) => (
            <NumberBox
              key={tag}
              tag={tag}
              label={['Width (X)', 'Depth (Y)', 'Height (Z)'][axis]}
              value={node.size[axis]}
              min={0.01}
              max={100000}
              disabled={locked}
              onChange={(v) => resizeNode(node, axis as 0 | 1 | 2, v, linked)}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="group">
        <legend>Position</legend>
        <div className="triple">
          {AXES.map((tag, axis) => (
            <NumberBox
              key={tag}
              tag={tag}
              label={axis === 2 ? 'Height above the plate' : `${tag} of the centre`}
              value={axis === 2 ? low : node.pos[axis]}
              min={-100000}
              max={100000}
              disabled={locked}
              onChange={(v) => setPos(axis, v)}
            />
          ))}
        </div>
        <p className="field-note">X and Y locate the centre; Z is the gap under the object.</p>
      </fieldset>
      <fieldset className="group">
        <legend>Rotation</legend>
        <div className="triple">
          {AXES.map((tag, axis) => (
            <NumberBox key={tag} tag={tag} unit="°" label={`Rotation about ${tag}`} value={node.rot[axis]} step={15} min={-360} max={360} disabled={locked} onChange={(v) => setRot(axis, v)} />
          ))}
        </div>
      </fieldset>
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
    const size = boundsSize(unionBounds(nodes.map((n) => geometry.bounds(n))));
    return (
      <>
        <header className="params-head">
          <div>
            <h1>{nodes.length} objects</h1>
            <p>Group them to merge the solids and cut the holes.</p>
          </div>
        </header>
        <Appearance nodes={nodes} />
        <fieldset className="group">
          <legend>Selection</legend>
          <dl className="facts">
            <div>
              <dt>Overall size</dt>
              <dd>{size.map((v) => formatNumber(v, 2)).join(' × ')} mm</dd>
            </div>
          </dl>
        </fieldset>
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
      <Appearance nodes={nodes} />
      <Transform node={node} />
      <ShapeParams node={node} />
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
