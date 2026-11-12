// How much a STEP file can hold of what goes into it as facets, and what is known of a design before it is
// written. Apart from the writer (stepExport.ts), so that the export panel can ask without the writer's library.
import { plural, tr } from '../i18n';
import type { SceneNode } from '../model/types';

/**
 * The most triangles a STEP file takes of objects that cannot be rebuilt as true surfaces, counted over the whole
 * file: every triangle is a face to sew, some 2.5 kB of file and some 22 kB of memory while it is written, so this
 * many already take half a minute, make a file of 150 MB and need well over a gigabyte. Over the whole file because
 * that is what runs out: twenty imported meshes of a few thousand triangles each passed one by one, and on a tablet
 * the system closed the app for the memory they took together. A design past it gets no STEP file: one with an
 * object left out of it would pass for the whole design.
 */
export const STEP_TRIANGLES = 60_000;

/**
 * Whether an object goes out as its facets whatever the writer tries: an imported mesh, lettering, or a group that
 * holds one. Others may still end as facets (a shape stretched out of round, a part that fails its checks), which
 * only the writer finds out.
 */
export function onlyFacets(node: SceneNode): boolean {
  if (node.type === 'import' || node.type === 'text') return true;
  return node.type === 'group' && node.children.some(onlyFacets);
}

/**
 * The objects among `nodes` that are known to go out as facets, when together they are past what a STEP file
 * holds: by name. None when the design may fit. `triangles` gives what an object has on screen, which is what
 * would be written of it.
 */
export function pastStepLimit(nodes: SceneNode[], triangles: (node: SceneNode) => number, limit = STEP_TRIANGLES): string[] {
  const faceted = nodes.filter(onlyFacets);
  return faceted.reduce((sum, node) => sum + triangles(node), 0) > limit ? faceted.map((node) => node.name) : [];
}

/** What is said of a design too detailed for a STEP file, naming the objects that make it so: three of them, and how many more. */
export function tooDetailed(names: string[]): string {
  const shown = names.slice(0, 3).map((name) => tr('"{name}"', { name })).join(', ');
  const more = names.length - 3;
  return tr('Too detailed for a STEP file: {names}.', { names: more > 0 ? plural(more, '{names} and {n} more', '{names} and {n} more', { names: shown }) : shown });
}
