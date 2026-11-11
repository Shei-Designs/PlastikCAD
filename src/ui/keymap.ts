// Every keyboard command of the app, once. The dispatcher in App.tsx runs whatever a key press
// matches here, and the tooltips, the File menu and the inspector's Shortcuts list take their
// wording from here, so that what a key does and what the app says it does cannot drift apart.
// A test holds the README's table to it as well.
import { mark, tr, trx } from '../i18n';
import { MAC, modifier } from './keys';

/** The rows of the Shortcuts list that hold keys, in the order they are shown. Their English is what the code knows them by; `marked()` translates them where they are shown. */
export const GROUPS = [
  mark('Move'),
  mark('Raise or lower'),
  mark('Undo / redo'),
  mark('Copy / cut / paste'),
  mark('Select all'),
  mark('Delete'),
  mark('Duplicate'),
  mark('Group / ungroup'),
  mark('Solid / hole'),
  mark('Mirror'),
  mark('Rotate 90°'),
  mark('Ghost / un-ghost all'),
  mark('Align'),
  mark('Measure'),
  mark('Object axes'),
  mark('Align to edge'),
  mark('Center on plate'),
  mark('Drop onto the plate'),
  mark('Fit to view'),
  mark('Import model or picture'),
] as const;

export type Group = (typeof GROUPS)[number];

/** What holding Shift or Alt changes; the Shortcuts list says it with the key's name (see HELD). */
type Held = '×10' | 'reverses' | 'centers';

interface Spec {
  id: string;
  /** What tooltips and menus call it. */
  name: string;
  /**
   * The key presses that run it; the first is the one shown. Each is written as its modifiers
   * and then a `KeyboardEvent.key`: `Mod` is Ctrl or ⌘, and a `?` after a modifier means the
   * command runs with or without it. Any modifier not named must not be held.
   */
  keys: readonly string[];
  /** The row of the Shortcuts list it is shown in; a command without one is left out of the list. */
  group?: Group;
  /** What holding Shift or Alt with it changes, as the Shortcuts list words it. */
  held?: { shift?: Held; alt?: Held };
  /** Runs while the focus is in a text box too. */
  typing?: true;
  /** Leaves the key to the browser as well: Escape must still close a dialog or a menu. */
  keepsDefault?: true;
}

