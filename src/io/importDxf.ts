// DXF drawings as filled outlines, the way SVG comes in: lines, polylines
// (with bulges), circles, arcs, ellipses and splines are flattened, chained
// end to end into closed contours, and grouped by color. Blocks placed with
// INSERT are expanded. Units follow $INSUNITS; a drawing that gives none is
// taken to be in millimeters.
//
// Not read: text, dimensions, hatches, 3D entities, and the paper space.
import type { OutlineShape, Polygon, Vec2 } from '../model/types';
import { applyTo, maxStretch, mul, signedArea, TOLERANCE, turnSegments } from './outline';
import type { Matrix } from './outline';

/** Endpoints closer than this (mm) are joined. */
const JOIN = 0.01;
/** Contours enclosing less than this (mm²) are lines or dots, not shapes. */
const MIN_AREA = 1e-6;
/** Blocks within blocks, past which an INSERT is ignored rather than followed forever. */
const MAX_NESTING = 8;
// A small file can still name a huge drawing: every INSERT is a copy of its block, and may ask for rows and
// columns of it. These stop one that would never fit in memory.
const MAX_ENTITIES = 1_000_000;
const MAX_POINTS = 4_000_000;
const TOO_MANY = 'This DXF has too many entities to open.';
/** The highest spline degree that is followed; real drawings stay far below it. */
const MAX_DEGREE = 32;
const TAU = Math.PI * 2;
const RAD = Math.PI / 180;

/** Millimeters per drawing unit, by $INSUNITS. Zero (unitless) and the unknown ones count as millimeters. */
const UNITS: Record<number, number> = {
  1: 25.4,
  2: 304.8,
  3: 1_609_344,
  4: 1,
  5: 10,
  6: 1000,
  7: 1_000_000,
  8: 0.0000254,
  9: 0.0254,
  10: 914.4,
  11: 1e-7,
  12: 1e-6,
  13: 1e-3,
  14: 100,
  15: 10_000,
  16: 100_000,
  17: 1e12,
  18: 1.495978707e14,
  19: 9.4607304725808e18,
  20: 3.0856775814913673e19,
};


/** One entity: the group codes it was written with, each kept in order of appearance. */
interface Entity {
  type: string;
  /** Code → every value given for it, in order. */
  codes: Map<number, string[]>;
  /** A POLYLINE's vertices. */
  vertices?: Entity[];
  /** An LWPOLYLINE's vertices in the order written, each with the bulge that follows it (0 when none does). */
  corners?: [x: number, y: number, bulge: number][];
}

/** Entities placed in a plane of their own, which an extrusion pointing down turns over. */
const IN_OWN_PLANE = new Set(['CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE']);
const MIRROR: Matrix = [-1, 0, 0, 1, 0, 0];

interface Block {
  base: Vec2;
  entities: Entity[];
}

/** A run of points; `closed` when the entity closed it itself. */
interface Path {
  points: Polygon;
  closed: boolean;
}

