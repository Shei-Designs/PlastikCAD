// The projects browser: every project in the store, newest first, to open,
// rename, duplicate or delete; plus where they are kept.
import { useCallback, useEffect, useState } from 'react';
import { APP_NAME } from '../appInfo';
import { isDesktop } from '../platform';
import type { ProjectInfo } from '../state/projects';
import {
  chooseProjectsFolder,
  closeProjects,
  deleteProject,
  duplicateProject,
  linkGoogleDrive,
  listProjects,
  newProject,
  openProject,
  openProjectFile,
  renameProjectAt,
  unlinkGoogleDrive,
  useEditor,
} from '../state/store';
import { cancelLink, syncNow, useSyncStatus } from '../sync/sync';
import { RenameInput } from './Fields';
import { CloseIcon, Logo, MoreIcon } from './icons';
import { MOD } from './keys';
import { MenuItem } from './Menu';
import { when } from './when';
import { Modal } from './Modal';
import { Popover } from './Popover';

function Card({ item, current, refresh }: { item: ProjectInfo; current: boolean; refresh: () => void }) {
  const [renaming, setRenaming] = useState(false);
  return (
    <li className={current ? 'project current' : 'project'}>
      <button type="button" className="project-open" title={current ? 'Open now' : `Open ${item.name}`} onClick={() => void openProject(item.key)}>
        <span className="project-thumb">{item.thumb ? <img src={item.thumb} alt="" /> : <Logo />}</span>
      </button>
      <div className="project-row">
        {renaming ? (
          <RenameInput
            name={item.name}
            label="Project name"
            onDone={(value) => {
              setRenaming(false);
              if (value !== null) void renameProjectAt(item.key, value).then(refresh);
            }}
          />
        ) : (
          <button type="button" className="project-name clip" title={item.name} onClick={() => void openProject(item.key)}>
            {item.name}
          </button>
        )}
        <Popover className="icon-button" title="Actions" button={<MoreIcon />} align="right" fixed>
          {(close) => (
            <div className="menu" role="menu">
              <MenuItem label="Open" run={() => void openProject(item.key)} close={close} />
              <MenuItem label="Rename" run={() => setRenaming(true)} close={close} />
              <MenuItem label="Duplicate" run={() => void duplicateProject(item.key).then(refresh)} close={close} />
              <hr />
              <MenuItem label="Delete…" danger run={() => void deleteProject(item.key, item.name).then(refresh)} close={close} />
            </div>
          )}
        </Popover>
      </div>
      <span className="project-when">{current ? 'Open now' : when(item.modified)}</span>
    </li>
  );
}

/** The Google Drive line of the footer: link, or the account and when it last synced. */
function DriveRow() {
  const sync = useSyncStatus();
  if (!sync.configured) return <span className="clip">Google Drive sync is not set up in this build.</span>;
  if (!isDesktop()) return <span className="clip">Google Drive sync works in the desktop and Android apps.</span>;
  if (!sync.linked) {
    return (
      <>
        <span className="clip">Google Drive: not linked{sync.error ? ` · ${sync.error}` : ''}</span>
        <button type="button" className="chip" title={sync.busy ? 'Gives up the sign-in.' : 'Keeps your projects in step across devices through your Google Drive.'} onClick={() => (sync.busy ? cancelLink() : void linkGoogleDrive())}>
          {sync.busy ? 'Cancel sign-in' : 'Link Google Drive…'}
        </button>
      </>
    );
  }
  const state = sync.busy ? 'Syncing…' : sync.offline ? 'Offline' : sync.error ? sync.error : sync.lastSync ? `Synced ${when(sync.lastSync).toLowerCase()}` : 'Not synced yet';
  return (
    <>
      <span className={sync.error && !sync.busy ? 'clip sync-error' : 'clip'}>
        Google Drive: {sync.email ?? 'linked'} · {state}
      </span>
      <button type="button" className="chip" disabled={sync.busy} title="Syncs with Google Drive now." onClick={() => void syncNow()}>
        Sync now
      </button>
      <button type="button" className="chip" disabled={sync.busy} title="Stops syncing with Google Drive." onClick={() => void unlinkGoogleDrive()}>
        Unlink
      </button>
    </>
  );
}

export function Projects() {
  const open = useEditor((s) => s.browsing);
  const currentKey = useEditor((s) => s.projectKey);
  const storage = useEditor((s) => s.storage);
  const [items, setItems] = useState<ProjectInfo[] | null>(null);
  const [query, setQuery] = useState('');

  const refresh = useCallback(() => void listProjects().then(setItems), []);
  useEffect(() => {
    if (!open) return;
    setItems(null);
    setQuery('');
    refresh();
  }, [open, refresh]);
  // A sync pass may have brought projects in or taken them away.
  const synced = useSyncStatus().lastSync;
  useEffect(() => {
    if (open) refresh();
  }, [synced, open, refresh]);

  const needle = query.trim().toLowerCase();
  const shown = items?.filter((i) => !needle || i.name.toLowerCase().includes(needle)) ?? [];

  return (
    <Modal
      open={open}
      onClose={closeProjects}
      className="projects"
      label="Projects"
      onKeyDown={(e) => {
        // The search box swallows Escape (it clears itself) before the dialog's cancel event can fire.
        if (e.key === 'Escape') {
          e.preventDefault();
          closeProjects();
        } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
          // The window's own shortcuts are kept out while the browser is open; this one is on its button.
          e.preventDefault();
          void newProject();
        }
      }}
    >
      <div className="projects-body">
        <header className="projects-head">
          <h2>Projects</h2>
          <input className="text-input projects-search" type="search" placeholder="Search" aria-label="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="button" className="primary" title={`New project (${MOD}N)`} onClick={() => void newProject()}>
            New project
          </button>
          <button type="button" className="chip" title="Brings a design file from anywhere in as a project." onClick={() => void openProjectFile()}>
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
        <footer className="projects-foot">
          {storage?.location && (
            <div className="projects-foot-row">
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
            </div>
          )}
          <div className="projects-foot-row">
            <DriveRow />
          </div>
        </footer>
      </div>
    </Modal>
  );
}
