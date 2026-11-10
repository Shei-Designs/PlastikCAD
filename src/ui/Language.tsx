// The Language box, opened from the File menu: the languages the app has, each named in itself.
import { APP_NAME } from '../appInfo';
import { LANGUAGES, chooseLanguage, languageChoice, tr } from '../i18n';
import type { Language } from '../i18n';
import { saveProject } from '../state/store';
import { Modal } from './Modal';

export function LanguageBox({ open, onClose }: { open: boolean; onClose: () => void }) {
  const choice = languageChoice();
  // The language is settled when the app starts (see i18n): the choice is kept, the design saved, and the app started again.
  const choose = async (next: Language | 'auto'): Promise<void> => {
    if (next === choice) return onClose();
    chooseLanguage(next);
    await saveProject();
    location.reload();
  };
  const row = (id: Language | 'auto', name: string) => (
    <button key={id} type="button" role="menuitemradio" aria-checked={id === choice} className={id === choice ? 'menu-item on' : 'menu-item'} onClick={() => void choose(id)}>
      <span>{name}</span>
    </button>
  );
  return (
    <Modal open={open} onClose={onClose} className="about language" label={tr('Language')}>
      <div className="about-body">
        <h2>{tr('Language')}</h2>
        <div className="language-list" role="menu">
          {row('auto', tr('Same as this device'))}
          {LANGUAGES.map((l) => row(l.id, l.name))}
        </div>
        <p>{tr('{app} starts again in the language chosen.', { app: APP_NAME })}</p>
        <div className="about-actions">
          <button type="button" className="primary" onClick={onClose}>
            {tr('Close')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
