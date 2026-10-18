import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { geometry } from '../state/geometry';
import { SNAP_STEPS } from '../state/persist';
import {
  beginGesture,
  cancelEditing,
  commitAlign,
  commitPlacing,
  deleteSelected,
  dropSelected,
  duplicateSelected,
  endGesture,
  finishEditing,
  getState,
  groupSelected,
  mirrorSelected,
  movePlacing,
  previewAlign,
  provideThumbnail,
  redo,
  replaceNodes,
  select,
  setAlignAnchor,
  setPrefs,
  toggleAligning,
  toggleSelected,
  undo,
  ungroupSelected,
  useEditor,
} from '../state/store';
import { GIZMO_SIZE, Viewer } from '../viewer/Viewer';
import type { HandlePrompt, ViewItem, ViewPreset } from '../viewer/Viewer';
import {
  AlignIcon,
  ArrayIcon,
  ChevronIcon,
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
import { ArrayPanel } from './ArrayPanel';
import { recentTouch, selectOnFocus } from './Fields';
import { enterByTouch, keyboardAttached, openTouchEntry } from './TouchEntry';
import { Popover } from './Popover';
import { MatePanel } from './MatePanel';
import { TransformBox } from './TransformBox';

const VIEWS: { id: ViewPreset; label: string }[] = [
  { id: 'iso', label: '3D' },
  { id: 'top', label: 'Top' },
  { id: 'front', label: 'Front' },
  { id: 'side', label: 'Side' },
];


/** The viewer other parts of the app may talk to (fit to view from a shortcut, cancel a drag). */
export const viewerRef: { current: Viewer | null } = { current: null };

function Actions() {
  const scene = useEditor((s) => s.doc.scene);
  const selection = useEditor((s) => s.selection);
  const picked = useMemo(() => scene.filter((n) => selection.includes(n.id)), [scene, selection]);
  const aligning = useEditor((s) => s.aligning);
  const none = picked.length === 0;
  const hasGroup = picked.some((n) => n.type === 'group');

  return (
    <>
      <div className="tool-group">
        <button type="button" className="chip icon" title="Group (Ctrl+G)" aria-label="Group" disabled={picked.length < 2} onClick={() => void groupSelected()}>
          <GroupIcon />
        </button>
        <button type="button" className="chip icon" title="Ungroup (Ctrl+Shift+G)" aria-label="Ungroup" disabled={!hasGroup} onClick={ungroupSelected}>
          <UngroupIcon />
        </button>
      </div>
      <div className="tool-group">
        <button
          type="button"
          className={aligning ? 'chip icon on' : 'chip icon'}
          title="Align (L)"
          aria-label="Align"
          aria-pressed={Boolean(aligning)}
          disabled={picked.length < 2 && !aligning}
          onClick={toggleAligning}
        >
          <AlignIcon />
        </button>
        <Popover className="chip icon" title="Mirror (X / Y / Z)" button={<MirrorIcon />} disabled={none} align="right">
          {() => (
            <div className="align-panel">
              <p>Mirrors the selection across the chosen axis.</p>
              <div className="segmented">
                {(['X', 'Y', 'Z'] as const).map((label, axis) => (
                  <button key={label} type="button" title={`Press ${label}`} onClick={() => mirrorSelected(axis as 0 | 1 | 2)}>
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
      <div className="tool-group">
        <button type="button" className="chip icon" title="Duplicate in place (Ctrl+D)" aria-label="Duplicate" disabled={none} onClick={duplicateSelected}>
          <DuplicateIcon />
        </button>
        <Popover className="chip icon" title="Array (grid or ring)" button={<ArrayIcon />} disabled={none} align="right">
          {(close) => <ArrayPanel close={close} />}
        </Popover>
        <button type="button" className="chip icon" title="Delete (Del)" aria-label="Delete" disabled={none} onClick={deleteSelected}>
          <TrashIcon />
        </button>
      </div>
    </>
  );
}

/** Undo and redo, at the left end of the bar. */
function History() {
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  return (
    <div className="tool-group">
      <button type="button" className="chip icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={undo}>
        <UndoIcon />
      </button>
      <button type="button" className="chip icon" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!canRedo} onClick={redo}>
        <RedoIcon />
      </button>
    </div>
  );
}

/**
 * The corner widget: the axis triad the viewer draws (it tracks the camera,
 * which keeps X, Y and Z straight when typing positions), with the camera
 * presets and fit beneath it. The triad is drawn on the canvas, so the widget
 * tells the viewer where its space is.
 */
function ViewWidget({ viewer }: { viewer: React.RefObject<Viewer | null> }) {
  const space = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = space.current;
    const host = el?.closest('.viewport');
    if (!el || !host) return;
    const place = () => {
      const a = el.getBoundingClientRect();
      const b = host.getBoundingClientRect();
      viewer.current?.setTriadOrigin(a.left - b.left, b.bottom - a.bottom);
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(el);
    watch.observe(host);
    return () => watch.disconnect();
  }, [viewer]);
  return (
    <div className="view-widget">
      <div className="triad-space" ref={space} style={{ width: GIZMO_SIZE, height: GIZMO_SIZE }} />
      <div className="view-row">
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
      </div>
    </div>
  );
}

/**
 * Boxes on the object's edges after a grip was clicked: type the value(s),
 * Enter applies them as if the grip had been dragged there.
 */
function HandleInput({ prompt, onClose }: { prompt: HandlePrompt; onClose: () => void }) {
  const [texts, setTexts] = useState(prompt.fields.map((f) => String(Number(f.value.toFixed(3)))));
  const host = useRef<HTMLFormElement>(null);
  const submit = () => {
    submitWith(texts);
  };
  const submitWith = (typed: string[]) => {
    // A box left empty keeps the value it showed; with every box empty there is nothing to apply.
    const blank = typed.map((t) => t.trim() === '');
    if (!blank.every(Boolean)) {
      const values = typed.map((t, i) => (blank[i] ? prompt.fields[i].value : Number(t.trim().replace(',', '.'))));
      if (values.every((v) => Number.isFinite(v))) viewerRef.current?.applyTyped(prompt.kind, values);
    }
    onClose();
  };
  /** With a finger and no keyboard, the value is typed in the entry sheet at the top of the window rather than in the box under the keypad. */
  const entryOf = (i: number): Parameters<typeof openTouchEntry>[0] => {
    const f = prompt.fields[i];
    return {
      label: `${f.tag}${prompt.fields.length > 1 ? ` (${i + 1} of ${prompt.fields.length})` : ''}`,
      value: texts[i],
      unit: prompt.unit,
      inputMode: 'decimal',
      onCommit: (raw) => {
        const next = texts.map((t, j) => (j === i ? raw : t));
        setTexts(next);
        // With two boxes, the second is asked for next; the last one applies.
        if (i + 1 < prompt.fields.length) setTimeout(() => openTouchEntry(entryOf(i + 1)), 0);
        else submitWith(next);
      },
      onCancel: onClose,
    };
  };
  // The fields carry screen coordinates; the boxes are placed within the viewport, so its
  // corner comes off. That is only known once the form is in the page, hence the effect.
  const [origin, setOrigin] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = host.current?.parentElement?.getBoundingClientRect();
    setOrigin(r ? { left: r.left, top: r.top } : { left: 0, top: 0 });
  }, []);
  // The first box takes the focus once it is in place (a box still hidden cannot); a grip tapped with a finger goes to the entry sheet instead.
  useEffect(() => {
    if (!origin) return;
    const first = host.current?.querySelector('input');
    if (!recentTouch()) first?.focus();
    else if (!keyboardAttached()) openTouchEntry(entryOf(0));
    // After a tap, the browser's compatibility mouse events would blur the box (and close the prompt) if it were focused now.
    else setTimeout(() => first?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin]);
  return (
    <form
      ref={host}
      className="prompt-boxes"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      // Leaving one box for the other, or for the entry sheet, keeps the prompt; leaving the form otherwise closes it.
      onBlur={(e) => {
        const to = e.relatedTarget as HTMLElement | null;
        if (!host.current?.contains(to) && !to?.closest('.touch-entry')) onClose();
      }}
    >
      {prompt.fields.map((f, i) => (
        <label key={f.tag} className="readout prompt" style={{ left: `${f.clientX - (origin?.left ?? 0)}px`, top: `${f.clientY - (origin?.top ?? 0)}px`, visibility: origin ? undefined : 'hidden' }}>
          <span className="tag">{f.tag}</span>
          <input
            aria-label={f.tag}
            value={texts[i]}
            spellCheck={false}
            inputMode="decimal"
            onPointerDown={(e) => enterByTouch(e, entryOf(i))}
            onFocus={selectOnFocus}
            onChange={(e) => setTexts(texts.map((t, j) => (j === i ? e.target.value : t)))}
            onKeyDown={(e) => {
              // With two boxes and no button, Enter would not submit the form on its own.
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') onClose();
              e.stopPropagation();
            }}
          />
          <span className="unit">{prompt.unit}</span>
        </label>
      ))}
    </form>
  );
}

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState<HandlePrompt | null>(null);
  const readout = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);

  const state = useEditor((s) => s);
  const { prefs, placing, selection, busy, aligning, editing, highlight, mating } = state;
  // Another selection, or an edit from elsewhere, and the typing boxes no longer belong to anything.
  useEffect(() => {
    viewer.current?.dismissPrompt();
  }, [selection, editing]);
  const scene = state.doc.scene;
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
        onAlignHover: previewAlign,
        onAlignPick: commitAlign,
        onAnchor: setAlignAnchor,
        onHandleClick: setPrompt,
      },
      { theme: prefs.theme, edges: prefs.edges, grid: prefs.grid, snap: prefs.snap },
    );
    viewer.current = viewerRef.current = v;
    provideThumbnail(() => v.capture(320, 200));
    return () => {
      provideThumbnail(null);
      v.dispose();
      viewer.current = viewerRef.current = null;
    };
    // The viewer is created once; later option changes go through setOptions.
  }, []);

  useEffect(() => {
    viewer.current?.setOptions({ theme: prefs.theme, edges: prefs.edges, grid: prefs.grid, snap: prefs.snap, interactive: true, align: aligning, highlight });
  }, [prefs.theme, prefs.edges, prefs.grid, prefs.snap, aligning, highlight]);

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
    viewer.current?.setItems(items, assets);
  }, [items, assets]);

  // A different design on screen: frame it.
  const shownKey = state.epoch;
  const framed = useRef(-1);
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

  return (
    <div className="viewport">
      <div className="canvas-host" ref={host} />
      <div className="readout" ref={readout} hidden />
      {prompt && <HandleInput key={JSON.stringify(prompt.kind)} prompt={prompt} onClose={() => viewer.current?.dismissPrompt()} />}
      <div className="view-toolbar">
        <div className="toolbar" role="toolbar" aria-label="Tools">
          <History />
          <div className="tool-group">
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
          </div>
          <Actions />
        </div>
      </div>
      <ViewWidget viewer={viewer} />

      {editing && (
        <div className="mode-banner" role="status">
          <span>
            Editing inside <strong>{editing.layers[0]?.name}</strong>
          </span>
          <button type="button" className="chip on" disabled={Boolean(busy)} onClick={() => void finishEditing()}>
            Done
          </button>
          <button type="button" className="chip" disabled={Boolean(busy)} onClick={cancelEditing}>
            Cancel
          </button>
        </div>
      )}
      {placing && <div className="hint-bar">Click on the plate to place the {placing.name.toLowerCase()} · Esc to cancel</div>}
      {aligning && !placing && (
        <div className="hint-bar">
          {aligning.anchor ? 'Aligning to the anchor' : 'Click a dot to align'} · click an object to set the anchor · Esc to finish
        </div>
      )}

      {mating && <MatePanel key={mating.id} />}

      <div className="corner">
        <div className="overlay">
        {failures.map((text) => (
          <div className="notice error" role="alert" key={text}>
            <WarningIcon />
            <span>{text}</span>
          </div>
        ))}
        </div>
        <TransformBox />
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
