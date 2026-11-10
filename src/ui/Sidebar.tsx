import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { APP_NAME } from '../appInfo';
import { SHAPES } from '../geometry/shapes';
import { HOLE_COLOR } from '../model/ops';
import {
  addPart,
  addPicture,
  addShape,
  addText,
  cancelPlacing,
  importModel,
  isDirty,
  newProject,
  openPartsBin,
  openProjectFile,
  openProjects,
  renameProject,
  saveCopy,
  select,
  setPrefs,
  startPlacing,
  startPlacingPart,
  startPlacingPicture,
  startPlacingText,
  toggleGhost,
  toggleHidden,
  toggleLocked,
  toggleRobotMode,
  toggleSelected,
  useEditor,
} from '../state/store';
import { About } from './About';
import { ExportPanel } from './ExportPanel';
import { EyeIcon, EyeOffIcon, GhostIcon, ImportIcon, LockIcon, Logo, MenuIcon, MoonIcon, ProjectsIcon, RobotIcon, SunIcon, UnlockIcon } from './icons';
import { LONG_PRESS_MS } from '../viewer/gesture';
import { RobotExport, RobotModeBar, RobotPanel } from './RobotPanel';
import { CommitInput } from './Fields';
import { useSyncStatus } from '../sync/sync';
import { shortcut, tip } from './keymap';
import { MenuItem } from './Menu';
import { kindOf } from './nodeKind';
import { Popover } from './Popover';
import { CATEGORIES, GENERATORS, getGenerator } from '../parts/generators';
import { partThumbnail } from './partThumbnails';
import { Structure } from './Structure';
import { PART_THUMBNAILS, partsBinThumbnail, pictureThumbnail, shapeThumbnail, textThumbnail } from './thumbnails';

/**
 * A finger's press is captured by the tile it lands on, and the plate would hear nothing of the drag
 * that follows: the tile lets the press go, so that a shape can be carried straight onto the plate.
 */
const letGo = (e: ReactPointerEvent<HTMLElement>): void => {
  // The capture is on whatever part of the tile the finger landed on: its picture, as a rule.
  const pressed = e.target as Element;
  if (pressed.hasPointerCapture(e.pointerId)) pressed.releasePointerCapture(e.pointerId);
};

function FileBar() {
  const name = useEditor((s) => s.doc.name);
  const dirty = useEditor(isDirty);
  const saving = useEditor((s) => s.saving);
  const [about, setAbout] = useState(false);
  const robot = useEditor((s) => s.robot);
  const status = saving ? 'Saving…' : dirty ? 'Changes not saved yet' : 'All changes saved';
  // Sync's word shows on the way into the projects browser, where it is spelled out: a conflict or a deletion kept
  // to be read, or sync itself in trouble.
  const notes = useEditor((s) => s.syncNotes.length);
  const sync = useSyncStatus();
  const trouble = Boolean(sync.error) && !sync.busy;
  const news = notes > 0 || trouble;

  return (
    <div className="file-bar">
      <span className={dirty || saving ? 'dirty-dot on' : 'dirty-dot'} title={status} role="status" aria-label={status} />
      <CommitInput className="doc-name" label="Project name" title="Project name" value={name} onCommit={renameProject} />
      <button type="button" className="icon-button" title={tip('projects')} aria-label={news ? 'Projects: sync has something to say' : 'Projects'} onClick={openProjects}>
        <ProjectsIcon />
        {news && <span className={trouble ? 'news-dot trouble' : 'news-dot'} />}
      </button>
      <button type="button" className={robot ? 'icon-button on' : 'icon-button'} title="Robot mode" aria-label="Robot mode" aria-pressed={robot} onClick={toggleRobotMode}>
        <RobotIcon />
      </button>
      <Popover className="icon-button" title="File" button={<MenuIcon />} align="right">
        {(close) => (
          <div className="menu" role="menu">
            <MenuItem label="New project" keys={shortcut('newProject')} run={() => void newProject()} close={close} />
            <MenuItem label="Projects…" keys={shortcut('projects')} run={openProjects} close={close} />
            <MenuItem label="Open project file…" keys={shortcut('openFile')} run={() => void openProjectFile()} close={close} />
            <MenuItem label="Save a copy…" keys={shortcut('saveCopy')} run={() => void saveCopy()} close={close} />
            <hr />
            <MenuItem label={`About ${APP_NAME}…`} run={() => setAbout(true)} close={close} />
          </div>
        )}
      </Popover>
      <About open={about} onClose={() => setAbout(false)} />
    </div>
  );
}

/** Short tile names for the part families. */
const FAMILY_NAMES: Record<string, string> = { gears: 'Gear', pulleys: 'Pulley', screws: 'Screw', frames: 'Rail', ducts: 'Pipe', boards: 'Board', fans: 'Fan', cutouts: 'Cutout', motors: 'Motor' };

