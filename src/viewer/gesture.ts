// Who a press on the plate belongs to. The viewer edits with one pointer and
// the camera (OrbitControls) turns, pans and zooms with one or two fingers;
// this says, for each pointer that goes down, which of the two gets it, given
// what the pointers already down are doing.

/** A finger held still this long means "more": add to the selection, or box-select. */
export const LONG_PRESS_MS = 450;

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
}

export interface PressEvent {
  pointerId: number;
  pointerType: string;
  /** The first finger down, or the mouse or pen itself. */
  isPrimary: boolean;
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
  | 'nobody';

/**
 * Two fingers are a camera gesture wherever they land: a second finger while
 * the first has not yet begun an edit takes both to the camera, and so does
 * any finger that joins one the camera is following. An edit under way keeps
 * its pointer and ignores the rest. A mouse or a pen is one pointer, and
 * never part of this.
 */
export function pressOwner(state: GestureState, event: PressEvent): Owner {
  const touch = event.pointerType === 'touch';
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
