// The Units box, opened from the File menu: the unit lengths are shown and typed in. It is laid out as the Language box is.
import { tr } from '../i18n';
import { setUnits, useEditor } from '../state/store';
import { UNITS } from '../units';
import type { Unit } from '../units';
import { Modal } from './Modal';

const NAMES: Record<Unit, string> = { mm: tr('Millimeters'), in: tr('Inches') };

export function UnitsBox({ open, onClose }: { open: boolean; onClose: () => void }) {
  const units = useEditor((s) => s.prefs.units);
  const choose = (next: Unit): void => {
    setUnits(next);
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} className="about language units" label={tr('Units')}>
      <div className="about-body">
        <h2>{tr('Units')}</h2>
        <div className="language-list" role="menu">
          {UNITS.map((id) => (
            <button key={id} type="button" role="menuitemradio" aria-checked={id === units} className={id === units ? 'menu-item on' : 'menu-item'} onClick={() => choose(id)}>
              <span>{NAMES[id]}</span>
            </button>
          ))}
        </div>
        <div className="about-actions">
          <button type="button" className="primary" onClick={onClose}>
            {tr('Close')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
