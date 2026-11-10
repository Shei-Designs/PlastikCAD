// What kind of thing an object is, in a word or two, for the lists that show it beside its name.
import { SHAPES } from '../geometry/shapes';
import { tr } from '../i18n';
import type { SceneNode } from '../model/types';
import { getGenerator } from '../parts/generators';

export const kindOf = (node: SceneNode): string =>
  node.type === 'group'
    ? tr('Group of {n}', { n: node.children.length })
    : node.type === 'import'
      ? tr('Imported')
      : node.type === 'text'
        ? tr('Text')
        : node.type === 'part'
          ? getGenerator(node.part).name
          : node.type === 'picture'
            ? tr('Picture')
            : (SHAPES.find((s) => s.kind === node.shape)?.name ?? '');
