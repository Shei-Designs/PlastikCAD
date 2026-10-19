import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PALETTE, paramMax, polygonExtent, shapeDef } from '../geometry/shapes';
import { boundsSize, tidyVec, unionBounds } from '../model/math';
import { picturesOf } from '../model/ops';
import { TEXT_FONTS } from '../model/types';
import type { ImageAsset, PictureMapping, PictureNode, SceneNode, ShapeNode, TextAlign, TextNode } from '../model/types';
import { geometry } from '../state/geometry';
import { editPicture, editText, imageAssets, pickImage, setColor, setHole, setTexture, toggleLocked, updateNode, updateSelected, useEditor } from '../state/store';
import { formatNumber, SliderField } from './Fields';
import { partFigures } from '../parts/figures';
import { CloseIcon, LockIcon, PictureIcon, WarningIcon } from './icons';
import { PartFields } from './PartFields';
import { Sections } from './Sections';
import type { Section } from './Sections';

const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** Fingers need bigger swatches than fit in one row: the row keeps the first few colors, the custom swatch covers the rest. */
const SWATCHES = TOUCH ? PALETTE.slice(0, 7) : PALETTE;

const SHORTCUTS: [string, string][] = [
  ...(TOUCH
    ? ([
        ['Orbit', 'One finger'],
        ['Pan / zoom', 'Two fingers'],
        ['Select more', 'Hold an object'],
        ['Box select', 'Hold the plate, then drag'],
        ['Clear selection', 'Tap the plate'],
      ] as [string, string][])
    : ([
        ['Orbit', 'Right drag'],
        ['Pan', 'Middle drag · Shift+right drag'],
        ['Zoom', 'Wheel'],
      ] as [string, string][])),
  ['Move', 'Drag · arrow keys'],
  ['Raise or lower', `Arrow handle · ${MOD}↑↓`],
  ['Resize height', 'Drag top or bottom grip'],
  ['Type a size', 'Click a grip'],
  ['Duplicate', `${MOD}D`],
  ['Group / ungroup', `${MOD}G / ${MOD}Shift+G`],
  ['Solid / hole', 'S / H'],
  ['Mirror', 'X / Y / Z'],
  ['Rotate 90°', 'Shift+X / Y / Z · Alt reverses'],
  ['Align', 'L'],
  ['Align to edge', 'Alt+arrows / PgUp / PgDn'],
  ['Align centers', 'Alt+Shift+arrows'],
  ['Center on plate', 'Alt+C'],
  ['Drop onto the plate', 'D'],
  ['Fit to view', 'F'],
  ['Import model or picture', `${MOD}I`],
];

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
  // A mixed group has no one color to show as its own.
  const mixed = nodes.some((n) => n.type === 'group' && n.mixed && !n.hole);
  const color = solid && !mixed && nodes.every((n) => n.color === nodes[0].color) ? nodes[0].color : null;
  // Edits skip locked objects, so the controls only go quiet once none of the selection takes them.
  const locked = nodes.every((n) => n.locked);
  return (
    <fieldset className="group">
      <legend>Material</legend>
      <div className="field">
        <div className="segmented" role="radiogroup" aria-label="Solid or hole">
          <button type="button" role="radio" aria-checked={solid} className={solid ? 'on' : ''} title="Adds material (S)" disabled={locked} onClick={() => setHole(false)}>
            Solid
          </button>
          <button type="button" role="radio" aria-checked={hole} className={hole ? 'on' : ''} title="Cuts material away from what it is grouped with (H)" disabled={locked} onClick={() => setHole(true)}>
            Hole
          </button>
        </div>
      </div>
      <div className="swatch-row" role="group" aria-label="Color">
        {SWATCHES.map((c) => (
          <button
            key={c.value}
            type="button"
            className={c.value === color ? 'swatch on' : 'swatch'}
            style={{ background: c.value }}
            title={c.name}
            aria-label={c.name}
            aria-pressed={c.value === color}
            disabled={locked}
            onClick={() => setColor(c.value)}
          />
        ))}
        <CustomColor color={color} custom={color !== null && !PALETTE.some((c) => c.value === color)} disabled={locked} />
      </div>
      {mixed && <p className="field-note">Each part keeps its own color. Picking one paints the whole.</p>}
      {nodes.length === 1 && nodes[0].type !== 'picture' && !nodes[0].hole && <TextureFields node={nodes[0]} />}
    </fieldset>
  );
}

