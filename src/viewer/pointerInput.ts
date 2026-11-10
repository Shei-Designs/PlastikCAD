// Pointer input on the plate: what a press takes hold of (a grip, an object,
// a marker, a feature to measure, or nothing), the drag that follows, and the
// edit it reports. Which presses are the camera's, and which are the hand that
// holds the pen, is settled in gesture.ts; the sums of each drag are in
// dragMath.ts; a tap of two or three fingers is told in multiTap.ts.
import { Plane, Vector3 } from 'three';
import type { Feature } from '../geometry/features';
import { boundsCenter, tidy, tidyVec } from '../model/math';
import type { Mat } from '../model/math';
import { rotateNodes } from '../model/ops';
import type { SceneNode, Vec3 } from '../model/types';
import type { CameraRig } from './camera';
import { MIN_SIZE, ROTATE_COARSE, ROTATE_STEP, alongAxis, angleAbout, baseEdgeOn, bestBaseAxis, boxAxis, gripBox, pointOf, resizePoint, snapTo, snapTurn, stretched } from './dragMath';
import type { GripBox } from './dragMath';
import { LONG_PRESS_MS, NO_PEN, penHeard, pressOwner } from './gesture';
import type { PenState, PressPhase } from './gesture';
import type { Handle, Handles } from './handles';
import type { MeasureOverlay } from './measureOverlay';
import { TapWatch } from './multiTap';
import type { HistoryStep } from './multiTap';
import type { HandlePrompts } from './prompt';
import type { MarkerDrag, RobotOverlay } from './robotOverlay';
import type { SceneSync } from './sceneSync';
import { fmt, setRay } from './stage';
import type { Stage } from './stage';
import { TouchFeedback } from './touchFeedback';
import type { HandleKind } from './types';

const DRAG_THRESHOLD = 4; // px
/** A finger wobbles more than a mouse before it means to drag. */
const TOUCH_DRAG_THRESHOLD = 10; // px
const dragThreshold = (event: PointerEvent) => (event.pointerType === 'touch' ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD);
/** What the pen is heard by, in the whole window. */
const PEN_EVENTS = ['pointerdown', 'pointermove', 'pointerover', 'pointerup', 'pointercancel', 'pointerout'] as const;

type Drag =
  /** `select` is the node a finger landed on, selected only once the press turns out to be a tap or a drag (a long press adds it instead). */
  | { mode: 'pending-move'; x: number; y: number; nodes: SceneNode[]; plane: Plane; origin: Vector3; select?: string }
  /** A finger on empty space: the camera has it unless it lifts without moving (clears the selection) or stays put (box selection). */
  | { mode: 'pending-tap'; x: number; y: number }
  /** Measuring, a finger on a feature: picked once the finger lifts, since a second finger makes it a camera gesture instead. */
  | { mode: 'pending-pick'; x: number; y: number; feature: Feature | null }
  | { mode: 'move'; nodes: SceneNode[]; plane: Plane; origin: Vector3 }
  | { mode: 'pending-marquee'; x: number; y: number; additive: boolean }
  | { mode: 'marquee'; x: number; y: number; additive: boolean }
  /** `axisOnly` restricts a corner grip to one base axis when the base is seen edge-on and the other cannot be followed. */
  | { mode: 'resize'; box: GripBox; nodes: SceneNode[]; sx: number; sy: number; grab: Vector3; axisOnly?: 0 | 1 }
  /** A grip pressed from an angle it cannot be dragged from: a click still brings up its typing boxes. */
  | { mode: 'held' }
  | { mode: 'height'; box: GripBox; nodes: SceneNode[]; side: 1 | -1; grab: number }
  /** `dir` is the axis in the scene: a design axis, or the object's own with Object axes on. */
  | { mode: 'slide'; nodes: SceneNode[]; origin: Vector3; axis: 0 | 1 | 2; dir: Vector3; grab: number }
  /** `frame`: the turn of the object whose own axis it goes about (Object axes); none for a design axis. */
  | { mode: 'rotate'; nodes: SceneNode[]; axis: 0 | 1 | 2; pivot: Vec3; start: number | null; x: number; frame?: Mat }
  /** The picked joint or sensor dragged along one of the design's axes by its arrow, or along its own axis by the rod. */
  | ({ mode: 'marker' } & MarkerDrag)
  | { mode: 'place' };

/** The other parts of the viewer a press may take hold of, or must tell. */
export interface PointerPeers {
  objects: SceneSync;
  handles: Handles;
  prompts: HandlePrompts;
  measure: MeasureOverlay;
  robot: RobotOverlay;
  rig: CameraRig;
}

