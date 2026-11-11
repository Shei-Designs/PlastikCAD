// Android's Back, which the app answers as it answers Escape: a box closes, then a menu or the sheet a number is
// typed in, then a tool that is under way, then the selection, one at a press. With none of them there the app has
// nothing to go back from, and says so, so that it can go behind the other apps.
import { getState } from '../state/store';

/** Does what Escape would do now, and says whether there was anything for it to do. */
export function backOut(): boolean {
  // A box over the window is closed by its own way out, as Escape and a press beside it close it.
  const box = [...document.querySelectorAll('dialog[open]')].pop();
  if (box) {
    box.dispatchEvent(new Event('cancel', { cancelable: true }));
    return true;
  }
  // The sheet a number is typed in takes its keys itself; a panel that dropped down hears them from the window.
  const sheet = document.getElementById('touch-entry-box');
  const dropped = document.querySelector('.popover.open') !== null;
  const s = getState();
  const underWay = Boolean(s.arraying || s.mating || s.measuring || s.aligning || s.placing || s.jointPick || s.joint || s.sensor) || s.selection.length > 0;
  if (!sheet && !dropped && !underWay) return false;
  const target: EventTarget = sheet ?? (document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  return true;
}