/** A swatch for any other color: it opens the system color picker, and shows the color it last gave. */
function CustomColor({ color, custom, disabled }: { color: string | null; custom: boolean; disabled?: boolean }) {
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
        disabled={disabled}
        onClick={() => input.current?.click()}
      />
      <input ref={input} type="color" className="swatch-input" aria-hidden tabIndex={-1} disabled={disabled} value={color ?? '#8fa3bf'} onChange={(e) => setColor(e.target.value)} />
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

function ShapeParams({ node }: { node: ShapeNode }) {
  const def = shapeDef(node.shape);
  const locked = Boolean(node.locked);
  return (
    <>
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
          disabled={locked}
          onChange={(v) => updateSelected((n) => (n.type === 'shape' ? withParam(n, p.key, v) : n), `param:${node.id}:${p.key}`)}
        />
      ))}
    </>
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
    <>
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
    </>
  );
}

const MAPPINGS: { id: PictureMapping; label: string; title: string }[] = [
  { id: 'flat', label: 'Flat', title: 'Projects the picture from a flat sheet.' },
  { id: 'wrap', label: 'Wrap', title: 'Projects the picture from a curved band.' },
];

function PictureFields({ node }: { node: PictureNode }) {
  const asset = useEditor((s) => s.doc.assets[node.asset]);
  const image = asset?.kind === 'image' ? asset : null;
  const locked = Boolean(node.locked);
  const [w, d, h] = node.size;
  const shows = node.mapping === 'flat' ? `${formatNumber(w, 1)} × ${formatNumber(d, 1)} mm` : `${formatNumber((Math.PI * w * node.angle) / 360, 1)} × ${formatNumber(h, 1)} mm, ${formatNumber(w, 1)} mm across`;
  return (
    <fieldset className="group">
      <legend>Picture</legend>
      <div className="field">
        <div className="segmented" role="radiogroup" aria-label="How the picture is laid on">
          {MAPPINGS.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={m.id === node.mapping} className={m.id === node.mapping ? 'on' : ''} title={m.title} disabled={locked} onClick={() => editPicture(node.id, { mapping: m.id })}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {node.mapping === 'wrap' && (
        <SliderField label="Reach around" help="Sets how far around the band the picture wraps." value={node.angle} min={5} max={360} step={1} integer unit="°" disabled={locked} onChange={(v) => editPicture(node.id, { angle: v })} />
      )}
      <dl className="facts">
        {image && (
          <div>
            <dt>Image</dt>
            <dd>
              {image.width} × {image.height} px
            </dd>
          </div>
        )}
        <div>
          <dt>Shows</dt>
          <dd>{shows}</dd>
        </div>
      </dl>
      <p className="field-note">{node.mapping === 'flat' ? 'Starts facing up: turn it 90° about X to face the front. Grouped with an object, it prints onto the first surface behind it.' : 'Curves back around an axis behind it. Put that axis on the object\'s and match the diameter (a touch bigger is fine): grouped, it prints inwards onto the first surface within the band, and leaves alone what sticks out past it, like a handle.'}</p>
    </fieldset>
  );
}

/**
 * A texture is a picture stretched over the surface, and lives under the colors
 * as part of the material. Until there is one, a button fetches a picture; then
 * one row holds the picture and a Tile toggle, with the layout's one setting under it.
 */
function TextureFields({ node }: { node: SceneNode }) {
  const doc = useEditor((s) => s.doc);
  const images = useMemo(() => imageAssets(doc), [doc]);
  const locked = Boolean(node.locked);
  const pictures = picturesOf(node).length;
  const texture = node.texture ?? null;
  const asset = node.type === 'import' ? doc.assets[node.asset] : undefined;
  // Untiled, the picture goes once around the object; an imported mesh that brought texture coordinates keeps the file's own layout instead.
  const plain = asset?.kind === 'mesh' && asset.uv ? 'own' : 'wrap';
  const tiled = texture?.mode === 'tile';
  const add = async () => {
    const key = await pickImage();
    if (key) setTexture({ asset: key, mode: plain, scale: 50, turn: 0 });
  };
  const choose = async (key: string) => {
    if (key === 'new') key = (await pickImage()) ?? '';
    if (key && texture) setTexture({ ...texture, asset: key });
  };
  if (pictures > 0) {
    return (
      <p className="field-note">
        Carries {pictures} picture{pictures === 1 ? '' : 's'}, which cover the surface instead of a texture.
      </p>
    );
  }
  if (!texture) {
    return (
      <button type="button" className="import-button texture-button" disabled={locked} onClick={() => void add()}>
        <PictureIcon />
        Texture from a picture…
      </button>
    );
  }
  return (
    <div className="texture">
      <div className="field inline texture-head">
        <label>Texture</label>
        <button type="button" className="legend-button" title="Remove the texture" aria-label="Remove the texture" disabled={locked} onClick={() => setTexture(null)}>
          <CloseIcon />
        </button>
      </div>
      <div className="field texture-row">
        <select aria-label="Picture" value={texture.asset} disabled={locked} onChange={(e) => void choose(e.target.value)}>
          {images.map((i) => (
            <option key={i.key} value={i.key}>
              {imageLabel(i.asset)}
            </option>
          ))}
          <option value="new">Another picture…</option>
        </select>
        <button type="button" className={tiled ? 'chip on' : 'chip'} aria-pressed={tiled} title={tiled ? 'Repeats the picture over every side; off, it goes once around the object like a label' : 'Repeats the picture over every side, for patterns and materials'} disabled={locked} onClick={() => setTexture({ ...texture, mode: tiled ? plain : 'tile' })}>
          Tile
        </button>
      </div>
      {texture.mode === 'wrap' && <SliderField label="Turn" help="Turns the picture round the object. At 0° its middle faces the front; 90° turns it to the right side, 180° to the back." value={texture.turn} min={-180} max={180} step={1} integer unit="°" disabled={locked} onChange={(v) => setTexture({ ...texture, turn: v })} />}
      {texture.mode === 'tile' && <SliderField label="Tile size" help="How many millimeters one repeat of the picture covers." value={texture.scale} min={2} max={500} step={1} unit="mm" disabled={locked} onChange={(v) => setTexture({ ...texture, scale: v })} />}
    </div>
  );
}

const imageLabel = (image: ImageAsset) => `${image.name} (${image.width} × ${image.height})`;

function Overview() {
  const scene = useEditor((s) => s.doc.scene);
  useSyncExternalStore(geometry.subscribe, geometry.getRevision);
  const visible = scene.filter((n) => !n.hidden && !n.hole);
  const size = visible.length ? boundsSize(unionBounds(visible.map((n) => geometry.bounds(n)))) : null;
  return (
    <>
      <header className="params-head">
        <div>
          <h1>Nothing selected</h1>
          <p>{scene.length === 0 ? 'Pick a shape on the left and click on the plate.' : 'Click on an object to select it.'}</p>
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
  const nodes = useMemo(() => scene.filter((n) => selection.includes(n.id)), [scene, selection]);
  useSyncExternalStore(geometry.subscribe, geometry.getRevision);

  if (nodes.length === 0) return <Overview />;
  if (nodes.length > 1) {
    return (
      <>
        <header className="params-head">
          <div>
            <h1>{nodes.length} objects</h1>
          </div>
        </header>
        <Appearance nodes={nodes} />
      </>
    );
  }
  const node = nodes[0];
  const own: Section[] =
    node.type === 'shape' && shapeDef(node.shape).params.length > 0
      ? [{ title: shapeDef(node.shape).name, content: <ShapeParams node={node} /> }]
      : node.type === 'text'
        ? [{ title: 'Text', content: <TextFields node={node} /> }]
        : [];
  return (
    <>
      <header className="params-head">
        <div className="grow">
          <NameField node={node} />
        </div>
        {node.locked && (
          <button type="button" className="icon-button" title="Locked: press to unlock" aria-label="Unlock" onClick={() => toggleLocked(node.id)}>
            <LockIcon />
          </button>
        )}
      </header>
      {node.type === 'picture' ? <PictureFields node={node} /> : <Appearance nodes={nodes} />}
      {node.type === 'part' ? <PartFields node={node} /> : <Sections legend="Settings" reset={node.id} sections={own} />}
    </>
  );
}

/**
 * What a part has to say about its settings, at the foot of the panel so the
 * settings above keep their place. Each note can be waved away; it comes back
 * the next time the part raises it.
 */
function Warnings() {
  const scene = useEditor((s) => s.doc.scene);
  const selection = useEditor((s) => s.selection);
  const node = selection.length === 1 ? scene.find((n) => n.id === selection[0]) : undefined;
  const warnings = node?.type === 'part' ? partFigures(node).warnings : [];
  const keys = warnings.map((w) => `${node!.id}:${w}`);
  const [dismissed, setDismissed] = useState<string[]>([]);
  // A note that is no longer raised is forgotten, so that it shows again when it is.
  const raised = keys.join('\n');
  useEffect(() => setDismissed((d) => d.filter((k) => keys.includes(k))), [raised]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = warnings.filter((_, i) => !dismissed.includes(keys[i]));
  if (shown.length === 0) return null;
  return (
    <div className="inspector-notes" role="status">
      {shown.map((w) => (
        <div key={w} className="inspector-note">
          <WarningIcon />
          <span>{w}</span>
          <button type="button" className="legend-button" title="Dismiss" aria-label="Dismiss" onClick={() => setDismissed((d) => [...d, `${node!.id}:${w}`])}>
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Inspector() {
  return (
    <aside className="inspector">
      <div className="params">
        <Design />
      </div>
      <Warnings />
    </aside>
  );
}