export class PointerInput {
  drag: Drag | null = null;
  private marquee: HTMLElement | null = null;
  /** How many of the selection a gesture in progress leaves behind for being locked; said in the readout. */
  private heldBack = 0;
  private longPress: ReturnType<typeof setTimeout> | undefined;
  /** The handle just pressed, until the pointer has moved far enough to count as a drag. */
  private press: { handle: Handle; x: number; y: number } | null = null;
  /** The pointer the current drag was started with: another finger neither steers it nor ends it. */
  private dragPointer = -1;
  /** Its kind ('mouse', 'pen', 'touch') and where it was last seen, in the window. */
  private dragType = '';
  private dragAt = { x: 0, y: 0 };
  /** The fingers the camera is following: those that went down on empty space, or joined one that had. */
  private cameraTouches = new Set<number>();
  /** Whether the press being handled was kept from the camera. */
  private claimed = false;
  /** True while a finger is being handed to the camera. */
  private handing = false;
  /** What has been heard of the pen: the hand that holds one rests on the screen, and is not a finger. */
  private pen: PenState = NO_PEN;
  /** The touches that landed while the pen was about: ignored until they lift. */
  private palms = new Set<number>();
  /** What the fingers on the plate have done, for telling a tap of two or three. */
  private readonly taps = new TapWatch();
  private readonly feedback: TouchFeedback;

  constructor(
    private readonly stage: Pick<Stage, 'container' | 'renderer' | 'camera' | 'controls' | 'raycaster' | 'pointer' | 'events' | 'options' | 'items' | 'placing'>,
    private readonly peers: PointerPeers,
  ) {
    this.feedback = new TouchFeedback(stage.container);
  }

  /** Starts listening on the canvas. */
  listen(): void {
    const canvas = this.stage.renderer.domElement;
    // Captured, so that an edit can start before OrbitControls sees the press: a finger on a grip or
    // an object must not also turn the camera, as a finger on empty space does.
    canvas.addEventListener('pointerdown', this.onPointerDown, true);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('lostpointercapture', this.onLostCapture);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    // The pen is heard in the whole window: it may hover over a panel while the hand rests on the plate.
    for (const type of PEN_EVENTS) window.addEventListener(type, this.onPen, { capture: true, passive: true });
    window.addEventListener('blur', this.onWindowBlur);
  }

