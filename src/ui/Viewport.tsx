import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, JSX } from 'react';
import { tr, trx } from '../i18n';
import { rich } from '../i18n/rich';
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
  toggleObjectAxes,
  setMeasureKinds,
  pickMeasure,
  toggleSelected,
  undo,
  ungroupSelected,
  unghostAll,
  useEditor,
} from '../state/store';
import { apply, cross, multiply, rotation, unit } from '../model/math';
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
  ObjectAxesIcon,
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
import { pressedByTouch, recentTouch, selectOnFocus } from './Fields';
import { enterByTouch, keyboardAttached, openTouchEntry } from './TouchEntry';
import { groupKeys, tip } from './keymap';
import type { CommandId } from './keymap';
import { Popover } from './Popover';
import { MatePanel } from './MatePanel';
import { placeReadout } from './readout';
import { TransformBox } from './TransformBox';
import { commitTyping } from './typing';

const VIEWS: { id: ViewPreset; label: string }[] = [
  { id: 'iso', label: '3D' },
  { id: 'top', label: trx('view', 'Top') },
  { id: 'front', label: trx('view', 'Front') },
  { id: 'side', label: trx('view', 'Side') },
];


/** The keymap's command behind each button of the Mirror panel, by axis. */
const MIRRORS: CommandId[] = ['mirrorX', 'mirrorY', 'mirrorZ'];

/** The viewer other parts of the app may talk to (fit to view from a shortcut, cancel a drag). */
export const viewerRef: { current: Viewer | null } = { current: null };

