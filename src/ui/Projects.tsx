// The projects browser: every project in the store, newest first, to open,
// rename, duplicate or delete; plus where they are kept.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { APP_NAME } from '../app';
import type { ProjectInfo } from '../state/projects';
import {
  chooseProjectsFolder,
  closeProjects,
  deleteProject,
  duplicateProject,
  listProjects,
  newProject,
  openProject,
  openProjectFile,
  renameProjectAt,
  useEditor,
} from '../state/store';
import { CloseIcon, Logo, MoreIcon } from './icons';
import { Popover } from './Popover';

const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/** "Just now", "12 min ago", or the date, for the card. */
export function when(modified: number, now = Date.now()): string {
  const minutes = Math.round((now - modified) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const date = new Date(modified);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return date.toLocaleDateString(undefined, { year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' });
}

function Card({ item, current, refresh }: { item: ProjectInfo; current: boolean; refresh: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const commit = (value: string) => {
    setRenaming(false);
    if (value.trim() && value.trim() !== item.name) void renameProjectAt(item.key, value).then(refresh);
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
    <li className={current ? 'project current' : 'project'}>
      <button type="button" className="project-open" title={current ? 'Open now' : `Open ${item.name}`} onClick={() => void openProject(item.key)}>
        <span className="project-thumb">{item.thumb ? <img src={item.thumb} alt="" /> : <Logo />}</span>
      </button>
      <div className="project-row">
        {renaming ? (
          <input className="text-input" aria-label="Project name" defaultValue={item.name} autoFocus onFocus={(e) => e.currentTarget.select()} onBlur={(e) => commit(e.currentTarget.value)} onKeyDown={onKey} />
        ) : (
          <button type="button" className="project-name clip" title={item.name} onClick={() => void openProject(item.key)}>
            {item.name}
          </button>
        )}
        <Popover className="icon-button" title="Actions" button={<MoreIcon />} align="right">
          {(close) => (
            <div className="menu" role="menu">
              {action('Open', () => void openProject(item.key), close)}
              {action('Rename', () => setRenaming(true), close)}
              {action('Duplicate', () => void duplicateProject(item.key).then(refresh), close)}
              <hr />
              {action('Delete…', () => void deleteProject(item.key, item.name).then(refresh), close, true)}
            </div>
          )}
        </Popover>
      </div>
      <span className="project-when">{current ? 'Open now' : when(item.modified)}</span>
    </li>
  );
}

export function Projects() {
  const open = useEditor((s) => s.browsing);
  const currentKey = useEditor((s) => s.projectKey);
  const storage = useEditor((s) => s.storage);
  const [items, setItems] = useState<ProjectInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(() => void listProjects().then(setItems), []);
  useEffect(() => {
    if (!open) return;
    setItems(null);
    setQuery('');
    refresh();
  }, [open, refresh]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const needle = query.trim().toLowerCase();
  const shown = items?.filter((i) => !needle || i.name.toLowerCase().includes(needle)) ?? [];

  return (
    <dialog
      ref={dialog}
      className="projects"
      aria-label="Projects"
      onCancel={(e) => {
        // Escape closes the browser and nothing else (it would otherwise also clear the selection).
        e.preventDefault();
        e.stopPropagation();
        closeProjects();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        // The search box swallows Escape (it clears itself) before the dialog's cancel event can fire.
        if (e.key === 'Escape') {
          e.preventDefault();
          closeProjects();
        }
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog itself, not on its contents.
        if (e.target === e.currentTarget) closeProjects();
      }}
    >
      <div className="projects-body">
        <header className="projects-head">
          <h2>Projects</h2>
          <input className="text-input projects-search" type="search" placeholder="Search" aria-label="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="button" className="primary" title={`New project (${MOD}N)`} onClick={() => void newProject()}>
            New project
          </button>
          <button type="button" className="chip" title="Brings a design file from anywhere in as a project" onClick={() => void openProjectFile()}>
            Open project file…
          </button>
          <button type="button" className="icon-button" title="Close (Esc)" aria-label="Close" onClick={closeProjects}>
            <CloseIcon />
          </button>
        </header>
        {items === null ? (
          <p className="empty">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="empty">{items.length ? 'No project has that name.' : `No projects yet. Place a shape and ${APP_NAME} saves your design as a project while you work.`}</p>
        ) : (
          <ul className="projects-grid">
            {shown.map((item) => (
              <Card key={item.key} item={item} current={item.key === currentKey} refresh={refresh} />
            ))}
          </ul>
        )}
        {storage?.location && (
          <footer className="projects-foot">
            <span className="clip" title={storage.location}>
              Saved in {storage.location}
            </span>
            {!storage.fixed && (
              <button type="button" className="chip" onClick={() => void chooseProjectsFolder()}>
                Change folder…
              </button>
            )}
            {!storage.fixed && storage.defaultDir && storage.location !== storage.defaultDir && (
              <button type="button" className="chip" onClick={() => void chooseProjectsFolder(storage.defaultDir)}>
                Use default
              </button>
            )}
          </footer>
        )}
      </div>
    </dialog>
  );
}