export function parseDxf(bytes: Uint8Array): { shapes: OutlineShape[]; color?: string }[] {
  const text = decode(bytes);
  const pairs = tokenize(text);
  if (pairs.length === 0) throw new Error('This is not a DXF file.');

  let scale = 1;
  const layers = new Map<string, number>();
  const blocks = new Map<string, Block>();
  const entities: Entity[] = [];
  let sawSection = false;

  // Sections, read one after the other.
  let i = 0;
  while (i < pairs.length) {
    const [code, value] = pairs[i++];
    if (code !== 0 || value !== 'SECTION') continue;
    sawSection = true;
    const name = pairs[i]?.[0] === 2 ? pairs[i++][1] : '';
    const end = sectionEnd(pairs, i);
    if (name === 'HEADER') scale = headerUnits(pairs, i, end);
    else if (name === 'TABLES') readLayers(pairs, i, end, layers);
    else if (name === 'BLOCKS') readBlocks(pairs, i, end, blocks);
    else if (name === 'ENTITIES') readEntities(pairs, i, end, entities);
    i = end;
  }
  if (!sawSection) throw new Error('This is not a DXF file.');

  // Paths by color, in the order the colors first appear.
  const paths = new Map<string | undefined, Path[]>();
  const unit: Matrix = [scale, 0, 0, scale, 0, 0];
  let drawn = 0;
  let pointCount = 0;
  const draw = (list: Entity[], m: Matrix, inherited: string | undefined, depth: number) => {
    for (const entity of list) {
      if (++drawn > MAX_ENTITIES) throw new Error(TOO_MANY);
      // Paper space holds the sheet's frame and title block, not the part.
      if (num(entity, 67, 0) === 1) continue;
      const color = entityColor(entity, layers, inherited);
      // An extrusion along -Z is how a mirrored entity is written: its own X axis runs the other way.
      const mirrored = num(entity, 230, 1) < 0;
      if (entity.type === 'INSERT') {
        if (depth >= MAX_NESTING) continue;
        const block = blocks.get(first(entity, 2) ?? '');
        if (!block) continue;
        const sx = num(entity, 41, 1);
        const sy = num(entity, 42, 1);
        const angle = num(entity, 50, 0) * RAD;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const place: Matrix = [cos * sx, sin * sx, -sin * sy, cos * sy, num(entity, 10, 0), num(entity, 20, 0)];
        const offset: Matrix = [1, 0, 0, 1, -block.base[0], -block.base[1]];
        // Rows and columns of the same block, if asked for.
        const columns = Math.max(1, Math.round(num(entity, 70, 1)));
        const rows = Math.max(1, Math.round(num(entity, 71, 1)));
        const dx = num(entity, 44, 0);
        const dy = num(entity, 45, 0);
        // Counted before any is placed, so that an array of an empty block ends too.
        drawn += rows * columns;
        if (drawn > MAX_ENTITIES) throw new Error(TOO_MANY);
        const frame = mirrored ? mul(m, MIRROR) : m;
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < columns; c++) {
            const at = mul(mul(frame, mul([1, 0, 0, 1, c * dx * cos - r * dy * sin, c * dx * sin + r * dy * cos], place)), offset);
            draw(block.entities, at, color, depth + 1);
          }
        continue;
      }
      // Curves are flattened in drawing units, so the tolerance is brought there.
      const stretch = maxStretch(m);
      if (!(stretch > 0) || !Number.isFinite(stretch)) continue;
      const frame = mirrored && IN_OWN_PLANE.has(entity.type) ? mul(m, MIRROR) : m;
      for (const path of entityPaths(entity, TOLERANCE / stretch)) {
        pointCount += path.points.length;
        if (pointCount > MAX_POINTS) throw new Error('This DXF has too many points to open.');
        const points = path.points.map((p) => applyTo(frame, p));
        if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) continue;
        const list = paths.get(color) ?? [];
        list.push({ points, closed: path.closed });
        paths.set(color, list);
      }
    }
  };
  draw(entities, unit, undefined, 0);

  const parts: { shapes: OutlineShape[]; color?: string }[] = [];
  for (const [color, list] of paths) {
    const contours = chain(list);
    if (contours.length === 0) continue;
    // All of one color as one shape, so that a contour inside another is a hole in it.
    parts.push(color ? { shapes: [{ contours, evenodd: true }], color } : { shapes: [{ contours, evenodd: true }] });
  }
  if (parts.length === 0) throw new Error('This DXF has no closed outlines that can be extruded.');
  return parts;
}

// ---------------------------------------------------------------------------
// Reading

/** DXF is ASCII, or UTF-8 in newer files; a UTF-16 one announces itself with a byte order mark. */
function decode(bytes: Uint8Array): string {
  const le = bytes[0] === 0xff && bytes[1] === 0xfe;
  const be = bytes[0] === 0xfe && bytes[1] === 0xff;
  if (le || be) return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(bytes);
  // Binary DXF opens with a sentinel; it is not read.
  if (bytes.length >= 22 && bytes[0] === 65 && bytes[1] === 117 && bytes[20] === 26) throw new Error('Binary DXF files cannot be imported. Save the drawing as ASCII DXF.');
  return new TextDecoder('utf-8').decode(bytes);
}

/** The file as (group code, value) pairs. A line that is not a number where a code should be ends the reading. */
function tokenize(text: string): [number, string][] {
  const lines = text.split(/\r\n|\n|\r/);
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) break;
    out.push([code, lines[i + 1].trim()]);
  }
  return out;
}

/** Index of the pair after the section's ENDSEC (or the end of the file). */
function sectionEnd(pairs: [number, string][], from: number): number {
  for (let i = from; i < pairs.length; i++) if (pairs[i][0] === 0 && pairs[i][1] === 'ENDSEC') return i + 1;
  return pairs.length;
}

function headerUnits(pairs: [number, string][], from: number, end: number): number {
  for (let i = from; i + 1 < end; i++) {
    if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS' && pairs[i + 1][0] === 70) return UNITS[Number(pairs[i + 1][1])] ?? 1;
  }
  return 1;
}

