import { useState } from 'react';
import { APP_NAME } from '../appInfo';
import { plural, tr } from '../i18n';
import { FORMATS } from '../io/export';
import { skinOf } from '../geometry/skin';
import { confirm } from '../platform';
import { exportDesign, notify, setPrefs, useEditor } from '../state/store';
import { Cancelled } from '../worker/client';
import { FormatPicker } from './FormatPicker';
import { DownloadIcon } from './icons';

export function ExportPanel() {
  const format = useEditor((s) => s.prefs.format);
  const selection = useEditor((s) => s.selection);
  const scene = useEditor((s) => s.doc.scene);
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
      const ok = await confirm(tr('{format} does not support pictures or textures. Export the plain shapes anyway?', { format: active.label }), { title: APP_NAME, okLabel: tr('Export') });
      if (!ok) return;
    }
    // Nothing selected: everything goes out as one part, which is worth a moment's pause (a GLB or 3MF keeps the objects apart).
    if (!partial && count > 1 && format !== 'glb' && format !== '3mf' && format !== 'step') {
      const ok = await confirm(plural(count, 'Export {n} object as one {format}?', 'Export all {n} objects together as one {format}?', { format: active.label }), { title: APP_NAME, okLabel: tr('Export') });
      if (!ok) return;
    }
    setSaving(true);
    try {
      // Where it went is told over the stage, so the panel keeps its height.
      await exportDesign(format, partial);
    } catch (e) {
      // Called off from the badge over the stage: nothing failed.
      if (!(e instanceof Cancelled)) notify(tr('Export failed: {error}', { error: e instanceof Error ? e.message : String(e) }), 'error');
    } finally {
      setSaving(false);
    }
  };

  // What goes out, and whether as one part: said of several objects only, as one alone is neither merged nor kept apart.
  const apart = format === 'glb' || format === 'step';
  const note =
    count === 0
      ? tr('Nothing to export yet')
      : partial
        ? apart
          ? plural(count, '{n} selected object', '{n} selected objects, separate')
          : plural(count, '{n} selected object', '{n} selected objects, merged')
        : apart
          ? plural(count, '{n} object', 'All {n} objects, separate')
          : plural(count, '{n} object', 'All {n} objects, merged');

  return (
    <div className="summary">
      <section className="export" aria-label={tr('Export')}>
        <div className="export-row">
          <span className="export-label">{tr('Format')}</span>
          <FormatPicker formats={FORMATS} value={format} title={tr('File format')} onPick={(id) => setPrefs({ format: id })} />
        </div>
        <p className="export-note">
          {note}
        </p>
        <button type="button" className="primary" disabled={saving || count === 0} onClick={run}>
          <DownloadIcon />
          {saving ? tr('Exporting…') : partial ? tr('Export selection') : tr('Export')}
        </button>
      </section>
    </div>
  );
}
