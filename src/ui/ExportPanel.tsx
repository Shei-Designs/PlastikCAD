import { useState } from 'react';
import { APP_NAME } from '../app';
import { FORMATS } from '../io/export';
import { skinOf } from '../geometry/skin';
import { confirm } from '../platform';
import { exportDesign, setPrefs, useEditor } from '../state/store';
import { ChevronIcon, DownloadIcon } from './icons';
import { Popover } from './Popover';

export function ExportPanel() {
  const format = useEditor((s) => s.prefs.format);
  const selection = useEditor((s) => s.selection);
  const scene = useEditor((s) => s.doc.scene);
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const active = FORMATS.find((f) => f.id === format)!;
  // Holes and hidden objects do not come out, nor do pictures on their own except in a GLB.
  const exportable = (nodes: typeof scene) => nodes.filter((n) => !n.hole && !n.hidden && (n.type !== 'picture' || format === 'glb'));
  const picked = exportable(scene.filter((n) => selection.includes(n.id)));
  const all = exportable(scene);
  const partial = picked.length > 0;
  const count = partial ? picked.length : all.length;

  const run = async () => {
    const going = partial ? picked : all;
    // Pictures and textures only travel in a GLB; the other formats carry the shapes alone.
    if (format !== 'glb' && going.some((n) => skinOf(n) !== null)) {
      const ok = await confirm(`${active.label} does not support pictures or textures. Export the plain shapes anyway?`, { title: APP_NAME, okLabel: 'Export' });
      if (!ok) return;
    }
    // Nothing selected: everything goes out as one part, which is worth a moment's pause (a GLB or 3MF keeps the objects apart).
    if (!partial && count > 1 && format !== 'glb' && format !== '3mf') {
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
          {/* Opens upwards: the panel sits at the bottom of the window, where a native select's list would run off the screen. */}
          <Popover
            className="select-button"
            title="File format"
            align="left"
            side="up"
            fill
            button={
              <>
                <span>{active.label}</span>
                <ChevronIcon />
              </>
            }
          >
            {(close) => (
              <div className="menu" role="listbox" aria-label="File format">
                {FORMATS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="option"
                    aria-selected={f.id === format}
                    className={f.id === format ? 'menu-item format on' : 'menu-item format'}
                    onClick={() => {
                      close();
                      setPrefs({ format: f.id });
                    }}
                  >
                    <span>{f.label}</span>
                    <small>{f.description}</small>
                  </button>
                ))}
              </div>
            )}
          </Popover>
        </div>
        <p className="export-note">
          {count === 0 ? 'Nothing to export yet' : `${partial ? `${count} selected` : count === 1 ? '1' : `All ${count}`} object${count === 1 ? '' : 's'}${count > 1 ? (format === 'glb' ? ', separate' : ', merged') : ''}`}
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