// The optional modifiers are what the dispatcher this table replaced let through without
// looking (Shift+H makes a hole, Ctrl+Alt+Z undoes), kept so that no key changes what it does.
const SPECS = [
  // The file commands are the only ones that work from inside a text box.
  { id: 'save', name: tr('Save now'), keys: ['Mod+S'], typing: true },
  { id: 'saveCopy', name: tr('Save a copy'), keys: ['Mod+Shift+S'], typing: true },
  { id: 'projects', name: tr('Projects'), keys: ['Mod+O'], typing: true },
  { id: 'openFile', name: tr('Open project file'), keys: ['Mod+Shift+O'], typing: true },
  { id: 'newProject', name: tr('New project'), keys: ['Mod+Shift?+N'], typing: true },
  { id: 'import', name: tr('Import'), keys: ['Mod+Shift?+I'], group: 'Import model or picture', typing: true },

  { id: 'cancel', name: tr('Cancel'), keys: ['Mod?+Alt?+Shift?+Escape'], keepsDefault: true },

  { id: 'undo', name: tr('Undo'), keys: ['Mod+Alt?+Z'], group: 'Undo / redo' },
  { id: 'redo', name: tr('Redo'), keys: ['Mod+Alt?+Shift?+Y', 'Mod+Alt?+Shift+Z'], group: 'Undo / redo' },
  { id: 'copy', name: tr('Copy'), keys: ['Mod+Alt?+Shift?+C'], group: 'Copy / cut / paste' },
  { id: 'cut', name: tr('Cut'), keys: ['Mod+Alt?+Shift?+X'], group: 'Copy / cut / paste' },
  { id: 'paste', name: tr('Paste'), keys: ['Mod+Alt?+Shift?+V'], group: 'Copy / cut / paste' },
  { id: 'selectAll', name: tr('Select all'), keys: ['Mod+Alt?+Shift?+A'], group: 'Select all' },
  { id: 'delete', name: tr('Delete'), keys: ['Alt?+Shift?+Delete', 'Alt?+Shift?+Backspace'], group: 'Delete' },
  { id: 'duplicate', name: tr('Duplicate'), keys: ['Mod+Alt?+Shift?+D'], group: 'Duplicate' },
  { id: 'group', name: trx('verb', 'Group'), keys: ['Mod+Alt?+G'], group: 'Group / ungroup' },
  { id: 'ungroup', name: tr('Ungroup'), keys: ['Mod+Alt?+Shift+G'], group: 'Group / ungroup' },

  // Alt with an arrow aligns, so a nudge is the one plain key that Alt does not let through.
  { id: 'nudgeLeft', name: tr('Move left'), keys: ['Shift?+ArrowLeft'], group: 'Move', held: { shift: '×10' } },
  { id: 'nudgeRight', name: tr('Move right'), keys: ['Shift?+ArrowRight'], group: 'Move', held: { shift: '×10' } },
  { id: 'nudgeBack', name: tr('Move back'), keys: ['Shift?+ArrowUp'], group: 'Move', held: { shift: '×10' } },
  { id: 'nudgeForward', name: tr('Move forward'), keys: ['Shift?+ArrowDown'], group: 'Move', held: { shift: '×10' } },
  { id: 'raise', name: tr('Raise'), keys: ['Mod+Alt?+Shift?+ArrowUp'], group: 'Raise or lower', held: { shift: '×10' } },
  { id: 'lower', name: tr('Lower'), keys: ['Mod+Alt?+Shift?+ArrowDown'], group: 'Raise or lower', held: { shift: '×10' } },

  { id: 'solid', name: tr('Solid'), keys: ['Alt?+Shift?+S'], group: 'Solid / hole' },
  { id: 'hole', name: tr('Hole'), keys: ['Alt?+Shift?+H'], group: 'Solid / hole' },
  { id: 'mirrorX', name: tr('Flip X'), keys: ['Alt?+X'], group: 'Mirror' },
  { id: 'mirrorY', name: tr('Flip Y'), keys: ['Alt?+Y'], group: 'Mirror' },
  { id: 'mirrorZ', name: tr('Flip Z'), keys: ['Alt?+Z'], group: 'Mirror' },
  { id: 'rotateX', name: tr('Rotate 90° about X'), keys: ['Alt?+Shift+X'], group: 'Rotate 90°', held: { alt: 'reverses' } },
  { id: 'rotateY', name: tr('Rotate 90° about Y'), keys: ['Alt?+Shift+Y'], group: 'Rotate 90°', held: { alt: 'reverses' } },
  { id: 'rotateZ', name: tr('Rotate 90° about Z'), keys: ['Alt?+Shift+Z'], group: 'Rotate 90°', held: { alt: 'reverses' } },
  { id: 'ghost', name: trx('verb', 'Ghost'), keys: ['Alt?+G'], group: 'Ghost / un-ghost all' },
  { id: 'unghostAll', name: tr('Un-ghost all'), keys: ['Alt?+Shift+G'], group: 'Ghost / un-ghost all' },

  { id: 'align', name: tr('Align'), keys: ['Alt?+Shift?+L'], group: 'Align' },
  { id: 'measure', name: tr('Measure'), keys: ['Alt?+Shift?+M'], group: 'Measure' },
  { id: 'objectAxes', name: tr('Object axes'), keys: ['Alt?+Shift?+O'], group: 'Object axes' },
  { id: 'alignLeft', name: tr('Align left'), keys: ['Alt+Shift?+ArrowLeft'], group: 'Align to edge', held: { shift: 'centers' } },
  { id: 'alignRight', name: tr('Align right'), keys: ['Alt+Shift?+ArrowRight'], group: 'Align to edge', held: { shift: 'centers' } },
  { id: 'alignFront', name: tr('Align front'), keys: ['Alt+Shift?+ArrowDown'], group: 'Align to edge', held: { shift: 'centers' } },
  { id: 'alignBack', name: tr('Align back'), keys: ['Alt+Shift?+ArrowUp'], group: 'Align to edge', held: { shift: 'centers' } },
  { id: 'alignTop', name: tr('Align top'), keys: ['Alt+Shift?+PageUp'], group: 'Align to edge', held: { shift: 'centers' } },
  { id: 'alignBottom', name: tr('Align bottom'), keys: ['Alt+Shift?+PageDown'], group: 'Align to edge', held: { shift: 'centers' } },
  { id: 'centerOnPlate', name: tr('Center on plate'), keys: ['Alt+C'], group: 'Center on plate' },
  { id: 'centerAll', name: tr('Center on every axis'), keys: ['Alt+Shift+C'] },

  { id: 'drop', name: tr('Drop onto the plate'), keys: ['Alt?+Shift?+D'], group: 'Drop onto the plate' },
  { id: 'fit', name: tr('Fit to view'), keys: ['Alt?+Shift?+F'], group: 'Fit to view' },
] as const satisfies readonly Spec[];

