import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS, GROUPS, command, commandFor, groupKeys, matches, shortcut, shortcutRows, tip, written } from './keymap';
import type { CommandId, KeyPress } from './keymap';

/** A key press written as it is read: "Ctrl+Shift+z", "Meta+s", "ArrowLeft". */
function press(text: string): KeyPress {
  const parts = text.split('+');
  const key = parts.pop() ?? '';
  return { key, ctrlKey: parts.includes('Ctrl'), metaKey: parts.includes('Meta'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift') };
}

const runs = (text: string): CommandId | null => commandFor(press(text))?.id ?? null;

describe('the table', () => {
  it('names every command once', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(46);
  });

  it('has a command for every row of the Shortcuts list', () => {
    for (const group of GROUPS) expect(COMMANDS.some((c) => c.group === group), group).toBe(true);
  });

  it('lets a modifier that changes a command through on every key of it', () => {
    for (const c of COMMANDS) {
      for (const k of c.chords) {
        if (c.held?.shift) expect(k.shift, `${c.id} with Shift`).toBe('any');
        if (c.held?.alt) expect(k.alt, `${c.id} with Alt`).toBe('any');
      }
    }
  });

  it('says the same of Shift and Alt for every command of a row, as the row says it once', () => {
    for (const group of GROUPS) {
      const held = COMMANDS.filter((c) => c.group === group).map((c) => JSON.stringify(c.held ?? {}));
      expect(new Set(held).size, group).toBe(1);
    }
  });

  it('shows no two commands with the same keys', () => {
    const shown = COMMANDS.map((c) => shortcut(c.id, false));
    expect(new Set(shown).size).toBe(shown.length);
  });
});

describe('matching a key press', () => {
  it('finds the single letters', () => {
    expect(runs('h')).toBe('hole');
    expect(runs('s')).toBe('solid');
    expect(runs('d')).toBe('drop');
    expect(runs('f')).toBe('fit');
    expect(runs('l')).toBe('align');
    expect(runs('m')).toBe('measure');
    expect(runs('o')).toBe('objectAxes');
    expect(runs('g')).toBe('ghost');
    expect(runs('x')).toBe('mirrorX');
    expect(runs('y')).toBe('mirrorY');
    expect(runs('z')).toBe('mirrorZ');
  });

  it('reads a capital as its letter, from Shift or from Caps Lock', () => {
    expect(runs('H')).toBe('hole');
    expect(runs('Shift+G')).toBe('unghostAll');
    expect(runs('Ctrl+Shift+Z')).toBe('redo');
    expect(runs('Ctrl+Z')).toBe('undo');
  });

  it('takes Ctrl and ⌘ alike', () => {
    expect(runs('Ctrl+z')).toBe('undo');
    expect(runs('Meta+z')).toBe('undo');
    expect(runs('Ctrl+Meta+z')).toBe('undo');
  });

  it('tells a command from the one Shift makes of it', () => {
    expect(runs('Ctrl+z')).toBe('undo');
    expect(runs('Ctrl+Shift+z')).toBe('redo');
    expect(runs('Ctrl+y')).toBe('redo');
    expect(runs('Ctrl+g')).toBe('group');
    expect(runs('Ctrl+Shift+g')).toBe('ungroup');
    expect(runs('Ctrl+s')).toBe('save');
    expect(runs('Ctrl+Shift+s')).toBe('saveCopy');
    expect(runs('Ctrl+o')).toBe('projects');
    expect(runs('Ctrl+Shift+o')).toBe('openFile');
    expect(runs('Alt+c')).toBe('centerOnPlate');
    expect(runs('Alt+Shift+c')).toBe('centerAll');
  });

  it('keeps the letters with Ctrl apart from the letters alone', () => {
    expect(runs('Ctrl+c')).toBe('copy');
    expect(runs('Ctrl+x')).toBe('cut');
    expect(runs('Ctrl+v')).toBe('paste');
    expect(runs('Ctrl+a')).toBe('selectAll');
    expect(runs('Ctrl+d')).toBe('duplicate');
    expect(runs('Ctrl+n')).toBe('newProject');
    expect(runs('Ctrl+i')).toBe('import');
    // Ctrl with a key that has no command of its own does nothing, whatever the key does alone.
    for (const key of ['h', 'f', 'l', 'm', 'Delete', 'Backspace', 'ArrowLeft', 'ArrowRight', 'PageUp']) expect(runs(`Ctrl+${key}`), key).toBeNull();
  });

  it('turns with Shift, and leaves which way to Alt', () => {
    expect(runs('Shift+X')).toBe('rotateX');
    expect(runs('Shift+Y')).toBe('rotateY');
    expect(runs('Shift+Z')).toBe('rotateZ');
    expect(runs('Alt+Shift+X')).toBe('rotateX');
    expect(runs('Ctrl+Shift+X')).toBe('cut');
    expect(command('rotateX').held).toEqual({ alt: 'reverses' });
  });

  it('nudges with the arrows, raises with Ctrl and aligns with Alt', () => {
    expect(runs('ArrowLeft')).toBe('nudgeLeft');
    expect(runs('ArrowRight')).toBe('nudgeRight');
    expect(runs('ArrowUp')).toBe('nudgeBack');
    expect(runs('ArrowDown')).toBe('nudgeForward');
    expect(runs('Shift+ArrowLeft')).toBe('nudgeLeft');
    expect(runs('Ctrl+ArrowUp')).toBe('raise');
    expect(runs('Ctrl+ArrowDown')).toBe('lower');
    expect(runs('Ctrl+Shift+ArrowUp')).toBe('raise');
    expect(runs('Alt+ArrowLeft')).toBe('alignLeft');
    expect(runs('Alt+ArrowRight')).toBe('alignRight');
    expect(runs('Alt+ArrowDown')).toBe('alignFront');
    expect(runs('Alt+ArrowUp')).toBe('alignBack');
    expect(runs('Alt+PageUp')).toBe('alignTop');
    expect(runs('Alt+PageDown')).toBe('alignBottom');
    expect(runs('Alt+Shift+ArrowLeft')).toBe('alignLeft');
    expect(runs('PageUp')).toBeNull();
  });

  it('deletes with Delete and with Backspace', () => {
    expect(runs('Delete')).toBe('delete');
    expect(runs('Backspace')).toBe('delete');
  });

  it('cancels on Escape whatever is held, and leaves the key to the browser', () => {
    for (const held of ['', 'Ctrl+', 'Alt+', 'Shift+', 'Ctrl+Alt+Shift+']) expect(runs(`${held}Escape`), held).toBe('cancel');
    expect(COMMANDS.filter((c) => c.keepsDefault).map((c) => c.id)).toEqual(['cancel']);
  });

  // What the dispatcher before the table did with modifiers it never looked at; see the note on the table.
  it('runs a command with the modifiers it has always let through', () => {
    expect(runs('Shift+H')).toBe('hole');
    expect(runs('Alt+h')).toBe('hole');
    expect(runs('Alt+Delete')).toBe('delete');
    expect(runs('Alt+x')).toBe('mirrorX');
    expect(runs('Ctrl+Alt+z')).toBe('undo');
    expect(runs('Ctrl+Shift+C')).toBe('copy');
    expect(runs('Ctrl+Shift+N')).toBe('newProject');
    expect(runs('Ctrl+Shift+I')).toBe('import');
  });

  it('does nothing for a key that is not bound', () => {
    for (const key of ['c', 'n', 'Enter', 'Tab', ' ', '1', 'Shift', 'Shift+C', 'Ctrl+Alt+s', 'Ctrl+Alt+o', 'Ctrl+Alt+n', 'Alt+Shift', 'Dead', 'toString']) expect(runs(key), key).toBeNull();
  });

  it('runs only the file commands while a text box has the focus', () => {
    expect(COMMANDS.filter((c) => c.typing).map((c) => c.id)).toEqual(['save', 'saveCopy', 'projects', 'openFile', 'newProject', 'import']);
  });

  it('never has two commands for one key press', () => {
    const keys = new Set(COMMANDS.flatMap((c) => c.chords.map((k) => k.key)));
    let pressed = 0;
    for (const key of keys) {
      for (let held = 0; held < 16; held++) {
        const e: KeyPress = { key, ctrlKey: Boolean(held & 1), metaKey: Boolean(held & 2), altKey: Boolean(held & 4), shiftKey: Boolean(held & 8) };
        const found = COMMANDS.filter((c) => matches(c, e)).map((c) => c.id);
        expect(found.length, `${JSON.stringify(e)} runs ${found.join(' and ')}`).toBeLessThanOrEqual(1);
        pressed += found.length;
      }
    }
    expect(pressed).toBeGreaterThan(COMMANDS.length);
  });
});

describe('writing a shortcut', () => {
  it('puts the modifiers before the key, Ctrl first', () => {
    expect(shortcut('undo', false)).toBe('Ctrl+Z');
    expect(shortcut('ungroup', false)).toBe('Ctrl+Shift+G');
    expect(shortcut('centerAll', false)).toBe('Alt+Shift+C');
    expect(shortcut('unghostAll', false)).toBe('Shift+G');
    expect(shortcut('hole', false)).toBe('H');
  });

  it('leaves out a modifier that makes no difference', () => {
    expect(shortcut('newProject', false)).toBe('Ctrl+N');
    expect(shortcut('rotateX', false)).toBe('Shift+X');
    expect(shortcut('nudgeLeft', false)).toBe('←');
  });

  it('names the keys that are not letters', () => {
    expect(shortcut('delete', false)).toBe('Delete');
    expect(shortcut('cancel', false)).toBe('Esc');
    expect(shortcut('raise', false)).toBe('Ctrl+↑');
    expect(shortcut('alignTop', false)).toBe('Alt+PgUp');
    expect(shortcut('alignBottom', false)).toBe('Alt+PgDn');
  });

  it('shows the first key of a command that has two', () => {
    expect(shortcut('redo', false)).toBe('Ctrl+Y');
    expect(command('redo').chords.map((k) => written(k, false))).toEqual(['Ctrl+Y', 'Ctrl+Shift+Z']);
    expect(command('delete').chords.map((k) => written(k, false))).toEqual(['Delete', 'Backspace']);
  });

  it('writes ⌘ for Ctrl on a Mac, with nothing after it', () => {
    expect(shortcut('undo', true)).toBe('⌘Z');
    expect(shortcut('ungroup', true)).toBe('⌘Shift+G');
    expect(shortcut('raise', true)).toBe('⌘↑');
    expect(shortcut('centerAll', true)).toBe('Alt+Shift+C');
    expect(tip('undo', undefined, true)).toBe('Undo (⌘Z)');
  });

  it('makes a tooltip of a name and its shortcut', () => {
    expect(tip('undo', undefined, false)).toBe('Undo (Ctrl+Z)');
    expect(tip('delete', undefined, false)).toBe('Delete (Delete)');
    expect(tip('mirrorX', undefined, false)).toBe('Flip X (X)');
    expect(tip('duplicate', 'Duplicate in place', false)).toBe('Duplicate in place (Ctrl+D)');
  });
});

describe('the Shortcuts list', () => {
  it('joins the keys of a row', () => {
    expect(groupKeys('Undo / redo', false)).toBe('Ctrl+Z / Ctrl+Y');
    expect(groupKeys('Copy / cut / paste', true)).toBe('⌘C / ⌘X / ⌘V');
    expect(groupKeys('Mirror', false)).toBe('X / Y / Z');
  });

  it('writes the four arrows as one word, and what Shift or Alt changes after the keys', () => {
    expect(groupKeys('Move', false)).toBe('arrow keys · Shift ×10');
    expect(groupKeys('Align to edge', false)).toBe('Alt+arrows / Alt+PgUp / Alt+PgDn · Shift centers');
    expect(groupKeys('Raise or lower', false)).toBe('Ctrl+↑ / Ctrl+↓ · Shift ×10');
    expect(groupKeys('Rotate 90°', false)).toBe('Shift+X / Shift+Y / Shift+Z · Alt reverses');
  });

  it('lists the mouse and then the keys on a desktop', () => {
    expect(shortcutRows(true, false, false)).toEqual([
      ['Orbit', 'Right drag'],
      ['Pan', 'Middle drag · Shift+right drag'],
      ['Zoom', 'Wheel'],
      ['Move', 'Drag · arrow keys · Shift ×10'],
      ['Raise or lower', 'Arrow handle · Ctrl+↑ / Ctrl+↓ · Shift ×10'],
      ['Resize height', 'Drag top or bottom grip'],
      ['Type a size', 'Click a grip'],
      ['Undo / redo', 'Ctrl+Z / Ctrl+Y'],
      ['Copy / cut / paste', 'Ctrl+C / Ctrl+X / Ctrl+V'],
      ['Select all', 'Ctrl+A'],
      ['Delete', 'Delete'],
      ['Duplicate', 'Ctrl+D'],
      ['Group / ungroup', 'Ctrl+G / Ctrl+Shift+G'],
      ['Solid / hole', 'S / H'],
      ['Mirror', 'X / Y / Z'],
      ['Rotate 90°', 'Shift+X / Shift+Y / Shift+Z · Alt reverses'],
      ['Ghost / un-ghost all', 'G / Shift+G'],
      ['Align', 'L'],
      ['Measure', 'M'],
      ['Object axes', 'O'],
      ['Align to edge', 'Alt+arrows / Alt+PgUp / Alt+PgDn · Shift centers'],
      ['Center on plate', 'Alt+C'],
      ['Drop onto the plate', 'D'],
      ['Fit to view', 'F'],
      ['Import model or picture', 'Ctrl+I'],
    ]);
  });

  it('shows only what fingers do on a tablet with no keyboard', () => {
    expect(shortcutRows(false, true, false)).toEqual([
      ['Orbit', 'One finger'],
      ['Pan / zoom', 'Two fingers'],
      ['Select more', 'Hold an object'],
      ['Box select', 'Hold the plate, then drag'],
      ['Clear selection', 'Tap the plate'],
      ['Undo / redo', 'Two-finger tap / three-finger tap'],
      ['Move', 'Drag'],
      ['Raise or lower', 'Arrow handle'],
      ['Resize height', 'Drag top or bottom grip'],
      ['Type a size', 'Click a grip'],
    ]);
  });

  it('adds the keys to the touch rows once a keyboard is docked', () => {
    const rows = shortcutRows(true, true, false);
    expect(rows.slice(0, 7)).toEqual([...shortcutRows(false, true, false).slice(0, 5), ['Undo / redo', 'Two-finger tap / three-finger tap · Ctrl+Z / Ctrl+Y'], ['Move', 'Drag · arrow keys · Shift ×10']]);
    // The rest is the keys alone, as with a mouse; undo and redo are already said beside the taps.
    expect(rows.slice(10)).toEqual(shortcutRows(true, false, false).slice(7).filter(([what]) => what !== 'Undo / redo'));
    expect(rows.map(([what]) => what)).not.toContain('Zoom');
  });

  it('has each row once', () => {
    for (const [keyboard, coarse] of [[true, true], [true, false], [false, true], [false, false]]) {
      const names = shortcutRows(keyboard, coarse, false).map(([what]) => what);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

// The README's table is prose, with explanations the keymap has none of, so it is checked rather than generated.
describe('the README', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const heading = '## Mouse and keyboard';

  /** The section under a heading, up to the next one. */
  function section(text: string): string {
    const from = text.indexOf(heading);
    if (from < 0) return '';
    const next = text.indexOf('\n## ', from + heading.length);
    return text.slice(from, next < 0 ? undefined : next);
  }

  /** Whether the text has these keys standing by themselves: "G" is not in "Ctrl+G", nor "Shift+G" in "Ctrl+Shift+G". */
  const names = (text: string, keys: string): boolean => new RegExp(`(?<![\\w+])${keys.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w+])`, 'u').test(text);

  /** The ways a shortcut may be written: as the app shows it, or for an arrow as the Shortcuts list does ("Alt+arrows", "arrow keys"). */
  function spellings(keys: string): string[] {
    const arrows = keys.replace(/[←→↑↓]$/u, 'arrows');
    return arrows === keys ? [keys] : [keys, arrows === 'arrows' ? 'arrow keys' : arrows];
  }

  /** The commands with a shortcut the text does not name, each with the shortcut that is missing. */
  function missing(text: string): string[] {
    return COMMANDS.flatMap((c) =>
      c.chords
        .map((k) => written(k, false))
        .filter((keys) => !spellings(keys).some((s) => names(text, s)))
        .map((keys) => `${c.name} (${keys})`),
    );
  }

  /** A shortcut as the README writes it, read back as the key press it stands for. */
  function read(keys: string): KeyPress {
    const parts = keys.split('+');
    const label = parts.pop() ?? '';
    const key = COMMANDS.flatMap((c) => c.chords).find((k) => written({ ...k, mod: false, alt: false, shift: false }, false) === label)?.key ?? label;
    return { key, ctrlKey: parts.includes('Ctrl'), metaKey: false, altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift') };
  }

  it('has the section', () => {
    expect(section(readme)).toContain('| Undo / redo |');
    expect(section(readme)).not.toContain('## Export formats');
  });

  it('names the shortcut of every command under "Mouse and keyboard"', () => {
    expect(missing(section(readme)), 'commands whose shortcut the README does not name').toEqual([]);
  });

  it('names no shortcut with a modifier that runs nothing', () => {
    const written = section(readme).match(/(?:(?:Ctrl|Alt|Shift)\+)+[^\s,;:/()|]+/gu) ?? [];
    expect(written.length).toBeGreaterThan(20);
    expect(written.filter((keys) => !commandFor(read(keys))), 'shortcuts in the README that no command answers to').toEqual([]);
  });

  it('would notice a shortcut that went missing', () => {
    const text = section(readme);
    expect(missing(text.replace('Ctrl+Shift+G', 'Ctrl+U'))).toEqual(['Ungroup (Ctrl+Shift+G)']);
    expect(missing(text.replace(' or Backspace', ''))).toEqual(['Delete (Backspace)']);
    expect(missing('')).toHaveLength(COMMANDS.flatMap((c) => c.chords).length);
  });
});

describe('Alt on a Mac', () => {
  const press = (key: string, code: string, over: Partial<{ shiftKey: boolean }> = {}) => ({ key, code, ctrlKey: false, metaKey: false, altKey: true, shiftKey: false, ...over });

  it('reads the letter off the key when Alt has typed another character', () => {
    // Alt+C types "ç" there, and Alt+Shift+X "˛".
    expect(commandFor(press('ç', 'KeyC'))?.id).toBe(commandFor(press('c', 'KeyC'))?.id);
    expect(commandFor(press('ç', 'KeyC'))).not.toBeNull();
    expect(commandFor(press('˛', 'KeyX', { shiftKey: true }))?.id).toBe(commandFor(press('X', 'KeyX', { shiftKey: true }))?.id);
  });

  it('trusts the letter the key says wherever it says one, whatever the layout', () => {
    // A French board: the key marked Z sits where a US board has W, and says "z".
    expect(commandFor(press('Z', 'KeyW', { shiftKey: true }))?.id).toBe(commandFor(press('Z', 'KeyZ', { shiftKey: true }))?.id);
    expect(commandFor(press('Z', 'KeyW', { shiftKey: true }))).not.toBeNull();
  });
});
