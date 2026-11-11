import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { Hint } from './Hint';
import { enterByTouch } from './TouchEntry';
import { typedNumber } from './typed';

const decimals = (step: number) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));

/** The last press on the page, to tell a focus given by a finger from one given by the keyboard or a mouse. */
let lastPress: { type: string; time: number } = { type: '', time: 0 };
if (typeof window !== 'undefined') window.addEventListener('pointerdown', (e) => (lastPress = { type: e.pointerType, time: e.timeStamp }), true);

/** Selects the box's text so that typing replaces it. (A finger without a keyboard never gets here: it opens the entry sheet instead.) */
export function selectOnFocus(e: { target: HTMLInputElement }): void {
  e.target.select();
}

/** Whether the last press on the page was a finger, a moment ago. */
export const recentTouch = (): boolean => lastPress.type === 'touch' && performance.now() - lastPress.time < 1000;

/** Whether the last press on the page was a finger, however long ago: a drag still going on is that finger's. */
export const pressedByTouch = (): boolean => lastPress.type === 'touch';

/** At most `places` decimals, without trailing zeros. */
export const formatNumber = (value: number, places = 2) => String(Number(value.toFixed(places)));

interface NumberBoxProps {
  value: number;
  onChange: (v: number) => void;
  /** Short tag shown inside the box, in front of the number ("X", "W"). */
  tag?: string;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  places?: number;
  disabled?: boolean;
  label: string;
  id?: string;
}

/**
 * Text box for a number. Typing commits on Enter or when the box is left, so
 * half-typed values never reach the model; arrow keys step (Shift: by ten).
 * A value that changes from outside while the box is being typed in (an undo,
 * or the selection moving to another object that the same box now edits)
 * drops what was typed, so the text never lands on something it was not typed for.
 */
export function NumberBox({ value, onChange, tag, unit, step = 1, min = -Infinity, max = Infinity, integer, places = 2, disabled, label, id }: NumberBoxProps) {
  const [text, setText] = useState(formatNumber(value, places));
  const [editing, setEditing] = useState(false);
  // The last value this box itself sent out, to tell its own commits from changes made elsewhere.
  const sent = useRef<number | null>(null);
  // Before the screen is drawn again, not after: a box whose value changes from elsewhere (another box was typed into)
  // must not show the old one for a frame. Whatever lands in it during that frame is typed into text that is then
  // swapped under it: a 3 typed into a box about to change to 3 reads 33.
  useLayoutEffect(() => {
    if (!editing || sent.current !== value) setText(formatNumber(value, places));
    sent.current = null;
  }, [value, places, editing]);

  const clamp = (v: number) => Math.min(max, Math.max(min, integer ? Math.round(v) : v));
  const send = (next: number) => {
    sent.current = next;
    onChange(next);
  };
  /** Sends what was typed, within the box's limits; returns the number taken, or null when the text is not one. */
  const commit = (raw: string): number | null => {
    const next = typedNumber(raw, { min, max, integer });
    if (next !== null && next !== value) send(next);
    return next;
  };

  return (
    <span className={disabled ? 'number-box disabled' : 'number-box'}>
      {tag && <span className="tag">{tag}</span>}
      <input
        id={id}
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        disabled={disabled}
        value={text}
        // A finger does not type into the box under the keypad: the entry sheet takes the value instead (unless a keyboard is attached).
        onPointerDown={(e) => enterByTouch(e, { label, value: formatNumber(value, places), unit, inputMode: integer ? 'numeric' : 'decimal', onCommit: (raw) => void commit(raw) })}
        onFocus={(e) => {
          setEditing(true);
          selectOnFocus(e);
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setEditing(false);
          commit(text);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = clamp(Number((value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)).toFixed(6)));
            setText(formatNumber(next, places));
            if (next !== value) send(next);
          } else if (e.key === 'Enter') {
            // The box shows what was taken: a value typed past a limit reads as the limit at once, not only once the box
            // is left. Drawn before the text is selected again, or the new text would arrive unselected.
            const box = e.currentTarget;
            const taken = commit(text);
            if (taken !== null) flushSync(() => setText(formatNumber(taken, places)));
            box.select();
          } else if (e.key === 'Escape') {
            setText(formatNumber(value, places));
            e.currentTarget.blur();
          }
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </span>
  );
}

