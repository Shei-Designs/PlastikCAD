/** The modifier of the app's shortcuts as it is written in tooltips and menus: ⌘ on a Mac, Ctrl+ everywhere else. */
export const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';
