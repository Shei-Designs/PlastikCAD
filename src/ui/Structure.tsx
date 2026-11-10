// The Structure tab: how the selected object was put together, as an outline
// with the object at the top and what it was grouped from indented beneath,
// down to the primitives; a single shape is one row. Hover a row to see that
// part on the plate; pick one to edit the object at that layer, and to name it
// and read or write its notes in the box fixed at the bottom.
import { useEffect, useState } from 'react';
import { plural, tr } from '../i18n';
import { MAX_NOTE } from '../model/file';
import { HOLE_COLOR } from '../model/ops';
import type { SceneNode } from '../model/types';
import { editInside, setHighlight, setNameAt, setNote } from '../state/store';
import { CommitInput } from './Fields';
import { kindOf } from './nodeKind';
import { enterByTouch } from './TouchEntry';

const countLeaves = (node: SceneNode): number => (node.type === 'group' ? node.children.reduce((n, c) => n + countLeaves(c), 0) : 1);
const depthOf = (node: SceneNode): number => (node.type === 'group' ? 1 + Math.max(...node.children.map(depthOf)) : 0);

/** The name of the picked layer, taken when typing is done (Enter or leaving the box); Escape puts the old one back. */
function Name({ path, node }: { path: string[]; node: SceneNode }) {
  return (
    <label className="details-field">
      <span className="notes-head">{tr('Name')}</span>
      <CommitInput className="text-input" label={tr('Name')} sheet={tr('Name')} value={node.name} onCommit={(name) => setNameAt(path, name)} />
    </label>
  );
}

/** The notes of the picked layer, kept as they are typed (a sitting of typing is one undo step). */
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
    <label className="details-field" title={tr('Keeps notes with this part of the object.')}>
      <span className="notes-head">{tr('Notes')}</span>
      <textarea
        className="text-input area"
        aria-label={tr('Notes for {name}', { name: node.name })}
        placeholder={tr('Anything to remember about this part.')}
        maxLength={MAX_NOTE}
        value={text}
        // A finger writes the notes in the entry sheet at the top of the window, clear of the keypad.
        onPointerDown={(e) =>
          enterByTouch(e, {
            label: tr('Notes for {name}', { name: node.name }),
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
          aria-label={node.note ? tr('{name}, {kind}, with notes', { name: node.name, kind: kindOf(node) }) : `${node.name}, ${kindOf(node)}`}
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
          {node.note && <span className="note-mark" title={tr('Has notes')} />}
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
        <h2 title={tr('Shows how the object was put together.')}>
          {tr('Structure')}
          <span className="count">{root.type === 'group' ? tr('{parts}, {levels}', { parts: plural(leaves, '{n} part', '{n} parts'), levels: plural(levels, '{n} level', '{n} levels') }) : ''}</span>
        </h2>
        <ul className="outline" role="tree" aria-label={tr('Structure tree')}>
          {row(root, [root.id])}
        </ul>
        {path.length > 1 && (
          <div className="structure-actions">
            <span className="clip">
              <strong>{chosen.name}</strong>
            </span>
            <button type="button" className="chip" title={tr('Edits this part inside the object.')} onClick={() => editInside(path)}>
              {tr('Edit here')}
            </button>
          </div>
        )}
      </div>
      <div className="details">
        <Name path={path} node={chosen} />
        <Notes path={path} node={chosen} />
      </div>
    </div>
  );
}