function Shapes() {
  const placing = useEditor((s) => s.placing);
  const bin = useEditor((s) => s.bin);
  const active = placing?.type === 'shape' ? placing.shape : null;
  const placingFamily = placing?.type === 'part' ? getGenerator(placing.part).category : null;
  return (
    <section>
      <h2>Shapes</h2>
      <ul className="shape-grid">
        {SHAPES.map((def) => (
          <li key={def.kind}>
            <button
              type="button"
              className={def.kind === active ? 'shape selected' : 'shape'}
              title={def.summary}
              // Pressing starts carrying the shape, so it can also be dragged straight onto the plate.
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                letGo(e);
                startPlacing(def.kind);
              }}
              onDoubleClick={() => addShape(def.kind)}
              // Keyboard activation has no pointer to follow.
              onClick={(e) => {
                if (e.detail === 0) addShape(def.kind);
              }}
            >
              <span className="thumb">{shapeThumbnail(def.kind)}</span>
              <span className="shape-name">{def.name}</span>
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className={placing?.type === 'text' ? 'shape selected' : 'shape'}
            title="Places lettering to emboss, or engrave as a hole."
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              letGo(e);
              void startPlacingText();
            }}
            onDoubleClick={() => void addText()}
            onClick={(e) => {
              if (e.detail === 0) void addText();
            }}
          >
            <span className="thumb">{textThumbnail}</span>
            <span className="shape-name">Text</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className={placing?.type === 'picture' ? 'shape selected' : 'shape'}
            title="Places a picture that prints onto the object it is grouped with."
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              letGo(e);
              void startPlacingPicture();
            }}
            onDoubleClick={() => void addPicture()}
            onClick={(e) => {
              if (e.detail === 0) void addPicture();
            }}
          >
            <span className="thumb">{pictureThumbnail}</span>
            <span className="shape-name">Picture</span>
          </button>
        </li>
      </ul>
      <h2>Parts</h2>
      <ul className="shape-grid">
        {CATEGORIES.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className={placing?.type === 'part' && placingFamily === c.id ? 'shape selected' : 'shape'}
              title={c.summary}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                letGo(e);
                void startPlacingPart(c.id);
              }}
              onDoubleClick={() => void addPart(c.id)}
              onClick={(e) => {
                if (e.detail === 0) void addPart(c.id);
              }}
            >
              <span className="thumb">{PART_THUMBNAILS[c.id] ?? partThumbnail(GENERATORS.find((g) => g.category === c.id)!)}</span>
              <span className="shape-name">{FAMILY_NAMES[c.id] ?? c.label}</span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" className={bin ? 'shape selected' : 'shape'} title="Parts you saved from your designs, to place again." aria-pressed={bin} onClick={openPartsBin}>
            <span className="thumb">{partsBinThumbnail}</span>
            <span className="shape-name">Custom</span>
          </button>
        </li>
      </ul>
    </section>
  );
}

function ImportRow() {
  return (
    <div className="import-row">
      <button type="button" className="import-button" title={tip('import', 'Import a model, drawing or picture')} onClick={() => void importModel()}>
        <ImportIcon />
        Import model or picture…
      </button>
    </div>
  );
}

