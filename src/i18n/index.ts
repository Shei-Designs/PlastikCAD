// The app in other languages.
//
// The words stay where they are used, in English, inside a call that looks them up:
//
//   tr('Save a copy…')                                  the text itself is the key
//   tr('Deleted {name}.', { name })                     with something put in
//   trx('verb', 'Open')                                 one English word, two meanings
//   plural(n, '{n} object', '{n} objects')              a count
//   mark('Move') … marked(group)                        named in one place, shown in another
//   rich('Made by {author}.', { author: <a>…</a> })     with elements put in (see rich.tsx)
//
// A language is a catalog: the English text against its translation (src/i18n/fr.ts). English has
// none, a text with no translation is shown in English, and a test (catalog.test.ts) reads the
// source for every text and fails when a catalog lacks one, holds one that is no longer used, or
// names other things to put in than the English does. Adding a language is a new catalog and a
// line in LANGUAGES.
//
// The language is settled once, when the page (or a worker) starts, and does not change while it
// runs: texts can then be looked up anywhere, in a table at the top of a module as well as in a
// component, and what a worker builds is in the same language as the page. Choosing another
// language starts the app again.
import { FILE_FORMAT } from '../appInfo';
import { fr } from './fr';

export type Language = 'en' | 'fr';

/** The languages on offer, each named in itself. */
export const LANGUAGES: readonly { id: Language; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'fr', name: 'Français' },
];

/** The forms a counted text takes, by the plural category of the count (see Intl.PluralRules). */
export type PluralForms = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
/** A language: each English text against its translation, a counted one (keyed by its plural) against its forms. */
export type Catalog = Readonly<Record<string, string | PluralForms>>;

const CATALOGS: Record<Exclude<Language, 'en'>, Catalog> = { fr };

/** What is put into a text, by the name it has there in braces. */
export type Params = Readonly<Record<string, string | number>>;

const isLanguage = (id: unknown): id is Language => LANGUAGES.some((l) => l.id === id);

/** Where the choice of language is kept; nothing there means the device's own. */
const CHOICE_KEY = `${FILE_FORMAT}:language`;
/** How a worker is told the language: in its name. */
const WORKER_NAME = /^lang:([a-z-]+)$/;

/** The language the user chose, or 'auto' for the device's. */
export function languageChoice(): Language | 'auto' {
  try {
    const saved = localStorage.getItem(CHOICE_KEY);
    return isLanguage(saved) ? saved : 'auto';
  } catch {
    return 'auto';
  }
}

/** Keeps the choice. It takes effect when the app next starts: the caller starts it again. */
export function chooseLanguage(choice: Language | 'auto'): void {
  try {
    if (choice === 'auto') localStorage.removeItem(CHOICE_KEY);
    else localStorage.setItem(CHOICE_KEY, choice);
  } catch {
    // Nowhere to keep it: the device's language goes on being used.
  }
}

/** The first of the device's languages the app has, English failing that. */
export function deviceLanguage(wanted: readonly string[]): Language {
  for (const tag of wanted) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLanguage(base)) return base;
  }
  return 'en';
}

function startLanguage(): Language {
  // In a worker: the language of the page that started it.
  if (typeof document === 'undefined') {
    const named = WORKER_NAME.exec(typeof self !== 'undefined' && typeof self.name === 'string' ? self.name : '');
    return named && isLanguage(named[1]) ? named[1] : 'en';
  }
  const choice = languageChoice();
  return choice === 'auto' ? deviceLanguage(navigator.languages ?? [navigator.language]) : choice;
}

/** The language of this run. Anywhere but in a page or one of its workers (the tests), English. */
export const language: Language = startLanguage();

/**
 * The locale dates and times are worded in: the device's own kind of the app's language where it
 * has one (en-GB on a British device, fr-CA on a Canadian one), the language otherwise. Numbers
 * are not worded by it: they are written one way in every language (see the README).
 */
export const locale: string = (typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : []).find((tag) => tag?.toLowerCase().split('-')[0] === language) ?? language;

/** The name to start a worker under, so that it speaks the page's language. */
export const WORKER_LANGUAGE = `lang:${language}`;

const fill = (text: string, params?: Params): string => (params ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole)) : text);

/** The key of a text that has a context. */
export const contextKey = (context: string, text: string): string => `${text} [[${context}]]`;

/** The lookups of one language. The app uses those of its own (below); the tests make others. */
export function translator(lang: Language) {
  const catalog: Catalog = lang === 'en' ? {} : CATALOGS[lang];
  const rules = new Intl.PluralRules(lang);
  const find = (key: string, fallback: string): string => {
    const found = catalog[key];
    return typeof found === 'string' ? found : fallback;
  };
  return {
    tr: (text: string, params?: Params): string => fill(find(text, text), params),
    trx: (context: string, text: string, params?: Params): string => fill(find(contextKey(context, text), text), params),
    plural: (n: number, one: string, other: string, params?: Params): string => {
      const forms = catalog[other];
      const text = forms && typeof forms !== 'string' ? (forms[rules.select(n)] ?? forms.other) : n === 1 ? one : other;
      return fill(text, { n, ...params });
    },
  };
}

const own = translator(language);

/** The text in the app's language, with `params` put in where the text names them in braces. */
export const tr = own.tr;
/** The same for a text that means different things in different places: `context` says which. */
export const trx = own.trx;
/** A text about a count, which it can name as `{n}`: `one` for a single one, `other` otherwise. */
export const plural = own.plural;

/**
 * A text in English and in every other language the app has: for telling a name the app gave by
 * itself from one the user chose, whichever language it was given in.
 */
export const inEveryLanguage = (text: string): string[] => [text, ...Object.values(CATALOGS).flatMap((catalog) => (typeof catalog[text] === 'string' ? [catalog[text]] : []))];

/**
 * A text that is written in one place and shown in another, which is where `marked` translates
 * it: the name of a row in a table whose type is the English text, say. It comes back unchanged.
 */
export const mark = <T extends string>(text: T): T => text;
/** The translation of a text that `mark` named. */
export const marked = (text: string, params?: Params): string => own.tr(text, params);
