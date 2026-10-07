// How a grouped object was put together, drawn as a tree: the primitives on
// the left, each grouping a node further right, the object itself at the end.
// Branches that merge are groupings; hover a node to see it on the plate,
// pick one to edit the object at that layer.
import { useMemo, useState } from 'react';
import { shapeDef } from '../geometry/shapes';
import { getGenerator } from '../parts/generators';
import { HOLE_COLOR } from '../model/ops';
import type { GroupNode, SceneNode } from '../model/types';
import { cancelEditing, editInside, finishEditing, setHighlight, useEditor } from '../state/store';

interface Placed {
  node: SceneNode;
  path: string[];
  /** Groupings between this node and the primitives below it (0 for a primitive). */
  level: number;
  /** Row, in units of leaf rows; groups sit midway between their children. */
  row: number;
  children: Placed[];
}

const ROW = 24;
const LABEL = 118;
const PAD = 10;
const DOT = 4.5;

/** Lays the tree out: leaves get consecutive rows, groups sit in the middle of their children. */
function place(node: SceneNode, path: string[], rows: { next: number }): Placed {
  if (node.type !== 'group') return { node, path, level: 0, row: rows.next++, children: [] };
  const children = node.children.map((c) => place(c, [...path, c.id], rows));
  const level = 1 + Math.max(...children.map((c) => c.level));
  const row = children.reduce((sum, c) => sum + c.row, 0) / children.length;
  return { node, path, level, row, children };
}

const flatten = (p: Placed, out: Placed[] = []): Placed[] => {
  out.push(p);
  for (const c of p.children) flatten(c, out);
  return out;
};

const kindOf = (node: SceneNode): string =>
  node.type === 'group'
    ? `Group of ${node.children.length}`
    : node.type === 'import'
      ? 'Imported'
      : node.type === 'text'
        ? 'Text'
        : node.type === 'part'
          ? getGenerator(node.part).name
          : shapeDef(node.shape).name;

export function Structure({ root }: { root: GroupNode }) {
  const [picked, setPicked] = useState<string[] | null>(null);
  const tree = useMemo(() => place(root, [root.id], { next: 0 }), [root]);
  const nodes = useMemo(() => flatten(tree), [tree]);
  const leaves = nodes.filter((n) => n.level === 0).length;
  const levels = tree.level;
  // Fits the panel: the levels share whatever width is left of the labels.
  const width = 284;
  const step = Math.min(64, (width - LABEL - 2 * PAD) / Math.max(levels, 1));
  const x = (p: Placed) => LABEL + PAD + p.level * step;
  const y = (p: Placed) => PAD + p.row * ROW + ROW / 2;
  const height = leaves * ROW + 2 * PAD;
  const chosen = picked ? nodes.find((n) => n.path.join('/') === picked.join('/')) : null;

  return (
    <fieldset className="group structure">
      <legend>Structure</legend>
      <p className="field-note">
        {leaves} part{leaves === 1 ? '' : 's'}, {levels} grouping{levels === 1 ? '' : 's'}. Hover to find a part; pick one, then edit the object at that layer.
      </p>
      <svg className="tree" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="tree" aria-label="How the object was put together">
        {nodes.map((p) =>
          p.children.map((c) => {
            // An elbow from the child to its grouping.
            const d = `M${x(c) + DOT} ${y(c)} H${x(p) - step / 2} V${y(p)} H${x(p) - DOT}`;
            return <path key={`${c.path.join('/')}>`} d={d} className="tree-edge" />;
          }),
        )}
        {nodes.map((p) => {
          const key = p.path.join('/');
          const on = picked?.join('/') === key;
          const leaf = p.level === 0;
          return (
            <g
              key={key}
              className={['tree-node', on ? 'on' : '', p.node.hole ? 'hole' : ''].join(' ')}
              tabIndex={0}
              role="treeitem"
              aria-selected={on}
              aria-label={`${p.node.name}, ${kindOf(p.node)}`}
              onMouseEnter={() => setHighlight(p.path)}
              onMouseLeave={() => setHighlight(null)}
              onFocus={() => setHighlight(p.path)}
              onBlur={() => setHighlight(null)}
              onClick={() => setPicked(on ? null : p.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setPicked(on ? null : p.path);
                }
              }}
            >
              <circle cx={x(p)} cy={y(p)} r={DOT} style={{ fill: p.node.hole ? HOLE_COLOR : p.node.color }} />
              {leaf ? (
                <text x={x(p) - DOT - 6} y={y(p)} textAnchor="end" dominantBaseline="central">
                  {p.node.name}
                </text>
              ) : (
                <text x={x(p)} y={y(p) - DOT - 4} textAnchor="middle" className="tree-group">
                  {p.node.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {chosen && chosen.path.length > 1 && (
        <div className="structure-actions">
          <span className="clip">
            <strong>{chosen.node.name}</strong> · {kindOf(chosen.node)}
          </span>
          <button type="button" className="chip" onClick={() => editInside(chosen.path)}>
            Edit here
          </button>
        </div>
      )}
      {chosen && chosen.path.length === 1 && <p className="field-note">That is the whole object. Pick a part or a grouping inside it.</p>}
    </fieldset>
  );
}

/** While editing inside a group: what was taken apart, and the way back. */
export function EditingNote() {
  const editing = useEditor((s) => s.editing);
  const busy = useEditor((s) => s.busy);
  if (!editing) return null;
  return (
    <fieldset className="group structure">
      <legend>Editing inside</legend>
      <ol className="layers">
        {editing.layers.map((l) => (
          <li key={l.id}>{l.name}</li>
        ))}
      </ol>
      <p className="field-note">These groupings were taken apart so the part could be changed. Done puts them back together in the same order; Cancel undoes everything since.</p>
      <div className="structure-actions">
        <button type="button" className="chip on" disabled={Boolean(busy)} onClick={() => void finishEditing()}>
          Done
        </button>
        <button type="button" className="chip" disabled={Boolean(busy)} onClick={cancelEditing}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}
