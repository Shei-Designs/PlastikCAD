// The Structure tab: how the selected object was put together, as an outline
// with the object at the top and what it was grouped from indented beneath,
// down to the primitives; a single shape is one row. Hover a row to see that
// part on the plate; pick one to edit the object at that layer, and to read or
// write its notes in the box fixed at the bottom.
import { useEffect, useState } from 'react';
import { shapeDef } from '../geometry/shapes';
import { getGenerator } from '../parts/generators';
import { MAX_NOTE } from '../model/file';
import { HOLE_COLOR } from '../model/ops';
import type { SceneNode } from '../model/types';
import { editInside, setHighlight, setNote } from '../state/store';
import { enterByTouch } from './TouchEntry';

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

/** The box at the bottom: the notes of the picked layer, kept as they are typed (a sitting of typing is one undo step). */
function Notes({ path, node }: { path: string[]; node: SceneNode }) {
  const note = node.note ?? '';
  const [text, setText] = useState(note);
  const key = path.join('/');
  // Another layer picked, or undo changing the note under the box: the box follows; its own typing comes back trimmed.
  useEffect(() => {
    setText(note);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (note !== text.trim()) setText(note);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);
  return (
    <label className="notes" title="Keeps reminders with this part of the object, saved in the design">
      <span className="notes-head">
        Notes
        <span className="notes-for clip">{node.name}</span>
      </span>
      <textarea
        className="text-input area"
        aria-label={`Notes for ${node.name}`}
        placeholder="Anything to remember about this part."
        maxLength={MAX_NOTE}
        value={text}
        // A finger writes the notes in the entry sheet at the top of the window, clear of the keypad.
        onPointerDown={(e) =>
          enterByTouch(e, {
            label: `Notes for ${node.name}`,
            value: text,
            inputMode: 'text',
            multiline: true,
            onCommit: (next) => {
              const clipped = next.slice(0, MAX_NOTE);
              setText(clipped);
              setNote(path, clipped);
            },
          })
        }
        onChange={(e) => {
          setText(e.target.value);
          setNote(path, e.target.value);
        }}
      />
    </label>
  );
}

export function Structure({ root }: { root: SceneNode }) {
  const [picked, setPicked] = useState<string[] | null>(null);
  // Another object: start again from its top.
  useEffect(() => setPicked(null), [root.id]);
  // A row still hovered when the tab goes away (the selection changes under the pointer, say) must not leave its ghost on the plate.
  useEffect(() => () => setHighlight(null), []);
  const leaves = countLeaves(root);
  const levels = depthOf(root);
  const path = picked ?? [root.id];
  const chosen = (() => {
    let node: SceneNode | undefined = root;
    for (const id of path.slice(1)) node = node?.type === 'group' ? node.children.find((c) => c.id === id) : undefined;
    return node ?? root;
  })();

  const row = (node: SceneNode, at: string[]) => {
    const key = at.join('/');
    const on = path.join('/') === key;
    return (
      <li key={key} role="none">
        <div
          className={['outline-row', on ? 'on' : '', node.hole ? 'hole' : ''].join(' ')}
          tabIndex={0}
          role="treeitem"
          aria-selected={on}
          aria-level={at.length}
          aria-expanded={node.type === 'group' ? true : undefined}
          aria-label={`${node.name}, ${kindOf(node)}${node.note ? ', with notes' : ''}`}
          onMouseEnter={() => setHighlight(at)}
          onMouseLeave={() => setHighlight(null)}
          onFocus={() => setHighlight(at)}
          onBlur={() => setHighlight(null)}
          onClick={() => setPicked(at)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setPicked(at);
            }
          }}
        >
          <span className={node.hole ? 'dot hole' : 'dot'} style={{ background: node.hole ? undefined : node.color, borderColor: node.hole ? HOLE_COLOR : undefined }} />
          <span className="clip">{node.name}</span>
          {node.note && <span className="note-mark" title="Has notes" />}
          <span className="outline-kind">{kindOf(node)}</span>
        </div>
        {node.type === 'group' && (
          <ul role="group" className="outline-branch">
            {node.children.map((c) => row(c, [...at, c.id]))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="structure-tab">
      <div className="structure-scroll">
        <h2 title="Hover a part to see it on the plate; pick one to edit it and to write its notes.">
          Structure
          <span className="count">{root.type === 'group' ? `${leaves} part${leaves === 1 ? '' : 's'}, ${levels} level${levels === 1 ? '' : 's'}` : ''}</span>
        </h2>
        <ul className="outline" role="tree" aria-label="Structure tree">
          {row(root, [root.id])}
        </ul>
        {path.length > 1 && (
          <div className="structure-actions">
            <span className="clip">
              <strong>{chosen.name}</strong>
            </span>
            <button type="button" className="chip" title="Edits this part inside the object" onClick={() => editInside(path)}>
              Edit here
            </button>
          </div>
        )}
      </div>
      <Notes path={path} node={chosen} />
    </div>
  );
}