export type CommandId = (typeof SPECS)[number]['id'];

/** Whether a modifier must be held, must not be, or makes no difference. */
export type Need = boolean | 'any';

export interface Chord {
  /** `KeyboardEvent.key`, a letter in lower case. */
  key: string;
  /** Ctrl or ⌘: either counts, on every system. */
  mod: Need;
  alt: Need;
  shift: Need;
}

export interface Command extends Omit<Spec, 'keys'> {
  id: CommandId;
  /** Its key presses; the first is the one shown. */
  chords: readonly Chord[];
}

const MODIFIERS = ['Mod', 'Alt', 'Shift'];

function chord(text: string): Chord {
  const parts = text.split('+');
  const key = parts.pop() ?? '';
  const stray = parts.find((p) => !MODIFIERS.includes(p.replace(/\?$/, '')));
  if (stray !== undefined || !key) throw new Error(`The keymap cannot read "${text}".`);
  const need = (name: string): Need => (parts.includes(name) ? true : parts.includes(`${name}?`) ? 'any' : false);
  return { key: key.length === 1 ? key.toLowerCase() : key, mod: need('Mod'), alt: need('Alt'), shift: need('Shift') };
}

export const COMMANDS: readonly Command[] = SPECS.map(({ keys, ...rest }) => ({ ...rest, chords: keys.map(chord) }));

const BY_ID = new Map<CommandId, Command>(COMMANDS.map((c) => [c.id, c]));

export function command(id: CommandId): Command {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`The keymap has no command "${id}".`);
  return found;
}

// --- matching ---------------------------------------------------------------------

