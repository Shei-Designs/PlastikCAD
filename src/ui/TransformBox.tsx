import { useMemo, useState, useSyncExternalStore } from 'react';
import { plural, tr, trx } from '../i18n';
import { boundsSize, tidy, tidyAngle, unionBounds } from '../model/math';
import type { SceneNode, Vec3 } from '../model/types';
import { geometry } from '../state/geometry';
import { partFigures } from '../parts/figures';
import { resizeNode, updateNode, useEditor } from '../state/store';
import { formatNumber, NumberBox } from './Fields';
import { ChevronIcon, LinkIcon } from './icons';

/** Whether the dimensions are unfolded; kept for the session, across selections. */
let dimsOpen = false;

const AXES = ['X', 'Y', 'Z'] as const;
const SIZE_TAGS = [trx('size', 'W'), trx('size', 'D'), trx('size', 'H')] as const;

/**
 * The size, position and rotation of the selection, in the corner of the
 * viewport where the hand that is dragging grips already is. One object gets
 * all three rows; several get their overall size.
 */
export function TransformBox() {
  const scene = useEditor((s) => s.doc.scene);
  const selection = useEditor((s) => s.selection);
  const placing = useEditor((s) => s.placing);
  const nodes = useMemo(() => scene.filter((n) => selection.includes(n.id)), [scene, selection]);
  useSyncExternalStore(geometry.subscribe, geometry.getRevision);
  if (placing || nodes.length === 0) return null;
  if (nodes.length > 1) {
    const size = boundsSize(unionBounds(nodes.map((n) => geometry.bounds(n))));
    return (
      <div className="transform-box" role="group" aria-label={tr('Selection')}>
        <div className="transform-row">
          <span className="transform-label">{plural(nodes.length, '{n} object', '{n} objects')}</span>
          <span className="transform-facts">{size.map((v) => formatNumber(v, 2)).join(' × ')} mm</span>
        </div>
      </div>
    );
  }
  return <Single node={nodes[0]} />;
}

/**
 * The figures a part works out about itself (pitch diameter and the like),
 * folded away above the size until asked for. Only parts have any.
 */
function Dimensions({ node }: { node: SceneNode }) {
  const [open, setOpen] = useState(dimsOpen);
  const info = node.type === 'part' ? partFigures(node).info : [];
  if (info.length === 0) return null;
  const toggle = () => {
    dimsOpen = !open;
    setOpen(!open);
  };
  return (
    <div className={open ? 'transform-dims open' : 'transform-dims'}>
      <button type="button" className="transform-dims-toggle" aria-expanded={open} onClick={toggle}>
        <ChevronIcon />
        {tr('Dimensions')}
      </button>
      {open && (
        <dl className="facts">
          {info.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function Single({ node }: { node: SceneNode }) {
  const [linked, setLinked] = useState(false);
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
    <div className="transform-box" role="group" aria-label={tr('Size, position and rotation')}>
      <Dimensions node={node} />
      <div className="transform-row">
        <span className="transform-label">
          {tr('Size')}
          <button type="button" className={linked ? 'legend-button on' : 'legend-button'} title={tr('Keep proportions')} aria-label={tr('Keep proportions')} aria-pressed={linked} onClick={() => setLinked(!linked)}>
            <LinkIcon />
          </button>
        </span>
        {SIZE_TAGS.map((tag, axis) => (
          <NumberBox key={tag} tag={tag} label={[tr('Width (X)'), tr('Depth (Y)'), tr('Height (Z)')][axis]} value={node.size[axis]} min={0.01} max={100000} disabled={locked} onChange={(v) => resizeNode(node, axis as 0 | 1 | 2, v, linked)} />
        ))}
      </div>
      <div className="transform-row">
        <span className="transform-label">{tr('Position')}</span>
        {AXES.map((tag, axis) => (
          <NumberBox key={tag} tag={tag} label={axis === 2 ? tr('Height above the plate') : tr('{axis} of the center', { axis: tag })} value={axis === 2 ? low : node.pos[axis]} min={-100000} max={100000} disabled={locked} onChange={(v) => setPos(axis, v)} />
        ))}
      </div>
      <div className="transform-row">
        <span className="transform-label">{tr('Rotation')}</span>
        {AXES.map((tag, axis) => (
          <NumberBox key={tag} tag={tag} unit="°" label={tr('Rotation about {axis}', { axis: tag })} value={node.rot[axis]} step={15} min={-360} max={360} disabled={locked} onChange={(v) => setRot(axis, v)} />
        ))}
      </div>
    </div>
  );
}
