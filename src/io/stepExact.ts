// The design's objects rebuilt as true solids for a STEP file: a cylinder as
// a cylinder, a ball as a sphere, a drilled plate as a box with a round hole
// cut through it, a part from the profiles and operations its generator
// describes it by. The geometry kernel builds the same things from flat
// facets; OpenCascade (see occ.ts) can build them from the surfaces
// themselves, which is what a CAD program wants to pick and measure.
//
// Not everything can be rebuilt: a tapered extrusion, a worm wheel, an
// imported mesh, lettering, a rounded rim, a shape stretched in a way that leaves no
// simple surface (a ball into an egg, an oval cone). `exactShape` then answers null, and the
// writer falls back on the kernel's own facets (see stepExport.ts). It also
// falls back when what was rebuilt does not match the kernel's solid in
// volume and extent, or does not come back from a STEP file as it went in:
// nothing goes out on trust.
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import { clampParams, regularPolygon, ROUND } from '../geometry/shapes';
import { flipSigns, rotation } from '../model/math';
import type { Bounds } from '../model/math';
import type { GroupNode, PartNode, SceneNode, ShapeNode, Vec3 } from '../model/types';
import { getGenerator } from '../parts/generators';
import { sanitizeParams } from '../parts/generators/types';
import { QUALITY } from '../parts/types';
import type { Polygon, Shape2D, Solid, Swept, Thread, Vec2 } from '../parts/types';
import { traceArcs } from './arcs';
import { isTrap } from './occ';
import { signedArea } from './outline';

type Oc = OpenCascadeInstance;
type Shape = InstanceType<Oc['TopoDS_Shape']>;
type Deletable = { delete(): void };
export type Keep = <T extends Deletable>(o: T) => T;

/** What the kernel knows of a part that its description does not say: its box as its generator makes it. */
export interface ExactTools {
  partBox(node: PartNode): Bounds | null;
}

/** Thrown inside the builders for something that has no exact form; caught by `exactShape`. */
class NoExactForm extends Error {}
const none = (): never => {
  throw new NoExactForm();
};

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/** How far a surface made for a twist may stand off the true one, in millimeters: a hundredth of a micron (see `screw`). */
const SCREW_TRUE = 1e-5;
/** Edges that agree to this, in millimeters, are one edge to the sewing of a twisted solid's faces: they are made from the same numbers, so they agree far closer. */
const SEW = 1e-6;
/**
 * How far the volume of a solid made of such surfaces may be from what it was made to hold (a twisted outline its
 * area over its height, a thread what its outline sweeps in its turns): a hundredth of a percent. That is fifty
 * times closer than a whole object is held to the kernel's facets, which stand back from every curve, at least
 * twenty times what the worst gear tried was off by (one of eight teeth, three millimeters across) and ten times
 * what any thread was; a surface laid wrong is off by far more.
 */
const SCREW_SLACK = 1e-4;
/**
 * The slack the library is given to tell touching from crossing, in millimeters, when one of two solids it is to
 * combine has a surface swept round a helix. Such a surface is true to `SCREW_TRUE` only, and where it should just
 * touch the other solid (a thread's root on the edge its lead-in ends on) the library, taking both at their word,
 * has answered with nothing at all, or with a solid that had a piece too many.
 */
const FUZZY = 2e-5;

/** A side of a traced contour: straight from `from` to `to`, or round the arc through `mid`, the point half way along it, which with its ends says which arc it is. */
interface Side {
  from: Vec2;
  to: Vec2;
  mid?: Vec2;
}

/**
 * The sides of a closed contour, its runs of corners on one circle as arcs (see arcs.ts). A contour that is one
 * circle all the way round is two arcs of half a turn.
 */
function sides(contour: Polygon): Side[] {
  const traced = traceArcs(contour);
  if ('circle' in traced) {
    const { center, radius } = traced.circle;
    // Round the way the contour goes: that is what tells a hole from a rim.
    const way = signedArea(contour) < 0 ? -1 : 1;
    const p = (a: number): Vec2 => [center[0] + radius * Math.cos(way * a), center[1] + radius * Math.sin(way * a)];
    return [0, Math.PI].map((a) => ({ from: p(a), mid: p(a + Math.PI / 2), to: p(a + Math.PI) }));
  }
  const out: Side[] = [];
  let from = traced.start;
  for (const side of traced.sides) {
    // A corner written twice makes a side of no length, which is no side.
    if (Math.hypot(side.to[0] - from[0], side.to[1] - from[1]) < 1e-6) continue;
    if (side.arc) {
      const { center, radius, sweep } = side.arc;
      const begin = Math.atan2(from[1] - center[1], from[0] - center[0]);
      out.push({ from, mid: [center[0] + radius * Math.cos(begin + sweep / 2), center[1] + radius * Math.sin(begin + sweep / 2)], to: side.to });
    } else out.push({ from, to: side.to });
    from = side.to;
  }
  return out;
}

/**
 * The areas a flat shape fills by the even-odd rule: every contour that lies inside an even number of the others
 * is the rim of one, and the contours right inside it are its holes. A rim goes round counterclockwise and its
 * holes clockwise, whichever way they were drawn.
 */
function regions(shape: Shape2D): { rim: Polygon; holes: Polygon[] }[] {
  const contours = shape.filter((c) => c.length >= 3);
  const inside = (p: Vec2, c: Polygon): boolean => {
    let odd = false;
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      if (c[i][1] > p[1] !== c[j][1] > p[1] && p[0] < ((c[j][0] - c[i][0]) * (p[1] - c[i][1])) / (c[j][1] - c[i][1]) + c[i][0]) odd = !odd;
    }
    return odd;
  };
  const depth = contours.map((c, i) => contours.filter((other, j) => j !== i && inside(c[0], other)).length);
  const turned = (c: Polygon, ccw: boolean): Polygon => (signedArea(c) > 0 === ccw ? c : [...c].reverse());
  const out: { rim: Polygon; holes: Polygon[] }[] = [];
  contours.forEach((rim, i) => {
    if (depth[i] % 2) return;
    out.push({ rim: turned(rim, true), holes: contours.filter((hole, j) => depth[j] === depth[i] + 1 && inside(hole[0], rim)).map((hole) => turned(hole, false)) });
  });
  return out;
}

/**
 * A side of an outline as a curve that can be given to OpenCascade pole by pole, which is what a surface made of it
 * needs: two poles for a straight side; for an arc its two ends and, between them, the point where the tangents at
 * its ends meet, which weighs `weight` (the cosine of half the arc's angle) to the ends' one.
 */
interface Span {
  poles: Vec2[];
  weight?: number;
}

