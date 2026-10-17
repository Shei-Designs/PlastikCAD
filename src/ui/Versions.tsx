import { useMemo, useState } from 'react';
import { describeDiff, diffScenes } from '../model/ops';
import type { Version } from '../model/types';
import { deleteVersion, renameVersion, restoreVersion, saveVersion, useEditor, viewVersion } from '../state/store';
import { PencilIcon, RestoreIcon, TrashIcon } from './icons';

function timeAgo(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const date = new Date(then);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (new Date(now).toDateString() === date.toDateString()) return `today ${time}`;
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short', year: date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' })} ${time}`;
}

function Row({ version, parent, previous, current, viewing }: { version: Version; parent: Version | null; previous: Version | null; current: boolean; viewing: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(version.label);
  const change = useMemo(() => describeDiff(diffScenes(parent?.scene ?? [], version.scene)), [parent, version]);
  const now = Date.now();

  return (
    <li className={['version', viewing ? 'viewing' : '', current ? 'current' : ''].join(' ')}>
      <button type="button" className="version-main" title="Look at this version" onClick={() => viewVersion(viewing ? null : version.id)}>
        <span className="version-thumb">{version.thumb ? <img src={version.thumb} alt="" draggable={false} /> : null}</span>
        <span className="version-text">
          {editing ? (
            <input
              autoFocus
              className="name-input small"
              aria-label="Version name"
              value={text}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                renameVersion(version.id, text);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  setText(version.label);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span className="version-label">{version.label}</span>
          )}
          <span className="version-meta">
            {timeAgo(version.time, now)}
            {current ? ' · current' : ''}
          </span>
          <span className="version-meta">
            {change}
            {/* Only worth saying when history is not a straight line. */}
            {parent && parent !== previous ? ` · from “${parent.label}”` : ''}
          </span>
        </span>
      </button>
      <span className="version-actions">
        <button type="button" className="mini" title="Rename" aria-label="Rename" onClick={() => setEditing(true)}>
          <PencilIcon />
        </button>
        <button type="button" className="mini" title="Restore this version" aria-label="Restore" onClick={() => restoreVersion(version.id)}>
          <RestoreIcon />
        </button>
        <button type="button" className="mini" title="Delete this version" aria-label="Delete version" onClick={() => deleteVersion(version.id)}>
          <TrashIcon />
        </button>
      </span>
    </li>
  );
}

export function Versions() {
  const doc = useEditor((s) => s.doc);
  const viewing = useEditor((s) => s.viewing);
  const [label, setLabel] = useState('');
  const head = doc.versions.find((v) => v.id === doc.head) ?? null;
  const pending = useMemo(() => diffScenes(head?.scene ?? [], doc.scene), [head, doc.scene]);
  const changed = pending.added + pending.changed + pending.removed > 0;
  const byId = useMemo(() => new Map(doc.versions.map((v) => [v.id, v])), [doc.versions]);

  const save = () => {
    saveVersion(label);
    setLabel('');
  };

  return (
    <>
      <header className="params-head">
        <div>
          <h1>Versions</h1>
          <p>Saves a snapshot of the design to view or restore later.</p>
        </div>
      </header>
      <div className="commit">
        <input
          className="text-input"
          placeholder={changed ? 'What changed? (optional)' : 'Name this version (optional)'}
          aria-label="Version name"
          value={label}
          disabled={Boolean(viewing)}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && changed) save();
          }}
        />
        <button type="button" className="primary" disabled={!changed || Boolean(viewing)} onClick={save}>
          Save version
        </button>
        <p className="field-note">
          {doc.scene.length === 0 && !head
            ? 'Nothing to save yet.'
            : changed
              ? `${describeDiff(pending)} since ${head ? `“${head.label}”` : 'the start'}.`
              : `No changes since “${head?.label}”.`}
        </p>
      </div>
      {doc.versions.length > 0 && (
        <ul className="versions">
          {[...doc.versions].reverse().map((v, i, list) => (
            <Row
              key={v.id}
              version={v}
              parent={v.parent ? (byId.get(v.parent) ?? null) : null}
              previous={list[i + 1] ?? null}
              current={v.id === doc.head && !changed}
              viewing={v.id === viewing}
            />
          ))}
        </ul>
      )}
    </>
  );
}
