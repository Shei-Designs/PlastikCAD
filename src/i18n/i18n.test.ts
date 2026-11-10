import { describe, expect, it } from 'vitest';
import { contextKey, deviceLanguage, language, mark, marked, plural, tr, translator, trx } from './index';

describe('the language of a run', () => {
  it('is English wherever there is no page to ask, as in these tests', () => {
    expect(language).toBe('en');
  });

  it('is the first of the device\'s languages the app has', () => {
    expect(deviceLanguage(['fr-CA', 'en-US'])).toBe('fr');
    expect(deviceLanguage(['de-DE', 'fr'])).toBe('fr');
    expect(deviceLanguage(['en-GB', 'fr-FR'])).toBe('en');
  });

  it('is English when the app has none of them', () => {
    expect(deviceLanguage(['de-DE', 'ja'])).toBe('en');
    expect(deviceLanguage([])).toBe('en');
  });
});

describe('a text in English', () => {
  it('is the text itself', () => {
    expect(tr('Save a copy…')).toBe('Save a copy…');
    expect(trx('verb', 'Open')).toBe('Open');
    expect(marked(mark('Move'))).toBe('Move');
  });

  it('has what it names in braces put in', () => {
    expect(tr('Deleted {name}.', { name: 'Bracket' })).toBe('Deleted Bracket.');
    expect(tr('{a} of {b}, {a} again', { a: 1, b: 2 })).toBe('1 of 2, 1 again');
  });

  it('keeps a name it was given nothing for, braces and all', () => {
    expect(tr('Deleted {name}.', {})).toBe('Deleted {name}.');
    expect(tr('Deleted {name}.')).toBe('Deleted {name}.');
  });

  it('puts in a value that itself holds braces as it is', () => {
    expect(tr('Opened {name}.', { name: '{other}', other: 'x' })).toBe('Opened {other}.');
  });

  it('is counted with one form for one and another for the rest', () => {
    expect(plural(1, '{n} object', '{n} objects')).toBe('1 object');
    expect(plural(0, '{n} object', '{n} objects')).toBe('0 objects');
    expect(plural(3, '{n} hole in {name}', '{n} holes in {name}', { name: 'Lid' })).toBe('3 holes in Lid');
  });
});

describe('a text in French', () => {
  const french = translator('fr');

  it('is looked up by the English text', () => {
    expect(french.tr('Close')).toBe('Fermer');
    expect(french.tr('About {app}…', { app: 'PlastikCAD' })).toBe('À propos de PlastikCAD…');
  });

  it('is the English text where the catalog has none', () => {
    expect(french.tr('A text no catalog holds, {n}', { n: 2 })).toBe('A text no catalog holds, 2');
    expect(french.trx('nowhere', 'A text no catalog holds')).toBe('A text no catalog holds');
    expect(french.plural(2, '{n} thing no catalog holds', '{n} things no catalog hold')).toBe('2 things no catalog hold');
    expect(french.plural(1, '{n} thing no catalog holds', '{n} things no catalog hold')).toBe('1 thing no catalog holds');
  });

  it('keeps a text with a context apart from the same text without', () => {
    expect(contextKey('verb', 'Open')).toBe('Open [[verb]]');
  });
});
