import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface Props {
  /** Contents of the button that opens the panel. */
  button: ReactNode;
  title: string;
  className?: string;
  disabled?: boolean;
  /** Which edge of the button the panel lines up with. */
  align?: 'left' | 'right';
  /** Whether the panel opens below the button or above it (for a button near the bottom of the window). */
  side?: 'down' | 'up';
  /** Stretch the button to its row's width and make the panel as wide. */
  fill?: boolean;
  children: (close: () => void) => ReactNode;
}

/** Button with a small panel that drops down below it (or up from it); closes on Escape or a click elsewhere. */
export function Popover({ button, title, className = 'chip', disabled, align = 'left', side = 'down', fill = false, children }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape closes the panel and nothing else (it would otherwise also clear the selection).
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className={`popover${open ? ' open' : ''}${fill ? ' fill' : ''}`} ref={root}>
      <button type="button" className={open ? `${className} on` : className} title={title} aria-label={title} aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {button}
      </button>
      {open && <div className={`popover-panel ${align} ${side}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}
