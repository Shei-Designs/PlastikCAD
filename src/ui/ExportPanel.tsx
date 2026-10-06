import { useState } from 'react';
import { FORMATS } from '../io/export';
import { exportDesign, setPrefs, shownScene, useEditor } from '../state/store';
import { DownloadIcon } from './icons';

export function ExportPanel() {
  const format = useEditor((s) => s.prefs.format);
  const selectionOnly = useEditor((s) => s.prefs.selectionOnly);
  const selected = useEditor((s) => s.selection.length);
  const viewing = useEditor((s) => s.viewing);
  const scene = useEditor(shownScene);
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const active = FORMATS.find((f) => f.id === format)!;
  const partial = selectionOnly && selected > 0 && !viewing;
  const solids = scene.filter((n) => !n.hole && !n.hidden).length;

  const run = async () => {
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
        <div className="export-row">
          <label className="export-label wide" htmlFor="selection-only">
            Selection only
          </label>
          <input id="selection-only" className="switch" type="checkbox" role="switch" checked={selectionOnly} onChange={(e) => setPrefs({ selectionOnly: e.target.checked })} />
        </div>
        <p className="export-note">
          {active.description}
          {partial ? ` · ${selected} selected object${selected === 1 ? '' : 's'}` : ` · ${solids} object${solids === 1 ? '' : 's'}, merged`}
        </p>
        <button type="button" className="primary" disabled={saving || (partial ? selected === 0 : solids === 0)} onClick={run}>
          <DownloadIcon />
          {saving ? 'Exporting…' : `Export ${active.label}`}
        </button>
        {saved && <p className={saved.ok ? 'export-result' : 'export-result failed'}>{saved.text}</p>}
      </section>
    </div>
  );
}
