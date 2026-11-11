// A box over the whole window, as the About box, the questions and the
// project browser are: shown while it is open, and closed by Escape or a
// click beside it.
import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { keyboardAttached } from './inputMode';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** What Escape does, for a box that has somewhere to go back to first; closing it when left out. */
  onEscape?: () => void;
  className: string;
  /** What a screen reader calls the box. */
  label?: string;
  /**
   * For a box whose first control is one to type in but which is not opened to be typed in (the search of the
   * projects): by touch with no keyboard attached the focus stays on the box, so that the keypad does not rise
   * over what was just opened.
   */
  calm?: boolean;
  /** Keys pressed in the box, for a box with shortcuts of its own; none of them reach the window either way. */
  onKeyDown?: (e: KeyboardEvent<HTMLDialogElement>) => void;
  children: ReactNode;
}

export function Modal({ open, onClose, onEscape, className, label, calm, onKeyDown, children }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // The browser has put the focus in the first control.
      if (calm && !keyboardAttached() && window.matchMedia?.('(pointer: coarse)').matches) d.focus();
    } else if (!open && d.open) d.close();
  }, [open, calm]);
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className={className}
      aria-label={label}
      onCancel={(e) => {
        // Escape closes the box and nothing else (it would otherwise also clear the selection).
        e.preventDefault();
        e.stopPropagation();
        (onEscape ?? onClose)();
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
