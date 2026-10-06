import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { geometry } from '../state/geometry';
import { SNAP_STEPS } from '../state/persist';
import {
  alignSelected,
  beginGesture,
  commitPlacing,
  deleteSelected,
  dismissNotice,
  dropSelected,
  duplicateSelected,
  endGesture,
  getState,
  groupSelected,
  mirrorSelected,
  movePlacing,
  redo,
  replaceNodes,
  restoreVersion,
  select,
  setPrefs,
  setThumbnailer,
  shownScene,
  toggleSelected,
  undo,
  ungroupSelected,
  useEditor,
  viewVersion,
} from '../state/store';
import { Viewer } from '../viewer/Viewer';
import type { ViewItem, ViewPreset } from '../viewer/Viewer';
import {
  AlignIcon,
  ChevronIcon,
  CloseIcon,
  DropIcon,
  DuplicateIcon,
  FitIcon,
  GroupIcon,
  MirrorIcon,
  RedoIcon,
  TrashIcon,
  UndoIcon,
  UngroupIcon,
  WarningIcon,
} from './icons';
import { Popover } from './Popover';

const VIEWS: { id: ViewPreset; label: string }[] = [
  { id: 'iso', label: '3D' },
  { id: 'top', label: 'Top' },
  { id: 'front', label: 'Front' },
  { id: 'side', label: 'Side' },
];

const ALIGN_ROWS: { axis: 0 | 1 | 2; label: string; options: [string, string, string] }[] = [
  { axis: 0, label: 'X', options: ['Left', 'Centre', 'Right'] },
  { axis: 1, label: 'Y', options: ['Front', 'Centre', 'Back'] },
  { axis: 2, label: 'Z', options: ['Bottom', 'Centre', 'Top'] },
];
const ALIGN_MODES = ['min', 'centre', 'max'] as const;

/** The viewer other parts of the app may talk to (fit to view from a shortcut, cancel a drag). */
export const viewerRef: { current: Viewer | null } = { current: null };

