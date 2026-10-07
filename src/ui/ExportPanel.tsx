import { useState } from 'react';
import { APP_NAME } from '../app';
import { FORMATS } from '../io/export';
import { confirm } from '../platform';
import { exportDesign, setPrefs, shownScene, useEditor } from '../state/store';
import { DownloadIcon } from './icons';

export function ExportPanel() {
  const format = useEditor((s) => s.prefs.format);
  const selection = useEditor((s) => s.selection);
  const viewing = useEditor((s) => s.viewing);
  const scene = useEditor(shownScene);
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const active = FORMATS.find((f) => f.id === format)!;
  // Holes and hidden objects do not come out; what is selected counts only while the working design is shown.
  const exportable = (nodes: typeof scene) => nodes.filter((n) => !n.hole && !n.hidden);
  const picked = viewing ? [] : exportable(scene.filter((n) => selection.includes(n.id)));
  const all = exportable(scene);
  const partial = picked.length > 0;
  const count = partial ? picked.length : all.length;

  const run = async () => {
    // Nothing selected: everything goes out as one part, which is worth a moment's pause.
    if (!partial && count > 1) {
      const ok = await confirm(`Export all ${count} objects together as one ${active.label}?`, { title: APP_NAME, okLabel: 'Export' });
      if (!ok) return;
    }
    setSaving(true);
    setSaved(null);
    try {
      const where = await exportDesign(format, partial);
      if (where) setSaved({ ok: true, text: `Saved ${where}` });
    } catch (e) {
      setSaved({ ok: false, text: `Export failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="summary">
      <section className="export" aria-label="Export">
        <div className="export-row">
          <span className="export-label">Format</span>
          <div className="segmented" role="radiogroup" aria-label="File format">
            {FORMATS.map((f) => (
              <button key={f.id} type="button" role="radio" aria-checked={f.id === format} className={f.id === format ? 'on' : ''} title={f.description} onClick={() => setPrefs({ format: f.id })}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <p className="export-note">
          {active.description}
          {count === 0
            ? ' · nothing to export yet'
            : ` · ${count} ${partial ? 'selected ' : ''}object${count === 1 ? '' : 's'}${count > 1 ? ', merged' : ''}`}
        </p>
        <button type="button" className="primary" disabled={saving || count === 0} onClick={run}>
          <DownloadIcon />
          {saving ? 'Exporting…' : partial ? 'Export selection' : 'Export'}
        </button>
        {saved && <p className={saved.ok ? 'export-result' : 'export-result failed'}>{saved.text}</p>}
      </section>
    </div>
  );
}
