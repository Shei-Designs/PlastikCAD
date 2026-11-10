// The projects browser: every project in the store, newest first, to open,
// rename, duplicate or delete; the trash deleted ones go to and the earlier
// saves kept of each; plus where they are kept.
import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_NAME } from '../appInfo';
import { isDesktop } from '../platform';
import type { ProjectInfo, VersionInfo } from '../state/projects';
import {
  chooseProjectsFolder,
  closeProjects,
  deleteProject,
  dismissSyncNotes,
  duplicateProject,
  emptyTrash,
  keepsTrash,
  keepsVersions,
  linkGoogleDrive,
  listProjects,
  listTrash,
  listVersions,
  newProject,
  openProject,
  openProjectFile,
  openVersion,
  renameProjectAt,
  restoreProject,
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

/** What the browser is showing: the projects, the trash, or the earlier saves of one project. */
type View = { kind: 'projects' } | { kind: 'trash' } | { kind: 'versions'; item: ProjectInfo };

function Card({ item, current, refresh, onVersions, onRenameEscape }: { item: ProjectInfo; current: boolean; refresh: () => void; onVersions: (() => void) | null; onRenameEscape: () => void }) {
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
            onEscape={onRenameEscape}
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
              {onVersions && <MenuItem label="Versions…" run={onVersions} close={close} />}
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

/** A project in the trash: put back, or deleted for good. */
function TrashCard({ item, refresh }: { item: ProjectInfo; refresh: () => void }) {
  return (
    <li className="project">
      <span className="project-open">
        <span className="project-thumb">{item.thumb ? <img src={item.thumb} alt="" /> : <Logo />}</span>
      </span>
      <div className="project-row">
        <span className="project-name clip" title={item.name}>
          {item.name}
        </span>
        <Popover className="icon-button" title="Actions" button={<MoreIcon />} align="right" fixed>
          {(close) => (
            <div className="menu" role="menu">
              <MenuItem label="Put back" run={() => void restoreProject(item.key).then(refresh)} close={close} />
              <hr />
              <MenuItem label="Delete for good…" danger run={() => void emptyTrash(item.key, item.name).then(refresh)} close={close} />
            </div>
          )}
        </Popover>
      </div>
      <span className="project-when">{when(item.modified)}</span>
    </li>
  );
}

/** The earlier saves kept of a project, newest first; each opens as a project of its own. */
function Versions({ item }: { item: ProjectInfo }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    void listVersions(item.id).then((list) => live && setVersions(list));
    return () => {
      live = false;
    };
  }, [item.id]);
  if (versions === null) return <p className="empty">Loading…</p>;
  if (versions.length === 0) return <p className="empty">No earlier saves of this project yet. One is kept every ten minutes of work, and before a sync replaces the project.</p>;
  return (
    <ul className="versions">
      {versions.map((version) => (
        <li key={version.key} className="version">
          <span className="version-when">{new Date(version.saved).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          <span className="version-ago">{when(version.saved)}</span>
          <button type="button" className="chip" title="Opens this save as a project of its own." onClick={() => void openVersion(version, item.name)}>
            Open as a copy
          </button>
        </li>
      ))}
    </ul>
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
  const notes = useEditor((s) => s.syncNotes);
  const [items, setItems] = useState<ProjectInfo[] | null>(null);
  const [trash, setTrash] = useState<ProjectInfo[]>([]);
  const [view, setView] = useState<View>({ kind: 'projects' });
  const [query, setQuery] = useState('');

  const refresh = useCallback(() => {
    void listProjects().then(setItems);
    if (keepsTrash()) void listTrash().then(setTrash);
  }, []);
  useEffect(() => {
    if (!open) return;
    setItems(null);
    setQuery('');
    setView({ kind: 'projects' });
    refresh();
  }, [open, refresh]);
  // A sync pass may have brought projects in or taken them away.
  const synced = useSyncStatus().lastSync;
  useEffect(() => {
    if (open) refresh();
  }, [synced, open, refresh]);

  // From the trash or a project's versions, Escape goes back to the projects first. One press reaches here twice on
  // some engines, as the key and as the dialog's own cancel that follows it at once: the cancel of a key that was
  // dealt with is let go. A key is never let go, so a second press works however soon it comes; and a cancel can come
  // with no key at all (the back gesture on Android), so the mark does not outlast the press.
  const keyed = useRef(false);
  const escapeKeyed = (): void => {
    keyed.current = true;
    setTimeout(() => (keyed.current = false), 0);
  };
  const goBack = (): void => {
    if (view.kind === 'projects') closeProjects();
    else setView({ kind: 'projects' });
  };
  const cancelled = (): void => {
    if (keyed.current) keyed.current = false;
    else goBack();
  };

  const needle = query.trim().toLowerCase();
  const listed = view.kind === 'trash' ? trash : items;
  const shown = listed?.filter((i) => !needle || i.name.toLowerCase().includes(needle)) ?? [];
  const back = (
    <button type="button" className="chip" title="Goes back to the projects." onClick={() => setView({ kind: 'projects' })}>
      Projects
    </button>
  );

  return (
    <Modal
      open={open}
      onClose={closeProjects}
      onEscape={cancelled}
      className="projects"
      label="Projects"
      onKeyDown={(e) => {
        // The search box swallows Escape (it clears itself) before the dialog's cancel event can fire.
        if (e.key === 'Escape') {
          e.preventDefault();
          escapeKeyed();
          goBack();
        } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
          // The window's own shortcuts are kept out while the browser is open; this one is on its button.
          e.preventDefault();
          void newProject();
        }
      }}
    >
      <div className="projects-body">
        <header className="projects-head">
          <h2 className="clip">{view.kind === 'trash' ? 'Trash' : view.kind === 'versions' ? `Versions of ${view.item.name}` : 'Projects'}</h2>
          {view.kind !== 'versions' && <input className="text-input projects-search" type="search" placeholder="Search" aria-label={view.kind === 'trash' ? 'Search the trash' : 'Search projects'} value={query} onChange={(e) => setQuery(e.target.value)} />}
          {view.kind === 'versions' && <span className="projects-gap" />}
          {view.kind === 'projects' ? (
            <>
              <button type="button" className="primary" title={`New project (${MOD}N)`} onClick={() => void newProject()}>
                New project
              </button>
              <button type="button" className="chip" title="Brings a design file from anywhere in as a project." onClick={() => void openProjectFile()}>
                Open project file…
              </button>
              {keepsTrash() && (
                <button type="button" className="chip" title="Shows the deleted projects." onClick={() => setView({ kind: 'trash' })}>
                  Trash{trash.length ? ` (${trash.length})` : ''}
                </button>
              )}
            </>
          ) : (
            <>
              {view.kind === 'trash' && trash.length > 0 && (
                <button type="button" className="chip danger" title="Deletes everything in the trash for good." onClick={() => void emptyTrash().then(refresh)}>
                  Empty Trash…
                </button>
              )}
              {back}
            </>
          )}
          <button type="button" className="icon-button" title="Close (Esc)" aria-label="Close" onClick={closeProjects}>
            <CloseIcon />
          </button>
        </header>
        {notes.length > 0 && view.kind === 'projects' && (
          <div className="sync-notes" role="status">
            <ul>
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <button type="button" className="chip" title="Clears these messages." onClick={dismissSyncNotes}>
              Dismiss
            </button>
          </div>
        )}
        {view.kind === 'versions' ? (
          <Versions item={view.item} />
        ) : listed === null ? (
          <p className="empty">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="empty">
            {listed.length ? 'No project has that name.' : view.kind === 'trash' ? 'The trash is empty. Deleted projects wait here, to be put back or deleted for good.' : `No projects yet. Place a shape and ${APP_NAME} saves your design as a project while you work.`}
          </p>
        ) : view.kind === 'trash' ? (
          <ul className="projects-grid">
            {shown.map((item) => (
              <TrashCard key={item.key} item={item} refresh={refresh} />
            ))}
          </ul>
        ) : (
          <ul className="projects-grid">
            {shown.map((item) => (
              <Card key={item.key} item={item} current={item.key === currentKey} refresh={refresh} onVersions={keepsVersions() && item.id ? () => setView({ kind: 'versions', item }) : null} onRenameEscape={escapeKeyed} />
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
