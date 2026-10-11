import { useMemo, useState, useSyncExternalStore } from 'react';
import { boundsSize, tidy, tidyAngle, unionBounds } from '../model/math';
import type { SceneNode, Vec3 } from '../model/types';
import { geometry } from '../state/geometry';
import { resizeNode, updateNode, useEditor } from '../state/store';
import { formatNumber, NumberBox } from './Fields';
import { LinkIcon } from './icons';

const AXES = ['X', 'Y', 'Z'] as const;
const SIZE_TAGS = ['W', 'D', 'H'] as const;

/**
 * The size, position and rotation of the selection, in the corner of the
 * viewport where the hand that is dragging grips already is. One object gets
 * all three rows; several get their overall size.
 */
export function TransformBox() {
  const scene = useEditor((s) => s.doc.scene);
  const selection = useEditor((s) => s.selection);
  const viewing = useEditor((s) => s.viewing);
  const placing = useEditor((s) => s.placing);
  const nodes = useMemo(() => scene.filter((n) => selection.includes(n.id)), [scene, selection]);
  useSyncExternalStore(geometry.subscribe, geometry.getRevision);
  if (viewing || placing || nodes.length === 0) return null;
  if (nodes.length > 1) {
    const size = boundsSize(unionBounds(nodes.map((n) => geometry.bounds(n))));
    return (
      <div className="transform-box" role="group" aria-label="Selection">
        <div className="transform-row">
          <span className="transform-label">{nodes.length} objects</span>
          <span className="transform-facts">{size.map((v) => formatNumber(v, 2)).join(' × ')} mm</span>
        </div>
      </div>
    );
  }
  return <Single node={nodes[0]} />;
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
    <div className="transform-box" role="group" aria-label="Size, position and rotation">
      <div className="transform-row">
        <span className="transform-label">
          Size
          <button type="button" className={linked ? 'legend-button on' : 'legend-button'} title="Keep proportions" aria-label="Keep proportions" aria-pressed={linked} onClick={() => setLinked(!linked)}>
            <LinkIcon />
          </button>
        </span>
        {SIZE_TAGS.map((tag, axis) => (
          <NumberBox key={tag} tag={tag} label={['Width (X)', 'Depth (Y)', 'Height (Z)'][axis]} value={node.size[axis]} min={0.01} max={100000} disabled={locked} onChange={(v) => resizeNode(node, axis as 0 | 1 | 2, v, linked)} />
        ))}
      </div>
      <div className="transform-row">
        <span className="transform-label">Position</span>
        {AXES.map((tag, axis) => (
          <NumberBox key={tag} tag={tag} label={axis === 2 ? 'Height above the plate' : `${tag} of the center`} value={axis === 2 ? low : node.pos[axis]} min={-100000} max={100000} disabled={locked} onChange={(v) => setPos(axis, v)} />
        ))}
      </div>
      <div className="transform-row">
        <span className="transform-label">Rotation</span>
        {AXES.map((tag, axis) => (
          <NumberBox key={tag} tag={tag} unit="°" label={`Rotation about ${tag}`} value={node.rot[axis]} step={15} min={-360} max={360} disabled={locked} onChange={(v) => setRot(axis, v)} />
        ))}
      </div>
    </div>
  );
}
