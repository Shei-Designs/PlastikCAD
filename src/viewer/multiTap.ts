// Fingers tapped together on the plate: two take the last step back, three
// bring it again. A tap is told from what the fingers did, once the last has
// lifted, so a pan or a pinch is never held up to wait for one. `tapOf` is the
// rule; `TapWatch` keeps the record it is asked about.

/** From the first finger down to the last one up. */
export const TAP_MAX_MS = 300;
/** The fingers of a tap land within this of each other. */
export const TAP_STAGGER_MS = 150;
/** How far a tapping finger may slide, in px: more is a pan or a pinch. */
export const TAP_SLOP = 10;

export type HistoryStep = 'undo' | 'redo';

/** One pointer's time on the plate. Times are those of its events (ms). */
export interface Contact {
  pointerType: string;
  down: number;
  up: number;
  /** The farthest it got from where it went down, in px. */
  travel: number;
}

/**
 * What the pointers that were on the plate together meant, if they were a tap: every one a finger,
 * down within a moment of each other, all down at once, none sliding, and all up again soon.
 * `editing` says an edit was under way meanwhile (a finger dragging an object, say), which no tap
 * beside it may undo.
 */
export function tapOf(contacts: readonly Contact[], editing: boolean): HistoryStep | null {
  if (editing || (contacts.length !== 2 && contacts.length !== 3)) return null;
  if (contacts.some((c) => c.pointerType !== 'touch' || c.travel > TAP_SLOP)) return null;
  const firstDown = Math.min(...contacts.map((c) => c.down));
  const lastDown = Math.max(...contacts.map((c) => c.down));
  const firstUp = Math.min(...contacts.map((c) => c.up));
  const lastUp = Math.max(...contacts.map((c) => c.up));
  // One finger tapping twice beside another is two contacts that were never down together.
  if (lastDown - firstDown > TAP_STAGGER_MS || lastDown > firstUp) return null;
  return lastUp - firstDown <= TAP_MAX_MS ? (contacts.length === 2 ? 'undo' : 'redo') : null;
}

interface Open extends Contact {
  x: number;
  y: number;
}

/** Keeps the record of the pointers on the plate, from the first one down to the last one up. */
export class TapWatch {
  private readonly open = new Map<number, Open>();
  private done: Contact[] = [];
  /** Something about this time on the plate rules a tap out, whatever the fingers do. */
  private spoiled = false;

  /**
   * A pointer went down. `first`: none was down before it, so any still kept never said it lifted.
   * `editing`: an edit is under way, or the mouse or pen is pressing.
   */
  down(id: number, pointerType: string, x: number, y: number, time: number, first: boolean, editing: boolean): void {
    if (first) this.open.clear();
    if (this.open.size === 0) {
      this.done = [];
      this.spoiled = false;
    }
    this.open.set(id, { pointerType, down: time, up: time, travel: 0, x, y });
    this.spoiled ||= editing;
  }

  move(id: number, x: number, y: number): void {
    const c = this.open.get(id);
    if (c) c.travel = Math.max(c.travel, Math.hypot(x - c.x, y - c.y));
  }

  /** A pointer lifted. Returns what the tap meant, when it was the last one up and they made one. */
  up(id: number, time: number): HistoryStep | null {
    const c = this.open.get(id);
    if (!c) return null;
    this.open.delete(id);
    this.done.push({ pointerType: c.pointerType, down: c.down, up: time, travel: c.travel });
    return this.open.size === 0 ? tapOf(this.done, this.spoiled) : null;
  }

  /** A pointer was taken away by the system: whatever the rest do, it was no tap. */
  cancel(id: number): void {
    if (this.open.delete(id)) this.spoiled = true;
  }
}
