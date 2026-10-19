// The figures a part works out about itself, kept per node so the inspector
// (warnings), the transform box (dimensions) and the fields share one build.
import type { PartNode } from '../model/types';
import { getGenerator } from './generators';
import { sanitizeParams } from './generators/types';
import type { BuildResult } from './generators/types';
import { QUALITY } from './types';

type Figures = Pick<BuildResult, 'info' | 'warnings'>;

const NONE: Figures = { info: [], warnings: [] };

// Nodes are immutable: an edit makes a new object, so the node itself is the cache key.
const cache = new WeakMap<PartNode, Figures>();

/** Derived dimensions and warnings of a part; empty when it cannot be built. Generators are pure functions, so this is worked out here, the mesh in the worker. */
export function partFigures(node: PartNode): Figures {
  let figures = cache.get(node);
  if (!figures) {
    try {
      const def = getGenerator(node.part);
      const built = def.build(sanitizeParams(def, node.params), QUALITY.draft);
      figures = { info: built.info, warnings: built.warnings };
    } catch {
      figures = NONE;
    }
    cache.set(node, figures);
  }
  return figures;
}
