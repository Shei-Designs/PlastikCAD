// How a grouped object was put together, as an outline: the object at the
// top, what it was grouped from indented beneath it, grouping by grouping,
// down to the primitives. Hover a row to see that part on the plate; pick one
// to edit the object at that layer.
import { useState } from 'react';
import { shapeDef } from '../geometry/shapes';
import { getGenerator } from '../parts/generators';
import { HOLE_COLOR } from '../model/ops';
import type { GroupNode, SceneNode } from '../model/types';
import { editInside, setHighlight } from '../state/store';

const kindOf = (node: SceneNode): string =>
  node.type === 'group'
    ? `Group of ${node.children.length}`
    : node.type === 'import'
      ? 'Imported'
      : node.type === 'text'
        ? 'Text'
        : node.type === 'part'
          ? getGenerator(node.part).name
          : node.type === 'picture'
            ? 'Picture'
            : shapeDef(node.shape).name;

const countLeaves = (node: SceneNode): number => (node.type === 'group' ? node.children.reduce((n, c) => n + countLeaves(c), 0) : 1);
const depthOf = (node: SceneNode): number => (node.type === 'group' ? 1 + Math.max(...node.children.map(depthOf)) : 0);

export function Structure({ root }: { root: GroupNode }) {
  const [picked, setPicked] = useState<string[] | null>(null);
  const leaves = countLeaves(root);
  const levels = depthOf(root);
  const chosenNode = (() => {
    if (!picked) return null;
    let node: SceneNode | undefined = root;
    for (const id of picked.slice(1)) node = node?.type === 'group' ? node.children.find((c) => c.id === id) : undefined;
    return node ?? null;
  })();

  const row = (node: SceneNode, path: string[]) => {
    const key = path.join('/');
    const on = picked?.join('/') === key;
    return (
      <li key={key} role="none">
        <div
          className={['outline-row', on ? 'on' : '', node.hole ? 'hole' : ''].join(' ')}
          tabIndex={0}
          role="treeitem"
          aria-selected={on}
          aria-label={`${node.name}, ${kindOf(node)}`}
          onMouseEnter={() => setHighlight(path)}
          onMouseLeave={() => setHighlight(null)}
          onFocus={() => setHighlight(path)}
          onBlur={() => setHighlight(null)}
          onClick={() => setPicked(on ? null : path)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setPicked(on ? null : path);
            }
          }}
        >
          <span className={node.hole ? 'dot hole' : 'dot'} style={{ background: node.hole ? undefined : node.color, borderColor: node.hole ? HOLE_COLOR : undefined }} />
          <span className="clip">{node.name}</span>
          <span className="outline-kind">{kindOf(node)}</span>
        </div>
        {node.type === 'group' && (
          <ul role="group" className="outline-branch">
            {node.children.map((c) => row(c, [...path, c.id]))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <fieldset className="group structure">
      <legend title="Hover to highlight a part; click to edit it.">
        Structure tree
        <span className="count">
          {leaves} part{leaves === 1 ? '' : 's'}, {levels} level{levels === 1 ? '' : 's'}
        </span>
      </legend>
      <ul className="outline" role="tree" aria-label="Structure tree">
        {row(root, [root.id])}
      </ul>
      {chosenNode && picked && picked.length > 1 && (
        <div className="structure-actions">
          <span className="clip">
            <strong>{chosenNode.name}</strong> · {kindOf(chosenNode)}
          </span>
          <button type="button" className="chip" onClick={() => editInside(picked)}>
            Edit here
          </button>
        </div>
      )}
      {chosenNode && picked && picked.length === 1 && <p className="field-note">Select a part or group inside the object.</p>}
    </fieldset>
  );
}