/** Layer colors, from the LAYER table. */
function readLayers(pairs: [number, string][], from: number, end: number, layers: Map<string, number>): void {
  for (const entity of readEntities(pairs, from, end, [])) {
    if (entity.type !== 'LAYER') continue;
    const name = first(entity, 2);
    const color = num(entity, 62, 7);
    if (name !== undefined) layers.set(name, Math.abs(color));
  }
}

function readBlocks(pairs: [number, string][], from: number, end: number, blocks: Map<string, Block>): void {
  let block: { name: string; base: Vec2; entities: Entity[] } | null = null;
  for (const entity of readEntities(pairs, from, end, [])) {
    if (entity.type === 'BLOCK') {
      block = { name: first(entity, 2) ?? '', base: [num(entity, 10, 0), num(entity, 20, 0)], entities: [] };
    } else if (entity.type === 'ENDBLK') {
      if (block) blocks.set(block.name, block);
      block = null;
    } else if (block) block.entities.push(entity);
  }
}

/** Every 0-code record between `from` and `end`, with a POLYLINE's VERTEX records folded into it. */
function readEntities(pairs: [number, string][], from: number, end: number, out: Entity[]): Entity[] {
  let current: Entity | null = null;
  let polyline: Entity | null = null;
  for (let i = from; i < end; i++) {
    const [code, value] = pairs[i];
    if (code === 0) {
      if (value === 'ENDSEC') break;
      current = { type: value, codes: new Map() };
      if (value === 'VERTEX' && polyline) {
        (polyline.vertices ??= []).push(current);
      } else if (value === 'SEQEND') {
        polyline = null;
      } else {
        out.push(current);
        polyline = value === 'POLYLINE' ? current : null;
      }
      continue;
    }
    if (!current) continue;
    // An LWPOLYLINE repeats 10, 20 and, where a side is an arc, 42 for every vertex: 42 belongs to the vertex before it.
    if (current.type === 'LWPOLYLINE' && (code === 10 || code === 20 || code === 42)) {
      const corners = (current.corners ??= []);
      if (code === 10) corners.push([Number(value), 0, 0]);
      else if (corners.length) corners[corners.length - 1][code === 20 ? 1 : 2] = Number(value);
      continue;
    }
    const list = current.codes.get(code);
    if (list) list.push(value);
    else current.codes.set(code, [value]);
  }
  return out;
}

const first = (entity: Entity, code: number): string | undefined => entity.codes.get(code)?.[0];
const num = (entity: Entity, code: number, fallback: number): number => {
  const v = Number(first(entity, code));
  return Number.isFinite(v) ? v : fallback;
};
const nums = (entity: Entity, code: number): number[] => (entity.codes.get(code) ?? []).map(Number);

// ---------------------------------------------------------------------------
// Colors

/** The entity's color as `#rrggbb`: its own true color or index, else its layer's; undefined for the default (index 7, drawn black or white). */
function entityColor(entity: Entity, layers: Map<string, number>, inherited: string | undefined): string | undefined {
  const truecolor = num(entity, 420, NaN);
  if (Number.isFinite(truecolor)) return `#${(truecolor & 0xffffff).toString(16).padStart(6, '0')}`;
  let index = num(entity, 62, 256);
  // 0 is "by block": the color of the INSERT that placed it. 256 is "by layer".
  if (index === 0) return inherited;
  if (index === 256) index = layers.get(first(entity, 8) ?? '') ?? 7;
  return aciColor(index);
}

/** AutoCAD's color index as `#rrggbb`; undefined for 7, the foreground color. */
export function aciColor(index: number): string | undefined {
  const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
  const basic: Record<number, string> = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 8: '#808080', 9: '#c0c0c0' };
  if (index === 7 || !Number.isInteger(index) || index < 1 || index > 255) return undefined;
  if (basic[index]) return basic[index];
  if (index >= 250) return hex(51 + (index - 250) * 41, 51 + (index - 250) * 41, 51 + (index - 250) * 41);
  // 10–249: 24 hues in steps of 15°, five shades each, the odd index of each pair washed out.
  const hue = (Math.floor((index - 10) / 10) * 15) % 360;
  const shade = [1, 0.8, 0.6, 0.5, 0.3][Math.floor(((index - 10) % 10) / 2)];
  const saturation = index % 2 === 1 ? 0.5 : 1;
  const c = shade * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = shade - c;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return hex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