/** The part of a `KeyboardEvent` a command is matched on. */
export interface KeyPress {
  key: string;
  /** Where the key is on the board ("KeyC"), for when Alt has made `key` some other character. */
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const fits = (need: Need, held: boolean): boolean => need === 'any' || need === held;

/** Whether a key press is one of a command's. */
export function matches(c: Command, e: KeyPress): boolean {
  // Caps Lock and Shift give the capital; the table has the letter.
  let key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // With Alt held a Mac types another character altogether (Alt+C gives "ç"). The letter is then read off the key's
  // place on the board, but only then: where the key says a letter, that letter is the one on its cap, whatever the
  // layout (on a French board the key marked Z sits where a US board has W).
  if (e.altKey && key.length === 1 && !/[a-z0-9]/.test(key) && e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  return c.chords.some((k) => k.key === key && fits(k.mod, mod) && fits(k.alt, e.altKey) && fits(k.shift, e.shiftKey));
}

/** The command a key press asks for. No two commands answer to the same press, so the order of the table decides nothing. */
export const commandFor = (e: KeyPress): Command | null => COMMANDS.find((c) => matches(c, e)) ?? null;

// --- wording ----------------------------------------------------------------------

const ALT = trx('key', 'Alt');
const SHIFT = trx('key', 'Shift');

/** The keys that are not written as the character they type: an arrow, or the name a keyboard of the app's language prints. */
const KEY_NAMES: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: trx('key', 'PgUp'),
  PageDown: trx('key', 'PgDn'),
  Escape: trx('key', 'Esc'),
  Delete: trx('key', 'Delete'),
  Backspace: trx('key', 'Backspace'),
};

/** What holding a key changes, said whole with the key's name: a language words the two together. */
const HELD: Record<Held, (key: string) => string> = {
  '×10': (key) => tr('{key} ×10', { key }),
  reverses: (key) => tr('{key} reverses', { key }),
  centers: (key) => tr('{key} centers', { key }),
};

/** The modifiers a chord needs, as they are written before its key. */
const prefix = (k: Chord, mac: boolean): string => `${k.mod === true ? modifier(mac) : ''}${k.alt === true ? `${ALT}+` : ''}${k.shift === true ? `${SHIFT}+` : ''}`;

/** A chord as the app writes it: "Ctrl+Shift+G", or "⌘Shift+G" on a Mac. */
export const written = (k: Chord, mac: boolean = MAC): string => `${prefix(k, mac)}${KEY_NAMES[k.key] ?? (k.key.length === 1 ? k.key.toUpperCase() : k.key)}`;

/** The shortcut a command is shown with. */
export const shortcut = (id: CommandId, mac: boolean = MAC): string => written(command(id).chords[0], mac);

/** A tooltip: "Undo (Ctrl+Z)". `text` stands in for the command's name where the button says more. */
export const tip = (id: CommandId, text?: string, mac: boolean = MAC): string => `${text ?? command(id).name} (${shortcut(id, mac)})`;

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

/** The keys of one row of the Shortcuts list: "Ctrl+Z / Ctrl+Y", "Shift+X / Shift+Y / Shift+Z · Alt reverses". */
export function groupKeys(group: Group, mac: boolean = MAC): string {
  const members = COMMANDS.filter((c) => c.group === group);
  const shown = members.map((c) => c.chords[0]);
  // The four arrows with the same modifiers read better as one word than as four keys.
  const arrows = shown.filter((k) => ARROWS.includes(k.key));
  const together = arrows.length === ARROWS.length && arrows.every((k) => prefix(k, mac) === prefix(arrows[0], mac));
  const keys: string[] = [];
  for (const k of shown) {
    if (!together || !ARROWS.includes(k.key)) keys.push(written(k, mac));
    else if (k === arrows[0]) keys.push(prefix(k, mac) ? tr('{modifiers}arrows', { modifiers: prefix(k, mac) }) : tr('arrow keys'));
  }
  const notes = new Set<string>();
  for (const c of members) {
    if (c.held?.alt) notes.add(HELD[c.held.alt](ALT));
    if (c.held?.shift) notes.add(HELD[c.held.shift](SHIFT));
  }
  return [keys.join(' / '), ...notes].join(' · ');
}

// --- the Shortcuts list -----------------------------------------------------------

/** One row of the Shortcuts list: what it does, in the English the rows are matched by (`marked()` translates it where it is shown), and how. */
export type Row = [what: string, how: string];

// What a mouse or a finger does is no key binding, so these rows are written here by hand.
const MOUSE: Row[] = [
  [mark('Orbit'), tr('Right drag')],
  [mark('Pan'), tr('Middle drag · Shift+right drag')],
  [mark('Zoom'), tr('Wheel')],
];

const FINGERS: Row[] = [
  [mark('Orbit'), tr('One finger')],
  [mark('Pan / zoom'), tr('Two fingers')],
  [mark('Select more'), tr('Hold an object')],
  [mark('Box select'), tr('Hold the plate, then drag')],
  [mark('Clear selection'), tr('Tap the plate')],
  [mark('Undo / redo'), tr('Two-finger tap / three-finger tap')],
];

/** The handles on a selection, for a mouse and a finger alike. A group of the same name adds its keys to the row. */
const HANDLES: Row[] = [
  [mark('Move'), tr('Drag')],
  [mark('Raise or lower'), tr('Arrow handle')],
  [mark('Resize height'), tr('Drag top or bottom grip')],
  [mark('Type a size'), tr('Click a grip')],
];

/**
 * The Shortcuts list for what the app is being driven with: the rows of the pointer in use, and
 * the keys only while there is a keyboard to press them on.
 */
export function shortcutRows(keyboard: boolean, coarse: boolean, mac: boolean = MAC): Row[] {
  const pointer = [...(coarse ? FINGERS : MOUSE), ...HANDLES];
  if (!keyboard) return pointer;
  const group = (what: string): Group | undefined => GROUPS.find((g) => g === what);
  const shared = pointer.map(([what, how]): Row => {
    const g = group(what);
    return g ? [what, `${how} · ${groupKeys(g, mac)}`] : [what, how];
  });
  const rest = GROUPS.filter((g) => !pointer.some(([what]) => what === g)).map((g): Row => [g, groupKeys(g, mac)]);
  return [...shared, ...rest];
}
