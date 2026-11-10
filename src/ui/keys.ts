import { trx } from '../i18n';

/** Whether this is a Mac, where the shortcuts are written with ⌘ rather than Ctrl. */
export const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** The modifier of the app's shortcuts as it is written in tooltips and menus: ⌘ on a Mac, Ctrl+ everywhere else. */
export const modifier = (mac: boolean = MAC): string => (mac ? '⌘' : `${trx('key', 'Ctrl')}+`);
