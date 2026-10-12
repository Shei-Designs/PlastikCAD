import { useEffect, useState } from 'react';
import { APP_NAME, APP_VERSION } from '../app';
import { SHAPES } from '../geometry/shapes';
import { HOLE_COLOR } from '../model/ops';
import type { SceneNode } from '../model/types';
import { isDesktop } from '../platform';
import {
  addPart,
  addPicture,
  addShape,
  addText,
  importModel,
  isDirty,
  newDesign,
  openDesign,
  openPath,
  renameDesign,
  saveDesign,
  saveDesignAs,
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
import { EyeIcon, EyeOffIcon, ImportIcon, LockIcon, Logo, MenuIcon, MoonIcon, SaveIcon, SunIcon, UnlockIcon } from './icons';
import { Popover } from './Popover';
import { CATEGORIES, GENERATORS, getGenerator } from '../parts/generators';
import { partThumbnail } from './partThumbnails';
import { Structure } from './Structure';
import { PART_THUMBNAILS, pictureThumbnail, shapeThumbnail, textThumbnail } from './thumbnails';

const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

function FileBar() {
  const name = useEditor((s) => s.doc.name);
  const dirty = useEditor(isDirty);
  const recent = useEditor((s) => s.prefs.recent);
  const filePath = useEditor((s) => s.filePath);
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);

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
      <kbd>{keys}</kbd>
    </button>
  );

  return (
    <div className="file-bar">
      <span className={dirty ? 'dirty-dot on' : 'dirty-dot'} title={dirty ? 'Unsaved changes' : 'All changes saved'} />
      <input
        className="doc-name"
        aria-label="Design name"
        title={filePath ?? 'Design name'}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          renameDesign(text);
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
      <button type="button" className="icon-button" title={`Save (${MOD}S)`} aria-label="Save" onClick={() => void saveDesign()}>
        <SaveIcon />
      </button>
      <Popover className="icon-button" title="File" button={<MenuIcon />} align="right">
        {(close) => (
          <div className="menu" role="menu">
            {item('New design', `${MOD}N`, () => void newDesign(), close)}
            {item('Open…', `${MOD}O`, () => void openDesign(), close)}
            {item('Save', `${MOD}S`, () => void saveDesign(), close)}
            {item('Save as…', `${MOD}Shift+S`, () => void saveDesignAs(), close)}
            <hr />
            {item('Import model or picture…', `${MOD}I`, () => void importModel(), close)}
            {isDesktop() && recent.length > 0 && (
              <>
                <hr />
                <div className="menu-title">Recent</div>
                {recent.map((path) => (
                  <button
                    key={path}
                    type="button"
                    className="menu-item"
                    title={path}
                    onClick={() => {
                      close();
                      void openPath(path);
                    }}
                  >
                    <span className="clip">{path.replace(/^.*[\\/]/, '')}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}

/** Short tile names for the part families. */
const FAMILY_NAMES: Record<string, string> = { gears: 'Gear', pulleys: 'Pulley', screws: 'Screw', frames: 'Rail', ducts: 'Pipe', boards: 'Board', fans: 'Fan', cutouts: 'Cutout', motors: 'Motor' };

function Shapes() {
  const placing = useEditor((s) => s.placing);
  const viewing = useEditor((s) => s.viewing);
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
              title={`${def.summary}\nClick, then click on the plate to place it. Double-click to drop it in the middle.`}
              disabled={Boolean(viewing)}
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
            title={'Lettering to emboss on an object or, as a hole, to engrave in it\nClick, then click on the plate or on top of an object to place it.'}
            disabled={Boolean(viewing)}
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
            title={'A picture (PNG or JPEG) on a sheet: group it with an object and it prints onto the surface\nClick, pick the file, then click on the plate to place it. Double-click to drop it in the middle.'}
            disabled={Boolean(viewing)}
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
              title={`${c.label}: pick the kind and the numbers once it is placed.\nClick, then click on the plate to place it. Double-click to drop it in the middle.`}
              disabled={Boolean(viewing)}
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
  const viewing = useEditor((s) => s.viewing);
  return (
    <div className="import-row">
      <button type="button" className="part" title="Import an STL, OBJ or 3MF mesh, an SVG drawing, or a PNG or JPEG picture" disabled={Boolean(viewing)} onClick={() => void importModel()}>
        <span className="thumb small">
          <ImportIcon />
        </span>
        <span className="part-name">Import…</span>
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
  const viewing = useEditor((s) => s.viewing);
  if (viewing) return null;
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
                  onClick={(e) => {
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
                  title={node.locked ? 'Unlock' : 'Lock (protect from changes)'}
                  aria-label={node.locked ? 'Unlock' : 'Lock'}
                  aria-pressed={Boolean(node.locked)}
                  onClick={() => toggleLocked(node.id)}
                >
                  {node.locked ? <LockIcon /> : <UnlockIcon />}
                </button>
                <button
                  type="button"
                  className={node.hidden ? 'mini on' : 'mini'}
                  title={node.hidden ? 'Show' : 'Hide (hidden objects are not exported)'}
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
  const viewing = useEditor((s) => s.viewing);
  const nodes = scene.filter((n) => selection.includes(n.id));
  const group = nodes.length === 1 && nodes[0].type === 'group' ? nodes[0] : null;
  if (viewing) return null;
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

export function Sidebar() {
  const theme = useEditor((s) => s.prefs.theme);
  const tab = useEditor((s) => s.prefs.sidebar);
  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo />
        <span>{APP_NAME}</span>
      </div>
      <FileBar />
      <div className="tabs">
        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'library'} className={tab === 'library' ? 'on' : ''} onClick={() => setPrefs({ sidebar: 'library' })}>
            Library
          </button>
          <button type="button" role="tab" aria-selected={tab === 'objects'} className={tab === 'objects' ? 'on' : ''} onClick={() => setPrefs({ sidebar: 'objects' })}>
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
      <footer className="sidebar-foot">
        <span>v{APP_VERSION} · GPL-3.0</span>
        <button
          type="button"
          className="icon-button"
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label="Toggle theme"
          onClick={() => setPrefs({ theme: theme === 'dark' ? 'light' : 'dark' })}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </footer>
    </aside>
  );
}
