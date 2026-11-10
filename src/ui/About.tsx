// The About box: name, version and license, opened from the File menu.
import { useEffect, useState } from 'react';
import type React from 'react';
import { APP_NAME, APP_URL, APP_VERSION, AUTHOR, AUTHOR_URL, PUBLISHER, PUBLISHER_URL } from '../appInfo';
import { diagnosticsReport } from '../diagnostics';
import { tr } from '../i18n';
import { rich } from '../i18n/rich';
import { isAndroid, isDesktop } from '../platform';
import { getState } from '../state/store';
import { getSyncStatus } from '../sync/sync';
import { Logo } from './icons';
import { Modal } from './Modal';

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
  // Whether the report reached the clipboard; where it cannot, it is shown to be copied by hand.
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  useEffect(() => {
    if (open) setCopied(null);
  }, [open]);
  const report = () => {
    const { storage, projectKey } = getState();
    const sync = getSyncStatus();
    return diagnosticsReport([
      `Platform: ${isAndroid() ? 'Android app' : isDesktop() ? 'desktop app' : 'browser'}`,
      `Projects: ${storage?.location ?? 'kept by the browser'}${projectKey ? '' : ' (no project open)'}`,
      `Google Drive: ${!sync.configured ? 'not set up in this build' : sync.linked ? `linked${sync.error ? `, ${sync.error}` : ''}` : 'not linked'}`,
    ]);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report());
      setCopied('yes');
    } catch {
      setCopied('no');
    }
  };
  return (
    <Modal open={open} onClose={onClose} className="about" label={tr('About {app}', { app: APP_NAME })}>
      <div className="about-body">
        <div className="brand">
          <Logo />
          <span className="wordmark">{APP_NAME}</span>
        </div>
        <p>{tr('Version {version}', { version: APP_VERSION })}</p>
        <p className="about-by">
          {rich('A {publisher} project, designed and built by {author}.', { publisher: <Link href={PUBLISHER_URL}>{PUBLISHER}</Link>, author: <Link href={AUTHOR_URL}>{AUTHOR}</Link> })}
        </p>
        <p>{tr('Free software under the GNU General Public License, version 3 or later.')}</p>
        <p className="about-link">
          <Link href={APP_URL}>{APP_URL}</Link>
        </p>
        <div className="about-actions">
          <button type="button" className="chip" title={tr('Copies a report of the app, the device and recent errors, to send with a problem.')} onClick={() => void copy()}>
            {copied === 'yes' ? tr('Copied') : tr('Copy diagnostics')}
          </button>
          <button type="button" className="primary" onClick={onClose}>
            {tr('Close')}
          </button>
        </div>
        {copied === 'no' && <textarea className="about-report" readOnly aria-label={tr('Diagnostics')} value={report()} onFocus={(e) => e.currentTarget.select()} />}
      </div>
    </Modal>
  );
}
