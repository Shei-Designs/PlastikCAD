import { useEffect, useId, useState } from 'react';
import type { CSSProperties } from 'react';
import { Hint } from './Hint';
import { enterByTouch } from './TouchEntry';

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
 */
export function NumberBox({ value, onChange, tag, unit, step = 1, min = -Infinity, max = Infinity, integer, places = 2, disabled, label, id }: NumberBoxProps) {
  const [text, setText] = useState(formatNumber(value, places));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(formatNumber(value, places));
  }, [value, places, editing]);

  const clamp = (v: number) => Math.min(max, Math.max(min, integer ? Math.round(v) : v));
  const commit = (raw: string) => {
    const parsed = Number(raw.replace(',', '.'));
    if (raw.trim() === '' || !Number.isFinite(parsed)) return;
    const next = clamp(parsed);
    if (next !== value) onChange(next);
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
        onPointerDown={(e) => enterByTouch(e, { label, value: formatNumber(value, places), unit, inputMode: integer ? 'numeric' : 'decimal', onCommit: commit })}
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
            if (next !== value) onChange(next);
          } else if (e.key === 'Enter') {
            commit(text);
            e.currentTarget.select();
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
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <NumberBox id={id} label={label} value={value} min={min} max={max} step={step} integer={integer} unit={unit} places={Math.min(4, decimals(step) + (integer ? 0 : 1))} disabled={disabled} onChange={onChange} />
      </div>
    </div>
  );
}
