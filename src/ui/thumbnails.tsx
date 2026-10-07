// Small catalog pictures of the basic shapes, drawn by hand in the style of a
// technical sketch (visible edges only).
import type { ReactNode } from 'react';
import type { ShapeKind } from '../model/types';

const glyph = (children: ReactNode) => (
  <svg viewBox="0 0 36 36" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    {children}
  </svg>
);

const GLYPHS: Record<ShapeKind, ReactNode> = {
  box: glyph(
    <>
      <path d="M18 4.5 30 10.5v14L18 31 6 24.5v-14L18 4.5z" />
      <path d="M6 10.5 18 17l12-6.5M18 17v14" />
    </>,
  ),
  cylinder: glyph(
    <>
      <ellipse cx="18" cy="9.5" rx="10.5" ry="4.5" />
      <path d="M7.5 9.5v17c0 2.5 4.7 4.5 10.5 4.5s10.5-2 10.5-4.5v-17" />
    </>,
  ),
  sphere: glyph(
    <>
      <circle cx="18" cy="18" r="12.5" />
      <path d="M5.5 18c0 2.3 5.6 4.2 12.5 4.2s12.5-1.9 12.5-4.2" />
    </>,
  ),
  cone: glyph(
    <>
      <path d="M18 4.5 7.5 26.5M18 4.5l10.5 22" />
      <path d="M7.5 26.5c0 2.5 4.7 4.5 10.5 4.5s10.5-2 10.5-4.5" />
    </>,
  ),
  pyramid: glyph(
    <>
      <path d="M18 4.5 5.5 24 16 31.5 30.5 23 18 4.5z" />
      <path d="M18 4.5 16 31.5" />
    </>,
  ),
  wedge: glyph(
    <>
      <path d="M5.5 9v15.5l10 6.5 15-8-15-1.5L5.5 9z" />
      <path d="M15.5 21.5V31M5.5 9l25 14" />
    </>,
  ),
  roof: glyph(
    <>
      <path d="M11.5 10 5 25.5l8 5.5 6-15.5-7.5-5.5z" />
      <path d="M11.5 10 25 6.5l6 14.5-18 10M19 15.5 31 21M19 15.5 25 6.5" />
    </>,
  ),
  roundroof: glyph(
    <>
      <path d="M4 27a9 9 0 0 1 18 0z" />
      <path d="M7 20.3l10-9A9 9 0 0 1 32 18l-10 9" />
    </>,
  ),
  prism: glyph(
    <>
      <path d="M11 5.5h14l6 7-6 7H11l-6-7 6-7z" />
      <path d="M5 12.5v10l6 7h14l6-7v-10M11 19.5v10M25 19.5v10" />
    </>,
  ),
  torus: glyph(
    <>
      <ellipse cx="18" cy="18" rx="13" ry="8" />
      <path d="M12 17c1.3 1.6 3.5 2.5 6 2.5s4.7-.9 6-2.5M13.5 18.3c1-1.3 2.6-2 4.5-2s3.5.7 4.5 2" />
    </>,
  ),
  fillet: glyph(
    <>
      <path d="M6 13h15v15A15 15 0 0 0 6 13z" />
      <path d="M6 13l8-6h15l-8 6M29 7v15l-8 6" />
    </>,
  ),
  dome: glyph(
    <>
      <path d="M5.5 23.5a12.5 12.5 0 0 1 25 0" />
      <ellipse cx="18" cy="23.5" rx="12.5" ry="4.5" />
    </>,
  ),
};

export const shapeThumbnail = (kind: ShapeKind): ReactNode => GLYPHS[kind];

/** Catalog pictures of the Gearwright part families, by category id. */
export const PART_THUMBNAILS: Record<string, ReactNode> = {
  gears: glyph(
    <>
      <path d="M18 4.5l2.2 3.4 3.9-1.2.6 4 3.9 1.3-1.6 3.7 2.8 2.9-2.8 2.9 1.6 3.7-3.9 1.3-.6 4-3.9-1.2L18 31.5l-2.2-3.4-3.9 1.2-.6-4-3.9-1.3 1.6-3.7L6.2 18l2.8-2.9-1.6-3.7 3.9-1.3.6-4 3.9 1.2z" />
      <circle cx="18" cy="18" r="4" />
    </>,
  ),
  pulleys: glyph(
    <>
      <ellipse cx="18" cy="10" rx="12" ry="4" />
      <path d="M6 10v4c0 2.2 5.4 4 12 4s12-1.8 12-4v-4M6 20v3c0 2.2 5.4 4 12 4s12-1.8 12-4v-3M6 14c0 2.2 5.4 4 12 4s12-1.8 12-4" />
      <path d="M8 23.5l-2-9.5M28 23.5l2-9.5" />
    </>,
  ),
  screws: glyph(
    <>
      <path d="M10 5h16v7H10z" />
      <path d="M14 12v19h8V12M14 17l8-2M14 21l8-2M14 25l8-2M14 29l8-2" />
    </>,
  ),
};

export const textThumbnail: ReactNode = glyph(
  <>
    <path d="M7 8h17v5.5h-5.5V27h-6V13.5H7z" />
    <path d="M7 8l5-3.5h17L24 8M29 4.5V10l-5 3.5M24 13.5h-5.5M18.5 27l5-3.5V13.5" />
  </>,
);
