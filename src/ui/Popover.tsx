import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

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
  /** Place the panel relative to the window rather than the button, for a button inside a scrolling box that would clip it. */
  fixed?: boolean;
  children: (close: () => void) => ReactNode;
}

/** Room a panel is assumed to need below its button before it opens upward instead. */
const PANEL_ROOM = 220;

/** Button with a small panel that drops down below it (or up from it); closes on Escape or a click elsewhere. */
export function Popover({ button, title, className = 'chip', disabled, align = 'left', side = 'down', fill = false, fixed = false, children }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);

  // A fixed panel is measured from the button when it opens, and closed by any scrolling, which would leave it behind.
  useLayoutEffect(() => {
    if (!open || !fixed || !root.current) return setPlace(null);
    const rect = root.current.getBoundingClientRect();
    const upward = side === 'up' || window.innerHeight - rect.bottom < PANEL_ROOM;
    setPlace({
      position: 'fixed',
      top: upward ? 'auto' : rect.bottom + 6,
      bottom: upward ? window.innerHeight - rect.top + 6 : 'auto',
      left: align === 'left' ? rect.left : 'auto',
      right: align === 'right' ? window.innerWidth - rect.right : 'auto',
    });
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, fixed, align, side]);

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
      {open && (
        <div className={`popover-panel ${align} ${side}`} style={place ?? undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
