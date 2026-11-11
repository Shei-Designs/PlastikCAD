// Holds every catalog to the source: each text the app looks up is read out of the code, and a
// catalog must translate all of them, none besides, and put the same things in.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { fr, FR_PARTS } from './fr';
import { contextKey } from './index';
import type { Catalog, Language } from './index';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** A text the source looks up: its key in a catalog, and what it names in braces. */
interface Found {
  key: string;
  /** Counted texts are keyed by their plural and translated as forms. */
  counted: boolean;
  names: Set<string>;
  at: string;
}

const namesIn = (text: string): Set<string> => new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === join(SRC, 'i18n') ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Which argument of each lookup holds a text. */
const TEXT_AT: Record<string, number[]> = { tr: [0], trx: [1], plural: [1, 2], mark: [0], rich: [0] };

function read(): { found: Found[]; faults: string[] } {
  const found: Found[] = [];
  const faults: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const code = readFileSync(path, 'utf8');
    if (!/from '(\.\.?\/)+(i18n|i18n\/rich|index|rich)'/.test(code) || !/i18n/.test(code)) continue;
    const file = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text in TEXT_AT) {
        const name = node.expression.text;
        const at = `${relative(SRC, path)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        const texts = TEXT_AT[name].map((i) => node.arguments[i]);
        if (texts.every((a) => a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)))) {
          const [first, second] = texts.map((a) => (a as ts.StringLiteral).text);
          if (name === 'trx') {
            const context = node.arguments[0];
            if (ts.isStringLiteral(context)) found.push({ key: contextKey(context.text, first), counted: false, names: namesIn(first), at });
            else faults.push(`${at}: the context of trx() must be written out`);
          } else if (name === 'plural') {
            // The count is put in by plural() itself; the single form may leave out what the plural names.
            found.push({ key: second, counted: true, names: new Set([...namesIn(first), ...namesIn(second), 'n']), at });
          } else found.push({ key: first, counted: false, names: namesIn(first), at });
        } else faults.push(`${at}: the text of ${name}() must be written out as it is, with {names} for what is put in`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { found, faults };
}

const { found, faults } = read();

describe('the texts the source looks up', () => {
  it('are written out where they are looked up', () => {
    expect(faults).toEqual([]);
  });

  it('are each either counted or not, wherever they appear', () => {
    const kinds = new Map<string, boolean>();
    const mixed = found.filter((f) => kinds.has(f.key) && kinds.get(f.key) !== f.counted).map((f) => `${f.at}: ${f.key}`);
    for (const f of found) kinds.set(f.key, f.counted);
    expect(mixed).toEqual([]);
  });
});

const CATALOGS: { id: Exclude<Language, 'en'>; catalog: Catalog; parts: readonly Catalog[] }[] = [{ id: 'fr', catalog: fr, parts: FR_PARTS }];

describe.each(CATALOGS)('the $id catalog', ({ id, catalog, parts }) => {
  const wanted = new Map(found.map((f) => [f.key, f]));

  it('translates every text', () => {
    expect([...wanted.keys()].filter((key) => !(key in catalog)).map((key) => `${wanted.get(key)!.at}: ${key}`)).toEqual([]);
  });

  it('holds no text the source no longer looks up', () => {
    expect(Object.keys(catalog).filter((key) => !wanted.has(key))).toEqual([]);
  });

  it('gives a counted text its forms and any other text a text', () => {
    const wrong = Object.entries(catalog).filter(([key, value]) => {
      const source = wanted.get(key);
      if (!source) return false;
      if (!source.counted) return typeof value !== 'string' || !value.trim();
      return typeof value === 'string' || !value.other || Object.values(value).some((form) => !form.trim());
    });
    expect(wrong.map(([key]) => key)).toEqual([]);
  });

  it('puts in what the English puts in', () => {
    const wrong: string[] = [];
    for (const [key, value] of Object.entries(catalog)) {
      const source = wanted.get(key);
      if (!source) continue;
      for (const form of typeof value === 'string' ? [value] : Object.values(value)) {
        const names = namesIn(form);
        const unknown = [...names].filter((n) => !source.names.has(n));
        // A text that is not counted must use all it is given; a counted form may drop the count ("Un objet").
        const dropped = source.counted ? [] : [...source.names].filter((n) => !names.has(n));
        if (unknown.length || dropped.length) wrong.push(`${key} → ${form}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('translates a text the same way in every part', () => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const part of parts) {
      for (const [key, value] of Object.entries(part)) {
        const text = JSON.stringify(value);
        if (seen.has(key) && seen.get(key) !== text) twice.push(key);
        seen.set(key, text);
      }
    }
    expect(twice).toEqual([]);
  });

  if (id === 'fr') {
    it('is set as French is: a no-break space before : ; ? ! and inside « », and ’ for the apostrophe', () => {
      const wrong: string[] = [];
      for (const [key, value] of Object.entries(catalog)) {
        for (const form of typeof value === 'string' ? [value] : Object.values(value)) {
          // What is put in ({name}) is not prose; neither is a time or a ratio (12:30, 1:5).
          const prose = form.replace(/\{\w+\}/g, 'x');
          if (/ [:;?!»]/.test(prose) || /« /.test(prose) || /[\p{L})][;?!]/u.test(prose) || /\p{L}:(\s|$)/u.test(prose) || /\p{L}'\p{L}/u.test(prose)) wrong.push(`${key} → ${form}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }
});
