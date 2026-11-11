// Typing a value with a finger: the on-screen keypad covers the lower half of
// a tablet, and with it the box being typed in. So a box tapped with a finger
// does not take the keyboard itself; this sheet opens at the top of the
// window, says what is being entered and what it is now, and takes the new
// value. Opened from anywhere through `openTouchEntry`, shown once in App.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { tr } from '../i18n';
import { inputState, keyboardAttached, onInputChange, refreshInput } from './inputMode';

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
 * one, the box works as on the desktop (the touch focuses it and its text is
 * selected for typing over); should the keypad come up after all, the sheet
 * opens.
 */
export function enterByTouch(e: { pointerType: string; currentTarget: HTMLInputElement | HTMLTextAreaElement; preventDefault: () => void }, entry: TouchEntry): void {
  const box = e.currentTarget;
  if (e.pointerType !== 'touch' || box.disabled) return;
  if (!keyboardAttached()) {
    e.preventDefault();
    return openTouchEntry(entry);
  }
  pending = { entry, until: performance.now() + 1500 };
}

// The keypad put away by its own button (not by Done or a tap elsewhere): the sheet goes with it.
let keypadWasVisible = false;
onInputChange((state) => {
  if (keypadWasVisible && !state.keypadVisible && current) {
    const entry = current;
    publish(null);
    entry.onCancel?.();
    (document.activeElement as HTMLElement | null)?.blur?.();
  }
  keypadWasVisible = state.keypadVisible;
});

/** Height of the room above the keypad: the window, less the keypad where it overlays, or what the keyboard left of the viewport where it resized it. */
function roomAbove(): number {
  const state = inputState();
  const overlay = window.innerHeight - (state?.keypadVisible ? state.keypadHeight : 0);
  const resized = window.visualViewport?.height ?? window.innerHeight;
  return Math.max(120, Math.min(overlay, resized));
}

export function TouchEntrySheet() {
  const entry = useSyncExternalStore(subscribe, () => current);
  const box = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  /** The entry the backdrop was last pressed under. */
  const pressed = useRef<TouchEntry | null>(null);
  // Kept in the middle of the room above the keypad, as that room changes.
  const [top, setTop] = useState(64);
  useLayoutEffect(() => {
    if (!entry) return;
    const place = () => {
      const height = panel.current?.offsetHeight ?? 180;
      setTop(Math.max(16, Math.round(roomAbove() / 2 - height / 2)));
    };
    place();
    const stop = onInputChange(place);
    window.visualViewport?.addEventListener('resize', place);
    window.addEventListener('resize', place);
    // The keypad comes up after the sheet opens; its report is asked for as well as listened for,
    // in case a change went by unheard.
    const ask = setInterval(() => void refreshInput(), 400);
    return () => {
      stop();
      clearInterval(ask);
      window.visualViewport?.removeEventListener('resize', place);
      window.removeEventListener('resize', place);
    };
  }, [entry]);
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
      {/* Closed by the click, not the press: gone at the press, the tap's click would land on whatever lies underneath.
          The tap that opened the sheet ends in a click here too, which is told apart by where its press began. */}
      <div
        className="touch-entry-backdrop"
        onPointerDown={() => {
          pressed.current = entry;
        }}
        onClick={() => {
          if (pressed.current === entry) cancel();
        }}
      />
      <div className="touch-entry" ref={panel} style={{ top }} role="dialog" aria-label={entry.label} onKeyDown={onKey}>
        <div className="touch-entry-head">
          <span className="touch-entry-label clip">{entry.label}</span>
          {!entry.multiline && (
            <span className="touch-entry-now">{tr('now {value}', { value: entry.unit ? `${entry.value} ${entry.unit}` : entry.value })}</span>
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
            {tr('Cancel')}
          </button>
          <button type="button" className="primary" onClick={done}>
            {tr('Done')}
          </button>
        </div>
      </div>
    </>
  );
}
