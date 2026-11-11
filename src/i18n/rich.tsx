// Texts with elements in them: a sentence with a link in the middle, a key in a hint.
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { tr } from './index';

/**
 * The text in the app's language, with an element put in wherever the text names one in braces:
 * `rich('Made by {author}.', { author: <a href="…">Ada</a> })`. The translation says where each
 * one goes, so a language can put them in another order.
 */
export function rich(text: string, parts: Readonly<Record<string, ReactNode>>): ReactNode {
  const pieces = tr(text).split(/\{(\w+)\}/);
  // The pieces alternate: text, name, text, name… A name the caller gave no element for is shown as written.
  return pieces.map((piece, i) => <Fragment key={i}>{i % 2 === 0 ? piece : piece in parts ? parts[piece] : `{${piece}}`}</Fragment>);
}
