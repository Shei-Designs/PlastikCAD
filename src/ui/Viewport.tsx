import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
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
  ghostSelected,
  hasGhosts,
  jointSnaps,
  pickJointSnap,
  dragMarker,
  endMarkerDrag,
  selectJoint,
  selectSensor,
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
  toggleMeasuring,
  setMeasureKinds,
  pickMeasure,
  toggleSelected,
  undo,
  ungroupSelected,
  unghostAll,
  useEditor,
} from '../state/store';
import { apply, multiply, rotation } from '../model/math';
import { FEATURE_KINDS } from '../geometry/features';
import type { FeatureKind } from '../geometry/features';
import { describe as describeFeature, measure as measureBetween } from '../geometry/measure';
import type { Mat } from '../model/math';
import type { SceneNode, Vec3 } from '../model/types';
import { posedScene } from '../robot/kinematics';
import { jointInDesign, sensorInDesign } from '../robot/model';
import type { RobotJoint, RobotSensor } from '../robot/types';
import type { EditorState } from '../state/store';
import { sim } from '../state/sim';
import { GIZMO_SIZE, Viewer } from '../viewer/Viewer';
import type { HandlePrompt, Marker, ViewItem, ViewPreset } from '../viewer/Viewer';
import {
  AlignIcon,
  RulerIcon,
  SnapCenterIcon,
  SnapCircleIcon,
  SnapEdgeIcon,
  SnapFaceCenterIcon,
  SnapFaceIcon,
  SnapMiddleIcon,
  SnapPointIcon,
  SnapQuadrantIcon,
  ArrayIcon,
  ChevronIcon,
  DropIcon,
  DuplicateIcon,
  FitIcon,
  GhostIcon,
  GroupIcon,
  MirrorIcon,
  RedoIcon,
  TrashIcon,
  UndoIcon,
  UnghostIcon,
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
  const measuring = useEditor((s) => Boolean(s.measuring));
  /** A picked joint or sensor lines up with an object's box, on its own. */
  const marker = useEditor((s) => Boolean(s.joint || s.sensor));
  const ghosts = useEditor(hasGhosts);
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
          disabled={picked.length < 2 && !aligning && !marker}
          onClick={toggleAligning}
        >
          <AlignIcon />
        </button>
        <button type="button" className={measuring ? 'chip icon on' : 'chip icon'} title="Measure (M)" aria-label="Measure" aria-pressed={measuring} onClick={toggleMeasuring}>
          <RulerIcon />
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
        <button type="button" className="chip icon" title="Ghost: fades the selection out of reach, so what is around or inside it can be worked on (G)" aria-label="Ghost" disabled={none} onClick={ghostSelected}>
          <GhostIcon />
        </button>
        <button type="button" className="chip icon" title="Un-ghost all: brings every ghost back within reach (Shift+G)" aria-label="Un-ghost all" disabled={!ghosts} onClick={unghostAll}>
          <UnghostIcon />
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

/** Measure mode's bar: which kinds of feature to take hold of, and what the picks measure. */
function MeasureBar({ kinds, picks, result }: { kinds: FeatureKind[]; picks: number; result: string[] | null }) {
  const toggle = (id: FeatureKind) => setMeasureKinds(kinds.includes(id) ? kinds.filter((k) => k !== id) : [...kinds, id]);
  return (
    <div className="hint-bar measure" role="status">
      <div className="measure-kinds" role="group" aria-label="Snaps">
        {FEATURE_KINDS.map((k) => {
          const Snap = SNAP_ICONS[k.id];
          return (
            <button key={k.id} type="button" className={kinds.includes(k.id) ? 'chip icon on' : 'chip icon'} aria-pressed={kinds.includes(k.id)} aria-label={k.label} title={`${k.label}: ${k.help}`} onClick={() => toggle(k.id)}>
              <Snap />
            </button>
          );
        })}
      </div>
      <span className="measure-result">{result ? result.join(' · ') : picks === 0 ? 'Click a point, edge, face or circle, then another · Esc to finish' : 'Click another feature to measure to it'}</span>
    </div>
  );
}

/** The symbol on each snap's chip. */
const SNAP_ICONS: Record<FeatureKind, () => JSX.Element> = {
  point: SnapPointIcon,
  middle: SnapMiddleIcon,
  edge: SnapEdgeIcon,
  circle: SnapCircleIcon,
  quadrant: SnapQuadrantIcon,
  facecenter: SnapFaceCenterIcon,
  face: SnapFaceIcon,
  center: SnapCenterIcon,
};

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

/** A sensor as the frame the viewer draws it by. */
function sensorMarkerOf(sensor: RobotSensor, link: SceneNode): Marker {
  const { matrix } = sensorInDesign(sensor, link);
  if (sensor.kind === 'camera' || sensor.kind === 'depth') return { kind: 'camera', matrix, hfov: sensor.camera.hfov, aspect: sensor.camera.width / Math.max(sensor.camera.height, 1), depth: sensor.kind === 'depth', near: sensor.camera.near, far: sensor.camera.far };
  if (sensor.kind === 'lidar') return { kind: 'lidar', matrix, hfov: sensor.lidar.hfov };
  if (sensor.kind === 'touch') return { kind: 'touch', matrix };
  return { kind: 'imu', matrix };
}

/** A joint as the frame the viewer draws it by: its Z is the axis, its X the child's own axis nearest to square with it. */
function jointMarkerOf(joint: RobotJoint, child: SceneNode): Marker {
  const { origin, axis } = jointInDesign(joint, child);
  // X follows the child's own X unless that lies along the axis, then its Y; Y completes the right-handed frame.
  const turn = rotation(child.rot);
  const own = apply(turn, [1, 0, 0]);
  const pick: Vec3 = Math.abs(own[0] * axis[0] + own[1] * axis[1] + own[2] * axis[2]) < 0.9 ? own : apply(turn, [0, 1, 0]);
  const y = normalize(cross(axis, pick));
  const x = cross(y, axis);
  const matrix: Mat = [x[0], x[1], x[2], y[0], y[1], y[2], axis[0], axis[1], axis[2], origin[0], origin[1], origin[2]];
  return { kind: 'joint', type: joint.type, matrix };
}

/** The picked joint or sensor. */
function robotMarker(s: EditorState): Marker | null {
  const sensor = s.sensor ? s.doc.robot?.sensors.find((x) => x.id === s.sensor) : undefined;
  const link = sensor && s.doc.scene.find((n) => n.id === sensor.link);
  if (sensor && link) return sensorMarkerOf(sensor, link);
  const joint = s.joint ? s.doc.robot?.joints.find((j) => j.id === s.joint) : undefined;
  const child = joint && s.doc.scene.find((n) => n.id === joint.child);
  return joint && child ? jointMarkerOf(joint, child) : null;
}

/** Every other joint and sensor, for Robot mode when it shows them all. */
function robotMarkers(s: EditorState): { id: string; marker: Marker }[] | null {
  if (!s.robot || !s.prefs.robotMarkers || !s.doc.robot) return null;
  const byId = new Map(s.doc.scene.map((n) => [n.id, n]));
  const out: { id: string; marker: Marker }[] = [];
  for (const j of s.doc.robot.joints) {
    const child = j.id !== s.joint ? byId.get(j.child) : undefined;
    if (child) out.push({ id: j.id, marker: jointMarkerOf(j, child) });
  }
  for (const x of s.doc.robot.sensors) {
    const link = x.id !== s.sensor ? byId.get(x.link) : undefined;
    if (link) out.push({ id: x.id, marker: sensorMarkerOf(x, link) });
  }
  return out;
}

/** While the test drive runs: every sensor on its link where the simulation has it, a lidar's with what its rays read and a touch sensor's with whether it is pressed, for the plate to draw the readouts. */
function drivenMarkers(s: EditorState, frames: Map<string, Mat>, readings: Map<string, number[]>): { id: string; marker: Marker }[] | null {
  if (!s.robot || !s.doc.robot) return null;
  const byId = new Map(s.doc.scene.map((n) => [n.id, n]));
  const out: { id: string; marker: Marker }[] = [];
  for (const x of s.doc.robot.sensors) {
    const link = byId.get(x.link);
    const frame = frames.get(x.link);
    if (!link || !frame) continue;
    const marker = sensorMarkerOf(x, link);
    marker.matrix = multiply(frame, marker.matrix);
    if (marker.kind === 'lidar') marker.ranges = readings.get(x.id);
    if (marker.kind === 'touch') marker.pressed = (readings.get(x.id)?.[0] ?? 0) > 0;
    out.push({ id: x.id, marker });
  }
  return out;
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v: Vec3): Vec3 => {
  const n = Math.hypot(...v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState<HandlePrompt | null>(null);
  const readout = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);

  const state = useEditor((s) => s);
  const { prefs, placing, selection, busy, aligning, editing, mating, pose } = state;
  // The test drive: while it runs, the links are drawn where the simulation has them.
  useSyncExternalStore(sim.subscribe, sim.getRevision);
  const driven = sim.get();
  const simFrames = driven.status === 'ready' && driven.frames.size > 0 ? driven.frames : null;
  useEffect(() => sim.check(state.doc, state.robot), [state.doc.scene, state.doc.robot, state.robot]);
  const highlight = state.highlight;
  // The joint markers sit where the design has the joints; while the simulation moves the links they would mislead, so they rest.
  // The sensors ride their links instead, a lidar's rays reaching to what they read, so a tilt or a range can be judged on the move.
  const marker = useMemo(() => (simFrames ? null : robotMarker(state)), [state.joint, state.sensor, state.doc, simFrames]);
  const markers = useMemo(() => (simFrames ? drivenMarkers(state, simFrames, driven.readings) : robotMarkers(state)), [state.robot, state.joint, state.sensor, state.doc, state.prefs.robotMarkers, simFrames, driven.readings]);
  // The picked camera's picture, from where the design has it or, while the test drive runs, from where the simulation carries it.
  const preview = useMemo(() => {
    if (!state.robot || !state.sensor) return null;
    const mk = simFrames ? markers?.find((d) => d.id === state.sensor)?.marker : marker;
    return mk?.kind === 'camera' ? mk : null;
  }, [state.robot, state.sensor, simFrames, marker, markers]);
  const ground = useMemo(() => (simFrames && driven.world !== 'flat' ? { world: driven.world, forward: driven.drive?.forward ?? ([0, 1, 0] as Vec3) } : null), [simFrames, driven.world, driven.drive]);
  // The view follows a driving robot: it moves by what the base moved since the last frame, and comes back when the drive ends.
  const followed = useRef<Vec3 | null>(null);
  useEffect(() => {
    const at = simFrames ? driven.base?.pos ?? null : null;
    const from = followed.current ?? [0, 0, 0];
    const to = at ?? [0, 0, 0];
    if (at || followed.current) viewer.current?.follow([to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
    followed.current = at;
  }, [driven.base, simFrames]);
  const snaps = useMemo(() => (state.jointPick ? jointSnaps(state) : null), [state.jointPick, state.joint, state.sensor, state.doc]);
  // Measure mode: the picks and what they say, for the plate to draw and the bar to show.
  const measuring = state.measuring;
  const measureResult = useMemo(() => {
    if (!measuring) return null;
    const [a, b] = measuring.picks;
    return b ? measureBetween(a, b) : a ? describeFeature(a) : null;
  }, [measuring]);
  const measure = useMemo(() => (measuring ? { kinds: measuring.kinds, picks: measuring.picks, result: measureResult } : null), [measuring, measureResult]);
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
        onSnapHover: () => undefined,
        onSnapPick: (index) => {
          const point = jointSnaps(getState())[index];
          if (point) pickJointSnap(point);
        },
        onMarkerMove: dragMarker,
        onMarkerDrop: endMarkerDrag,
        onMeasurePick: pickMeasure,
        onMarkerPick: (id) => {
          const robot = getState().doc.robot;
          if (robot?.joints.some((j) => j.id === id)) selectJoint(id);
          else if (robot?.sensors.some((x) => x.id === id)) selectSensor(id);
        },
      },
      { theme: prefs.theme, edges: prefs.edges, grid: prefs.grid, snap: prefs.snap },
    );
    viewer.current = viewerRef.current = v;
    provideThumbnail((only) => v.capture(320, 200, only));
    return () => {
      provideThumbnail(null);
      v.dispose();
      viewer.current = viewerRef.current = null;
    };
    // The viewer is created once; later option changes go through setOptions.
  }, []);

  useEffect(() => {
    viewer.current?.setOptions({ theme: prefs.theme, edges: prefs.edges, grid: prefs.grid, snap: prefs.snap, interactive: true, align: aligning, highlight, snaps, marker, markers, ground, preview, measure });
  }, [prefs.theme, prefs.edges, prefs.grid, prefs.snap, aligning, highlight, snaps, marker, markers, ground, preview, measure]);

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
    // A posed robot is drawn with its links moved; the geometry is the same, only the matrices change.
    const shown = simFrames ? posedScene(scene, simFrames) : pose ? posedScene(scene, pose.solved.frames) : scene;
    // A ghosted object is drawn faintly and ignored by picking, like a shape being placed.
    const list: ViewItem[] = shown.map((node) => ({ node, result: ready(node), selected: picked.has(node.id), ...(node.ghost ? { ghost: true } : {}) }));
    if (placing) list.push({ node: placing, result: ready(placing), selected: false, ghost: true });
    return list;
    // `revision` changes when geometry arrives.
  }, [scene, selection, placing, revision, pose, simFrames]);

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
      {measuring && !placing && <MeasureBar kinds={measuring.kinds} picks={measuring.picks.length} result={measureResult?.lines ?? null} />}

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
