import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { APP_NAME } from '../app';
import { SHAPES } from '../geometry/shapes';
import { HOLE_COLOR } from '../model/ops';
import type { SceneNode } from '../model/types';
import {
  addPart,
  addPicture,
  addShape,
  addText,
  cancelPlacing,
  importModel,
  isDirty,
  newProject,
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
  toggleHidden,
  toggleLocked,
  toggleSelected,
  useEditor,
} from '../state/store';
import { About } from './About';
import { ExportPanel } from './ExportPanel';
import { EyeIcon, EyeOffIcon, ImportIcon, LockIcon, Logo, MenuIcon, MoonIcon, ProjectsIcon, SunIcon, UnlockIcon } from './icons';
import { Popover } from './Popover';
import { CATEGORIES, GENERATORS, getGenerator } from '../parts/generators';
import { partThumbnail } from './partThumbnails';
import { Structure } from './Structure';
import { PART_THUMBNAILS, pictureThumbnail, shapeThumbnail, textThumbnail } from './thumbnails';

const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

function FileBar() {
  const name = useEditor((s) => s.doc.name);
  const dirty = useEditor(isDirty);
  const saving = useEditor((s) => s.saving);
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  const [about, setAbout] = useState(false);
  const status = saving ? 'Saving…' : dirty ? 'Changes not saved yet' : 'All changes saved';

  const item = (label: string, keys: string, run: () => void, close: () => void) => (
    <button
      type="button"
      className="menu-item"
      onClick={() => {
        close();
        run();
      }}
    >
      <span>{label}</span>
      {keys && <kbd>{keys}</kbd>}
    </button>
  );

  return (
    <div className="file-bar">
      <span className={dirty || saving ? 'dirty-dot on' : 'dirty-dot'} title={status} role="status" aria-label={status} />
      <input
        className="doc-name"
        aria-label="Project name"
        title="Project name"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          renameProject(text);
          setText((t) => t.trim() || name);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(name);
            e.currentTarget.blur();
          }
        }}
      />
      <button type="button" className="icon-button" title={`Projects (${MOD}O)`} aria-label="Projects" onClick={openProjects}>
        <ProjectsIcon />
      </button>
      <Popover className="icon-button" title="File" button={<MenuIcon />} align="right">
        {(close) => (
          <div className="menu" role="menu">
            {item('New project', `${MOD}N`, () => void newProject(), close)}
            {item('Projects…', `${MOD}O`, openProjects, close)}
            {item('Open project file…', '', () => void openProjectFile(), close)}
            {item('Save a copy…', `${MOD}Shift+S`, () => void saveCopy(), close)}
            <hr />
            {item(`About ${APP_NAME}…`, '', () => setAbout(true), close)}
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
                if (e.button === 0) startPlacing(def.kind);
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
              if (e.button === 0) void startPlacingText();
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
              if (e.button === 0) void startPlacingPicture();
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
                if (e.button === 0) void startPlacingPart(c.id);
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
      </ul>
    </section>
  );
}

function ImportRow() {
  return (
    <div className="import-row">
      <button type="button" className="import-button" title={`Import a model, drawing or picture (${MOD}I)`} onClick={() => void importModel()}>
        <ImportIcon />
        Import model or picture…
      </button>
    </div>
  );
}

const describe = (node: SceneNode): string =>
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
            : (SHAPES.find((s) => s.kind === node.shape)?.name ?? '');

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
            return (
              <li key={node.id} className={['object', selected ? 'selected' : '', node.hidden ? 'dim' : ''].join(' ')}>
                <button
                  type="button"
                  className="object-main"
                  title={describe(node)}
                  onPointerDown={(e) => {
                    if (!node.hidden) startHold(e, node.id);
                  }}
                  onPointerUp={endHold}
                  onPointerCancel={endHold}
                  onPointerLeave={endHold}
                  onClick={(e) => {
                    if (held.current === node.id) {
                      held.current = null;
                      return;
                    }
                    if (node.hidden) return;
                    if (e.shiftKey || e.ctrlKey || e.metaKey) toggleSelected(node.id);
                    else select([node.id]);
                  }}
                >
                  <span className={node.hole ? 'dot hole' : 'dot'} style={{ background: node.hole ? undefined : node.color, borderColor: node.hole ? HOLE_COLOR : undefined }} />
                  <span className="clip">{node.name}</span>
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

/** The lower half of the Objects tab: how the selected object was put together, when it is a group. */
function SelectedStructure() {
  const scene = useEditor((s) => s.doc.scene);
  const selection = useEditor((s) => s.selection);
  const nodes = scene.filter((n) => selection.includes(n.id));
  const group = nodes.length === 1 && nodes[0].type === 'group' ? nodes[0] : null;
  return (
    <section className="structure-pane">
      {group ? (
        <Structure root={group} />
      ) : (
        <>
          <h2>Structure tree</h2>
          <p className="empty">{nodes.length === 1 ? 'A single shape has no parts inside it.' : 'Select a group to see how it was put together.'}</p>
        </>
      )}
    </section>
  );
}

/** A shape being carried from the library is put back when the tab changes: the next press on the plate must not place it. */
function showTab(tab: 'library' | 'objects'): void {
  cancelPlacing();
  setPrefs({ sidebar: tab });
}

/** How long a finger rests on a row before it adds the object to the selection instead of selecting it alone. */
const LONG_PRESS_MS = 450;

export function Sidebar() {
  const theme = useEditor((s) => s.prefs.theme);
  const tab = useEditor((s) => s.prefs.sidebar);
  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo />
        <span>{APP_NAME}</span>
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
      <FileBar />
      <div className="tabs">
        <div className="page-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'library'} className={tab === 'library' ? 'on' : ''} onClick={() => showTab('library')}>
            Library
          </button>
          <button type="button" role="tab" aria-selected={tab === 'objects'} className={tab === 'objects' ? 'on' : ''} onClick={() => showTab('objects')}>
            Objects
          </button>
        </div>
      </div>
      {tab === 'library' ? (
        <nav className="catalog library" aria-label="Shapes and parts">
          <Shapes />
          <ImportRow />
        </nav>
      ) : (
        <nav className="catalog objects-tab" aria-label="Objects">
          <Objects />
          <SelectedStructure />
        </nav>
      )}
      <ExportPanel />
    </aside>
  );
}
