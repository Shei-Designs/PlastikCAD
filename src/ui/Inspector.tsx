import { CURVE_KINDS, MAX_CURVE_ANGLE, MIN_CURVE_ANGLE, clampAngle, curveRadius } from '../text/curve';
import type { TextCurve } from '../text/curve';
import { outlineOf } from '../text/fonts';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PALETTE, paramMax, polygonExtent, shapeDef } from '../geometry/shapes';
import { marked, plural, tr, trx } from '../i18n';
import { boundsSize, tidyVec, unionBounds } from '../model/math';
import { picturesOf } from '../model/ops';
import { TEXT_FONTS } from '../model/types';
import type { ImageAsset, PictureMapping, PictureNode, SceneNode, ShapeNode, TextAlign, TextNode } from '../model/types';
import { geometry } from '../state/geometry';
import { editPicture, editText, imageAssets, notify, pickImage, saveAsPart, setColor, setHole, setSelectedLocked, setTexture, toggleLocked, updateNode, updateSelected, useEditor } from '../state/store';
import { inUnit, lengthText, sizeText } from '../units';
import { CommitInput, NumberBox, SliderField } from './Fields';
import { Hint } from './Hint';
import { shortcutRows, tip } from './keymap';
import { useCoarsePointer, useKeyboardAttached } from './inputMode';
import { partFigures } from '../parts/figures';
import { tell } from './ask';
import { CloseIcon, LockIcon, PictureIcon, SaveAsPartIcon, UnlockIcon, WarningIcon } from './icons';
import { PartsBin } from './PartsBin';
import { RobotInspector } from './RobotInspector';
import { PartFields } from './PartFields';
import { Sections } from './Sections';
import type { Section } from './Sections';

const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** Fingers need bigger swatches than fit in one row: the row keeps the first few colors, the custom swatch covers the rest. */
const SWATCHES = TOUCH ? PALETTE.slice(0, 7) : PALETTE;

export function NameField({ node }: { node: SceneNode }) {
  return <CommitInput className="name-input" label={tr('Name')} value={node.name} onCommit={(name) => updateNode(node.id, { name })} />;
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
      <legend>{trx('appearance', 'Material')}</legend>
      <div className="field">
        <div className="segmented" role="radiogroup" aria-label={tr('Solid or hole')}>
          <button type="button" role="radio" aria-checked={solid} className={solid ? 'on' : ''} title={tip('solid', tr('Adds material'))} disabled={locked} onClick={() => setHole(false)}>
            {tr('Solid')}
          </button>
          <button type="button" role="radio" aria-checked={hole} className={hole ? 'on' : ''} title={tip('hole', tr('Cuts material away from what it is grouped with'))} disabled={locked} onClick={() => setHole(true)}>
            {tr('Hole')}
          </button>
        </div>
      </div>
      <div className="swatch-row" role="group" aria-label={tr('Color')}>
        {SWATCHES.map((c) => (
          <button
            key={c.value}
            type="button"
            className={c.value === color ? 'swatch on' : 'swatch'}
            style={{ background: c.value }}
            title={marked(c.name)}
            aria-label={marked(c.name)}
            aria-pressed={c.value === color}
            disabled={locked}
            onClick={() => setColor(c.value)}
          />
        ))}
        <CustomColor color={color} custom={color !== null && !PALETTE.some((c) => c.value === color)} disabled={locked} />
      </div>
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
        title={tr('Any color…')}
        aria-label={tr('Any color')}
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
          length={p.unit === 'mm'}
          disabled={locked}
          onChange={(v) => updateSelected((n) => (n.type === 'shape' ? withParam(n, p.key, v) : n), `param:${node.id}:${p.key}`)}
        />
      ))}
    </>
  );
}

