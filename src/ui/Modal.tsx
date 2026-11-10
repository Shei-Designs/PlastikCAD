// A box over the whole window, as the About box, the questions and the
// project browser are: shown while it is open, and closed by Escape or a
// click beside it.
import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  className: string;
  /** What a screen reader calls the box. */
  label?: string;
  /** Keys pressed in the box, for a box with shortcuts of its own; none of them reach the window either way. */
  onKeyDown?: (e: KeyboardEvent<HTMLDialogElement>) => void;
  children: ReactNode;
}

export function Modal({ open, onClose, className, label, onKeyDown, children }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={className}
      aria-label={label}
      onCancel={(e) => {
        // Escape closes the box and nothing else (it would otherwise also clear the selection).
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        onKeyDown?.(e);
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog itself, not on its contents.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
