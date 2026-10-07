// Kernel-independent description of shapes. Generators only produce this data;
// a backend (see evaluate.ts) turns it into a mesh. Keeping generators free of
// kernel calls makes them trivially testable and leaves room for a B-rep
// (STEP) backend later.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** Closed contour; the edge from the last point back to the first is implied. */
export type Polygon = Vec2[];

/** One or more contours filled with the even-odd rule (so inner contours are holes). */
export type Shape2D = Polygon[];

export type Solid =
  /** Extrude along +Z from z=0. `twist` is the total rotation of the top in degrees (CCW seen from +Z). */
  | { op: 'extrude'; shape: Shape2D; height: number; twist?: number; scaleTop?: number; divisions?: number }
  /** Revolve a (radius, z) contour around the Z axis. */
  | { op: 'revolve'; profile: Polygon; segments?: number }
  /** Cylinder / cone frustum along +Z from z=0. */
  | { op: 'cylinder'; radius: number; radiusTop?: number; height: number; segments?: number }
  /** Closed, outward-facing (CCW) triangle mesh. */
  | { op: 'mesh'; positions: number[]; triangles: number[] }
  | { op: 'union' | 'intersection'; children: Solid[] }
  /** First child minus all the others. */
  | { op: 'difference'; children: Solid[] }
  /** Applied in the order mirror, rotate (degrees, XYZ), translate. */
  | { op: 'transform'; child: Solid; mirror?: Vec3; rotate?: Vec3; translate?: Vec3 };

export interface ExtrudeOptions {
  twist?: number;
  scaleTop?: number;
  divisions?: number;
}

export const extrude = (shape: Shape2D, height: number, opts: ExtrudeOptions = {}): Solid => ({
  op: 'extrude',
  shape,
  height,
  ...opts,
});
export const revolve = (profile: Polygon, segments?: number): Solid => ({ op: 'revolve', profile, segments });
export const cylinder = (radius: number, height: number, segments?: number, radiusTop?: number): Solid => ({
  op: 'cylinder',
  radius,
  radiusTop,
  height,
  segments,
});
export const union = (...children: Solid[]): Solid => (children.length === 1 ? children[0] : { op: 'union', children });
export const intersection = (...children: Solid[]): Solid => ({ op: 'intersection', children });
export const difference = (base: Solid, ...cutters: Solid[]): Solid =>
  cutters.length === 0 ? base : { op: 'difference', children: [base, ...cutters] };
export const translate = (child: Solid, v: Vec3): Solid => ({ op: 'transform', child, translate: v });
export const rotate = (child: Solid, v: Vec3): Solid => ({ op: 'transform', child, rotate: v });
export const mirror = (child: Solid, normal: Vec3): Solid => ({ op: 'transform', child, mirror: normal });

/** Tessellation density. `circle` = segments per full turn, `flank` = samples per tooth flank curve. */
export interface Quality {
  circle: number;
  flank: number;
}

export type QualityName = 'draft' | 'normal' | 'fine';

export const QUALITY: Record<QualityName, Quality> = {
  draft: { circle: 48, flank: 6 },
  normal: { circle: 96, flank: 10 },
  fine: { circle: 192, flank: 18 },
};