const ALIGNMENTS: { id: TextAlign; label: string }[] = [
  { id: 'left', label: trx('alignment', 'Left') },
  { id: 'center', label: trx('alignment', 'Center') },
  { id: 'right', label: trx('alignment', 'Right') },
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
          aria-label={tr('Text')}
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
        <label htmlFor={id}>{tr('Font')}</label>
        <select id={id} value={node.font} disabled={locked} onChange={(e) => void editText(node.id, { font: e.target.value })}>
          {TEXT_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <div className="segmented" role="radiogroup" aria-label={tr('How the letters run')}>
          {CURVE_KINDS.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={(node.curve?.kind ?? 'none') === c.id} className={(node.curve?.kind ?? 'none') === c.id ? 'on' : ''} title={c.title} disabled={locked} onClick={() => void editText(node.id, { curve: c.id === 'none' ? null : { kind: c.id, angle: node.curve?.angle ?? 90, flip: node.curve?.flip ?? false, thickness: node.curve?.thickness ?? node.size[2] } })}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {node.curve && <CurveFields node={node} curve={node.curve} />}
      {node.text.includes('\n') && (
        <div className="field">
          <div className="segmented" role="radiogroup" aria-label={tr('Alignment of the lines')}>
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

/** The curve of bent or arced lettering: how far round, which way, how thick, and the circle it fits. */
function CurveFields({ node, curve }: { node: TextNode; curve: TextCurve }) {
  const id = useId();
  const locked = Boolean(node.locked);
  const bend = curve.kind === 'bend';
  // The letters' scale, and from it the flat width in mm the curve is wound from.
  const scale = node.natural[1] > 0 ? node.size[1] / node.natural[1] : 1;
  const flat = (outlineOf(node)?.size[0] ?? 0) * scale;
  const diameter = 2 * curveRadius(curve, flat);
  const set = (change: Partial<TextCurve>) => void editText(node.id, { curve: { ...curve, ...change } });
  const sides = bend
    ? [
        { flip: false, label: tr('Outside'), title: tr('The letters stand on the outside of the cylinder.') },
        { flip: true, label: tr('Inside'), title: tr('The letters stand on the inside, read from the middle.') },
      ]
    : [
        { flip: false, label: tr('Arch'), title: tr('The arc rises in the middle.') },
        { flip: true, label: tr('Hang'), title: tr('The arc dips in the middle.') },
      ];
  return (
    <>
      <SliderField label={bend ? tr('Reach around') : trx('lettering', 'Sweep')} help={bend ? tr('Sets how far round the cylinder the letters reach.') : tr('Sets how much of a circle the letters follow.')} value={curve.angle} min={MIN_CURVE_ANGLE} max={MAX_CURVE_ANGLE} step={1} integer unit="°" disabled={locked} onChange={(v) => set({ angle: v })} />
      <div className="field">
        <label htmlFor={`${id}-d`}>
          {bend ? tr('Fits') : tr('Circle')}
          <Hint text={bend ? tr('Sets the diameter of the cylinder the letters sit on, by changing the reach.') : tr('Sets the diameter of the circle the baseline follows, by changing the sweep.')} />
        </label>
        <NumberBox id={`${id}-d`} label={tr('Diameter')} value={diameter} unit="mm" length min={0.1} step={1} places={1} disabled={locked || flat <= 0} onChange={(d) => set({ angle: clampAngle((360 * flat) / (Math.PI * Math.max(d, 0.1))) })} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-t`}>{tr('Thickness')}</label>
        <NumberBox id={`${id}-t`} label={tr('Thickness')} value={curve.thickness} unit="mm" length min={0.1} step={0.5} places={2} disabled={locked} onChange={(t) => set({ thickness: Math.max(0.1, t) })} />
      </div>
      <div className="field">
        <div className="segmented" role="radiogroup" aria-label={bend ? tr('Which side of the cylinder') : tr('Which way the arc goes')}>
          {sides.map((s) => (
            <button key={s.label} type="button" role="radio" aria-checked={curve.flip === s.flip} className={curve.flip === s.flip ? 'on' : ''} title={s.title} disabled={locked} onClick={() => set({ flip: s.flip })}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

const MAPPINGS: { id: PictureMapping; label: string; title: string }[] = [
  { id: 'flat', label: trx('picture', 'Flat'), title: tr('Projects the picture from a flat sheet.') },
  { id: 'wrap', label: trx('picture', 'Wrap'), title: tr('Projects the picture from a curved band.') },
];

function PictureFields({ node }: { node: PictureNode }) {
  const asset = useEditor((s) => s.doc.assets[node.asset]);
  const image = asset?.kind === 'image' ? asset : null;
  const locked = Boolean(node.locked);
  const unit = useEditor((s) => s.prefs.units);
  const [w, d, h] = node.size;
  const shows = node.mapping === 'flat' ? sizeText([w, d], unit, 1) : tr('{size}, {across} across', { size: sizeText([(Math.PI * w * node.angle) / 360, h], unit, 1), across: lengthText(w, unit, 1) });
  return (
    <fieldset className="group">
      <legend>{tr('Picture')}</legend>
      <div className="field">
        <div className="segmented" role="radiogroup" aria-label={tr('How the picture is laid on')}>
          {MAPPINGS.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={m.id === node.mapping} className={m.id === node.mapping ? 'on' : ''} title={m.title} disabled={locked} onClick={() => editPicture(node.id, { mapping: m.id })}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {node.mapping === 'wrap' && (
        <SliderField label={tr('Reach around')} help={tr('Sets how far around the band the picture wraps.')} value={node.angle} min={5} max={360} step={1} integer unit="°" disabled={locked} onChange={(v) => editPicture(node.id, { angle: v })} />
      )}
      <dl className="facts">
        {image && (
          <div>
            <dt>{tr('Image')}</dt>
            <dd>
              {image.width} × {image.height} px
            </dd>
          </div>
        )}
        <div>
          <dt>{tr('Shows')}</dt>
          <dd>{shows}</dd>
        </div>
      </dl>
      <p className="field-note">{node.mapping === 'flat' ? tr('Prints onto the first surface behind it when grouped with an object.') : tr('Prints inwards onto the first surface inside the band when grouped with an object.')}</p>
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
    // Pictures grouped onto the object cover its surface; a texture would never show under them.
    if (pictures > 0) {
      await tell({
        title: tr('Texture'),
        text: tr('The selected object already has an image projected onto its surface. To add a texture remove the projected image first.'),
        actions: [tr('OK')],
      });
      return;
    }
    const key = await pickImage();
    if (key) setTexture({ asset: key, mode: plain, scale: 50, turn: 0 });
  };
  const choose = async (key: string) => {
    if (key === 'new') key = (await pickImage()) ?? '';
    if (key && texture) setTexture({ ...texture, asset: key });
  };
  if (!texture || pictures > 0) {
    return (
      <button type="button" className="import-button texture-button" disabled={locked} onClick={() => void add()}>
        <PictureIcon />
        {tr('Texture from a picture…')}
      </button>
    );
  }
  return (
    <div className="texture">
      <div className="field inline texture-head">
        <label>{tr('Texture')}</label>
        <button type="button" className="legend-button" title={tr('Remove the texture')} aria-label={tr('Remove the texture')} disabled={locked} onClick={() => setTexture(null)}>
          <CloseIcon />
        </button>
      </div>
      <div className="field texture-row">
        <select aria-label={tr('Picture')} value={texture.asset} disabled={locked} onChange={(e) => void choose(e.target.value)}>
          {images.map((i) => (
            <option key={i.key} value={i.key}>
              {imageLabel(i.asset)}
            </option>
          ))}
          <option value="new">{tr('Another picture…')}</option>
        </select>
        <button type="button" className={tiled ? 'chip on' : 'chip'} aria-pressed={tiled} title={tr('Repeats the picture over every side.')} disabled={locked} onClick={() => setTexture({ ...texture, mode: tiled ? plain : 'tile' })}>
          {tr('Tile')}
        </button>
      </div>
      {texture.mode === 'wrap' && <SliderField label={trx('texture', 'Turn')} help={tr('Turns the picture round the object. 0° puts its middle at the front.')} value={texture.turn} min={-180} max={180} step={1} integer unit="°" disabled={locked} onChange={(v) => setTexture({ ...texture, turn: v })} />}
      {texture.mode === 'tile' && <SliderField label={tr('Tile size')} help={tr('Sets the size of one repeat of the picture.')} value={texture.scale} min={2} max={500} step={1} unit="mm" length disabled={locked} onChange={(v) => setTexture({ ...texture, scale: v })} />}
    </div>
  );
}

const imageLabel = (image: ImageAsset) => `${image.name} (${image.width} × ${image.height})`;

function Overview() {
  const scene = useEditor((s) => s.doc.scene);
  const unit = useEditor((s) => s.prefs.units);
  useSyncExternalStore(geometry.subscribe, geometry.getRevision);
  const visible = scene.filter((n) => !n.hidden && !n.hole);
  const size = visible.length ? boundsSize(unionBounds(visible.map((n) => geometry.bounds(n)))) : null;
  return (
    <>
      <header className="params-head">
        <div>
          <h1>{tr('Nothing selected')}</h1>
          <p>{scene.length === 0 ? tr('Pick a shape on the left and click on the plate.') : tr('Click on an object to select it.')}</p>
        </div>
      </header>
      {size && (
        <fieldset className="group">
          <legend>{tr('Design')}</legend>
          <dl className="facts">
            <div>
              <dt>{tr('Objects')}</dt>
              <dd>{scene.length}</dd>
            </div>
            <div>
              <dt>{tr('Overall size')}</dt>
              <dd>{sizeText(tidyVec(size), unit, 1)}</dd>
            </div>
          </dl>
        </fieldset>
      )}
      <Shortcuts />
    </>
  );
}

/** The keys and gestures of the app. A tablet shows its keys once a keyboard is docked, and loses them when it goes. */
function Shortcuts() {
  const keyboard = useKeyboardAttached();
  const coarse = useCoarsePointer();
  return (
    <fieldset className="group">
      <legend>{tr('Shortcuts')}</legend>
      <dl className="facts keys">
        {shortcutRows(keyboard, coarse).map(([what, how]) => (
          <div key={what}>
            <dt>{marked(what)}</dt>
            <dd>{how}</dd>
          </div>
        ))}
      </dl>
    </fieldset>
  );
}

function Design() {
  const scene = useEditor((s) => s.doc.scene);
  const selection = useEditor((s) => s.selection);
  const nodes = useMemo(() => scene.filter((n) => selection.includes(n.id)), [scene, selection]);
  const bin = useEditor((s) => s.bin);
  useSyncExternalStore(geometry.subscribe, geometry.getRevision);

  if (nodes.length === 0) return bin ? <PartsBin /> : <Overview />;
  if (nodes.length > 1) {
    const lockedCount = nodes.filter((n) => n.locked).length;
    const allLocked = lockedCount === nodes.length;
    return (
      <>
        <header className="params-head">
          <div className="grow">
            <h1>{plural(nodes.length, '{n} object', '{n} objects')}</h1>
          </div>
          <LockToggle
            locked={allLocked}
            title={allLocked ? tr('Locked: press to unlock all') : lockedCount ? tr('{locked} of {total} locked: press to lock all', { locked: lockedCount, total: nodes.length }) : tr('Lock all')}
            onClick={() => setSelectedLocked(!allLocked)}
          />
          <button
            type="button"
            className="icon-button"
            title={tr('Save as a custom part (group the objects first)')}
            aria-label={tr('Save as a part')}
            onClick={() => notify(tr('Group the objects first, then save the group as a part.'))}
          >
            <SaveAsPartIcon />
          </button>
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
        ? [{ title: tr('Text'), content: <TextFields node={node} /> }]
        : [];
  return (
    <>
      <header className="params-head">
        <div className="grow">
          <NameField node={node} />
        </div>
        <LockToggle locked={Boolean(node.locked)} title={node.locked ? tr('Unlock') : tr('Lock')} onClick={() => toggleLocked(node.id)} />
        <button type="button" className="icon-button" title={tr('Save as a custom part, to place in any design')} aria-label={tr('Save as a part')} onClick={() => void saveAsPart(node.id)}>
          <SaveAsPartIcon />
        </button>
      </header>
      {node.type === 'picture' ? <PictureFields node={node} /> : <Appearance nodes={nodes} />}
      {node.type === 'part' ? <PartFields node={node} /> : <Sections legend={tr('Settings')} reset={node.id} sections={own} />}
    </>
  );
}

/** The lock in the panel header: the same switch as the one on the object's row in the Objects list. */
function LockToggle({ locked, title, onClick }: { locked: boolean; title: string; onClick: () => void }) {
  return (
    <button type="button" className={locked ? 'icon-button lock on' : 'icon-button'} title={title} aria-label={locked ? tr('Unlock') : tr('Lock')} aria-pressed={locked} onClick={onClick}>
      {locked ? <LockIcon /> : <UnlockIcon />}
    </button>
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
  const unit = useEditor((s) => s.prefs.units);
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
          <span>{inUnit(w, unit)}</span>
          <button type="button" className="legend-button" title={tr('Dismiss')} aria-label={tr('Dismiss')} onClick={() => setDismissed((d) => [...d, `${node!.id}:${w}`])}>
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Inspector() {
  const robot = useEditor((s) => s.robot);
  return (
    <aside className="inspector">
      <div className="params">{robot ? <RobotInspector /> : <Design />}</div>
      {!robot && <Warnings />}
    </aside>
  );
}
