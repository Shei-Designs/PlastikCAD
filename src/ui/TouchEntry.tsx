// Typing a value with a finger: the on-screen keypad covers the lower half of
// a tablet, and with it the box being typed in. So a box tapped with a finger
// does not take the keyboard itself; this sheet opens at the top of the
// window, says what is being entered and what it is now, and takes the new
// value. Opened from anywhere through `openTouchEntry`, shown once in App.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { keyboardAttached, onInputChange } from './inputMode';

export { keyboardAttached } from './inputMode';

export interface TouchEntry {
  /** What the value is ("Width", "Notes for Box"). */
  label: string;
  /** The value as it stands, shown until something is typed. */
  value: string;
  unit?: string;
  inputMode: 'decimal' | 'numeric' | 'text';
  multiline?: boolean;
  onCommit: (text: string) => void;
  onCancel?: () => void;
}

let current: TouchEntry | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const publish = (next: TouchEntry | null) => {
  current = next;
  for (const l of listeners) l();
};

/** Opens the sheet. Called from inside a touch where possible, so that focusing its box is allowed to raise the keyboard. */
export function openTouchEntry(entry: TouchEntry): void {
  // Rendered at once, while the touch still counts as a user gesture (from inside a React effect
  // the flush is deferred instead, and the sheet focuses its box itself when it appears).
  flushSync(() => publish(entry));
  const box = document.getElementById('touch-entry-box') as HTMLInputElement | HTMLTextAreaElement | null;
  box?.focus({ preventScroll: true });
}

export const closeTouchEntry = (): void => publish(null);

// --- a finger on a box -------------------------------------------------------

/** The entry a box asked for while typing in place; opened after all if the keypad comes up. */
let pending: { entry: TouchEntry; until: number } | null = null;
onInputChange((state) => {
  if (state.keypadVisible && pending && performance.now() < pending.until) {
    const { entry } = pending;
    pending = null;
    openTouchEntry(entry);
  }
});

/**
 * A finger on a box. Without a keyboard the entry sheet opens at once. With
 * one, the box is focused by hand (so Android shows no caret handle) and
 * works as on the desktop; should the keypad come up after all, the sheet
 * opens.
 */
export function enterByTouch(e: { pointerType: string; currentTarget: HTMLInputElement | HTMLTextAreaElement; preventDefault: () => void }, entry: TouchEntry): void {
  const box = e.currentTarget;
  if (e.pointerType !== 'touch' || box.disabled) return;
  e.preventDefault();
  if (!keyboardAttached()) return openTouchEntry(entry);
  if (document.activeElement !== box) focusFresh(box, !entry.multiline);
  pending = { entry, until: performance.now() + 1500 };
}

/**
 * Focuses a box by hand with the caret at the end (no selection, so Android
 * shows neither handle nor cut-and-copy bar). With `fresh`, the first key
 * typed replaces the whole value, as a selected value would be replaced.
 */
export function focusFresh(box: HTMLInputElement | HTMLTextAreaElement, fresh: boolean): void {
  box.focus({ preventScroll: true });
  const end = box.value.length;
  box.setSelectionRange(end, end);
  if (fresh) box.dataset.fresh = '1';
  else delete box.dataset.fresh;
}

/**
 * For a box focused with `focusFresh`: the text the first key typed should
 * leave in it (the key itself, or nothing for Backspace and Delete), or null
 * when the key is to be handled as usual. The box stops being fresh either way.
 */
export function freshReplacement(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; currentTarget: HTMLInputElement | HTMLTextAreaElement }): string | null {
  const box = e.currentTarget;
  if (!box.dataset.fresh) return null;
  delete box.dataset.fresh;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Backspace' || e.key === 'Delete') return '';
  return e.key.length === 1 ? e.key : null;
}

export function TouchEntrySheet() {
  const entry = useSyncExternalStore(subscribe, () => current);
  const box = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // A new entry starts afresh and takes the focus. When the sheet opens from a tap the viewer handled
  // (a grip), the browser's compatibility mouse events arrive after the tap and move the focus to the
  // page, so the focus is taken once more a moment later.
  useEffect(() => {
    const el = box.current;
    if (!el || !entry) return;
    if (!entry.multiline) el.value = '';
    const take = () => {
      if (el.isConnected && document.activeElement !== el) el.focus({ preventScroll: true });
    };
    take();
    const again = setTimeout(take, 80);
    return () => clearTimeout(again);
  }, [entry]);
  if (!entry) return null;
  const done = () => {
    const text = box.current?.value ?? '';
    closeTouchEntry();
    // Left empty: the value stays as it was, and whatever asked is told nothing came of it.
    if (text.trim() !== '' || entry.multiline) entry.onCommit(text);
    else entry.onCancel?.();
  };
  const cancel = () => {
    closeTouchEntry();
    entry.onCancel?.();
  };
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !(entry.multiline && e.shiftKey)) {
      e.preventDefault();
      done();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };
  return (
    <>
      <div className="touch-entry-backdrop" onPointerDown={cancel} />
      <div className="touch-entry" role="dialog" aria-label={entry.label} onKeyDown={onKey}>
        <div className="touch-entry-head">
          <span className="touch-entry-label clip">{entry.label}</span>
          {!entry.multiline && (
            <span className="touch-entry-now">
              now {entry.value}
              {entry.unit ? ` ${entry.unit}` : ''}
            </span>
          )}
        </div>
        <div className="touch-entry-row">
          {entry.multiline ? (
            <textarea id="touch-entry-box" ref={(el) => {
                box.current = el;
              }}
              className="text-input area" defaultValue={entry.value} aria-label={entry.label} rows={4} />
          ) : (
            <input
              id="touch-entry-box"
              ref={(el) => {
                box.current = el;
              }}
              className="text-input"
              type="text"
              inputMode={entry.inputMode}
              autoComplete="off"
              spellCheck={false}
              placeholder={entry.value}
              aria-label={entry.label}
            />
          )}
          {entry.unit && !entry.multiline && <span className="touch-entry-unit">{entry.unit}</span>}
        </div>
        <div className="touch-entry-buttons">
          <button type="button" className="chip" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={done}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}
