import { sizeDependent } from './math';
import type { PartNode, SceneNode, TextNode } from './types';

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
      // Curved lettering is built with its thickness in the letters' own scale, so the key follows the size.
      return `t:${textKey(node)}${node.curve ? `:${node.curve.kind}:${node.curve.angle}:${node.curve.flip ? 'in' : 'out'}:${textThickness(node).toFixed(3)}` : ''}`;
    case 'part':
      return `p:${partKey(node)}`;
    case 'group':
      // Pictures do not shape the group: moving one must not rebuild it.
      return `g:${hashString(node.children.filter((c) => c.type !== 'picture').map(placedKey).join('|'))}`;
    case 'picture':
      return `pic:${node.mapping}:${node.angle}`;
  }
}

/** Identifies a part's geometry: its generator and parameters. */
export const partKey = (node: Pick<PartNode, 'part' | 'params'>): string =>
  `${node.part}:${Object.keys(node.params)
    .sort()
    .map((k) => `${k}=${JSON.stringify(node.params[k])}`)
    .join(',')}`;

/**
 * The thickness of curved lettering in the letters' own units (the 10 mm em the outlines are laid out
 * at): the mm asked for over the letters' scale, which the height axis carries whatever the curve.
 */
export const textThickness = (node: Pick<TextNode, 'curve' | 'size' | 'natural'>): number => {
  if (!node.curve) return 1;
  const scale = node.natural[1] > 0 ? node.size[1] / node.natural[1] : 1;
  return Math.max(1e-3, node.curve.thickness / (scale || 1));
};

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
