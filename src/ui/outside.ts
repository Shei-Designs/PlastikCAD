// Whether a press landed outside a panel that closes on a press elsewhere.

/** The touch entry sheet and the backdrop behind it (see TouchEntry). */
export const TOUCH_ENTRY = '.touch-entry, .touch-entry-backdrop';

interface Holder {
  contains(node: never): boolean;
}
interface Pressed {
  closest(selector: string): unknown;
}

/**
 * True for a press that should close the panel rooted at `root`. A press on
 * the entry sheet does not count: the sheet stands in for a box of the panel
 * on a tablet without a keyboard, and typing there is typing in the panel.
 */
export function pressedOutside(root: Holder | null, target: unknown): boolean {
  if (root?.contains(target as never)) return false;
  const el = target as Partial<Pressed> | null;
  return !(typeof el?.closest === 'function' && el.closest(TOUCH_ENTRY));
}