function Objects() {
  const scene = useEditor((s) => s.doc.scene);
  const selection = useEditor((s) => s.selection);
  // A finger held on a row toggles the object into the selection, and the tap that follows is not a click.
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; id: string } | null>(null);
  const held = useRef<string | null>(null);
  const endHold = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  const startHold = (e: ReactPointerEvent, id: string) => {
    if (e.pointerType !== 'touch') return;
    endHold();
    hold.current = {
      id,
      timer: setTimeout(() => {
        hold.current = null;
        held.current = id;
        toggleSelected(id);
      }, LONG_PRESS_MS),
    };
  };
  return (
    <section className="objects">
      <h2>
        Objects <span className="count">{scene.length || ''}</span>
      </h2>
      {scene.length === 0 ? (
        <p className="empty">Nothing yet. Pick a shape from the library and click on the plate to place it.</p>
      ) : (
        <ul>
          {scene.map((node) => {
            const selected = selection.includes(node.id);
            // Hidden and ghosted objects are out of reach: their rows do not select.
            const away = Boolean(node.hidden || node.ghost);
            return (
              <li key={node.id} className={['object', selected ? 'selected' : '', away ? 'dim' : ''].join(' ')}>
                <button
                  type="button"
                  className="object-main"
                  title={node.ghost ? `${kindOf(node)} (ghost)` : kindOf(node)}
                  onPointerDown={(e) => {
                    if (!away) startHold(e, node.id);
                  }}
                  onPointerUp={endHold}
                  onPointerCancel={endHold}
                  onPointerLeave={endHold}
                  onClick={(e) => {
                    if (held.current === node.id) {
                      held.current = null;
                      return;
                    }
                    if (away) return;
                    if (e.shiftKey || e.ctrlKey || e.metaKey) toggleSelected(node.id);
                    else select([node.id]);
                  }}
                  // A second click (or tap) goes to the object's structure.
                  onDoubleClick={() => {
                    if (away) return;
                    select([node.id]);
                    showTab('structure');
                  }}
                >
                  <span className={node.hole ? 'dot hole' : 'dot'} style={{ background: node.hole ? undefined : node.color, borderColor: node.hole ? HOLE_COLOR : undefined }} />
                  <span className="clip">{node.name}</span>
                  {node.note && <span className="note-mark" title="Has notes" />}
                </button>
                <button
                  type="button"
                  className={node.ghost ? 'mini on' : 'mini'}
                  title={node.ghost ? 'Un-ghost' : 'Ghost'}
                  aria-label={node.ghost ? 'Un-ghost' : 'Ghost'}
                  aria-pressed={Boolean(node.ghost)}
                  onClick={() => toggleGhost(node.id)}
                >
                  <GhostIcon small />
                </button>
                <button
                  type="button"
                  className={node.locked ? 'mini on' : 'mini'}
                  title={node.locked ? 'Unlock' : 'Lock'}
                  aria-label={node.locked ? 'Unlock' : 'Lock'}
                  aria-pressed={Boolean(node.locked)}
                  onClick={() => toggleLocked(node.id)}
                >
                  {node.locked ? <LockIcon /> : <UnlockIcon />}
                </button>
                <button
                  type="button"
                  className={node.hidden ? 'mini on' : 'mini'}
                  title={node.hidden ? 'Show' : 'Hide'}
                  aria-label={node.hidden ? 'Show' : 'Hide'}
                  aria-pressed={Boolean(node.hidden)}
                  onClick={() => toggleHidden(node.id)}
                >
                  {node.hidden ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The Structure tab: the selected object's tree and notes, or a word on what to select. */
function StructureTab() {
  const scene = useEditor((s) => s.doc.scene);
  const selection = useEditor((s) => s.selection);
  const nodes = scene.filter((n) => selection.includes(n.id));
  if (nodes.length === 1) return <Structure root={nodes[0]} />;
  return (
    <section className="structure-empty">
      <h2>Structure</h2>
      <p className="empty">{nodes.length === 0 ? 'Select an object to see how it was put together and keep notes on it.' : 'Select one object at a time to see its structure.'}</p>
    </section>
  );
}

/** A shape being carried from the library is put back when the tab changes: the next press on the plate must not place it. */
function showTab(tab: 'library' | 'objects' | 'structure'): void {
  cancelPlacing();
  setPrefs({ sidebar: tab });
}

function Brand({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <div className="brand">
      <Logo />
      <span className="wordmark">{APP_NAME}</span>
      <button
        type="button"
        className="icon-button"
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label="Toggle theme"
        onClick={() => setPrefs({ theme: theme === 'dark' ? 'light' : 'dark' })}
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
    </div>
  );
}

export function Sidebar() {
  const theme = useEditor((s) => s.prefs.theme);
  const tab = useEditor((s) => s.prefs.sidebar);
  const robot = useEditor((s) => s.robot);
  if (robot) {
    return (
      <aside className="sidebar">
        <Brand theme={theme} />
        <FileBar />
        <RobotModeBar />
        <nav className="catalog structure-pane" aria-label="Robot">
          <RobotPanel />
        </nav>
        <RobotExport />
      </aside>
    );
  }
  return (
    <aside className="sidebar">
      <Brand theme={theme} />
      <FileBar />
      <div className="tabs">
        <div className="page-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'library'} className={tab === 'library' ? 'on' : ''} onClick={() => showTab('library')}>
            Library
          </button>
          <button type="button" role="tab" aria-selected={tab === 'objects'} className={tab === 'objects' ? 'on' : ''} onClick={() => showTab('objects')}>
            Objects
          </button>
          <button type="button" role="tab" aria-selected={tab === 'structure'} className={tab === 'structure' ? 'on' : ''} onClick={() => showTab('structure')}>
            Structure
          </button>
        </div>
      </div>
      {tab === 'library' ? (
        <nav className="catalog library" aria-label="Shapes and parts">
          <Shapes />
          <ImportRow />
        </nav>
      ) : tab === 'objects' ? (
        <nav className="catalog objects-tab" aria-label="Objects">
          <Objects />
        </nav>
      ) : (
        <nav className="catalog structure-pane" aria-label="Structure">
          <StructureTab />
        </nav>
      )}
      <ExportPanel />
    </aside>
  );
}
