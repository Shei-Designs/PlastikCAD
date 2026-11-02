// The About box: name, version and license, opened from the File menu.
import { useEffect, useRef } from 'react';
import type React from 'react';
import { APP_NAME, APP_URL, APP_VERSION, AUTHOR, AUTHOR_URL, PUBLISHER, PUBLISHER_URL } from '../appInfo';
import { isDesktop } from '../platform';
import { Logo } from './icons';

/** A link that opens in the browser; on desktop, where the webview cannot leave the app, the address is shown instead. */
function Link({ href, children }: { href: string; children: React.ReactNode }) {
  if (isDesktop()) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

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
          <span className="wordmark">{APP_NAME}</span>
        </div>
        <p>Version {APP_VERSION}</p>
        <p className="about-by">
          A <Link href={PUBLISHER_URL}>{PUBLISHER}</Link> project, designed and built by <Link href={AUTHOR_URL}>{AUTHOR}</Link>.
        </p>
        <p>Free software under the GNU General Public License, version 3 or later.</p>
        <p className="about-link">
          <Link href={APP_URL}>{APP_URL}</Link>
        </p>
        <button type="button" className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
