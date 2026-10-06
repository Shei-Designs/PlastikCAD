import { sizeDependent } from './math';
import type { SceneNode, TextNode } from './types';

/** Fast, well-mixed 53-bit string hash (cyrb53). */
export function hashString(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Identifies the geometry of a node as built (see `builtSize`), independent of
 * where the node is, how it is turned or mirrored and - for most nodes - how
 * big it is. Moving, rotating and (mostly) resizing therefore never rebuild
 * anything: the cached geometry is just drawn with a different matrix.
 */
export function geomKey(node: SceneNode): string {
  switch (node.type) {
    case 'shape': {
      const params = Object.keys(node.params)
        .sort()
        .map((k) => `${k}=${node.params[k]}`)
        .join(',');
      return `s:${node.shape}:${params}${sizeDependent(node) ? `:${node.size.join('x')}` : ''}`;
    }
    case 'import':
      return `i:${node.asset}`;
    case 'text':
      return `t:${textKey(node)}`;
    case 'group':
      return `g:${hashString(node.children.map(placedKey).join('|'))}`;
  }
}

/** Identifies the outlines of a piece of lettering: its words, font and alignment. */
export const textKey = (node: Pick<TextNode, 'text' | 'font' | 'align'>): string => `${node.font}:${node.align}:${JSON.stringify(node.text)}`;

/**
 * Name under which the outlines of a text node are handed to the geometry
 * worker. They travel like imported drawings, but are made on the fly and
 * never saved.
 */
export const textAssetKey = (node: Pick<TextNode, 'text' | 'font' | 'align'>): string => `text:${textKey(node)}`;

/** A child's geometry together with its placement inside the group. */
function placedKey(node: SceneNode): string {
  const flip = node.flip ? node.flip.map((f) => (f ? 1 : 0)).join('') : '';
  return `${geomKey(node)}@${node.pos.join(',')}/${node.rot.join(',')}/${node.size.join(',')}/${flip}/${node.hole ? 'h' : 's'}`;
}