function Actions() {
  // How many objects are picked and whether a group is among them is all the buttons go by, so that
  // a drag, which changes the scene on every move, leaves the bar as it is.
  const count = useEditor((s) => (s.selection.length ? s.doc.scene.reduce((n, node) => n + (s.selection.includes(node.id) ? 1 : 0), 0) : 0));
  const hasGroup = useEditor((s) => s.selection.length > 0 && s.doc.scene.some((n) => n.type === 'group' && s.selection.includes(n.id)));
  const aligning = useEditor((s) => Boolean(s.aligning));
  const measuring = useEditor((s) => Boolean(s.measuring));
  const objectAxes = useEditor((s) => s.objectAxes);
  /** A picked joint or sensor lines up with an object's box, on its own. */
  const marker = useEditor((s) => Boolean(s.joint || s.sensor));
  const ghosts = useEditor(hasGhosts);
  const none = count === 0;

  return (
    <>
      <div className="tool-group">
        <button type="button" className="chip icon" title={tip('group')} aria-label={trx('verb', 'Group')} disabled={count < 2} onClick={() => void groupSelected()}>
          <GroupIcon />
        </button>
        <button type="button" className="chip icon" title={tip('ungroup')} aria-label={tr('Ungroup')} disabled={!hasGroup} onClick={ungroupSelected}>
          <UngroupIcon />
        </button>
      </div>
      <div className="tool-group">
        <button
          type="button"
          className={aligning ? 'chip icon on' : 'chip icon'}
          title={tip('align')}
          aria-label={tr('Align')}
          aria-pressed={aligning}
          disabled={count < 2 && !aligning && !marker}
          onClick={toggleAligning}
        >
          <AlignIcon />
        </button>
        <button type="button" className={measuring ? 'chip icon on' : 'chip icon'} title={tip('measure')} aria-label={tr('Measure')} aria-pressed={measuring} onClick={toggleMeasuring}>
          <RulerIcon />
        </button>
        <button type="button" className={objectAxes ? 'chip icon on' : 'chip icon'} title={tip('objectAxes')} aria-label={tr('Object axes')} aria-pressed={objectAxes} onClick={toggleObjectAxes}>
          <ObjectAxesIcon />
        </button>
        <Popover className="chip icon" title={tr('Mirror ({keys})', { keys: groupKeys('Mirror') })} button={<MirrorIcon />} disabled={none} align="right">
          {() => (
            <div className="align-panel">
              <p>{tr('Mirrors the selection across the chosen axis.')}</p>
              <div className="segmented">
                {(['X', 'Y', 'Z'] as const).map((label, axis) => (
                  <button key={label} type="button" title={tip(MIRRORS[axis])} onClick={() => mirrorSelected(axis as 0 | 1 | 2)}>
                    {tr('Flip {axis}', { axis: label })}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Popover>
        <button type="button" className="chip icon" title={tip('drop')} aria-label={tr('Drop onto the plate')} disabled={none} onClick={dropSelected}>
          <DropIcon />
        </button>
      </div>
      <div className="tool-group">
        <button type="button" className="chip icon" title={tip('ghost')} aria-label={trx('verb', 'Ghost')} disabled={none} onClick={ghostSelected}>
          <GhostIcon />
        </button>
        <button type="button" className="chip icon" title={tip('unghostAll')} aria-label={tr('Un-ghost all')} disabled={!ghosts} onClick={unghostAll}>
          <UnghostIcon />
        </button>
      </div>
      <div className="tool-group">
        <button type="button" className="chip icon" title={tip('duplicate', tr('Duplicate in place'))} aria-label={tr('Duplicate')} disabled={none} onClick={duplicateSelected}>
          <DuplicateIcon />
        </button>
        <Popover className="chip icon" title={tr('Array')} button={<ArrayIcon />} disabled={none} align="right">
          {(close) => <ArrayPanel close={close} />}
        </Popover>
        <button type="button" className="chip icon" title={tip('delete')} aria-label={tr('Delete')} disabled={none} onClick={deleteSelected}>
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
      <div className="measure-kinds" role="group" aria-label={tr('Snaps')}>
        {FEATURE_KINDS.map((k) => {
          const Snap = SNAP_ICONS[k.id];
          return (
            <button key={k.id} type="button" className={kinds.includes(k.id) ? 'chip icon on' : 'chip icon'} aria-pressed={kinds.includes(k.id)} aria-label={k.label} title={tr('{label}: {help}', { label: k.label, help: k.help })} onClick={() => toggle(k.id)}>
              <Snap />
            </button>
          );
        })}
      </div>
      <span className="measure-result">{result ? result.join(' · ') : picks === 0 ? tr('Click a point, edge, face or circle, then another · Esc to finish') : tr('Click another feature to measure to it')}</span>
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
      <button type="button" className="chip icon" title={tip('undo')} aria-label={tr('Undo')} disabled={!canUndo} onClick={undo}>
        <UndoIcon />
      </button>
      <button type="button" className="chip icon" title={tip('redo')} aria-label={tr('Redo')} disabled={!canRedo} onClick={redo}>
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
const ViewWidget = memo(function ViewWidget({ viewer }: { viewer: React.RefObject<Viewer | null> }) {
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
        <div className="segmented small" role="group" aria-label={tr('Camera view')}>
          {VIEWS.map((v) => (
            <button key={v.id} type="button" onClick={() => viewer.current?.setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        <button type="button" className="chip icon" title={tip('fit')} aria-label={tr('Fit to view')} onClick={() => viewer.current?.fit()}>
          <FitIcon />
        </button>
      </div>
    </div>
  );
});

/**
 * Boxes on the object's edges after a grip was clicked: type the value(s),
 * Enter applies them as if the grip had been dragged there.
 */
function HandleInput({ prompt, onClose }: { prompt: HandlePrompt; onClose: () => void }) {
  const [texts, setTexts] = useState(prompt.fields.map((f) => String(Number(f.value.toFixed(3)))));
  /** The box being typed in, in place or in the entry sheet: it and the length it sets are lit. */
  const [focused, setFocused] = useState(0);
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
      label: prompt.fields.length > 1 ? tr('{name} ({index} of {count})', { name: f.name, index: i + 1, count: prompt.fields.length }) : f.name,
      value: texts[i],
      unit: prompt.unit,
      inputMode: 'decimal',
      onCommit: (raw) => {
        const next = texts.map((t, j) => (j === i ? raw : t));
        setTexts(next);
        // With two boxes, the second is asked for next; the last one applies.
        if (i + 1 < prompt.fields.length) setTimeout(() => openEntry(i + 1), 0);
        else submitWith(next);
      },
      onCancel: onClose,
    };
  };
  const openEntry = (i: number) => {
    setFocused(i);
    openTouchEntry(entryOf(i));
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
    else if (!keyboardAttached()) openEntry(0);
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
      {origin && <PromptSpans fields={prompt.fields} focused={focused} origin={origin} />}
      {prompt.fields.map((f, i) => (
        <label
          key={f.tag}
          className={`readout prompt${i === focused ? ' focused' : ''}`}
          style={{ left: `${f.clientX - (origin?.left ?? 0)}px`, top: `${f.clientY - (origin?.top ?? 0)}px`, visibility: origin ? undefined : 'hidden', '--dim': f.color } as CSSProperties}
        >
          <span className="tag">{f.tag}</span>
          <input
            aria-label={f.name}
            value={texts[i]}
            spellCheck={false}
            inputMode="decimal"
            onPointerDown={(e) => {
              setFocused(i);
              enterByTouch(e, entryOf(i));
            }}
            onFocus={(e) => {
              setFocused(i);
              selectOnFocus(e);
            }}
            onChange={(e) => setTexts(texts.map((t, j) => (j === i ? e.target.value : t)))}
            onKeyDown={(e) => {
              // With two boxes and no button, Enter would not submit the form on its own.
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') onClose();
              else if (e.key === 'Tab') {
                // Tab goes round the handle's own boxes and never leaves for the rest of the page.
                e.preventDefault();
                const boxes = host.current?.querySelectorAll('input');
                const n = boxes?.length ?? 0;
                if (n > 1) boxes?.[(i + (e.shiftKey ? n - 1 : 1)) % n]?.focus();
              }
              e.stopPropagation();
            }}
          />
          <span className="unit">{prompt.unit}</span>
        </label>
      ))}
    </form>
  );
}

/** On-screen length of the ticks across the ends of a lit length, in pixels. */
const SPAN_TICK = 7;

/**
 * What the typing boxes set, drawn over the view: each length as a dimension line with ticks across its
 * ends, a turn as the line it goes about, in its axis's color; the one being typed bold, the others faint.
 */
function PromptSpans({ fields, focused, origin }: { fields: HandlePrompt['fields']; focused: number; origin: { left: number; top: number } }) {
  return (
    <svg className="prompt-spans" aria-hidden="true">
      {fields.map((f, i) => {
        if (!f.ends || !f.span) return null;
        const [[x0, y0], [x1, y1]] = f.ends.map(([x, y]) => [x - origin.left, y - origin.top]);
        const length = Math.hypot(x1 - x0, y1 - y0);
        if (length < 1) return null;
        const nx = (-(y1 - y0) / length) * SPAN_TICK;
        const ny = ((x1 - x0) / length) * SPAN_TICK;
        const on = i === focused;
        return (
          <g key={f.tag} className={on ? 'on' : undefined} style={{ color: f.color }}>
            <line className="halo" x1={x0} y1={y0} x2={x1} y2={y1} />
            <line className={f.span.axis ? 'axis' : undefined} x1={x0} y1={y0} x2={x1} y2={y1} />
            {!f.span.axis &&
              [
                [x0, y0],
                [x1, y1],
              ].map(([x, y], end) => <line key={end} x1={x - nx} y1={y - ny} x2={x + nx} y2={y + ny} />)}
          </g>
        );
      })}
    </svg>
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
  const y = unit(cross(axis, pick));
  const x = cross(y, axis);
  const matrix: Mat = [x[0], x[1], x[2], y[0], y[1], y[2], axis[0], axis[1], axis[2], origin[0], origin[1], origin[2]];
  return { kind: 'joint', type: joint.type, matrix };
}

/** What of the editor's state the markers are worked out from. */
type MarkerState = Pick<EditorState, 'doc' | 'robot' | 'joint' | 'sensor' | 'prefs'>;

/** The picked joint or sensor. */
function robotMarker(s: MarkerState): Marker | null {
  const sensor = s.sensor ? s.doc.robot?.sensors.find((x) => x.id === s.sensor) : undefined;
  const link = sensor && s.doc.scene.find((n) => n.id === sensor.link);
  if (sensor && link) return sensorMarkerOf(sensor, link);
  const joint = s.joint ? s.doc.robot?.joints.find((j) => j.id === s.joint) : undefined;
  const child = joint && s.doc.scene.find((n) => n.id === joint.child);
  return joint && child ? jointMarkerOf(joint, child) : null;
}

/** Every other joint and sensor, for Robot mode when it shows them all. */
function robotMarkers(s: MarkerState): { id: string; marker: Marker }[] | null {
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
function drivenMarkers(s: MarkerState, frames: Map<string, Mat>, readings: Map<string, number[]>): { id: string; marker: Marker }[] | null {
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

/**
 * The bar over the plate. It is its own component, drawn again only for what it shows: the viewport
 * around it is drawn again on every move of a drag.
 */
const Toolbar = memo(function Toolbar() {
  const edges = useEditor((s) => s.prefs.edges);
  const grid = useEditor((s) => s.prefs.grid);
  const snap = useEditor((s) => s.prefs.snap);
  // On a narrow stage the bar wraps onto a second row; what sits under it is told how tall it is.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    const host = el?.closest<HTMLElement>('.viewport');
    if (!el || !host) return;
    const tell = () => host.style.setProperty('--bar', `${el.offsetHeight}px`);
    tell();
    const watch = new ResizeObserver(tell);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return (
    <div className="view-toolbar">
      <div className="toolbar" role="toolbar" aria-label={tr('Tools')} ref={bar}>
        <History />
        <div className="tool-group">
          <button type="button" className={edges ? 'chip on' : 'chip'} aria-pressed={edges} onClick={() => setPrefs({ edges: !edges })}>
            {tr('Edges')}
          </button>
          <button type="button" className={grid ? 'chip on' : 'chip'} aria-pressed={grid} onClick={() => setPrefs({ grid: !grid })}>
            {tr('Grid')}
          </button>
          <label className="chip select" title={tr('Sets the step that moves and sizes snap to.')}>
            {tr('Snap')}
            <select value={snap} onChange={(e) => setPrefs({ snap: Number(e.target.value) })}>
              {SNAP_STEPS.map((s) => (
                <option key={s} value={s}>
                  {s === 0 ? trx('snap', 'Off') : `${s} mm`}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </label>
        </div>
        <Actions />
      </div>
    </div>
  );
});

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState<HandlePrompt | null>(null);
  const readout = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);

  // Each piece of the editor's state on its own, so that a change to the rest (a notice, a save) draws nothing here.
  const prefs = useEditor((s) => s.prefs);
  const placing = useEditor((s) => s.placing);
  const selection = useEditor((s) => s.selection);
  const busy = useEditor((s) => s.busy);
  const aligning = useEditor((s) => s.aligning);
  const editing = useEditor((s) => s.editing);
  const mating = useEditor((s) => s.mating);
  const pose = useEditor((s) => s.pose);
  const doc = useEditor((s) => s.doc);
  const robot = useEditor((s) => s.robot);
  const joint = useEditor((s) => s.joint);
  const sensor = useEditor((s) => s.sensor);
  const jointPick = useEditor((s) => s.jointPick);
  const state = useMemo(() => ({ doc, robot, joint, sensor, prefs }), [doc, robot, joint, sensor, prefs]);
  // The test drive: while it runs, the links are drawn where the simulation has them.
  useSyncExternalStore(sim.subscribe, sim.getRevision);
  const driven = sim.get();
  const simFrames = driven.status === 'ready' && driven.frames.size > 0 ? driven.frames : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the objects and the robot are what the drive depends on; a new name or thumbnail must not look it over again
  useEffect(() => sim.check(doc, robot), [doc.scene, doc.robot, robot]);
  const highlight = useEditor((s) => s.highlight);
  // The joint markers sit where the design has the joints; while the simulation moves the links they would mislead, so they rest.
  // The sensors ride their links instead, a lidar's rays reaching to what they read, so a tilt or a range can be judged on the move.
  const marker = useMemo(() => (simFrames ? null : robotMarker(state)), [state, simFrames]);
  const markers = useMemo(() => (simFrames ? drivenMarkers(state, simFrames, driven.readings) : robotMarkers(state)), [state, simFrames, driven.readings]);
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
  // The store's own state is the one these were read from: the snap points follow the same four things.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- joint, sensor and doc are not read here but say when the store's state, which is, has changed
  const snaps = useMemo(() => (jointPick ? jointSnaps(getState()) : null), [jointPick, joint, sensor, doc]);
  // Measure mode: the picks and what they say, for the plate to draw and the bar to show.
  const measuring = useEditor((s) => s.measuring);
  const measureResult = useMemo(() => {
    if (!measuring) return null;
    const [a, b] = measuring.picks;
    return b ? measureBetween(a, b) : a ? describeFeature(a) : null;
  }, [measuring]);
  const measure = useMemo(() => (measuring ? { kinds: measuring.kinds, picks: measuring.picks, result: measureResult } : null), [measuring, measureResult]);
  const objectAxes = useEditor((s) => s.objectAxes);
  // Another selection, or an edit from elsewhere, and the typing boxes no longer belong to anything.
  useEffect(() => {
    viewer.current?.dismissPrompt();
  }, [selection, editing]);
  const scene = doc.scene;
  const assets = doc.assets;
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
          // Beside the pointer and inside the view; above a finger, which would cover it.
          const rect = host.current!.getBoundingClientRect();
          const { left, top } = placeReadout({ x: x - rect.left, y: y - rect.top }, { width: el.offsetWidth, height: el.offsetHeight }, rect, pressedByTouch());
          el.style.left = `${left}px`;
          el.style.top = `${top}px`;
        },
        boundsOf: (node) => geometry.bounds(node),
        onAlignHover: previewAlign,
        onAlignPick: commitAlign,
        onAnchor: setAlignAnchor,
        onHandleClick: setPrompt,
        onSnapPick: (index) => {
          const point = jointSnaps(getState())[index];
          if (point) pickJointSnap(point);
        },
        onMarkerMove: dragMarker,
        onMarkerDrop: endMarkerDrag,
        onMeasurePick: pickMeasure,
        // Two fingers tapped on the plate undo and three redo; the viewer is told whether there was a step to take.
        onHistory: (step) => {
          const can = step === 'undo' ? getState().canUndo : getState().canRedo;
          if (can) (step === 'undo' ? undo : redo)();
          return can;
        },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- made once, with the options as they stand then
  }, []);

  useEffect(() => {
    viewer.current?.setOptions({ theme: prefs.theme, edges: prefs.edges, grid: prefs.grid, snap: prefs.snap, align: aligning, highlight, snaps, marker, markers, ground, preview, measure, objectAxes });
  }, [prefs.theme, prefs.edges, prefs.grid, prefs.snap, aligning, highlight, snaps, marker, markers, ground, preview, measure, objectAxes]);

  const carrying = Boolean(placing);
  useEffect(() => {
    viewer.current?.setPlacing(carrying);
  }, [carrying]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` is not read here: it changes when geometry arrives, which `ready` then finds
  }, [scene, selection, placing, revision, pose, simFrames]);

  useEffect(() => {
    viewer.current?.setItems(items, assets);
  }, [items, assets]);

  // A different design on screen: frame it.
  const shownKey = useEditor((s) => s.epoch);
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
      if (entry?.state === 'error') out.push(tr('{name}: {message}', { name: node.name, message: entry.message }));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` changes when a build ends, well or badly
  }, [scene, revision]);

  return (
    <div className="viewport">
      <div
        className="canvas-host"
        ref={host}
        // A value still being typed in a box is taken before the press changes the selection under it.
        onPointerDownCapture={(e) => {
          if (e.button === 0) commitTyping();
        }}
      />
      <div className="readout" ref={readout} hidden />
      {prompt && <HandleInput key={JSON.stringify(prompt.kind)} prompt={prompt} onClose={() => viewer.current?.dismissPrompt()} />}
      <Toolbar />
      <ViewWidget viewer={viewer} />

      {editing && (
        <div className="mode-banner" role="status">
          <span>{rich('Editing inside {name}', { name: <strong>{editing.layers[0]?.name}</strong> })}</span>
          <button type="button" className="chip on" disabled={Boolean(busy)} onClick={() => void finishEditing()}>
            {tr('Done')}
          </button>
          <button type="button" className="chip" disabled={Boolean(busy)} onClick={cancelEditing}>
            {tr('Cancel')}
          </button>
        </div>
      )}
      {placing && <div className="hint-bar">{tr('Click on the plate to place the {name} · Esc to cancel', { name: placing.name.toLowerCase() })}</div>}
      {aligning && !placing && (
        <div className="hint-bar">
          {aligning.anchor ? tr('Aligning to the anchor · click an object to set the anchor · Esc to finish') : tr('Click a dot to align · click an object to set the anchor · Esc to finish')}
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