/** A side as spans: one, or two halves for an arc of more than a quarter turn, whose middle pole would otherwise stand far off it and weigh next to nothing. */
function spans({ from, to, mid }: Side): Span[] {
  if (!mid) return [{ poles: [from, to] }];
  // Where the arc's middle point is, seen from the chord: `along` it from its middle, and `across` it to one side or the other.
  const half = Math.hypot(to[0] - from[0], to[1] - from[1]) / 2;
  const middle: Vec2 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  const [ex, ey] = [(to[0] - from[0]) / (2 * half), (to[1] - from[1]) / (2 * half)];
  const along = (mid[0] - middle[0]) * ex + (mid[1] - middle[1]) * ey;
  const across = (mid[1] - middle[1]) * ex - (mid[0] - middle[0]) * ey;
  const off = Math.abs(across);
  // An arc that leaves its chord by less than a millionth of a micron is the chord.
  if (off < 1e-9) return [{ poles: [from, to] }];
  // The way from the chord towards the arc.
  const [ux, uy] = across < 0 ? [ey, -ex] : [-ey, ex];
  // The circle through the three points: its center is `back` behind the chord's middle.
  const back = (half * half - along * along - off * off) / (2 * off);
  const radius = Math.hypot(half, back);
  const center: Vec2 = [middle[0] - back * ux, middle[1] - back * uy];
  const top: Vec2 = [center[0] + radius * ux, center[1] + radius * uy];
  const span = (a: Vec2, b: Vec2): Span => {
    const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
    const d = Math.hypot(m[0] - center[0], m[1] - center[1]);
    const out = (chord * chord) / (d * d);
    return { poles: [a, [m[0] + (m[0] - center[0]) * out, m[1] + (m[1] - center[1]) * out], b], weight: d / Math.hypot(chord, d) };
  };
  return back < half ? [span(from, top), span(top, to)] : [span(from, to)];
}

/** The area a closed run of spans goes round: positive counterclockwise. */
function enclosed(loop: Span[]): number {
  let twice = 0;
  for (const { poles, weight } of loop) {
    const [a, b] = [poles[0], poles[poles.length - 1]];
    twice += a[0] * b[1] - a[1] * b[0];
    if (weight === undefined) continue;
    // What lies between an arc and its chord: a slice of the circle less a triangle, on the side the middle pole is.
    const angle = 2 * Math.acos(Math.min(1, weight));
    const radius = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2 / Math.sin(angle / 2);
    const bulge = radius * radius * (angle - Math.sin(angle));
    const left = (b[0] - a[0]) * (poles[1][1] - a[1]) - (b[1] - a[1]) * (poles[1][0] - a[0]) > 0;
    twice += left ? -bulge : bulge;
  }
  return twice / 2;
}

/** An even turn about the Z axis over a rise, for the poles of a surface: see `screw`. */
interface Screw {
  /** For every pole on the way up, what a point x + iy of the outline is multiplied by to be turned to it: [real, imaginary]. */
  factors: Vec2[];
  /** How far up every pole is, from 0 at the bottom to 1 at the top. */
  rises: number[];
  knots: number[];
  mults: number[];
}

/**
 * A turn by `turn` (radians) about the Z axis, even over a rise, as a B-spline of the fifth degree follows it.
 *
 * A helix is no polynomial, so the turn is cut into spans, and on each the curve agrees with the helix at both ends
 * in place, direction and curvature. The spans then join smooth to the second derivative, and the curve leaves the
 * helix by about the span's angle to the sixth power over 46,080, times the radius. The spans are as wide as keeps
 * that under `SCREW_TRUE` at `reach`, the furthest the outline is from the axis, and never over an eighth of a turn.
 * Every pole is the outline turned and scaled about the axis, so any curve of the outline is swept true to itself.
 */
function screw(turn: number, reach: number): Screw {
  const widest = Math.min(Math.PI / 4, ((46080 * SCREW_TRUE) / Math.max(reach, 1e-6)) ** (1 / 6));
  const count = Math.max(1, Math.ceil(Math.abs(turn) / widest));
  const a = turn / count;
  const step = 1 / count;
  const factors: Vec2[] = [];
  const rises: number[] = [];
  /** A pole: the outline turned by `whole` spans, multiplied by `re` + i `im`, and `rise` of the way up. */
  const pole = (whole: number, re: number, im: number, rise: number): void => {
    const [c, s] = [Math.cos(whole * a), Math.sin(whole * a)];
    factors.push([c * re - s * im, s * re + c * im]);
    rises.push(rise);
  };
  // The first two poles and the last two give the ends their place and direction; the two in the middle of every
  // span and the one over every join between two spans come from the helix's place, direction and curvature there.
  pole(0, 1, 0, 0);
  pole(0, 1, a / 5, step / 5);
  for (let k = 0; k < count; k++) {
    pole(k, 1 - (a * a) / 20, (2 * a) / 5, (k + 0.4) * step);
    pole(k + 1, 1 - (a * a) / 20, (-2 * a) / 5, (k + 0.6) * step);
    if (k + 1 < count) pole(k + 1, 1 + (a * a) / 20, 0, (k + 1) * step);
  }
  pole(count, 1, -a / 5, 1 - step / 5);
  pole(count, 1, 0, 1);
  const knots = Array.from({ length: count + 1 }, (_, k) => k * step);
  return { factors, rises, knots, mults: knots.map((_, k) => (k === 0 || k === count ? 6 : 3)) };
}

/**
 * The twisted extrusion that a union is, when it is one with its own mirror image set on top of it (a herringbone
 * gear): null for any other union.
 */
function mirroredOnTop(children: Solid[]): Extract<Solid, { op: 'extrude' }> | null {
  const [low, high] = children;
  if (children.length !== 2 || low.op !== 'extrude' || !low.twist || (low.scaleTop !== undefined && !near(low.scaleTop, 1))) return null;
  if (high.op !== 'transform' || high.mirror || high.rotate || !high.translate) return null;
  const image = high.child;
  if (image.op !== 'transform' || image.child !== low || !image.mirror || image.rotate || image.translate) return null;
  // Mirrored in the plane it stands on and lifted by twice its height, it sits on the first with its turned end down.
  const flat = near(image.mirror[0], 0) && near(image.mirror[1], 0) && !near(image.mirror[2], 0);
  return flat && near(high.translate[0], 0) && near(high.translate[1], 0) && near(high.translate[2], 2 * low.height) ? low : null;
}

/** A part as it was built for the first object that is one, for the others like it in the same file: null when it has no exact form. */
interface BuiltPart {
  shape: Shape;
  helical: boolean;
  steepest: number;
}

/** The parts built so far for one file, by what they are (see `Builder.part`). */
export type PartCache = Map<string, BuiltPart | null>;

class Builder {
  /** Whether a surface swept round a helix has been made: from then on the solids combined are given some slack (see `FUZZY`). */
  helical = false;
  /** How steep the steepest thread made is (its lead over the way round it at the middle of its depth), or 0 while none has been: what holds a thread is held to the kernel's solid by its skin as well (see `skinSlack`). */
  steepest = 0;

  constructor(
    readonly oc: Oc,
    readonly keep: Keep,
    readonly tools: ExactTools,
    /** Whether faces on one surface are made one (see `tidy`). */
    readonly join: boolean,
    readonly parts: PartCache,
  ) {}

  point(x: number, y: number, z: number): InstanceType<Oc['gp_Pnt']> {
    return this.keep(new this.oc.gp_Pnt(x, y, z));
  }

  /** A frame at `at` whose main axis is `axis` and whose X is `x`. */
  frame(at: Vec3, axis: Vec3, x: Vec3): InstanceType<Oc['gp_Ax2']> {
    return this.keep(new this.oc.gp_Ax2(this.point(...at), this.keep(new this.oc.gp_Dir(...axis)), this.keep(new this.oc.gp_Dir(...x))));
  }

  /**
   * The solid a builder makes, or no exact form if it did not come off. The builders of solids do their
   * work when the shape is asked for, and say only then whether it came off.
   */
  result(builder: { Shape(): Shape; IsDone(): boolean } & Deletable): Shape {
    this.keep(builder);
    const shape = builder.Shape();
    if (!builder.IsDone()) none();
    return this.keep(shape);
  }

