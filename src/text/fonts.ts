// The built-in fonts and the outlines made from them. Fonts (and the parser
// for them) are fetched the first time lettering needs them.
import allertaLatin from '@fontsource/allerta-stencil/files/allerta-stencil-latin-400-normal.woff?url';
import interLatinExt from '@fontsource/inter/files/inter-latin-ext-700-normal.woff?url';
import interLatin from '@fontsource/inter/files/inter-latin-700-normal.woff?url';
import monoLatinExt from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-ext-700-normal.woff?url';
import monoLatin from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff?url';
import slabLatinExt from '@fontsource/roboto-slab/files/roboto-slab-latin-ext-700-normal.woff?url';
import slabLatin from '@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff?url';
import type { Font } from 'opentype.js';
import { textAssetKey } from '../model/geomKey';
import { TEXT_FONTS } from '../model/types';
import type { TextNode } from '../model/types';
import { layoutText } from './layout';
import type { TextOutline } from './layout';

/** Files of each font, main one first; the others add the characters of further scripts. */
const FILES: Record<string, string[]> = {
  sans: [interLatin, interLatinExt],
  serif: [slabLatin, slabLatinExt],
  mono: [monoLatin, monoLatinExt],
  stencil: [allertaLatin],
};

export const DEFAULT_FONT = TEXT_FONTS[0].id;

const loaded = new Map<string, Font[]>();
const loading = new Map<string, Promise<void>>();
const outlines = new Map<string, TextOutline | null>();
const KEEP_OUTLINES = 300;

export const fontReady = (id: string): boolean => loaded.has(id);

/** Resolves once the font can be used. Safe to call repeatedly. */
export function loadFont(id: string): Promise<void> {
  if (loaded.has(id)) return Promise.resolve();
  let pending = loading.get(id);
  if (!pending) {
    pending = (async () => {
      const [{ parse }, buffers] = await Promise.all([
        import('opentype.js'),
        Promise.all((FILES[id] ?? FILES[DEFAULT_FONT]).map(async (url) => (await fetch(url)).arrayBuffer())),
      ]);
      loaded.set(id, buffers.map((buffer) => parse(buffer)));
    })();
    // A failed download may be retried later.
    pending.catch(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

type Lettering = Pick<TextNode, 'text' | 'font' | 'align'>;

/**
 * Outlines of a piece of lettering, or null if it draws nothing. The font
 * must be ready (`fontReady`).
 */
export function outlineOf(lettering: Lettering): TextOutline | null {
  const key = textAssetKey(lettering);
  const cached = outlines.get(key);
  if (cached !== undefined) return cached;
  const fonts = loaded.get(lettering.font);
  if (!fonts) throw new Error(`The font "${lettering.font}" has not been loaded yet`);
  const outline = layoutText(fonts, lettering.text, lettering.align);
  outlines.set(key, outline);
  if (outlines.size > KEEP_OUTLINES) outlines.delete(outlines.keys().next().value as string);
  return outline;
}
