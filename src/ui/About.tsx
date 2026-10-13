// The About box: name, version and license, opened from the File menu.
import { useEffect, useRef } from 'react';
import { APP_NAME, APP_URL, APP_VERSION } from '../app';
import { isDesktop } from '../platform';
import { Logo } from './icons';

export function About({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      className="about"
      aria-label={`About ${APP_NAME}`}
      onCancel={(e) => {
        // Escape closes the box and nothing else (it would otherwise also clear the selection).
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog itself, not on its contents.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <div className="brand">
          <Logo />
          <span>{APP_NAME}</span>
        </div>
        <p>Version {APP_VERSION}</p>
        <p>Free software under the GNU General Public License, version 3 or later.</p>
        <p className="about-link">
          {isDesktop() ? (
            <span>{APP_URL}</span>
          ) : (
            <a href={APP_URL} target="_blank" rel="noreferrer">
              {APP_URL}
            </a>
          )}
        </p>
        <button type="button" className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
