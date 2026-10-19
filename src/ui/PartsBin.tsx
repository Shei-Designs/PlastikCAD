// The custom parts bin, in the inspector while nothing is selected: the
// objects the user saved from designs, searched and sorted, each pictured. A
// part picked here is carried to the plate like a shape from the library.
import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ProjectInfo } from '../state/projects';
import { addCustomPart, closePartsBin, deletePart, listParts, pickPart, renamePartAt, useEditor } from '../state/store';
import { selectOnFocus } from './Fields';
import { CloseIcon, MoreIcon, PartsBinIcon } from './icons';
import { Popover } from './Popover';

type Sort = 'recent' | 'name';

function Card({ item, on, onPick }: { item: ProjectInfo; on: boolean; onPick: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const commit = (value: string) => {
    setRenaming(false);
    if (value.trim() && value.trim() !== item.name) void renamePartAt(item.key, value);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
    if (e.key === 'Escape') {
      e.currentTarget.value = item.name;
      e.currentTarget.blur();
    }
  };
  const action = (label: string, run: () => void, close: () => void, danger = false) => (
    <button
      type="button"
      className={danger ? 'menu-item danger' : 'menu-item'}
      onClick={() => {
        close();
        run();
      }}
    >
      <span>{label}</span>
    </button>
  );
  return (
    <li className={on ? 'bin-card on' : 'bin-card'}>
      <button
        type="button"
        className="bin-pick"
        title={`${item.name}: pick, then click on the plate to place it. Double-click to add it at the middle.`}
        aria-pressed={on}
        onClick={(e) => {
          // Keyboard activation has no plate to click on next.
          if (e.detail === 0) void addCustomPart(item.key);
          else onPick();
        }}
        onDoubleClick={() => void addCustomPart(item.key)}
      >
        <span className="bin-thumb">{item.thumb ? <img src={item.thumb} alt="" /> : <PartsBinIcon />}</span>
      </button>
      <div className="bin-row">
        {renaming ? (
          <input className="text-input" aria-label="Part name" defaultValue={item.name} autoFocus onFocus={selectOnFocus} onBlur={(e) => commit(e.currentTarget.value)} onKeyDown={onKey} />
        ) : (
          <span className="bin-name clip" title={item.name}>
            {item.name}
          </span>
        )}
        <Popover className="icon-button" title="Actions" button={<MoreIcon />} align="right" fixed>
          {(close) => (
            <div className="menu" role="menu">
              {action('Add to the design', () => void addCustomPart(item.key), close)}
              {action('Rename', () => setRenaming(true), close)}
              <hr />
              {action('Delete…', () => void deletePart(item.key, item.name), close, true)}
            </div>
          )}
        </Popover>
      </div>
    </li>
  );
}

export function PartsBin() {
  const epoch = useEditor((s) => s.partsEpoch);
  const placing = useEditor((s) => s.placing);
  const [items, setItems] = useState<ProjectInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void listParts().then((list) => {
      if (live) setItems(list);
    });
    return () => {
      live = false;
    };
  }, [epoch]);
  // The pick shows until the part is put down or let go of.
  useEffect(() => {
    if (!placing) setPicked(null);
  }, [placing]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = (items ?? []).filter((i) => !needle || i.name.toLowerCase().includes(needle));
    return list.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) || b.modified - a.modified : b.modified - a.modified || a.name.localeCompare(b.name)));
  }, [items, query, sort]);

  return (
    <section className="parts-bin" aria-label="Custom parts">
      <header className="bin-head">
        <div className="grow">
          <h1>Custom parts</h1>
          <p>Pick a part, then click on the plate to place it.</p>
        </div>
        <button type="button" className="icon-button" title="Close" aria-label="Close" onClick={closePartsBin}>
          <CloseIcon />
        </button>
      </header>
      <div className="bin-tools">
        <input className="text-input" type="search" placeholder="Search" aria-label="Search parts" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="bin-sort" role="radiogroup" aria-label="Sort by">
          <button type="button" role="radio" aria-checked={sort === 'recent'} className={sort === 'recent' ? 'chip on' : 'chip'} title="Newest first" onClick={() => setSort('recent')}>
            Recent
          </button>
          <button type="button" role="radio" aria-checked={sort === 'name'} className={sort === 'name' ? 'chip on' : 'chip'} title="By name" onClick={() => setSort('name')}>
            A–Z
          </button>
        </div>
      </div>
      {items === null ? (
        <p className="empty">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="empty">{items.length ? 'No part has that name.' : 'No custom parts yet. Select an object and press the save-as-part button beside its name to keep it here.'}</p>
      ) : (
        <ul className="bin-grid">
          {shown.map((item) => (
            <Card
              key={item.key}
              item={item}
              on={picked === item.key}
              onPick={() => {
                setPicked(item.key);
                void pickPart(item.key);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