// ---------------------------------------------------------------------------
// Entities to paths

function entityPaths(entity: Entity, tolerance: number): Path[] {
  switch (entity.type) {
    case 'LINE':
      return [{ points: [[num(entity, 10, 0), num(entity, 20, 0)], [num(entity, 11, 0), num(entity, 21, 0)]], closed: false }];
    case 'LWPOLYLINE': {
      const corners = entity.corners ?? [];
      return [polyline(corners.map(([x, y]): Vec2 => [x, y]), corners.map((c) => c[2]), (num(entity, 70, 0) & 1) !== 0, tolerance)];
    }
    case 'POLYLINE': {
      const flags = num(entity, 70, 0);
      // Polygon and polyface meshes (bits 16 and 64) and 3D polylines (bit 8) are not outlines.
      if (flags & (8 | 16 | 64)) return [];
      const vertices = (entity.vertices ?? []).filter((v) => (num(v, 70, 0) & (16 | 64 | 128)) === 0);
      const points = vertices.map((v): Vec2 => [num(v, 10, 0), num(v, 20, 0)]);
      const bulges = vertices.map((v) => num(v, 42, 0));
      return [polyline(points, bulges, (flags & 1) !== 0, tolerance)];
    }
    case 'CIRCLE': {
      const r = num(entity, 40, 0);
      if (!(r > 0)) return [];
      return [{ points: arcPoints(num(entity, 10, 0), num(entity, 20, 0), r, r, 0, 0, TAU, tolerance, false), closed: true }];
    }
    case 'ARC': {
      const r = num(entity, 40, 0);
      if (!(r > 0)) return [];
      const start = num(entity, 50, 0) * RAD;
      const end = start + sweepOf(start, num(entity, 51, 360) * RAD);
      return [{ points: arcPoints(num(entity, 10, 0), num(entity, 20, 0), r, r, 0, start, end, tolerance, true), closed: false }];
    }
    case 'ELLIPSE': {
      const mx = num(entity, 11, 0);
      const my = num(entity, 21, 0);
      const major = Math.hypot(mx, my);
      const ratio = num(entity, 40, 1);
      if (!(major > 0 && ratio > 0)) return [];
      const start = num(entity, 41, 0);
      const sweep = sweepOf(start, num(entity, 42, TAU));
      const whole = sweep >= TAU - 1e-9;
      // With its normal along -Z the ellipse is gone round the other way.
      const turn = num(entity, 230, 1) < 0 ? -1 : 1;
      return [{ points: arcPoints(num(entity, 10, 0), num(entity, 20, 0), major, major * ratio, Math.atan2(my, mx), turn * start, turn * (start + (whole ? TAU : sweep)), tolerance, !whole), closed: whole }];
    }
    case 'SPLINE':
      return splinePaths(entity, tolerance);
    default:
      return [];
  }
}

/** How far round an arc goes counterclockwise from `start` to `end` (radians): in (0, 2π], a whole turn when the two are the same angle. */
function sweepOf(start: number, end: number): number {
  const sweep = end - start;
  if (sweep > 0 && sweep <= TAU) return sweep;
  // Whatever whole turns the file adds say nothing; a hair past a whole turn is a whole turn written with rounding.
  const rest = sweep % TAU;
  return rest > 1e-9 ? rest : rest + TAU;
}

/** A polyline whose segments may be arcs (bulge = tan of a quarter of the included angle). */
function polyline(points: Vec2[], bulges: number[], closed: boolean, tolerance: number): Path {
  const out: Polygon = [];
  const n = points.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    out.push(p);
    if (i >= last) break;
    const q = points[(i + 1) % n];
    const bulge = bulges[i] ?? 0;
    if (Math.abs(bulge) < 1e-9) continue;
    // The arc between p and q: included angle θ = 4·atan(bulge), positive counterclockwise.
    const theta = 4 * Math.atan(bulge);
    const chord = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!(chord > 0)) continue;
    const r = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
    const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    // The center sits off the chord's midpoint, on the left for a counterclockwise arc smaller than a half turn.
    const h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2))) * (Math.abs(theta) > Math.PI ? -1 : 1) * Math.sign(bulge);
    const nx = -(q[1] - p[1]) / chord;
    const ny = (q[0] - p[0]) / chord;
    const cx = mid[0] + h * nx;
    const cy = mid[1] + h * ny;
    const a0 = Math.atan2(p[1] - cy, p[0] - cx);
    const inner = arcPoints(cx, cy, r, r, 0, a0, a0 + theta, tolerance, true);
    // Without its endpoints, which are p and q.
    out.push(...inner.slice(1, -1));
  }
  return { points: out, closed };
}

