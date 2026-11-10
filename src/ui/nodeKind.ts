// What kind of thing an object is, in a word or two, for the lists that show it beside its name.
import { SHAPES } from '../geometry/shapes';
import type { SceneNode } from '../model/types';
import { getGenerator } from '../parts/generators';

export const kindOf = (node: SceneNode): string =>
  node.type === 'group'
    ? `Group of ${node.children.length}`
    : node.type === 'import'
      ? 'Imported'
      : node.type === 'text'
        ? 'Text'
        : node.type === 'part'
          ? getGenerator(node.part).name
          : node.type === 'picture'
            ? 'Picture'
            : (SHAPES.find((s) => s.kind === node.shape)?.name ?? '');