  unlisten(): void {
    const canvas = this.stage.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown, true);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('lostpointercapture', this.onLostCapture);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    for (const type of PEN_EVENTS) window.removeEventListener(type, this.onPen, { capture: true });
    window.removeEventListener('blur', this.onWindowBlur);
  }

  /** Takes the box-selection rectangle and what a finger is shown out of the page. */
  removeOverlays(): void {
    this.marquee?.remove();
    this.feedback.remove();
  }

  /** Whether an edit is under way, rather than a press that may yet become one or a box selection. */
  get editing(): boolean {
    return this.drag !== null && this.drag.mode !== 'pending-move' && this.drag.mode !== 'pending-tap' && this.drag.mode !== 'pending-pick' && this.drag.mode !== 'pending-marquee' && this.drag.mode !== 'marquee';
  }

  /** The live measurement beside the pointer, with a word on what the drag leaves behind. */
  private say(text: string, event: PointerEvent): void {
    const n = this.heldBack;
    this.stage.events.onReadout(n ? `${text} · ${n} locked ${n === 1 ? 'stays' : 'stay'} put` : text, event.clientX, event.clientY);
  }

  /** Abandon the drag in progress, if any. Returns whether there was one. */
  cancel(): boolean {
    const drag = this.drag;
    if (!drag) return false;
    this.drag = null;
    this.press = null;
    this.hideMarquee();
    this.stage.events.onReadout(null, 0, 0);
    this.endHold();
    if (drag.mode !== 'pending-move' && drag.mode !== 'pending-tap' && drag.mode !== 'pending-pick' && drag.mode !== 'pending-marquee' && drag.mode !== 'marquee' && drag.mode !== 'place') {
      this.stage.events.onGestureEnd(true);
    }
    return true;
  }

  private readonly onPen = (event: PointerEvent): void => {
    if (event.pointerType !== 'pen') return;
    const { type } = event;
    if (type === 'pointerdown') this.pen = penHeard(this.pen, 'down', event.timeStamp);
    else if (type === 'pointerup' || type === 'pointercancel') this.pen = penHeard(this.pen, 'up', event.timeStamp);
    // Leaving one element for the next is not leaving the screen: only a pen that goes nowhere has gone.
    else if (type !== 'pointerout') this.pen = penHeard(this.pen, 'near', event.timeStamp);
    else if (!event.relatedTarget) this.pen = penHeard(this.pen, 'gone', event.timeStamp);
  };

  /** A window in the background hears nothing more of the pen: it starts again as unknown. */
  private readonly onWindowBlur = (): void => {
    this.pen = NO_PEN;
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    // The press being handed to the camera (see `handToCamera`) is on its way there.
    if (this.handing) return;
    const touch = event.pointerType === 'touch';
    // The first finger down means none was down before: any kept went unheard.
    if (touch && event.isPrimary) {
      this.cameraTouches.clear();
      this.palms.clear();
    }
    // As things stood before this press: a tap of fingers beside an edit, or a mouse or pen press, undoes nothing.
    const busy = this.drag !== null && (this.dragType !== 'touch' || this.pressPhase() === 'editing');
    this.claimed = false;
    this.startPress(event);
    if (touch && !this.palms.has(event.pointerId)) this.taps.down(event.pointerId, event.pointerType, event.clientX, event.clientY, event.timeStamp, event.isPrimary, busy);
    // A finger left unclaimed is one the camera follows from here on.
    if (touch && !this.claimed) this.cameraTouches.add(event.pointerId);
    // A pen or mouse pressed while fingers turn the camera is kept from it: the controls take a left press as the end of the turn.
    else if (!touch && event.button === 0 && this.cameraTouches.size > 0) event.stopImmediatePropagation();
  };

  /** True for a touch that landed while the pen was about, which is kept from the camera as well. */
  private palm(event: PointerEvent): boolean {
    if (!this.palms.has(event.pointerId)) return false;
    event.stopImmediatePropagation();
    return true;
  }

  /** Two fingers tapped take the last step back, three bring it again; the middle of the view says which. */
  private history(step: HistoryStep): void {
    const taken = this.stage.events.onHistory(step);
    this.feedback.say(taken ? (step === 'undo' ? 'Undo' : 'Redo') : `Nothing to ${step}`);
  }

  /** How far the viewer's own press has got, for `pressOwner`. */
  private pressPhase(): PressPhase {
    const drag = this.drag;
    if (!drag) return 'none';
    if (drag.mode === 'pending-tap') return 'tap';
    if (drag.mode === 'pending-move' || drag.mode === 'pending-pick' || drag.mode === 'pending-marquee' || drag.mode === 'place') return 'pending';
    // A grip pressed and not yet dragged.
    const grip = drag.mode === 'resize' || drag.mode === 'height' || drag.mode === 'slide' || drag.mode === 'rotate' || drag.mode === 'held';
    return grip && this.press ? 'pending' : 'editing';
  }

  /**
   * Calls off a press that has not become an edit and gives its finger to the camera, which was kept
   * from it when it went down: the camera is told of it now, where the finger is, so that the finger
   * landing next makes a pan or a pinch with it.
   */
  private handToCamera(): void {
    this.cancel();
    const canvas = this.stage.renderer.domElement;
    canvas.style.cursor = this.stage.placing ? 'copy' : '';
    this.handing = true;
    try {
      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: this.dragPointer, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: this.dragAt.x, clientY: this.dragAt.y }));
    } finally {
      this.handing = false;
    }
    this.cameraTouches.add(this.dragPointer);
  }

  private startPress(event: PointerEvent): void {
    // A camera button must not take the focus off a typing box: a pan keeps the boxes.
    if (event.button !== 0 && this.peers.prompts.current) event.preventDefault();
    const owner = pressOwner(
      { phase: this.pressPhase(), pointerId: this.dragPointer, pointerType: this.dragType, cameraTouches: this.cameraTouches.size, pen: this.pen },
      { pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: event.isPrimary, time: event.timeStamp },
    );
    switch (owner) {
      case 'camera':
        return;
      case 'palm':
        // The hand that holds the pen: neither ours nor the camera's, now and until it lifts.
        event.stopImmediatePropagation();
        this.claimed = true;
        this.palms.add(event.pointerId);
        return;
      case 'camera-drop-tap':
        // A second finger while the first rests on empty space makes a two-finger camera gesture (pan,
        // pinch): the press is the camera's from here on, not a tap or a long press.
        this.endHold();
        this.drag = null;
        return;
      case 'camera-handover':
        // The same with the first finger on an object or a grip: nothing has moved yet, so nothing does.
        this.handToCamera();
        return;
      case 'nobody':
        // A second finger during an edit is neither ours nor the camera's.
        event.stopImmediatePropagation();
        this.claimed = true;
        return;
      case 'viewer-afresh':
        // The last press never heard its pointer lift; it ends here, without effect.
        this.cancel();
        break;
      case 'viewer':
        break;
    }
    if (event.button !== 0) return;
    // Whatever the press does next, the boxes from the last click are stale.
    this.peers.prompts.dismiss();
    this.peers.rig.halt();
    const canvas = this.stage.renderer.domElement;
    canvas.setPointerCapture(event.pointerId);
    this.dragPointer = event.pointerId;
    this.dragType = event.pointerType;
    this.dragAt = { x: event.clientX, y: event.clientY };
    setRay(this.stage, event);

    // Whatever starts here is ours alone: the camera does not get the press as well.
    const claim = () => {
      event.stopImmediatePropagation();
      this.claimed = true;
    };
    if (this.stage.placing) {
      this.drag = { mode: 'place' };
      claim();
      return;
    }

    // Measuring, a press takes hold of a feature; on empty space it is the camera's.
    if (this.stage.options.measure) {
      const feature = this.peers.measure.pick(event);
      if (feature) {
        // A finger picks when it lifts: until then a second finger can still make it a pinch.
        if (event.pointerType === 'touch') this.drag = { mode: 'pending-pick', x: event.clientX, y: event.clientY, feature };
        else this.stage.events.onMeasurePick(feature);
        claim();
      }
      return;
    }
    const snap = this.peers.robot.pickSnap(event);
    if (snap !== null) {
      this.stage.events.onSnapPick(snap);
      claim();
      return;
    }
    const markerHandle = this.peers.robot.pickMarkerHandle(event);
    if (markerHandle !== null) {
      this.drag = { mode: 'marker', ...this.peers.robot.grab(markerHandle) };
      this.stage.renderer.domElement.style.cursor = 'move';
      claim();
      return;
    }
    const other = this.peers.robot.pickDimMarker();
    if (other !== null) {
      this.stage.events.onMarkerPick(other);
      claim();
      return;
    }
    const handle = this.peers.handles.pick(event);
    if (handle?.kind.type === 'align') {
      this.stage.events.onAlignPick(handle.kind.axis, handle.kind.mode);
      claim();
      return;
    }
    if (handle && this.peers.handles.frame) {
      this.startHandleDrag(handle, event);
      claim();
      return;
    }

    const hit = this.peers.objects.pick();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const touch = event.pointerType === 'touch';
    // In align mode a click on a selected object makes it the anchor instead of starting a drag; lining up a joint or sensor, any object will do.
    if (this.stage.options.align && hit && (hit.item.selected || this.stage.options.align.marker) && !additive) {
      this.stage.events.onAnchor(hit.item.node.id);
      claim();
      return;
    }
    if (!hit) {
      // Empty space: a mouse draws a marquee. A finger turns the camera (OrbitControls takes it from
      // here), unless it lifts without moving (a tap clears the selection) or stays put (box selection).
      if (!touch) this.drag = { mode: 'pending-marquee', x: event.clientX, y: event.clientY, additive };
      else {
        this.drag = { mode: 'pending-tap', x: event.clientX, y: event.clientY };
        this.holdFor(event, () => {
          this.stage.controls.enabled = false;
          this.drag = { mode: 'marquee', x: event.clientX, y: event.clientY, additive: true };
          this.showMarquee(event.clientX, event.clientY, event.clientX, event.clientY);
        });
      }
      return;
    }
    claim();
    const { node } = hit.item;
    if (additive) {
      this.stage.events.onSelect([node.id], 'toggle');
      return;
    }
    // Dragging something that is not selected yet selects it and moves it alone. A mouse selects it at
    // once; a finger only once the press turns out to be a tap or a drag, since a long press adds it instead.
    const selected = hit.item.selected ? this.stage.items.filter((i) => i.selected).map((i) => i.node) : [node];
    const later = touch && !hit.item.selected;
    if (!hit.item.selected && !later) this.stage.events.onSelect([node.id], 'replace');
    const movable = selected.filter((n) => !n.locked);
    this.heldBack = selected.length - movable.length;
    this.drag = {
      mode: 'pending-move',
      x: event.clientX,
      y: event.clientY,
      nodes: movable,
      plane: new Plane(new Vector3(0, 0, 1), -hit.point.z),
      origin: hit.point.clone(),
      ...(later ? { select: node.id } : {}),
    };
    if (touch) {
      this.holdFor(event, () => {
        // Held still on an object: it joins (or leaves) the selection, and nothing moves.
        this.drag = null;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        this.stage.events.onSelect([node.id], 'toggle');
      });
    }
  };

  /** Runs `then` if the finger is still down and has not moved by then; a ring at the finger fills meanwhile. */
  private holdFor(event: PointerEvent, then: () => void): void {
    clearTimeout(this.longPress);
    this.feedback.showRing(event.clientX, event.clientY);
    this.longPress = setTimeout(() => {
      this.longPress = undefined;
      this.feedback.hideRing();
      if (this.drag?.mode === 'pending-tap' || this.drag?.mode === 'pending-move') then();
    }, LONG_PRESS_MS);
  }

  endHold(): void {
    clearTimeout(this.longPress);
    this.longPress = undefined;
    this.feedback.hideRing();
  }

  private startHandleDrag(handle: Handle, event: PointerEvent): void {
    const f = this.peers.handles.frame!;
    const k = handle.kind;
    const nodes = this.stage.items.filter((i) => i.selected && !i.ghost && !i.node.locked).map((i) => i.node);
    if (nodes.length === 0) return;
    this.heldBack = this.stage.items.filter((i) => i.selected && !i.ghost && !i.node.hidden).length - nodes.length;
    const box = gripBox(f);
    if (k.type === 'resize') {
      // A corner grip seen with the base edge-on cannot follow both axes: it follows the one seen best.
      const axisOnly = k.sx !== 0 && k.sy !== 0 && baseEdgeOn(this.stage.raycaster.ray, box) ? bestBaseAxis(this.stage.raycaster.ray, box) : undefined;
      const grab = resizePoint(this.stage.raycaster.ray, box, k.sx, k.sy, axisOnly);
      const handleLocal = new Vector3(k.sx * f.half[0], k.sy * f.half[1], 0);
      this.drag = grab ? { mode: 'resize', box, nodes, sx: k.sx, sy: k.sy, grab: grab.sub(handleLocal), axisOnly } : { mode: 'held' };
    } else if (k.type === 'height') {
      // Measured from the end that stays put: the base for the top grip, the top for the bottom one.
      const t = alongAxis(this.stage.raycaster.ray, this.peers.handles.framePoint([0, 0, -k.side * f.half[2]]), boxAxis(box, 2));
      this.drag = t === null ? { mode: 'held' } : { mode: 'height', box, nodes, side: k.side, grab: t - k.side * box.size[2] };
    } else if (k.type === 'move') {
      const origin = handle.object.position.clone();
      const dir = this.peers.handles.frameAxis(k.axis);
      const t = alongAxis(this.stage.raycaster.ray, origin, dir);
      this.drag = t === null ? { mode: 'held' } : { mode: 'slide', nodes, origin, axis: k.axis, dir, grab: t };
    } else if (k.type === 'rotate') {
      const pivot: Vec3 = f.single ? [...f.single.pos] : boundsCenter(f.bounds);
      const frame = this.peers.handles.frameTurn();
      this.drag = { mode: 'rotate', nodes, axis: k.axis, pivot, start: angleAbout(this.stage.raycaster.ray, k.axis, pivot, frame), x: event.clientX, frame };
    } else {
      return;
    }
    this.stage.renderer.domElement.style.cursor = k.type === 'rotate' ? 'grabbing' : handle.cursor;
    this.press = { handle, x: event.clientX, y: event.clientY };
    this.stage.events.onGestureStart();
  }

  /** True for the pointer of the press or drag in progress. */
  private dragging(event: PointerEvent): boolean {
    return this.drag !== null && event.pointerId === this.dragPointer;
  }

  /**
   * The canvas no longer has the pointer and its release was never heard (the window lost it, say):
   * the press ends here as a cancel, or it would hold every later press off.
   */
  private readonly onLostCapture = (event: PointerEvent): void => {
    this.cameraTouches.delete(event.pointerId);
    this.palms.delete(event.pointerId);
    if (this.dragging(event)) this.cancel();
  };

  /** True for a pointer other than the one dragging, which is kept from the camera as well. */
  private otherPointer(event: PointerEvent): boolean {
    if (!this.drag || event.pointerId === this.dragPointer) return false;
    event.stopImmediatePropagation();
    return true;
  }

  /** Apply a typed value as if the handle had been dragged there (one undo step). */
  applyTyped(kind: HandleKind, values: number[]): void {
    const f = this.peers.handles.frame;
    if (!f || values.length === 0) return;
    const nodes = this.stage.items.filter((i) => i.selected && !i.ghost && !i.node.locked).map((i) => i.node);
    if (nodes.length === 0) return;
    let changed: SceneNode[] | null = null;
    const v = values[0];
    const box = gripBox(f);
    if (kind.type === 'height') {
      if (v >= MIN_SIZE) changed = stretched(box, nodes, [box.size[0], box.size[1], v], [0, 0, -kind.side]);
    } else if (kind.type === 'resize') {
      const size: Vec3 = [...box.size];
      const w = values[0];
      const d = values.length > 1 ? values[1] : values[0];
      if (kind.sx !== 0 && w >= MIN_SIZE) size[0] = w;
      if (kind.sy !== 0 && d >= MIN_SIZE) size[1] = d;
      changed = stretched(box, nodes, size, [-kind.sx as -1 | 0 | 1, -kind.sy as -1 | 0 | 1, 0]);
    } else if (kind.type === 'move' && kind.axis === 2 && !f.local) {
      const dz = v - f.bounds.min[2];
      changed = nodes.map((n) => ({ ...n, pos: [n.pos[0], n.pos[1], n.pos[2] + dz] as Vec3 }));
    } else if (kind.type === 'rotate') {
      const pivot: Vec3 = f.single ? [...f.single.pos] : boundsCenter(f.bounds);
      changed = rotateNodes(nodes, kind.axis, v, pivot, this.peers.handles.frameTurn());
    }
    if (!changed) return;
    this.stage.events.onGestureStart();
    this.stage.events.onGestureChange(changed);
    this.stage.events.onGestureEnd(false);
  }

  private snap(v: number): number {
    return snapTo(v, this.stage.options.snap);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.palm(event)) return;
    this.taps.move(event.pointerId, event.clientX, event.clientY);
    // A finger the camera is following does nothing else, unless it is also resting for a tap.
    if (this.cameraTouches.has(event.pointerId) && !this.dragging(event)) return;
    if (this.otherPointer(event)) return;
    const drag = this.drag;
    if (drag) this.dragAt = { x: event.clientX, y: event.clientY };
    setRay(this.stage, event);

    if (this.stage.placing) {
      this.stage.events.onPlaceMove(this.landingPoint());
      return;
    }
    if (!drag) {
      if (event.buttons === 0) {
        if (this.stage.options.measure) {
          this.peers.measure.hover(this.peers.measure.pick(event), event);
          return;
        }
        const snap = this.peers.robot.pickSnap(event);
        this.peers.robot.hoverSnap(snap);
        const markerHandle = snap === null ? this.peers.robot.pickMarkerHandle(event) : null;
        this.peers.robot.hoverArrow(markerHandle);
        this.peers.handles.hover(snap === null && markerHandle === null ? this.peers.handles.pick(event) : null);
        const other = snap === null && markerHandle === null && !this.peers.handles.hovered ? this.peers.robot.pickDimMarker() : null;
        const cursor = this.stage.renderer.domElement.style;
        if (snap !== null || other !== null) cursor.cursor = 'pointer';
        else if (markerHandle !== null) cursor.cursor = 'move';
        else if (!this.peers.handles.hovered && !this.stage.placing) cursor.cursor = '';
      }
      return;
    }
    if (this.press && Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) >= dragThreshold(event)) this.press = null;

    switch (drag.mode) {
      case 'held':
        return;
      case 'pending-tap':
        // The finger is moving: the camera has it after all.
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < dragThreshold(event)) return;
        this.endHold();
        this.drag = null;
        return;
      case 'pending-pick':
        // A finger that slides off was not a tap: nothing is picked.
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= dragThreshold(event)) drag.feature = null;
        return;
      case 'pending-move': {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < dragThreshold(event) || drag.nodes.length === 0) return;
        this.endHold();
        if (drag.select) this.stage.events.onSelect([drag.select], 'replace');
        this.drag = { mode: 'move', nodes: drag.nodes, plane: drag.plane, origin: drag.origin };
        this.stage.renderer.domElement.style.cursor = 'move';
        this.stage.events.onGestureStart();
        this.moveTo(this.drag, event);
        return;
      }
      case 'move':
        this.moveTo(drag, event);
        return;
      case 'pending-marquee':
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < dragThreshold(event)) return;
        this.drag = { ...drag, mode: 'marquee' };
        this.showMarquee(drag.x, drag.y, event.clientX, event.clientY);
        return;
      case 'marquee':
        this.showMarquee(drag.x, drag.y, event.clientX, event.clientY);
        return;
      case 'resize':
        this.resizeTo(drag, event);
        return;
      case 'height':
        this.heightTo(drag, event);
        return;
      case 'slide':
        this.slideTo(drag, event);
        return;
      case 'rotate':
        this.rotateTo(drag, event);
        return;
      case 'marker':
        this.peers.robot.dragTo(drag, event);
        return;
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.palm(event)) {
      this.palms.delete(event.pointerId);
      return;
    }
    // What the fingers did is known once the last has lifted; whatever the lift itself ends comes first.
    const step = event.type === 'pointerup' ? this.taps.up(event.pointerId, event.timeStamp) : null;
    if (event.type === 'pointercancel') this.taps.cancel(event.pointerId);
    this.release(event);
    if (step) this.history(step);
  };

  /** Ends whatever the lifted pointer was doing. */
  private release(event: PointerEvent): void {
    // A finger lifting from a pan or a pinch ends nothing here, and puts no carried shape down.
    const ours = this.dragging(event);
    if (this.cameraTouches.delete(event.pointerId) && !ours) return;
    if (this.otherPointer(event)) return;
    this.endHold();
    const drag = this.drag;
    this.drag = null;
    const canvas = this.stage.renderer.domElement;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!drag) {
      // A shape dragged in from the palette is put down where the button is released.
      if (this.stage.placing && event.type === 'pointerup' && event.button === 0) {
        setRay(this.stage, event);
        this.stage.events.onPlaceMove(this.landingPoint());
        this.stage.events.onPlaceCommit();
      }
      return;
    }
    canvas.style.cursor = this.stage.placing ? 'copy' : '';
    this.stage.events.onReadout(null, 0, 0);

    switch (drag.mode) {
      case 'place':
        if (event.type === 'pointerup') {
          setRay(this.stage, event);
          this.stage.events.onPlaceMove(this.landingPoint());
          this.stage.events.onPlaceCommit();
        }
        return;
      case 'pending-move':
        // A finger that tapped an object selects it.
        if (drag.select && event.type === 'pointerup') this.stage.events.onSelect([drag.select], 'replace');
        return;
      case 'pending-tap':
        if (event.type === 'pointerup') this.stage.events.onSelect([], 'replace');
        return;
      case 'pending-pick':
        if (event.type === 'pointerup' && drag.feature) this.stage.events.onMeasurePick(drag.feature);
        return;
      case 'pending-marquee':
        // A plain click on nothing clears the selection.
        if (!drag.additive) this.stage.events.onSelect([], 'replace');
        return;
      case 'marquee':
        this.stage.events.onSelect(this.insideMarquee(drag.x, drag.y, event.clientX, event.clientY), drag.additive ? 'add' : 'replace');
        this.hideMarquee();
        return;
      case 'marker':
        this.stage.events.onMarkerDrop();
        return;
      default: {
        // A press without a drag asks for the value instead.
        const press = this.press;
        this.press = null;
        if (press && event.type === 'pointerup') {
          this.stage.events.onGestureEnd(true);
          this.peers.prompts.show(press.handle);
          return;
        }
        this.stage.events.onGestureEnd(event.type === 'pointercancel');
      }
    }
  }

  private readonly onPointerLeave = (): void => {
    if (this.stage.placing && !this.drag) this.stage.events.onPlaceMove(null);
    this.peers.handles.hover(null);
    this.peers.robot.hoverSnap(null);
    this.peers.robot.hoverArrow(null);
    this.peers.measure.unhover();
  };

  /** Where a new shape would stand: on the flat top of whatever is under the pointer, else on the plate. */
  private landingPoint(): Vec3 | null {
    const hit = this.peers.objects.pick();
    let point: Vector3 | null = null;
    if (hit && hit.normal.z > 0.9 && !hit.item.node.hole) point = hit.point;
    else if (this.stage.raycaster.ray.direction.z < -0.02) point = this.stage.raycaster.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), 0), new Vector3());
    if (!point || Math.hypot(point.x, point.y) > 5000) return null;
    return [this.snap(point.x), this.snap(point.y), tidy(point.z)];
  }

  private moveTo(drag: Extract<Drag, { mode: 'move' }>, event: PointerEvent): void {
    // A plane seen nearly edge-on would fling the object to the horizon.
    if (Math.abs(this.stage.raycaster.ray.direction.z) < 0.04) return;
    const p = this.stage.raycaster.ray.intersectPlane(drag.plane, new Vector3());
    if (!p) return;
    let dx = this.snap(p.x - drag.origin.x);
    let dy = this.snap(p.y - drag.origin.y);
    // Shift keeps the move on one axis.
    if (event.shiftKey) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    this.stage.events.onGestureChange(drag.nodes.map((n) => ({ ...n, pos: tidyVec([n.pos[0] + dx, n.pos[1] + dy, n.pos[2]]) })));
    this.say(`${fmt(dx)}, ${fmt(dy)}`, event);
  }

  /** The selection follows the pointer along one of the design's axes; steps snap to the grid. */
  private slideTo(drag: Extract<Drag, { mode: 'slide' }>, event: PointerEvent): void {
    const t = alongAxis(this.stage.raycaster.ray, drag.origin, drag.dir);
    if (t === null) return;
    const d = this.snap(t - drag.grab);
    const { x, y, z } = drag.dir;
    this.stage.events.onGestureChange(drag.nodes.map((n) => ({ ...n, pos: tidyVec([n.pos[0] + x * d, n.pos[1] + y * d, n.pos[2] + z * d]) })));
    this.say(`${'XYZ'[drag.axis]} ${d >= 0 ? '+' : ''}${fmt(d)}`, event);
  }

  private resizeTo(drag: Extract<Drag, { mode: 'resize' }>, event: PointerEvent): void {
    const { box, sx, sy } = drag;
    const p = resizePoint(this.stage.raycaster.ray, box, sx, sy, drag.axisOnly);
    if (!p) return;
    p.sub(drag.grab);
    const size: Vec3 = [...box.size];
    if (sx !== 0) size[0] = Math.max(MIN_SIZE, this.snap(sx * p.x + box.size[0] / 2));
    if (sy !== 0) size[1] = Math.max(MIN_SIZE, this.snap(sy * p.y + box.size[1] / 2));
    if (event.shiftKey) {
      // Shift scales the whole thing evenly, following the axis that moved most.
      const fx = size[0] / box.size[0];
      const fy = size[1] / box.size[1];
      const f = Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy;
      size[0] = box.size[0] * f;
      size[1] = box.size[1] * f;
      size[2] = box.size[2] * f;
    }
    // The side opposite the grip stays where it is; so does the base.
    this.stage.events.onGestureChange(stretched(box, drag.nodes, size, [-sx as -1 | 0 | 1, -sy as -1 | 0 | 1, event.shiftKey ? -1 : 0]));
    this.say(event.shiftKey ? size.map(fmt).join(' × ') : `${fmt(size[0])} × ${fmt(size[1])}`, event);
  }

  private heightTo(drag: Extract<Drag, { mode: 'height' }>, event: PointerEvent): void {
    const { box, side } = drag;
    const z = boxAxis(box, 2);
    const fixed = pointOf(box.matrix, [0, 0, 0]).addScaledVector(z, (-side * box.size[2]) / 2);
    const t = alongAxis(this.stage.raycaster.ray, fixed, z);
    if (t === null) return;
    const h = Math.max(MIN_SIZE, this.snap(side * (t - drag.grab)));
    const f = h / box.size[2];
    const size: Vec3 = event.shiftKey ? [box.size[0] * f, box.size[1] * f, h] : [box.size[0], box.size[1], h];
    this.stage.events.onGestureChange(stretched(box, drag.nodes, size, [0, 0, -side]));
    this.say(event.shiftKey ? size.map(fmt).join(' × ') : fmt(h), event);
  }

  private rotateTo(drag: Extract<Drag, { mode: 'rotate' }>, event: PointerEvent): void {
    const angle = angleAbout(this.stage.raycaster.ray, drag.axis, drag.pivot, drag.frame);
    // Seen side-on, the ring cannot be followed; fall back to sideways pointer travel.
    let delta = angle !== null && drag.start !== null ? angle - drag.start : (event.clientX - drag.x) * 0.6;
    const step = event.shiftKey ? ROTATE_COARSE : event.altKey || event.ctrlKey ? 1 : ROTATE_STEP;
    delta = snapTurn(delta, step);
    this.stage.events.onGestureChange(delta === 0 ? drag.nodes : rotateNodes(drag.nodes, drag.axis, delta, drag.pivot, drag.frame));
    this.say(`${fmt(delta)}°`, event);
  }

  // --- marquee -------------------------------------------------------------

  private showMarquee(x0: number, y0: number, x1: number, y1: number): void {
    if (!this.marquee) {
      this.marquee = document.createElement('div');
      this.marquee.className = 'marquee';
      this.stage.container.appendChild(this.marquee);
    }
    const rect = this.stage.container.getBoundingClientRect();
    Object.assign(this.marquee.style, {
      display: 'block',
      left: `${Math.min(x0, x1) - rect.left}px`,
      top: `${Math.min(y0, y1) - rect.top}px`,
      width: `${Math.abs(x1 - x0)}px`,
      height: `${Math.abs(y1 - y0)}px`,
    });
  }

  private hideMarquee(): void {
    if (this.marquee) this.marquee.style.display = 'none';
  }

  /** Ids of the nodes whose bounds, as seen on screen, touch the rectangle. */
  private insideMarquee(x0: number, y0: number, x1: number, y1: number): string[] {
    const rect = this.stage.renderer.domElement.getBoundingClientRect();
    const left = Math.min(x0, x1) - rect.left;
    const right = Math.max(x0, x1) - rect.left;
    const top = Math.min(y0, y1) - rect.top;
    const bottom = Math.max(y0, y1) - rect.top;
    const ids: string[] = [];
    const v = new Vector3();
    for (const item of this.stage.items) {
      if (item.ghost || item.node.hidden) continue;
      const b = this.stage.events.boundsOf(item.node);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let behind = false;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]).project(this.stage.camera);
        if (v.z > 1) behind = true;
        const sx = ((v.x + 1) / 2) * rect.width;
        const sy = ((1 - v.y) / 2) * rect.height;
        minX = Math.min(minX, sx);
        maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy);
        maxY = Math.max(maxY, sy);
      }
      if (!behind && minX <= right && maxX >= left && minY <= bottom && maxY >= top) ids.push(item.node.id);
    }
    return ids;
  }
}
