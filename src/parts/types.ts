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
  /** Closed, outward-facing (CCW) triangle mesh. `swept` says what it was lofted from, where it was. */
  | { op: 'mesh'; positions: number[]; triangles: number[]; swept?: Swept }
  /** `thread` says what a union is when it is a thread before it is cut to length: its children are then the mesh of it. */
  | { op: 'union'; children: Solid[]; thread?: Thread }
  | { op: 'intersection'; children: Solid[] }
  /** The child with its mesh tidied: faces in one plane made one, and what is smaller than `within` (mm) taken out. The solid is the same to that measure. */
  | { op: 'tidy'; child: Solid; within: number }
  /** First child minus all the others. */
  | { op: 'difference'; children: Solid[] }
  /** Applied in the order mirror, rotate (degrees, XYZ), translate. */
  | { op: 'transform'; child: Solid; mirror?: Vec3; rotate?: Vec3; translate?: Vec3 };

/**
 * What a lofted mesh was made from: a ring of points at each station along a
 * path, each ring in the plane its station's `u` and `v` span, around `p`.
 * The mesh is what the kernel builds with; a writer that can make true
 * surfaces (see io/stepExact.ts) makes the same solid from this instead.
 */
export interface Swept {
  stations: { p: Vec3; u: Vec3; v: Vec3 }[];
  rings: Polygon[];
}

/**
 * What a thread is made from, before it is cut to length: the kernel builds it of a core and a coiled ridge for
 * every start, in facets; a writer that can make true surfaces (see io/stepExact.ts) makes the same solid from this
 * instead. The thread stands on the Z axis and is whole from z = 0 up to the length it was asked for: beyond both
 * ends it runs out in whatever way suits who makes it, since it is cut off there.
 */
export interface Thread {
  /**
   * The thread's surface in the half plane through the axis at angle 0, over one lead: (z, radius) corners from the
   * root, over the ridge of every start, to the root one lead higher. It starts below z = 0, a lead and more.
   */
  outline: Vec2[];
  /** How far the thread climbs in one turn. */
  lead: number;
  /** A right-handed thread climbs as it turns counterclockwise, seen from +Z. */
  leftHanded: boolean;
  /** How many whole turns of the outline reach past the top of the thread, with a turn to spare. */
  turns: number;
}

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
export const tidy = (child: Solid, within: number): Solid => ({ op: 'tidy', child, within });
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