/**
 * Points along an elliptical arc from angle `start` to `end` (radians, in the
 * ellipse's own frame, `end` may be below `start` for a clockwise arc), the
 * ellipse's major axis turned by `rotation`. With `ends`, the endpoints are
 * included; a whole turn leaves them out so that the contour does not repeat its first point.
 */
function arcPoints(cx: number, cy: number, rx: number, ry: number, rotation: number, start: number, end: number, tolerance: number, ends: boolean): Polygon {
  const perTurn = turnSegments(Math.max(rx, ry), tolerance);
  const sweep = end - start;
  const n = Math.max(1, Math.ceil((Math.abs(sweep) / TAU) * perTurn));
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const out: Polygon = [];
  const at = (a: number): Vec2 => {
    const ex = rx * Math.cos(a);
    const ey = ry * Math.sin(a);
    return [cx + cos * ex - sin * ey, cy + sin * ex + cos * ey];
  };
  const to = ends ? n : n - 1;
  for (let i = 0; i <= to; i++) out.push(at(start + (sweep * i) / n));
  return out;
}

/** A B-spline by its control points (de Boor), or a curve through its fit points when that is all the file gives. */
function splinePaths(entity: Entity, tolerance: number): Path[] {
  const flags = num(entity, 70, 0);
  const closed = (flags & 1) !== 0;
  const degree = Math.max(1, Math.round(num(entity, 71, 3)));
  // Each point costs the square of the degree to work out.
  if (degree > MAX_DEGREE) return [];
  const cx = nums(entity, 10);
  const cy = nums(entity, 20);
  const knots = nums(entity, 40);
  const weights = nums(entity, 41);
  if (cx.length >= 2 && knots.length >= cx.length + degree + 1) {
    const control = cx.map((x, i): Vec2 => [x, cy[i] ?? 0]);
    const w = control.map((_, i) => (Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 1));
    const t0 = knots[degree];
    const t1 = knots[knots.length - degree - 1];
    if (!(t1 > t0)) return [];
    // Enough samples that no chord strays further than the tolerance: estimated from the control polygon's length.
    let length = 0;
    for (let i = 1; i < control.length; i++) length += Math.hypot(control[i][0] - control[i - 1][0], control[i][1] - control[i - 1][1]);
    const n = Math.min(4000, Math.max(8 * control.length, Math.ceil(length / Math.sqrt(8 * tolerance * Math.max(length, 1e-9)) * 4)));
    const points: Polygon = [];
    for (let i = 0; i <= n; i++) points.push(deBoor(degree, knots, control, w, t0 + ((t1 - t0) * i) / n));
    return [{ points, closed }];
  }
  const fx = nums(entity, 11);
  const fy = nums(entity, 21);
  if (fx.length >= 2) return [{ points: catmullRom(fx.map((x, i): Vec2 => [x, fy[i] ?? 0]), closed, tolerance), closed }];
  return [];
}

/** The point of a rational B-spline at parameter t. */
function deBoor(degree: number, knots: number[], control: Vec2[], weights: number[], t: number): Vec2 {
  const n = control.length;
  // The knot span t lies in.
  let k = degree;
  while (k < n - 1 && t >= knots[k + 1]) k++;
  if (k >= n) k = n - 1;
  const d: [number, number, number][] = [];
  for (let j = 0; j <= degree; j++) {
    const idx = Math.min(n - 1, Math.max(0, j + k - degree));
    const w = weights[idx];
    d.push([control[idx][0] * w, control[idx][1] * w, w]);
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = j + k - degree;
      const left = knots[i] ?? 0;
      const right = knots[i + degree - r + 1] ?? 1;
      const alpha = right > left ? (t - left) / (right - left) : 0;
      d[j] = [(1 - alpha) * d[j - 1][0] + alpha * d[j][0], (1 - alpha) * d[j - 1][1] + alpha * d[j][1], (1 - alpha) * d[j - 1][2] + alpha * d[j][2]];
    }
  }
  const [x, y, w] = d[degree];
  return w !== 0 ? [x / w, y / w] : [x, y];
}

