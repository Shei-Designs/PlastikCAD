// Pictures of the parametric parts for the type picker. Parts with a flat
// outline are drawn from their real default geometry; the rest get a glyph.
import type { ReactNode } from 'react';
import { bounds } from '../parts/math2d';
import { defaultParams } from '../parts/generators/types';
import type { GeneratorDef } from '../parts/generators/types';
import { QUALITY } from '../parts/types';

const SIZE = 36;

const glyph = (children: ReactNode) => (
  <svg viewBox="0 0 36 36" width={SIZE} height={SIZE} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    {children}
  </svg>
);

const GLYPHS: Record<string, ReactNode> = {
  pipe: glyph(
    <>
      <rect x="4" y="12" width="28" height="12" />
      <path d="M4 15.5h28M4 20.5h28" />
    </>,
  ),
  elbow: glyph(
    <>
      <path d="M4 10h10a14 14 0 0 1 14 14v8M4 22h10a2 2 0 0 1 2 2v8" />
      <path d="M4 10v12M16 32h12" />
    </>,
  ),
  reducer: glyph(
    <>
      <path d="M4 8h10l14 7v6l-14 7H4z" />
      <path d="M4 12h10l14 5M4 24h10l14-5" />
    </>,
  ),
  tee: glyph(
    <>
      <path d="M3 13h30v10H3zM13 13V4h10v9" />
      <path d="M3 16h10v-9M23 7v9h10M3 20h30" />
    </>,
  ),
  bevel: glyph(
    <>
      <path d="M5 26h26l-6-13H11L5 26z" />
      <path d="M13 13v-3h10v3M10 26l3.5-13M15.5 26l1.5-13M20.5 26l-1.5-13M26 26l-3.5-13" />
    </>,
  ),
  worm: glyph(
    <>
      <path d="M3 18h4M29 18h4" />
      <rect x="7" y="11" width="22" height="14" rx="2" />
      <path d="M10 25l4-14M15 25l4-14M20 25l4-14M25 25l3.2-11" />
    </>,
  ),
  'metric-bolt': glyph(
    <>
      <path d="M10 5h16v7H10z" />
      <path d="M14 12v19h8V12M14 17l8-2M14 21l8-2M14 25l8-2M14 29l8-2" />
    </>,
  ),
  'metric-nut': glyph(
    <>
      <path d="M18 4l12 7v14l-12 7-12-7V11l12-7z" />
      <circle cx="18" cy="18" r="5.5" />
    </>,
  ),
  'lead-screw': glyph(
    <>
      <path d="M13 3v30h10V3z" />
      <path d="M13 9l10-4M13 15l10-4M13 21l10-4M13 27l10-4M13 33l10-4" />
    </>,
  ),
  'lead-screw-nut': glyph(
    <>
      <circle cx="18" cy="18" r="13" />
      <circle cx="18" cy="18" r="5" />
      <circle cx="18" cy="8.5" r="1.4" />
      <circle cx="18" cy="27.5" r="1.4" />
      <circle cx="8.5" cy="18" r="1.4" />
      <circle cx="27.5" cy="18" r="1.4" />
    </>,
  ),
};

const cache = new Map<string, ReactNode>();

export function partThumbnail(def: GeneratorDef): ReactNode {
  const cached = cache.get(def.id);
  if (cached) return cached;
  let node: ReactNode = GLYPHS[def.id];
  if (!node) {
    try {
      const outline = def.build(defaultParams(def), QUALITY.draft).outline;
      if (outline?.length) {
        const { min, max } = bounds(outline);
        const span = Math.max(max[0] - min[0], max[1] - min[1]) || 1;
        const scale = (SIZE - 4) / span;
        const ox = (SIZE - (max[0] - min[0]) * scale) / 2;
        const oy = (SIZE - (max[1] - min[1]) * scale) / 2;
        const d = outline
          .map(
            (poly) =>
              poly
                .map(([x, y], i) => `${i ? 'L' : 'M'}${(ox + (x - min[0]) * scale).toFixed(1)} ${(SIZE - oy - (y - min[1]) * scale).toFixed(1)}`)
                .join('') + 'Z',
          )
          .join('');
        node = (
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true">
            <path d={d} fill="currentColor" fillRule="evenodd" />
          </svg>
        );
      }
    } catch {
      // Fall through to the generic glyph.
    }
  }
  node ??= glyph(<circle cx="18" cy="18" r="12" />);
  cache.set(def.id, node);
  return node;
}