  /** A builder that has done its work on being made (an edge, a wire, a face), or no exact form if it did not come off. */
  done<T extends { IsDone(): boolean } & Deletable>(builder: T): T {
    this.keep(builder);
    if (!builder.IsDone()) none();
    return builder;
  }

  // --- flat outlines ---------------------------------------------------------------------------

  /**
   * A closed contour in a plane as a wire, its runs of corners on one circle as arcs (see arcs.ts).
   * `place` says where a point of the contour is in space.
   */
  wire(contour: Polygon, place: (p: [number, number]) => Vec3): InstanceType<Oc['TopoDS_Wire']> {
    const { oc } = this;
    const maker = this.keep(new oc.BRepBuilderAPI_MakeWire());
    const at = (p: [number, number]) => this.point(...place(p));
    for (const side of sides(contour)) {
      if (side.mid) {
        // An arc found again from three of its points, wherever the plane lies.
        const curve = this.done(new oc.GC_MakeArcOfCircle(at(side.from), at(side.mid), at(side.to)));
        maker.Add(this.done(new oc.BRepBuilderAPI_MakeEdge(this.keep(curve.Value()))).Edge());
      } else maker.Add(this.done(new oc.BRepBuilderAPI_MakeEdge(at(side.from), at(side.to))).Edge());
    }
    if (!maker.IsDone()) none();
    return this.keep(maker.Wire());
  }

  /** The faces of a flat shape filled by the even-odd rule (see `regions`): one for every area, with its holes. */
  faces(shape: Shape2D, place: (p: [number, number]) => Vec3): Shape[] {
    const out = regions(shape).map(({ rim, holes }) => {
      const face = this.done(new this.oc.BRepBuilderAPI_MakeFace(this.wire(rim, place), true));
      for (const hole of holes) face.Add(this.wire(hole, place));
      if (!face.IsDone()) none();
      return this.keep(face.Face());
    });
    if (out.length === 0) none();
    return out;
  }

