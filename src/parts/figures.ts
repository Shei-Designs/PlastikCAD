// The figures a part works out about itself, kept per part so the inspector
// (warnings), the transform box (dimensions) and the fields share one build.
import { partKey } from '../model/geomKey';
import type { PartNode } from '../model/types';
import { getGenerator } from './generators';
import { sanitizeParams } from './generators/types';
import type { BuildResult } from './generators/types';
import { QUALITY } from './types';

type Figures = Pick<BuildResult, 'info' | 'warnings'>;

const NONE: Figures = { info: [], warnings: [] };

// By generator and parameters: a part being moved is a new node at every step of the drag, the same part throughout.
const cache = new Map<string, Figures>();
/** A slider being dragged makes a new set of parameters at every step; only the latest are worth keeping. */
const KEEP = 200;

/** Derived dimensions and warnings of a part; empty when it cannot be built. Generators are pure functions, so this is worked out here, the mesh in the worker. */
export function partFigures(node: PartNode): Figures {
  const key = partKey(node);
  let figures = cache.get(key);
  if (!figures) {
    try {
      const def = getGenerator(node.part);
      const built = def.build(sanitizeParams(def, node.params), QUALITY.draft);
      figures = { info: built.info, warnings: built.warnings };
    } catch {
      figures = NONE;
    }
    cache.set(key, figures);
    if (cache.size > KEEP) cache.delete(cache.keys().next().value as string);
  }
  return figures;
}
