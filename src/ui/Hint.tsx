import { useState } from 'react';
import { createPortal } from 'react-dom';
import { InfoIcon } from './icons';

/** Small "i" that shows an explanation on hover or keyboard focus. */
export function Hint({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.top });
  };
  return (
    <>
      <span
        className="hint"
        tabIndex={0}
        role="note"
        aria-label={text}
        onMouseEnter={(e) => show(e.currentTarget)}
        onMouseLeave={() => setPos(null)}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={() => setPos(null)}
      >
        <InfoIcon />
      </span>
      {pos &&
        createPortal(
          <div className="tooltip" style={{ left: Math.max(150, Math.min(window.innerWidth - 150, pos.x)), top: pos.y }}>
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