  /**
   * A flat face outlined by an arc of an oval and straight sides. The oval is centered at `center`,
   * reaches `across` along the plane's first direction and `up` along its second, and the arc runs
   * from angle `from` to `to` round it (radians, from the first direction towards the second); the
   * straight sides go on from the arc's end through `corners` and back to its start. `place` says
   * where a point of the plane is in space.
   */
  ovalFace(center: [number, number], across: number, up: number, from: number, to: number, corners: [number, number][], place: (p: [number, number]) => Vec3): Shape {
    const { oc } = this;
    const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const origin = place(center);
    const u = sub(place([center[0] + 1, center[1]]), origin);
    const v = sub(place([center[0], center[1] + 1]), origin);
    const normal: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    // An oval is given by its longer half first: when that is the one across, its angles are the arc's own; when it is the one up, a quarter turn less.
    const wide = across >= up;
    const oval = this.keep(new oc.gp_Elips(this.frame(origin, normal, wide ? u : v), Math.max(across, up), Math.min(across, up)));
    const turn = wide ? 0 : Math.PI / 2;
    const at = (a: number): [number, number] => [center[0] + across * Math.cos(a), center[1] + up * Math.sin(a)];
    const wire = this.keep(new oc.BRepBuilderAPI_MakeWire());
    wire.Add(this.done(new oc.BRepBuilderAPI_MakeEdge(oval, from - turn, to - turn)).Edge());
    const path = [at(to), ...corners, at(from)];
    for (let i = 0; i + 1 < path.length; i++) {
      if (Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]) < 1e-9) continue;
      wire.Add(this.done(new oc.BRepBuilderAPI_MakeEdge(this.point(...place(path[i])), this.point(...place(path[i + 1])))).Edge());
    }
    if (!wire.IsDone()) none();
    return this.keep(this.done(new oc.BRepBuilderAPI_MakeFace(this.keep(wire.Wire()), true)).Face());
  }

  // --- solids ------------------------------------------------------------------------------------

  /**
   * What one of the library's operations on two solids (together, one less the other, what both hold) makes of
   * `a` and `b`, or no exact form if it did not come off or says it met with an error.
   */
  private combined(operation: InstanceType<Oc['BRepAlgoAPI_BooleanOperation']>, a: Shape, b: Shape): Shape {
    const { oc } = this;
    this.keep(operation);
    const [first, second] = [this.keep(new oc.NCollection_List_TopoDS_Shape()), this.keep(new oc.NCollection_List_TopoDS_Shape())];
    first.Append(a);
    second.Append(b);
    operation.SetArguments(first);
    operation.SetTools(second);
    if (this.helical) operation.SetFuzzyValue(FUZZY);
    operation.Build(this.keep(new oc.Message_ProgressRange()));
    if (!operation.IsDone() || operation.HasErrors()) none();
    return this.keep(operation.Shape());
  }

  fuse(shapes: Shape[]): Shape {
    if (shapes.length === 0) none();
    return shapes.reduce((all, next) => this.combined(new this.oc.BRepAlgoAPI_Fuse(), all, next));
  }

  cut(from: Shape, cutters: Shape[]): Shape {
    return cutters.reduce((left, cutter) => this.combined(new this.oc.BRepAlgoAPI_Cut(), left, cutter), from);
  }

  /** What all of `shapes` hold in common. */
  common(shapes: Shape[]): Shape {
    if (shapes.length === 0) none();
    return shapes.reduce((all, next) => this.combined(new this.oc.BRepAlgoAPI_Common(), all, next));
  }

  /** A flat shape in the XY plane at `z`, raised by `height`. */
  prism(shape: Shape2D, z: number, height: number): Shape {
    const up = this.keep(new this.oc.gp_Vec(0, 0, height));
    return this.fuse(this.faces(shape, ([x, y]) => [x, y, z]).map((face) => this.result(new this.oc.BRepPrimAPI_MakePrism(face, up, false, true))));
  }

  /** A contour of (radius, height) points turned once round the Z axis. */
  turned(profile: Polygon): Shape {
    const axis = this.keep(new this.oc.gp_Ax1(this.point(0, 0, 0), this.keep(new this.oc.gp_Dir(0, 0, 1))));
    const [face] = this.faces([profile], ([r, z]) => [r, 0, z]);
    return this.result(new this.oc.BRepPrimAPI_MakeRevol(face, axis, false));
  }

  /** `shape` moved by a matrix of the app's (the images of X, Y and Z, then the translation): a turn and a move, and one size change for all three axes. */
  moved(shape: Shape, m: number[]): Shape {
    const move = this.keep(new this.oc.gp_Trsf());
    move.SetValues(m[0], m[3], m[6], m[9], m[1], m[4], m[7], m[10], m[2], m[5], m[8], m[11]);
    return this.result(new this.oc.BRepBuilderAPI_Transform(shape, move, true, false));
  }

  /** `shape` seen in a mirror standing on the origin, square to `axis`. */
  mirrored(shape: Shape, axis: Vec3): Shape {
    const move = this.keep(new this.oc.gp_Trsf());
    move.SetMirror(this.frame([0, 0, 0], axis, axis[2] ? [1, 0, 0] : [0, 0, 1]));
    return this.result(new this.oc.BRepBuilderAPI_Transform(shape, move, true, false));
  }

  // --- twists and threads: an outline turned as it rises ----------------------------------------

  /** Numbers as a list of the library's, which counts from one. */
  private reals(values: number[]): InstanceType<Oc['NCollection_Array1_double']> {
    const out = this.keep(new this.oc.NCollection_Array1_double(1, values.length));
    values.forEach((v, i) => out.SetValue(i + 1, v));
    return out;
  }

  /** Whole numbers as a list of the library's. */
  private wholes(values: number[]): InstanceType<Oc['NCollection_Array1_int']> {
    const out = this.keep(new this.oc.NCollection_Array1_int(1, values.length));
    values.forEach((v, i) => out.SetValue(i + 1, v));
    return out;
  }

  /** A closed run of spans in the XY plane as a wire, turned about the Z axis by `turn` (radians) and lifted to `z`. */
  private spanWire(loop: Span[], turn: number, z: number): InstanceType<Oc['TopoDS_Wire']> {
    const { oc } = this;
    const [c, s] = [Math.cos(turn), Math.sin(turn)];
    const at = ([x, y]: Vec2) => this.point(c * x - s * y, s * x + c * y, z);
    const maker = this.keep(new oc.BRepBuilderAPI_MakeWire());
    for (const { poles, weight } of loop) {
      if (weight === undefined) {
        maker.Add(this.done(new oc.BRepBuilderAPI_MakeEdge(at(poles[0]), at(poles[1]))).Edge());
        continue;
      }
      // An arc from the same poles as the surface that ends on it, so that the two meet to the last digit.
      const points = this.keep(new oc.NCollection_Array1_gp_Pnt(1, 3));
      poles.forEach((p, i) => points.SetValue(i + 1, at(p)));
      const curve = this.keep(new oc.Geom_BSplineCurve(points, this.reals([1, weight, 1]), this.reals([0, 1]), this.wholes([3, 3]), 2, false, false));
      maker.Add(this.done(new oc.BRepBuilderAPI_MakeEdge(curve)).Edge());
    }
    if (!maker.IsDone()) none();
    return this.keep(maker.Wire());
  }

  /**
   * The face a span sweeps as it is turned about the Z axis and lifted by `height` the way `way` says, from where
   * its `poles` are: across it the span's own poles (the middle one of an arc weighing `weight`), up it those of the turn.
   */
  private screwFace(poles: Vec3[], weight: number | undefined, way: Screw, height: number): Shape {
    const { oc } = this;
    const [across, up] = [poles.length, way.factors.length];
    const points = this.keep(new oc.NCollection_Array2_gp_Pnt(1, across, 1, up));
    const weights = weight === undefined ? null : this.keep(new oc.NCollection_Array2_double(1, across, 1, up));
    // The list takes a copy of the point it is given, so one point serves for all of them.
    const at = this.point(0, 0, 0);
    poles.forEach(([x, y, z], i) => {
      way.factors.forEach(([re, im], j) => {
        at.SetCoord(re * x - im * y, im * x + re * y, z + height * way.rises[j]);
        points.SetValue(i + 1, j + 1, at);
        weights?.SetValue(i + 1, j + 1, i === 1 ? (weight ?? 1) : 1);
      });
    });
    const degree = across - 1;
    const [knots, mults] = [this.reals([0, 1]), this.wholes([across, across])];
    const [upKnots, upMults] = [this.reals(way.knots), this.wholes(way.mults)];
    const surface = this.keep(weights ? new oc.Geom_BSplineSurface(points, weights, knots, upKnots, mults, upMults, degree, 5, false, false) : new oc.Geom_BSplineSurface(points, knots, upKnots, mults, upMults, degree, 5, false, false));
    this.helical = true;
    return this.keep(this.done(new oc.BRepBuilderAPI_MakeFace(surface, 1e-9)).Face());
  }

  /**
   * Faces sewn along the edges they share into the one closed skin of a solid, which has to hold `volume`: what
   * the faces were made to enclose. No exact form when they do not close, or close on something else.
   */
  private sewn(faces: Shape[], volume: number): Shape {
    const { oc } = this;
    const sewing = this.keep(new oc.BRepBuilderAPI_Sewing(SEW, true, true, true, false));
    for (const face of faces) sewing.Add(face);
    sewing.Perform(this.keep(new oc.Message_ProgressRange()));
    const all = this.keep(sewing.SewedShape());
    // One closed skin, or it is no solid: an edge left without its neighbor, or faces that hang together in several pieces, which sew into as many skins.
    if (sewing.NbFreeEdges() > 0 || all.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) none();
    const shell = this.keep(oc.TopoDS.Shell(all));
    if (!shell.Closed()) none();
    const solid = this.keep(this.keep(new oc.BRepBuilderAPI_MakeSolid(shell)).Solid());
    // Outside out, whichever way the sewing left it.
    oc.BRepLib.OrientClosedSolid(solid);
    if (!(Math.abs(volumeOf(oc, solid, this.keep, true) - volume) <= SCREW_SLACK * volume)) none();
    return solid;
  }

  /**
   * A flat shape in the XY plane raised in stages, turned evenly about the Z axis by each stage's `turn` (radians)
   * as it rises by that stage's `height`: a helical gear is one stage, a herringbone two that turn opposite ways.
   *
   * Every side of the outline sweeps a face of its own (see `screw`), the two ends are flat, and the faces are sewn
   * along the edges they share into one closed skin. Made this way the surfaces are true to a known measure, holes
   * come with the outline, and two stages are one solid from the start: fused from two solids that meet in a face
   * of hundreds of edges, a herringbone gear takes the library ten seconds and more.
   */
  twisted(shape: Shape2D, stages: { turn: number; height: number }[]): Shape {
    const { oc } = this;
    // Every area of the shape as its closed runs of spans: its rim first, then its holes. A shape of several areas side by side would sew into as many skins, and has no exact form.
    const outlines = regions(shape).map(({ rim, holes }) => [rim, ...holes].map((contour) => sides(contour).flatMap(spans)));
    if (outlines.length === 0) none();
    const reach = shape.reduce((far, contour) => contour.reduce((f, [x, y]) => Math.max(f, Math.hypot(x, y)), far), 0);
    const faces: Shape[] = [];
    let [turn, z] = [0, 0];
    /** The flat end where the shape now is. */
    const end = (): void => {
      for (const loops of outlines) {
        const [rim, ...holes] = loops.map((loop) => this.spanWire(loop, turn, z));
        const face = this.done(new oc.BRepBuilderAPI_MakeFace(rim, true));
        for (const hole of holes) face.Add(hole);
        if (!face.IsDone()) none();
        faces.push(this.keep(face.Face()));
      }
    };
    end();
    for (const stage of stages) {
      const way = screw(stage.turn, reach);
      const [c, s] = [Math.cos(turn), Math.sin(turn)];
      for (const loops of outlines) for (const loop of loops) for (const span of loop) faces.push(this.screwFace(span.poles.map(([x, y]): Vec3 => [c * x - s * y, s * x + c * y, z]), span.weight, way, stage.height));
      turn += stage.turn;
      z += stage.height;
    }
    end();
    // Turning an outline as it rises leaves its area as it was: the solid holds that area over the whole height.
    const area = outlines.reduce((sum, [rim, ...holes]) => sum + Math.abs(enclosed(rim)) - holes.reduce((inner, hole) => inner + Math.abs(enclosed(hole)), 0), 0);
    return this.sewn(faces, area * z);
  }

  /**
   * A thread before it is cut to length, from its description: its outline over one lead, in the half plane through
   * the axis, carried up the helix a turn at a time. Every side of the outline sweeps a face in every turn; under
   * the first turn and over the last the skin is closed by one turn of the helicoid a line from the axis to the
   * root sweeps, and by the flat section through the axis the outline itself bounds.
   *
   * The generator makes the same thread of a core and a coiled ridge, which only facets can be joined of: fused of
   * such solids the library's answer was wrong, and took it seven seconds. And a face that went round the axis
   * thirty times is more than the operations that cut the thread to length can be trusted with: one that goes
   * round once is not.
   */
  thread({ outline, lead, leftHanded, turns }: Thread): Shape {
    const { oc } = this;
    const reach = outline.reduce((far, [, r]) => Math.max(far, r), 0);
    const root = outline.reduce((near, [, r]) => Math.min(near, r), reach);
    const way = screw(leftHanded ? -2 * Math.PI : 2 * Math.PI, reach);
    const [z0, r0] = outline[0];
    const faces: Shape[] = [];
    let perTurn = 0;
    for (let i = 0; i + 1 < outline.length; i++) {
      const [[za, ra], [zb, rb]] = [outline[i], outline[i + 1]];
      // Two corners in one place bound no side.
      if (Math.hypot(zb - za, rb - ra) < 1e-7) continue;
      for (let turn = 0; turn < turns; turn++) faces.push(this.screwFace([[ra, 0, za + turn * lead], [rb, 0, zb + turn * lead]], undefined, way, lead));
      // What this side sweeps in one turn about the axis: a slice of a cone.
      perTurn += (Math.PI * (zb - za) * (ra * ra + ra * rb + rb * rb)) / 3;
    }
    for (const up of [0, turns * lead]) {
      faces.push(this.screwFace([[0, 0, z0 + up], [r0, 0, z0 + up]], undefined, way, lead));
      const corners: Vec3[] = [[0, 0, z0 + up], ...outline.map(([z, r]): Vec3 => [r, 0, z + up]), [0, 0, z0 + lead + up]];
      const section = this.keep(new oc.BRepBuilderAPI_MakeWire());
      corners.forEach((a, i) => {
        const b = corners[(i + 1) % corners.length];
        if (Math.hypot(b[0] - a[0], b[2] - a[2]) >= 1e-7) section.Add(this.done(new oc.BRepBuilderAPI_MakeEdge(this.point(...a), this.point(...b))).Edge());
      });
      if (!section.IsDone()) none();
      faces.push(this.keep(this.done(new oc.BRepBuilderAPI_MakeFace(this.keep(section.Wire()), true)).Face()));
    }
    this.steepest = Math.max(this.steepest, lead / (Math.PI * (root + reach)));
    return this.sewn(faces, turns * perTurn);
  }

  // --- sweeps: a pipe's section carried along its path ------------------------------------------

  /**
   * A lofted mesh from what it was lofted from, stretch by stretch: a section carried straight on
   * is a prism, one carried round a bend is turned about the bend's axis, and one that changes
   * size on the way is a cone when it is round and stays on its axis, and otherwise the surface
   * of straight lines from the one outline to the other. Anything else has no exact form.
   */
  swept({ stations, rings }: Swept): Shape {
    const { oc } = this;
    const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const along = (p: Vec3, d: Vec3, by: number): Vec3 => [p[0] + d[0] * by, p[1] + d[1] * by, p[2] + d[2] * by];
    const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
    const close = (a: Vec3, b: Vec3, within = 1e-6): boolean => length(sub(a, b)) <= within;
    const sameRing = (a: Polygon, b: Polygon): boolean => a.length === b.length && a.every((q, k) => Math.hypot(q[0] - b[k][0], q[1] - b[k][1]) <= 1e-9);
    type Station = Swept['stations'][number];
    const place = (s: Station) => ([x, y]: [number, number]): Vec3 => along(along(s.p, s.u, x), s.v, y);
    /** The section at a station as a face. */
    const section = (i: number): Shape => {
      const [face] = this.faces([rings[i]], place(stations[i]));
      return face;
    };
    /** The bend two stations are on, if they are on one: the section's plane turned about an axis along `v`. */
    const bend = (a: Station, b: Station): { center: Vec3; angle: number } | null => {
      if (!close(a.v, b.v)) return null;
      const turn = sub(a.u, b.u);
      if (length(turn) < 1e-9) return null;
      // The one point both sections stand off by the same distance along their `u`: the middle of the bend.
      const off = dot(sub(b.p, a.p), turn) / dot(turn, turn);
      const center = along(a.p, a.u, off);
      if (!close(center, along(b.p, b.u, off), 1e-6 * Math.max(1, Math.abs(off)))) return null;
      return { center, angle: Math.atan2(dot(cross(a.u, b.u), a.v), dot(a.u, b.u)) };
    };
    const pieces: Shape[] = [];
    let i = 0;
    while (i + 1 < stations.length) {
      const a = stations[i];
      const b = stations[i + 1];
      const step = sub(b.p, a.p);
      if (close(a.u, b.u) && close(a.v, b.v)) {
        // Carried on without turning: straight along the section's own normal, or it is skewed.
        const normal = cross(a.u, a.v);
        const run = dot(step, normal);
        if (!close(step, along([0, 0, 0], normal, run), 1e-6 * Math.max(1, length(step))) || Math.abs(run) < 1e-9) none();
        if (sameRing(rings[i], rings[i + 1])) pieces.push(this.result(new oc.BRepPrimAPI_MakePrism(section(i), this.keep(new oc.gp_Vec(...step)), false, true)));
        else pieces.push(this.taper(rings[i], rings[i + 1], a, b, normal, run));
        i++;
        continue;
      }
      // Turned: every station from here on that is on the same bend makes one piece with it.
      const first = sameRing(rings[i], rings[i + 1]) ? bend(a, b) : null;
      if (!first || first.angle === 0) return none();
      let total = first.angle;
      let j = i + 1;
      while (j + 1 < stations.length && sameRing(rings[j], rings[j + 1])) {
        const next = bend(stations[j], stations[j + 1]);
        if (!next || !close(next.center, first.center, 1e-6 * Math.max(1, length(first.center))) || next.angle * first.angle <= 0) break;
        total += next.angle;
        j++;
      }
      // A full turn or more would run into itself.
      if (Math.abs(total) >= 2 * Math.PI - 1e-9) none();
      const way = total > 0 ? 1 : -1;
      const axis = this.keep(new oc.gp_Ax1(this.point(...first.center), this.keep(new oc.gp_Dir(a.v[0] * way, a.v[1] * way, a.v[2] * way))));
      pieces.push(this.result(new oc.BRepPrimAPI_MakeRevol(section(i), axis, Math.abs(total), false)));
      i = j;
    }
    return this.fuse(pieces);
  }

  /** A section that changes from one outline to another between two stations facing the same way, `run` apart along `normal`. */
  private taper(from: Polygon, to: Polygon, a: Swept['stations'][number], b: Swept['stations'][number], normal: Vec3, run: number): Shape {
    const { oc } = this;
    const [near0, far] = [traceArcs(from), traceArcs(to)];
    const centered = (t: ReturnType<typeof traceArcs>): t is { circle: { center: [number, number]; radius: number } } => 'circle' in t && Math.hypot(t.circle.center[0], t.circle.center[1]) <= 1e-9;
    if (centered(near0) && centered(far)) {
      // Round and on its axis at both ends: a cone, its side a straight line turned round the axis.
      const [r0, r1] = [near0.circle.radius, far.circle.radius];
      const at = ([r, z]: [number, number]): Vec3 => [a.p[0] + a.u[0] * r + normal[0] * z, a.p[1] + a.u[1] * r + normal[1] * z, a.p[2] + a.u[2] * r + normal[2] * z];
      const [face] = this.faces([[[0, 0], [r0, 0], [r1, run], [0, run]]], at);
      const axis = this.keep(new oc.gp_Ax1(this.point(...a.p), this.keep(new oc.gp_Dir(...normal))));
      return this.result(new oc.BRepPrimAPI_MakeRevol(face, axis, false));
    }
    // Any other pair of outlines: straight lines from each point of the one to its like on the other.
    const through = this.keep(new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6));
    const put = (s: Swept['stations'][number]) => ([x, y]: [number, number]): Vec3 => [s.p[0] + s.u[0] * x + s.v[0] * y, s.p[1] + s.u[1] * x + s.v[1] * y, s.p[2] + s.u[2] * x + s.v[2] * y];
    through.AddWire(this.wire(from, put(a)));
    through.AddWire(this.wire(to, put(b)));
    through.Build(this.keep(new oc.Message_ProgressRange()));
    if (!through.IsDone()) none();
    return this.keep(through.Shape());
  }

  // --- parts: a generator's description --------------------------------------------------------

  described(solid: Solid): Shape {
    const { oc } = this;
    switch (solid.op) {
      case 'cylinder': {
        const top = solid.radiusTop ?? solid.radius;
        if (near(top, solid.radius)) return this.result(new oc.BRepPrimAPI_MakeCylinder(solid.radius, solid.height));
        // A frustum, or a cone when one end comes to a point.
        const profile: Polygon = [[0, 0], [solid.radius, 0], [top, solid.height], [0, solid.height]];
        return this.turned(profile.filter((p, i) => !(i > 0 && near(p[0], 0) && near(profile[i - 1][0], 0) && near(p[1], profile[i - 1][1]))));
      }
      case 'extrude':
        // Tapered as it rises: the kernel's facets are the only form it has.
        if (solid.scaleTop !== undefined && !near(solid.scaleTop, 1)) return none();
        return solid.twist ? this.twisted(solid.shape, [{ turn: (solid.twist * Math.PI) / 180, height: solid.height }]) : this.prism(solid.shape, 0, solid.height);
      case 'revolve':
        return this.turned(solid.profile);
      case 'mesh':
        // Only one that says what it was lofted from has another form than its triangles.
        return solid.swept ? this.swept(solid.swept) : none();
      case 'union': {
        // A thread before it is cut to length: made from what it is, not from the core and the coils the kernel joins it of.
        if (solid.thread) return this.thread(solid.thread);
        // A twisted extrusion under its mirror image is one outline raised in two stages, the second turning back.
        const half = mirroredOnTop(solid.children);
        if (half) {
          const turn = ((half.twist ?? 0) * Math.PI) / 180;
          return this.twisted(half.shape, [{ turn, height: half.height }, { turn: -turn, height: half.height }]);
        }
        return this.fuse(solid.children.map((c) => this.described(c)));
      }
      case 'intersection':
        return this.common(solid.children.map((c) => this.described(c)));
      case 'difference': {
        const [first, ...rest] = solid.children.map((c) => this.described(c));
        return this.cut(first ?? none(), rest);
      }
      case 'tidy':
        // Only its mesh is tidied: the solid is the child.
        return this.described(solid.child);
      case 'transform': {
        let shape = this.described(solid.child);
        if (solid.mirror) shape = this.mirrored(shape, solid.mirror);
        if (solid.rotate || solid.translate) {
          const m = rotation(solid.rotate ?? [0, 0, 0]);
          const t = solid.translate ?? [0, 0, 0];
          shape = this.moved(shape, [...m.slice(0, 9), t[0], t[1], t[2]]);
        }
        return shape;
      }
    }
  }

  /**
   * A part as its generator describes it, centered on its box and at the size it has been given: all three axes by
   * the one factor, or not at all. It is built once for a file: fifty bolts of one kind are one bolt to build (the
   * thread of each takes most of a second), and each is then put in its place as a copy.
   */
  part(node: PartNode): Shape {
    const def = getGenerator(node.part);
    const params = sanitizeParams(def, node.params);
    const key = JSON.stringify([node.part, params, node.natural, node.size, this.join]);
    let built = this.parts.get(key);
    if (built === undefined) {
      // What this part is made of is told apart from what the builder has made before it.
      const before = { helical: this.helical, steepest: this.steepest };
      this.helical = false;
      this.steepest = 0;
      built = null;
      try {
        const box = this.tools.partBox(node) ?? none();
        const scale = node.size[0] / node.natural[0];
        if (!node.size.every((s, i) => near(s / node.natural[i], scale))) none();
        const center = [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2);
        const shape = this.moved(this.tidy(this.described(def.build(params, QUALITY.fine).solid)), [scale, 0, 0, 0, scale, 0, 0, 0, scale, -center[0] * scale, -center[1] * scale, -center[2] * scale]);
        built = { shape, helical: this.helical, steepest: this.steepest };
      } finally {
        // Kept even when it did not come off: the next one like it need not be tried.
        this.parts.set(key, built);
        this.helical = before.helical;
        this.steepest = before.steepest;
      }
    }
    if (!built) return none();
    this.helical ||= built.helical;
    this.steepest = Math.max(this.steepest, built.steepest);
    return built.shape;
  }

  /**
   * `shape` with its faces that are parts of one surface made one face: the two halves a round wall
   * is drawn in, the pieces a cut left of a flat. Left as it is when the builder was told not to.
   */
  tidy(shape: Shape): Shape {
    if (!this.join) return shape;
    const unify = this.keep(new this.oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false));
    unify.Build();
    return this.keep(unify.Shape());
  }

  // --- the basic shapes ----------------------------------------------------------------------------

  /** A shape at its size, centered on the origin, as `buildShape` makes it of facets. */
  shape(node: ShapeNode): Shape {
    const { oc } = this;
    const [w, d, h] = node.size;
    const p = clampParams(node);
    const round = (p.sides ?? 0) >= (ROUND[node.shape] ?? Infinity);
    /** The regular polygon of the shape's sides, fitted to its width and depth as the kernel fits it. */
    const footprint = (): Polygon => {
      const unit = regularPolygon(p.sides);
      const xs = unit.map((q) => q[0]);
      const ys = unit.map((q) => q[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      return unit.map(([x, y]) => [((x - (x0 + x1) / 2) / (x1 - x0)) * w, ((y - (y0 + y1) / 2) / (y1 - y0)) * d]);
    };
    /** A section drawn in the XZ plane, run through the shape's depth along Y. */
    const lying = (section: Polygon): Shape => {
      const [face] = this.faces([section], ([x, z]) => [x, -d / 2, z]);
      return this.result(new oc.BRepPrimAPI_MakePrism(face, this.keep(new oc.gp_Vec(0, d, 0)), false, true));
    };
    /** Points along a curve, close enough together to be found again as the arc they lie on (see arcs.ts). */
    const arc = (steps: number, at: (a: number) => [number, number]): Polygon => Array.from({ length: steps + 1 }, (_, i) => at(i / steps));
    switch (node.shape) {
      case 'box': {
        const box = this.result(new oc.BRepPrimAPI_MakeBox(this.point(-w / 2, -d / 2, -h / 2), w, d, h));
        if (!(p.radius > 0)) return box;
        // Rounded all over: every edge by the radius, which only comes off while flats are left between them.
        if (p.radius * 2 >= Math.min(w, d, h) - 1e-6) return none();
        const fillet = this.keep(new oc.BRepFilletAPI_MakeFillet(box, oc.ChFi3d_FilletShape.ChFi3d_Rational));
        const edges = this.keep(new oc.TopExp_Explorer(box, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
        const seen: Shape[] = [];
        for (; edges.More(); edges.Next()) {
          const edge = this.keep(edges.Current());
          // Every edge is met twice, once from each face.
          if (seen.some((e) => e.IsSame(edge))) continue;
          seen.push(edge);
          fillet.Add(p.radius, oc.TopoDS.Edge(edge));
        }
        fillet.Build(this.keep(new oc.Message_ProgressRange()));
        if (!fillet.IsDone()) none();
        return this.keep(fillet.Shape());
      }
      case 'cylinder':
      case 'prism': {
        if (p.radius > 0) return none();
        if (!round || node.shape === 'prism') return this.prism([footprint()], -h / 2, h);
        // Round: as wide as its box across the flats the kernel gives it, so the true circle is the one inside its box.
        if (near(w, d)) return this.result(new oc.BRepPrimAPI_MakeCylinder(this.frame([0, 0, -h / 2], [0, 0, 1], [1, 0, 0]), w / 2, h));
        const wide = w >= d;
        const oval = this.keep(new oc.gp_Elips(this.frame([0, 0, -h / 2], [0, 0, 1], wide ? [1, 0, 0] : [0, 1, 0]), Math.max(w, d) / 2, Math.min(w, d) / 2));
        const rim = this.keep(this.done(new oc.BRepBuilderAPI_MakeWire(this.done(new oc.BRepBuilderAPI_MakeEdge(oval)).Edge())).Wire());
        const face = this.keep(this.done(new oc.BRepBuilderAPI_MakeFace(rim, true)).Face());
        return this.result(new oc.BRepPrimAPI_MakePrism(face, this.keep(new oc.gp_Vec(0, 0, h)), false, true));
      }
      case 'cone':
      case 'pyramid': {
        // Round and as deep as wide: a profile turned round. Anything else is flat faces, or an oval cone, which the facets say as well.
        const top = node.shape === 'pyramid' ? 0 : p.top;
        if (!round || node.shape === 'pyramid' || !near(w, d)) return none();
        const profile: Polygon = [[0, -h / 2], [w / 2, -h / 2], [(w / 2) * top, h / 2]];
        if (top > 0) profile.push([0, h / 2]);
        return this.turned(profile);
      }
      case 'sphere':
        // A ball stretched into an egg is an oval turned round an axis, which a STEP file has been seen not to keep (it is read back as another shape): left to the facets.
        return round && near(w, d) && near(d, h) ? this.result(new oc.BRepPrimAPI_MakeSphere(w / 2)) : none();
      case 'wedge':
        return lying([[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2]]);
      case 'roof':
        return lying([[-w / 2, -h / 2], [w / 2, -h / 2], [0, h / 2]]);
      case 'torus': {
        if (!round || !near(w, d)) return none();
        const r = h / 2;
        const a = p.ring > 0 ? Math.min(p.ring / 2, w / 4) : Math.min(r, w / 4);
        const center = w / 2 - a;
        // A round section on a ring with a hole in it; a flattened one is no torus to OpenCascade, and a closed hole is no solid of revolution.
        if (!near(a, r) || center - a < 1e-6) return none();
        return this.result(new oc.BRepPrimAPI_MakeTorus(center, r));
      }
      case 'roundroof': {
        // Half a round bar lying on its flat: a cylinder while it is half as tall as it is wide, and half an oval bar when it is not. Of few steps it is flat faces, which the facets say as well.
        if (!round) return none();
        if (near(h, w / 2)) return lying(arc(64, (a) => [(Math.cos(a * Math.PI) * w) / 2, Math.sin(a * Math.PI) * h - h / 2]));
        return this.result(new oc.BRepPrimAPI_MakePrism(this.ovalFace([0, -h / 2], w / 2, h, 0, Math.PI, [], ([x, z]) => [x, -d / 2, z]), this.keep(new oc.gp_Vec(0, d, 0)), false, true));
      }
      case 'fillet': {
        // What a quarter-round bar leaves of a square one: the solid corner at +X +Z, the hollow running from the top at -X down to the bottom at +X.
        if (!round) return none();
        if (near(w, h)) return lying([[w / 2, h / 2], ...arc(32, (a) => [Math.cos(((1 - a) * Math.PI) / 2) * w - w / 2, Math.sin(((1 - a) * Math.PI) / 2) * h - h / 2])]);
        // Wider than tall, or taller than wide: the hollow is a quarter of an oval.
        return this.result(new oc.BRepPrimAPI_MakePrism(this.ovalFace([-w / 2, -h / 2], w, h, 0, Math.PI / 2, [[w / 2, h / 2]], ([x, z]) => [x, -d / 2, z]), this.keep(new oc.gp_Vec(0, d, 0)), false, true));
      }
      case 'dome': {
        // Half a ball on its flat: a quarter circle turned round, while it is as deep as wide and half as tall. Taller or flatter it is an oval turned round, which is left to the facets like the egg.
        if (!round || !near(w, d) || !near(h, w / 2)) return none();
        return this.turned([[0, -h / 2], ...arc(32, (a) => [Math.cos((a * Math.PI) / 2) * h, Math.sin((a * Math.PI) / 2) * h - h / 2])]);
      }
      default:
        return none();
    }
  }

  // --- groups ----------------------------------------------------------------------------------------

  /** A group: its solids together, less its holes, as the kernel combines them. */
  group(node: GroupNode): Shape {
    const scale = node.size[0] / node.natural[0];
    if (!node.size.every((s, i) => near(s / node.natural[i], scale))) none();
    const solids: Shape[] = [];
    const holes: Shape[] = [];
    for (const child of node.children) {
      if (child.type === 'picture') continue;
      (child.hole ? holes : solids).push(this.placed(child));
    }
    const all = this.cut(this.fuse(solids), holes);
    return near(scale, 1) ? all : this.moved(all, [scale, 0, 0, 0, scale, 0, 0, 0, scale, 0, 0, 0]);
  }

  /** A node at its built size, centered on the origin. */
  built(node: SceneNode): Shape {
    switch (node.type) {
      case 'shape':
        // Built at its size rather than stretched to it: only a round rim or a ring's width depend on the size, and both are read from it.
        return this.shape(node);
      case 'part':
        return this.part(node);
      case 'group':
        return this.group(node);
      default:
        return none();
    }
  }

  /** A node where it is in its parent: mirrored, turned and moved, as `nodeMatrix` does it (its size is already in what was built). */
  placed(node: SceneNode): Shape {
    let shape = this.built(node);
    const sign = flipSigns(node.flip);
    const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    axes.forEach((axis, i) => {
      if (sign[i] < 0) shape = this.mirrored(shape, axis);
    });
    const m = rotation(node.rot);
    return this.moved(shape, [...m.slice(0, 9), node.pos[0], node.pos[1], node.pos[2]]);
  }
}

/**
 * The volume a shape holds. Where it has surfaces swept round a helix (`helical`) the library works it out to a
 * part in a million by the rule that takes as many points as that needs: its plain rule lays so many on such a
 * surface that a bolt takes it ten times as long, for the same digits.
 */
function volumeOf(oc: Oc, shape: Shape, keep: Keep, helical: boolean): number {
  const props = keep(new oc.GProp_GProps());
  if (helical) oc.BRepGProp.VolumeProperties(shape, props, 1e-6, false, false);
  else oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
  return props.Mass();
}

/**
 * The volume and the box of a shape, to hold against the kernel's. The box is worked out from the
 * surfaces themselves; with `facets` it is that of fine facets laid over them instead, which is the
 * one to go by where the library's own is loose (it is for an oval turned round an axis, once the
 * shape is turned off the axes).
 */
function measured(oc: Oc, shape: Shape, keep: Keep, helical: boolean, facets = false): { volume: number; bounds: Bounds } {
  const volume = volumeOf(oc, shape, keep, helical);
  const box = keep(new oc.Bnd_Box());
  if (facets) {
    keep(new oc.BRepMesh_IncrementalMesh(shape, 0.01, false, 0.1, false));
    oc.BRepBndLib.Add(shape, box, true);
  } else oc.BRepBndLib.AddOptimal(shape, box, false, false);
  const min = keep(box.CornerMin());
  const max = keep(box.CornerMax());
  return { volume, bounds: { min: [min.X(), min.Y(), min.Z()], max: [max.X(), max.Y(), max.Z()] } };
}

/** The area of the skin of a shape that holds a thread, to a part in a hundred thousand (by the rule `volumeOf` uses for such shapes). */
function skin(oc: Oc, shape: Shape, keep: Keep): number {
  const props = keep(new oc.GProp_GProps());
  oc.BRepGProp.SurfaceProperties(shape, props, 1e-5, false);
  return props.Mass();
}

/**
 * Whether a shape written to a STEP file of its own is read back with the
 * volume it should have, and with a skin of `expect.area` to within `skinSlack`
 * where one is given. What the library holds in memory and what it writes
 * are not always the same thing: an oval turned round an axis is right in
 * memory and comes back from the file as nothing, or as another shape; and
 * a nut with a piece of thread too many measured otherwise in memory than it
 * did once written. What is read back is what the file will hold.
 */
function survives(oc: Oc, shape: Shape, expect: Expected, keep: Keep, helical: boolean, skinSlack: number | null): boolean {
  const path = '/exact-check.step';
  try {
    const writer = keep(new oc.STEPControl_Writer());
    const progress = keep(new oc.Message_ProgressRange());
    if (writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, progress) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) return false;
    if (writer.Write(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) return false;
    const reader = keep(new oc.STEPControl_Reader());
    if (reader.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) return false;
    reader.TransferRoots(progress);
    const back = keep(reader.OneShape());
    if (back.IsNull()) return false;
    if (!(Math.abs(volumeOf(oc, back, keep, helical) - expect.volume) <= 0.005 * Math.abs(expect.volume))) return false;
    return skinSlack === null || Math.abs(skin(oc, back, keep) - expect.area) <= skinSlack * expect.area;
  } catch (e) {
    if (isTrap(e)) throw e;
    return false;
  } finally {
    try {
      oc.FS.unlink(path);
    } catch {
      // Never written.
    }
  }
}

/**
 * How far the box of a true solid may be from the box of the kernel's facets
 * of it, in millimeters: a twentieth of a millimeter, and a quarter of a
 * percent of its largest side, which is what the flats of a curve of some
 * fifty sides stand back from the curve itself.
 */
export const boxSlack = (bounds: Bounds): number => 0.05 + 0.0025 * Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);

/** What the kernel's own solid of an object measures: what a rebuilt one is held against. */
export interface Expected {
  volume: number;
  bounds: Bounds;
  /** The area of its skin. */
  area: number;
}

/**
 * How far the area of the skin of a solid that holds a thread may be from that of the kernel's facets, as a part of it.
 *
 * Cutting a thread to length is where the library has been seen to give a wrong answer that looks right: before
 * it was given its slack (see `FUZZY`), four nuts in a hundred and fifteen threaded parts kept a piece of thread
 * they should have lost. All four were closed, found valid, and within the half percent of volume every solid is
 * allowed (three 0.34% to 0.40% over, one 0.09%). The volume cannot tell such a solid from a right one: the
 * kernel's own facets of a steep thread of many starts hold up to half a percent more than the true thread. The
 * skin can, since a thread is thin ridges and a piece too many moves the skin more than the volume: read back from
 * the file, the four were 1.3% to 1.4% and 0.19% off.
 *
 * What a right solid is off by is what the kernel's facets are, and that grows with how steep the thread is
 * (`steepest`: its lead over the way round it at the middle of its depth): under 0.05% for screw threads (steep by
 * 0.04 to 0.08), 0.2% at 0.25, 0.65% at 0.9. So a part is allowed a tenth of a percent, more by the square of its
 * steepness over a tenth, and never more than one percent, which leaves the right ones at least half as much room
 * again as the worst of them took, and three times that where threads are not steep. Anything that is not a part
 * by itself (a group with a threaded hole in it) is allowed the one percent, whatever else it is made of.
 */
const skinSlack = (steepest: number, part: boolean): number => (part ? Math.min(0.01, 0.001 * (1 + (steepest / 0.1) ** 2)) : 0.01);

/**
 * The node as a true solid, placed in the design; null when it has no exact
 * form, or when the form it was given does not match `expect`, the kernel's
 * own solid: its volume to within the difference between a curve and its
 * facets, its box to within `boxSlack`, and where it holds a thread the
 * skin it has in the file as well (see `skinSlack`). `parts` holds the parts built for the
 * file so far, so that each kind is built once.
 *
 * A trap inside the library is passed on (see `forgetOcc` in occ.ts): what it
 * was asked for next would not be worth having.
 */
export function exactShape(oc: Oc, node: SceneNode, expect: Expected, tools: ExactTools, keep: Keep, parts: PartCache = new Map()): Shape | null {
  // With its faces joined where they lie on one surface, and failing that as it was built: two round
  // pipes of one size that cross touch along a line, and joining faces there has been seen to lose one of them.
  for (const join of [true, false]) {
    const builder = new Builder(oc, keep, tools, join, parts);
    let shape: Shape;
    try {
      shape = builder.placed(node);
    } catch (e) {
      if (isTrap(e)) throw e;
      // No exact form, or OpenCascade gave up on it (it says so by an exception of its own).
      continue;
    }
    try {
      let got = measured(oc, shape, keep, builder.helical);
      if (!(Math.abs(got.volume - expect.volume) <= 0.005 * expect.volume)) continue;
      // A round shape turned off the axes reaches a little further than its facets do, by more the larger it is.
      const slack = boxSlack(expect.bounds);
      const off = (): boolean => [0, 1, 2].some((i) => Math.abs(got.bounds.min[i] - expect.bounds.min[i]) > slack || Math.abs(got.bounds.max[i] - expect.bounds.max[i]) > slack);
      if (off()) {
        got = measured(oc, shape, keep, builder.helical, true);
        if (off()) continue;
      }
      // And it has to come out of a STEP file as it went in: a solid that is right here has been seen to be read back as another.
      if (!survives(oc, shape, expect, keep, builder.helical, builder.steepest > 0 ? skinSlack(builder.steepest, node.type === 'part') : null)) continue;
      return shape;
    } catch (e) {
      if (isTrap(e)) throw e;
      continue;
    }
  }
  return null;
}