interface CommitInputProps {
  /** The text as it stands; shown again whenever it changes from outside. */
  value: string;
  /** Told what was typed, trimmed, when that is neither empty nor what was there. */
  onCommit: (text: string) => void;
  label: string;
  className: string;
  title?: string;
  /** For a finger without a keyboard: the entry sheet opens instead, under this heading. */
  sheet?: string;
}

/** Text box for a name, taken when typing is done (Enter or leaving the box); Escape puts the old one back. */
export function CommitInput({ value, onCommit, label, className, title, sheet }: CommitInputProps) {
  const [text, setText] = useState(value);
  // Before the screen is drawn again, like the number box's: the old words are not shown for a frame.
  useLayoutEffect(() => setText(value), [value]);
  // Set by Escape for the blur it causes: that blur still sees what was typed, and must not take it.
  const dropped = useRef(false);
  const commit = (next: string) => {
    const clean = dropped.current ? '' : next.trim();
    dropped.current = false;
    if (clean && clean !== value) onCommit(clean);
    else setText(value);
  };
  return (
    <input
      className={className}
      aria-label={label}
      title={title}
      spellCheck={false}
      value={text}
      onPointerDown={sheet ? (e) => enterByTouch(e, { label: sheet, value: text, inputMode: 'text', onCommit: commit }) : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => commit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          dropped.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * Text box to rename a card in place: it takes the focus with the name selected. `onDone` is told
 * the new name when the box is left (Enter leaves it), or null when there is nothing to change:
 * the box is empty, the name is the same, or Escape put it back. `onEscape` hears of that Escape
 * first, for a dialog round the box that would otherwise take the key for its own.
 */
export function RenameInput({ name, label, onDone, onEscape }: { name: string; label: string; onDone: (value: string | null) => void; onEscape?: () => void }) {
  return (
    <input
      className="text-input"
      aria-label={label}
      defaultValue={name}
      autoFocus
      onFocus={selectOnFocus}
      onBlur={(e) => {
        const value = e.currentTarget.value;
        onDone(value.trim() && value.trim() !== name ? value : null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          // The key is the box's: it must not also close whatever the box is in.
          e.stopPropagation();
          onEscape?.();
          e.currentTarget.value = name;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

interface SliderFieldProps {
  label: string;
  help?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  unit?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}

/** Labeled slider with a number box, for the handful of numbers a shape has besides its size. */
export function SliderField({ label, help, value, min, max, step, integer, unit, disabled, onChange }: SliderFieldProps) {
  const id = useId();
  const span = max - min || 1;
  // A finger that lands on the slider may be on its way up or down the panel. The slider takes a touch anywhere on
  // its track at once, so a swipe meant to scroll set a value (a gear grew fifteen times as wide). The value a finger
  // gives is held back until the finger has moved sideways, or has left again without moving: a tap on the track. A
  // finger that moves up or down is the panel's (the slider lets the browser have it: `touch-action: pan-y`).
  const finger = useRef<{ x: number; y: number; slides: boolean; held: number | null } | null>(null);
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {help && <Hint text={help} />}
      </label>
      <div className="number-row">
        <input
          type="range"
          tabIndex={-1}
          aria-hidden="true"
          min={min}
          max={max}
          step={step}
          value={Math.min(max, value)}
          disabled={disabled}
          style={{ '--fill': `${(Math.min(1, Math.max(0, (value - min) / span)) * 100).toFixed(2)}%` } as CSSProperties}
          onPointerDown={(e) => {
            finger.current = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY, slides: false, held: null } : null;
          }}
          onPointerMove={(e) => {
            const f = finger.current;
            if (!f || f.slides) return;
            const across = Math.abs(e.clientX - f.x);
            if (across < 6 || across <= Math.abs(e.clientY - f.y)) return;
            f.slides = true;
            if (f.held !== null) onChange(f.held);
          }}
          onPointerUp={() => {
            const f = finger.current;
            finger.current = null;
            if (f && !f.slides && f.held !== null) onChange(f.held);
          }}
          onPointerCancel={() => {
            finger.current = null;
          }}
          onChange={(e) => {
            const next = Number(e.target.value);
            const f = finger.current;
            if (f && !f.slides) f.held = next;
            else onChange(next);
          }}
        />
        <NumberBox id={id} label={label} value={value} min={min} max={max} step={step} integer={integer} unit={unit} places={Math.min(4, decimals(step) + (integer ? 0 : 1))} disabled={disabled} onChange={onChange} />
      </div>
    </div>
  );
}