/** A smooth curve through the points, each span a Catmull-Rom segment sampled finely enough. */
function catmullRom(points: Vec2[], closed: boolean, tolerance: number): Polygon {
  const n = points.length;
  const out: Polygon = [];
  const spans = closed ? n : n - 1;
  const at = (i: number) => points[closed ? ((i % n) + n) % n : Math.min(n - 1, Math.max(0, i))];
  for (let s = 0; s < spans; s++) {
    const p0 = at(s - 1);
    const p1 = at(s);
    const p2 = at(s + 1);
    const p3 = at(s + 2);
    const length = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.min(200, Math.max(4, Math.ceil(length / Math.sqrt(8 * tolerance * Math.max(length, 1e-9)) * 2)));
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// Chaining

/**
 * Closed contours from the paths: those closed already, and chains of open
 * ones whose ends meet. Open chains that lead nowhere (construction lines,
 * dimension leaders) are dropped.
 */
export function chain(paths: Path[]): Polygon[] {
  const out: Polygon[] = [];
  const open: Polygon[] = [];
  for (const path of paths) {
    if (path.points.length < 2) continue;
    if (path.closed || near(path.points[0], path.points[path.points.length - 1])) {
      const contour = clean(path.points);
      if (contour) out.push(contour);
    } else open.push(path.points);
  }
  // The ends of the open paths on a grid twice as coarse as the join tolerance: whatever meets a point lies in
  // its cell or one of the eight around it. An entry is twice the path's index, plus one for its last point; a
  // cell holds them in rising order.
  const cells = new Map<number, { entries: number[]; from: number }>();
  const GRID = 2 * JOIN;
  const keyOf = (ix: number, iy: number): number => Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663);
  const endOf = (entry: number): Vec2 => (entry & 1 ? open[entry >> 1][open[entry >> 1].length - 1] : open[entry >> 1][0]);
  for (let i = 0; i < open.length; i++) {
    for (const entry of [2 * i, 2 * i + 1]) {
      const [x, y] = endOf(entry);
      const key = keyOf(Math.floor(x / GRID), Math.floor(y / GRID));
      const cell = cells.get(key);
      if (cell) cell.entries.push(entry);
      else cells.set(key, { entries: [entry], from: 0 });
    }
  }
  const used = new Array<boolean>(open.length).fill(false);
  /** The first unused path with an end at `tail`, its start before its end; -1 when there is none. */
  const meeting = (tail: Vec2): number => {
    let best = -1;
    const seen: number[] = [];
    const ix = Math.floor(tail[0] / GRID);
    const iy = Math.floor(tail[1] / GRID);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const key = keyOf(ix + dx, iy + dy);
        // Two cells may share a key; each is looked through once.
        if (seen.includes(key)) continue;
        seen.push(key);
        const cell = cells.get(key);
        if (!cell) continue;
        const { entries } = cell;
        while (cell.from < entries.length && used[entries[cell.from] >> 1]) cell.from++;
        for (let k = cell.from; k < entries.length; k++) {
          const entry = entries[k];
          if (best >= 0 && entry >= best) break;
          if (used[entry >> 1] || !near(endOf(entry), tail)) continue;
          best = entry;
          break;
        }
      }
    return best;
  };
  // Greedy: from each unused path, keep appending whichever path starts (or ends) where the chain ends.
  for (let s = 0; s < open.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const points: Polygon = [...open[s]];
    while (!near(points[0], points[points.length - 1])) {
      const entry = meeting(points[points.length - 1]);
      if (entry < 0) break;
      const candidate = open[entry >> 1];
      if (entry & 1) for (let k = candidate.length - 2; k >= 0; k--) points.push(candidate[k]);
      else for (let k = 1; k < candidate.length; k++) points.push(candidate[k]);
      used[entry >> 1] = true;
    }
    if (near(points[0], points[points.length - 1])) {
      const contour = clean(points);
      if (contour) out.push(contour);
    }
  }
  return out;
}

const near = (a: Vec2, b: Vec2): boolean => Math.abs(a[0] - b[0]) <= JOIN && Math.abs(a[1] - b[1]) <= JOIN;

/** Drops repeated points and the closing one; undefined if what is left encloses nothing. */
function clean(contour: Polygon): Polygon | undefined {
  const out: Polygon = [];
  for (const p of contour) {
    const last = out[out.length - 1];
    if (!last || !near(p, last)) out.push(p);
  }
  while (out.length > 1 && near(out[0], out[out.length - 1])) out.pop();
  return out.length >= 3 && Math.abs(signedArea(out)) >= MIN_AREA ? out : undefined;
}
