// Where the live readout of a drag goes: beside the pointer, inside the view.

/** How far from a mouse pointer the readout sits, right and below. */
const OFFSET = 16;
/** How far above a finger, which hides what is under and just below it. */
const FINGER = 44;
/** The least room left between the readout and the edge of the view. */
const MARGIN = 6;

/**
 * The readout's top-left corner within a view of `view` size, for a pointer
 * at `at` (both in the view's own pixels) and a readout of `size`. Beside a
 * mouse it goes right and below, and to the other side where that would run
 * off the view; with a finger it goes above, centered, or below the finger
 * when there is no room above. It never leaves the view.
 */
export function placeReadout(at: { x: number; y: number }, size: { width: number; height: number }, view: { width: number; height: number }, touch: boolean): { left: number; top: number } {
  let left: number;
  let top: number;
  if (touch) {
    left = at.x - size.width / 2;
    top = at.y - FINGER - size.height;
    if (top < MARGIN) top = at.y + FINGER;
  } else {
    left = at.x + OFFSET;
    top = at.y + OFFSET;
    if (left + size.width > view.width - MARGIN) left = at.x - OFFSET - size.width;
    if (top + size.height > view.height - MARGIN) top = at.y - OFFSET - size.height;
  }
  const within = (v: number, room: number) => Math.max(MARGIN, Math.min(v, room - MARGIN));
  return { left: within(left, view.width - size.width), top: within(top, view.height - size.height) };
}