function Actions() {
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const scene = useEditor((s) => s.doc.scene);
  const selection = useEditor((s) => s.selection);
  const picked = useMemo(() => scene.filter((n) => selection.includes(n.id)), [scene, selection]);
  const none = picked.length === 0;
  const hasGroup = picked.some((n) => n.type === 'group');

  return (
    <div className="actions">
      <div className="chip-group">
        <button type="button" className="chip icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={undo}>
          <UndoIcon />
        </button>
        <button type="button" className="chip icon" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!canRedo} onClick={redo}>
          <RedoIcon />
        </button>
      </div>
      <div className="chip-group">
        <button type="button" className="chip icon" title="Duplicate in place (Ctrl+D)" aria-label="Duplicate" disabled={none} onClick={duplicateSelected}>
          <DuplicateIcon />
        </button>
        <button type="button" className="chip icon" title="Delete (Del)" aria-label="Delete" disabled={none} onClick={deleteSelected}>
          <TrashIcon />
        </button>
      </div>
      <div className="chip-group">
        <button type="button" className="chip icon" title="Group: merge solids, cut holes (Ctrl+G)" aria-label="Group" disabled={picked.length < 2} onClick={() => void groupSelected()}>
          <GroupIcon />
        </button>
        <button type="button" className="chip icon" title="Ungroup (Ctrl+Shift+G)" aria-label="Ungroup" disabled={!hasGroup} onClick={ungroupSelected}>
          <UngroupIcon />
        </button>
      </div>
      <div className="chip-group">
        <Popover className="chip icon" title="Align" button={<AlignIcon />} disabled={none} align="right">
          {() => (
            <div className="align-panel">
              <p>{picked.length > 1 ? 'Line the selected objects up with each other' : 'Line the object up with the centre of the plate'}</p>
              {ALIGN_ROWS.map((row) => (
                <div className="align-row" key={row.axis}>
                  <span>{row.label}</span>
                  <div className="segmented">
                    {row.options.map((label, i) => (
                      <button key={label} type="button" onClick={() => alignSelected(row.axis, ALIGN_MODES[i])}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Popover>
        <Popover className="chip icon" title="Mirror (M)" button={<MirrorIcon />} disabled={none} align="right">
          {() => (
            <div className="align-panel">
              <p>Flip the selection, as in a mirror standing across the chosen axis</p>
              <div className="segmented">
                {(['X', 'Y', 'Z'] as const).map((label, axis) => (
                  <button key={label} type="button" onClick={() => mirrorSelected(axis as 0 | 1 | 2)}>
                    Flip {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Popover>
        <button type="button" className="chip icon" title="Drop onto the plate (D)" aria-label="Drop onto the plate" disabled={none} onClick={dropSelected}>
          <DropIcon />
        </button>
      </div>
    </div>
  );
}

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);

  const state = useEditor((s) => s);
  const { prefs, placing, selection, viewing, notice, busy } = state;
  const scene = shownScene(state);
  const assets = state.doc.assets;
  const revision = useSyncExternalStore(geometry.subscribe, geometry.getRevision);

  useEffect(() => {
    const v = new Viewer(
      host.current!,
      {
        onSelect: (ids, mode) => {
          if (mode === 'toggle') ids.forEach(toggleSelected);
          else select(mode === 'add' ? [...new Set([...getState().selection, ...ids])] : ids);
        },
        onGestureStart: beginGesture,
        onGestureChange: (nodes) => replaceNodes(nodes),
        onGestureEnd: endGesture,
        onPlaceMove: movePlacing,
        onPlaceCommit: commitPlacing,
        onReadout: (text, x, y) => {
          const el = readout.current;
          if (!el) return;
          el.hidden = text === null;
          if (text === null) return;
          el.textContent = text;
          const rect = host.current!.getBoundingClientRect();
          el.style.left = `${x - rect.left + 16}px`;
          el.style.top = `${y - rect.top + 16}px`;
        },
        boundsOf: (node) => geometry.bounds(node),
      },
      { theme: prefs.theme, edges: prefs.edges, grid: prefs.grid, snap: prefs.snap },
    );
    viewer.current = viewerRef.current = v;
    setThumbnailer(() => v.capture());
    return () => {
      setThumbnailer(null);
      v.dispose();
      viewer.current = viewerRef.current = null;
    };
    // The viewer is created once; later option changes go through setOptions.
  }, []);

  useEffect(() => {
    viewer.current?.setOptions({ theme: prefs.theme, edges: prefs.edges, grid: prefs.grid, snap: prefs.snap, interactive: !viewing });
  }, [prefs.theme, prefs.edges, prefs.grid, prefs.snap, viewing]);

  useEffect(() => {
    viewer.current?.setPlacing(Boolean(placing));
  }, [Boolean(placing)]);

  useEffect(() => {
    geometry.ensure(placing ? [...scene, placing] : scene, assets);
  }, [scene, placing, assets]);

  const items = useMemo<ViewItem[]>(() => {
    const picked = new Set(selection);
    const ready = (node: ViewItem['node']) => {
      const entry = geometry.get(node);
      return entry?.state === 'ready' ? entry.result : null;
    };
    const list: ViewItem[] = scene.map((node) => ({ node, result: ready(node), selected: picked.has(node.id) }));
    if (placing) list.push({ node: placing, result: ready(placing), selected: false, ghost: true });
    return list;
    // `revision` changes when geometry arrives.
  }, [scene, selection, placing, revision]);

  useEffect(() => {
    viewer.current?.setItems(items);
  }, [items]);

  // A different design (or version) on screen: frame it.
  const shownKey = `${state.epoch}:${viewing ?? ''}`;
  const framed = useRef('');
  useEffect(() => {
    if (framed.current === shownKey) return;
    framed.current = shownKey;
    viewer.current?.fit(true);
  }, [shownKey, items]);

  const failures = useMemo(() => {
    const out: string[] = [];
    for (const node of scene) {
      const entry = geometry.get(node);
      if (entry?.state === 'error') out.push(`${node.name}: ${entry.message}`);
    }
    return out;
  }, [scene, revision]);

  const version = viewing ? state.doc.versions.find((v) => v.id === viewing) : null;

  return (
    <div className="viewport">
      <div className="canvas-host" ref={host} />
      <div className="readout" ref={readout} hidden />
      <div className="view-toolbar">
        <div className="segmented small" role="group" aria-label="Camera view">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" onClick={() => viewer.current?.setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        <button type="button" className="chip icon" title="Fit to view (F)" aria-label="Fit to view" onClick={() => viewer.current?.fit()}>
          <FitIcon />
        </button>
        <button type="button" className={prefs.edges ? 'chip on' : 'chip'} aria-pressed={prefs.edges} onClick={() => setPrefs({ edges: !prefs.edges })}>
          Edges
        </button>
        <button type="button" className={prefs.grid ? 'chip on' : 'chip'} aria-pressed={prefs.grid} onClick={() => setPrefs({ grid: !prefs.grid })}>
          Grid
        </button>
        <label className="chip select" title="Grid that moves and sizes snap to">
          Snap
          <select value={prefs.snap} onChange={(e) => setPrefs({ snap: Number(e.target.value) })}>
            {SNAP_STEPS.map((s) => (
              <option key={s} value={s}>
                {s === 0 ? 'Off' : `${s} mm`}
              </option>
            ))}
          </select>
          <ChevronIcon />
        </label>
        {!viewing && <Actions />}
      </div>

      {version && (
        <div className="version-banner" role="status">
          <span>
            Viewing <strong>{version.label}</strong>
          </span>
          <button type="button" className="chip on" onClick={() => restoreVersion(version.id)}>
            Restore this version
          </button>
          <button type="button" className="chip" onClick={() => viewVersion(null)}>
            Back to current
          </button>
        </div>
      )}

      {placing && <div className="hint-bar">Click on the plate to place the {placing.name.toLowerCase()} · Esc to cancel</div>}

      <div className="overlay">
        {failures.map((text) => (
          <div className="notice error" role="alert" key={text}>
            <WarningIcon />
            <span>{text}</span>
          </div>
        ))}
        {notice && (
          <div className={notice.kind === 'error' ? 'notice error' : 'notice info'} role={notice.kind === 'error' ? 'alert' : 'status'}>
            {notice.kind === 'error' && <WarningIcon />}
            <span>{notice.text}</span>
            <button type="button" className="notice-close" aria-label="Dismiss" onClick={dismissNotice}>
              <CloseIcon />
            </button>
          </div>
        )}
      </div>

      {busy && (
        <div className="busy" role="status">
          <span className="spinner" />
          {busy}
        </div>
      )}
    </div>
  );
}
