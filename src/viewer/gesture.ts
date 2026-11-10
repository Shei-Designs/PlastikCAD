// Who a press on the plate belongs to. The viewer edits with one pointer and
// the camera (OrbitControls) turns, pans and zooms with one or two fingers;
// this says, for each pointer that goes down, which of the two gets it, given
// what the pointers already down are doing, and whether a pen is about (the
// hand that holds one rests on the screen, and is not a finger).

/** A finger held still this long means "more": add to the selection, or box-select. */
export const LONG_PRESS_MS = 450;
/** Fingers count again this long after the pen lifted or left: the palm often lifts after it. */
export const PALM_GRACE_MS = 400;
/** A hovering pen that has said nothing for this long is taken as gone: a tablet may not say when it leaves. */
export const PEN_STALE_MS = 2000;

/** What has been heard of the pen, anywhere in the window. Times are those of the events (ms). */
export interface PenState {
  /** Its tip is on the screen. */
  down: boolean;
  /** It is in range of the screen, as far as was heard, and `seen` is when it last said so. */
  near: boolean;
  seen: number;
  /** When it last lifted or left. */
  left: number;
}

export const NO_PEN: PenState = { down: false, near: false, seen: -Infinity, left: -Infinity };

/**
 * The pen's state after one of its events: its tip went `down`, it moved or came in range (`near`),
 * its tip lifted (`up`), or it left the range of the screen (`gone`). A lifted pen has to say again
 * that it is near, as one that hovers does at once: a tablet that reports no hover says nothing more.
 */
export function penHeard(pen: PenState, what: 'down' | 'near' | 'up' | 'gone', time: number): PenState {
  switch (what) {
    case 'down':
      return { ...pen, down: true, near: true, seen: time };
    case 'near':
      return { ...pen, near: true, seen: time };
    case 'up':
      return { down: false, near: false, seen: time, left: time };
    case 'gone':
      return { ...pen, near: false, seen: time, left: time };
  }
}

/** Whether a hand on the screen at `time` is taken as the one holding the pen. */
export function penAbout(pen: PenState, time: number): boolean {
  if (pen.down) return true;
  if (pen.near && time - pen.seen <= PEN_STALE_MS) return true;
  return time - pen.left < PALM_GRACE_MS;
}

/** The viewer's own press, as far as it has got. */
export type PressPhase =
  /** Nothing is pressed. */
  | 'none'
  /** A finger resting on empty space: a tap or a long press in the making, and already the camera's to turn with. */
  | 'tap'
  /** Pressed on an object, a grip or the plate to place on, and not yet moved far enough to be a drag. */
  | 'pending'
  /** An edit is under way: a move, a stretch, a turn, a box selection. */
  | 'editing';

export interface GestureState {
  phase: PressPhase;
  /** The pointer of the viewer's press, and its kind ('mouse', 'pen', 'touch'). */
  pointerId: number;
  pointerType: string;
  /** How many fingers the camera is following. */
  cameraTouches: number;
  pen: PenState;
}

export interface PressEvent {
  pointerId: number;
  pointerType: string;
  /** The first finger down, or the mouse or pen itself. */
  isPrimary: boolean;
  /** When it went down, on the clock the pen's events are timed by. */
  time: number;
}

export type Owner =
  /** A fresh press: the viewer starts whatever is under it (and leaves empty space to the camera). */
  | 'viewer'
  /** The same, after calling off a press whose end was never heard. */
  | 'viewer-afresh'
  /** The camera's, as things stand. */
  | 'camera'
  /** The camera's; the resting finger, which the camera has already, is no longer a tap. */
  | 'camera-drop-tap'
  /** The camera's; the pending press is called off and its finger is handed to the camera as well. */
  | 'camera-handover'
  /** Neither's: a stray pointer during an edit. */
  | 'nobody'
  /** Neither's: a touch while a pen is about, which is the hand that holds it. */
  | 'palm';

/**
 * Two fingers are a camera gesture wherever they land: a second finger while
 * the first has not yet begun an edit takes both to the camera, and so does
 * any finger that joins one the camera is following. An edit under way keeps
 * its pointer and ignores the rest. A mouse or a pen is one pointer, and
 * never part of this. While a pen is down or in range, and for a moment
 * after, no touch that lands is anyone's; fingers already down carry on, since
 * only a press is asked about here.
 */
export function pressOwner(state: GestureState, event: PressEvent): Owner {
  const touch = event.pointerType === 'touch';
  if (touch && penAbout(state.pen, event.time)) return 'palm';
  // The first finger down means none was down before: any the camera is thought to follow have gone unheard.
  const cameraTouches = touch && event.isPrimary ? 0 : state.cameraTouches;
  if (state.phase === 'none') return touch && cameraTouches > 0 ? 'camera' : 'viewer';
  // The pressed pointer cannot go down twice, and a first finger cannot join another: the press ended unheard.
  if (event.pointerId === state.pointerId || (touch && event.isPrimary && state.pointerType === 'touch')) return 'viewer-afresh';
  if (touch && state.pointerType === 'touch') {
    if (state.phase === 'tap') return 'camera-drop-tap';
    if (state.phase === 'pending') return 'camera-handover';
  }
  return 'nobody';
}
