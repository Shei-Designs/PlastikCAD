// The built-in fonts and the outlines made from them. Fonts (and the parser
// for them) are fetched the first time lettering needs them.
import allertaLatin from '@fontsource/allerta-stencil/files/allerta-stencil-latin-400-normal.woff?url';
import interCyrillic from '@fontsource/inter/files/inter-cyrillic-700-normal.woff?url';
import interCyrillicExt from '@fontsource/inter/files/inter-cyrillic-ext-700-normal.woff?url';
import interGreek from '@fontsource/inter/files/inter-greek-700-normal.woff?url';
import interGreekExt from '@fontsource/inter/files/inter-greek-ext-700-normal.woff?url';
import interLatin from '@fontsource/inter/files/inter-latin-700-normal.woff?url';
import interLatinExt from '@fontsource/inter/files/inter-latin-ext-700-normal.woff?url';
import interVietnamese from '@fontsource/inter/files/inter-vietnamese-700-normal.woff?url';
import monoCyrillic from '@fontsource/jetbrains-mono/files/jetbrains-mono-cyrillic-700-normal.woff?url';
import monoCyrillicExt from '@fontsource/jetbrains-mono/files/jetbrains-mono-cyrillic-ext-700-normal.woff?url';
import monoGreek from '@fontsource/jetbrains-mono/files/jetbrains-mono-greek-700-normal.woff?url';
import monoLatin from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff?url';
import monoLatinExt from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-ext-700-normal.woff?url';
import monoVietnamese from '@fontsource/jetbrains-mono/files/jetbrains-mono-vietnamese-700-normal.woff?url';
import nunitoCyrillic from '@fontsource/nunito/files/nunito-cyrillic-800-normal.woff?url';
import nunitoCyrillicExt from '@fontsource/nunito/files/nunito-cyrillic-ext-800-normal.woff?url';
import nunitoLatin from '@fontsource/nunito/files/nunito-latin-800-normal.woff?url';
import nunitoLatinExt from '@fontsource/nunito/files/nunito-latin-ext-800-normal.woff?url';
import nunitoVietnamese from '@fontsource/nunito/files/nunito-vietnamese-800-normal.woff?url';
import oswaldCyrillic from '@fontsource/oswald/files/oswald-cyrillic-700-normal.woff?url';
import oswaldCyrillicExt from '@fontsource/oswald/files/oswald-cyrillic-ext-700-normal.woff?url';
import oswaldLatin from '@fontsource/oswald/files/oswald-latin-700-normal.woff?url';
import oswaldLatinExt from '@fontsource/oswald/files/oswald-latin-ext-700-normal.woff?url';
import oswaldVietnamese from '@fontsource/oswald/files/oswald-vietnamese-700-normal.woff?url';
import pacificoCyrillic from '@fontsource/pacifico/files/pacifico-cyrillic-400-normal.woff?url';
import pacificoCyrillicExt from '@fontsource/pacifico/files/pacifico-cyrillic-ext-400-normal.woff?url';
import pacificoLatin from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url';
import pacificoLatinExt from '@fontsource/pacifico/files/pacifico-latin-ext-400-normal.woff?url';
import pacificoVietnamese from '@fontsource/pacifico/files/pacifico-vietnamese-400-normal.woff?url';
import slabCyrillic from '@fontsource/roboto-slab/files/roboto-slab-cyrillic-700-normal.woff?url';
import slabCyrillicExt from '@fontsource/roboto-slab/files/roboto-slab-cyrillic-ext-700-normal.woff?url';
import slabGreek from '@fontsource/roboto-slab/files/roboto-slab-greek-700-normal.woff?url';
import slabGreekExt from '@fontsource/roboto-slab/files/roboto-slab-greek-ext-700-normal.woff?url';
import slabLatin from '@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff?url';
import slabLatinExt from '@fontsource/roboto-slab/files/roboto-slab-latin-ext-700-normal.woff?url';
import slabVietnamese from '@fontsource/roboto-slab/files/roboto-slab-vietnamese-700-normal.woff?url';
import type { Font } from 'opentype.js';
import { textAssetKey } from '../model/geomKey';
import { TEXT_FONTS } from '../model/types';
import type { TextNode } from '../model/types';
import { layoutText } from './layout';
import type { TextOutline } from './layout';

/**
 * Files of each font, main one first; the others add the characters of further scripts: the rest
 * of Latin, Cyrillic, Greek where the font has it, and Vietnamese. They are a few kilobytes each.
 */
const FILES: Record<string, string[]> = {
  sans: [interLatin, interLatinExt, interCyrillic, interCyrillicExt, interGreek, interGreekExt, interVietnamese],
  serif: [slabLatin, slabLatinExt, slabCyrillic, slabCyrillicExt, slabGreek, slabGreekExt, slabVietnamese],
  mono: [monoLatin, monoLatinExt, monoCyrillic, monoCyrillicExt, monoGreek, monoVietnamese],
  stencil: [allertaLatin],
  condensed: [oswaldLatin, oswaldLatinExt, oswaldCyrillic, oswaldCyrillicExt, oswaldVietnamese],
  rounded: [nunitoLatin, nunitoLatinExt, nunitoCyrillic, nunitoCyrillicExt, nunitoVietnamese],
  script: [pacificoLatin, pacificoLatinExt, pacificoCyrillic, pacificoCyrillicExt, pacificoVietnamese],
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
      const own = FILES[id] ?? FILES[DEFAULT_FONT];
      // A letter the font has not got (Greek in the stencil, say) is set in the default font rather than as an empty box.
      const spare = own === FILES[DEFAULT_FONT] ? [] : FILES[DEFAULT_FONT];
      const [{ parse }, buffers] = await Promise.all([import('opentype.js'), Promise.all([...own, ...spare].map(async (url) => (await fetch(url)).arrayBuffer()))]);
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
