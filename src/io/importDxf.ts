// DXF drawings as filled outlines, the way SVG comes in: lines, polylines
// (with bulges), circles, arcs, ellipses and splines are flattened, chained
// end to end into closed contours, and grouped by color. Blocks placed with
// INSERT are expanded. Units follow $INSUNITS; a drawing that gives none is
// taken to be in millimeters.
//
// Not read: text, dimensions, hatches, 3D entities, and the paper space.
import type { OutlineShape, Polygon, Vec2 } from '../model/types';
import { signedArea } from './outline';

/** How far a flattened curve may stray from the true one, in mm. */
const TOLERANCE = 0.02;
/** Segments per full turn of an arc, however small or large. */
const MIN_TURN = 24;
const MAX_TURN = 1440;
/** Endpoints closer than this (mm) are joined. */
const JOIN = 0.01;
/** Contours enclosing less than this (mm²) are lines or dots, not shapes. */
const MIN_AREA = 1e-6;
/** Blocks within blocks, past which an INSERT is ignored rather than followed forever. */
const MAX_NESTING = 8;
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
  12: 1e-6,
  13: 1e-3,
  14: 100,
  15: 10_000,
  16: 100_000,
};

/** x' = a·x + c·y + e, y' = b·x + d·y + f. */
type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number];
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const applyTo = (m: Matrix, [x, y]: Vec2): Vec2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** One entity: the group codes it was written with, each kept in order of appearance. */
interface Entity {
  type: string;
  /** Code → every value given for it, in order. */
  codes: Map<number, string[]>;
  /** A POLYLINE's vertices. */
  vertices?: Entity[];
}

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
  const draw = (list: Entity[], m: Matrix, inherited: string | undefined, depth: number) => {
    for (const entity of list) {
      const color = entityColor(entity, layers, inherited);
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
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < columns; c++) {
            const at = mul(mul(m, mul([1, 0, 0, 1, c * dx * cos - r * dy * sin, c * dx * sin + r * dy * cos], place)), offset);
            draw(block.entities, at, color, depth + 1);
          }
        continue;
      }
      // Curves are flattened in drawing units, so the tolerance is brought there.
      const stretch = maxStretch(m);
      if (!(stretch > 0) || !Number.isFinite(stretch)) continue;
      for (const path of entityPaths(entity, TOLERANCE / stretch)) {
        const points = path.points.map((p) => applyTo(m, p));
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
  if (bytes.length >= 22 && bytes[0] === 65 && bytes[1] === 117 && bytes[21] === 26) throw new Error('Binary DXF files cannot be imported. Save the drawing as ASCII DXF.');
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
      const xs = nums(entity, 10);
      const ys = nums(entity, 20);
      const bulges = bulgesOf(entity, xs.length);
      return [polyline(xs.map((x, i): Vec2 => [x, ys[i] ?? 0]), bulges, (num(entity, 70, 0) & 1) !== 0, tolerance)];
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
      let end = num(entity, 51, 360) * RAD;
      while (end <= start) end += TAU;
      return [{ points: arcPoints(num(entity, 10, 0), num(entity, 20, 0), r, r, 0, start, end, tolerance, true), closed: false }];
    }
    case 'ELLIPSE': {
      const mx = num(entity, 11, 0);
      const my = num(entity, 21, 0);
      const major = Math.hypot(mx, my);
      const ratio = num(entity, 40, 1);
      if (!(major > 0 && ratio > 0)) return [];
      const start = num(entity, 41, 0);
      let end = num(entity, 42, TAU);
      while (end <= start) end += TAU;
      const whole = end - start >= TAU - 1e-9;
      return [{ points: arcPoints(num(entity, 10, 0), num(entity, 20, 0), major, major * ratio, Math.atan2(my, mx), start, whole ? start + TAU : end, tolerance, !whole), closed: whole }];
    }
    case 'SPLINE':
      return splinePaths(entity, tolerance);
    default:
      return [];
  }
}

/** A vertex's bulge is written after it (42), so the bulges are matched to vertices by the order of the codes. */
function bulgesOf(entity: Entity, count: number): number[] {
  const bulges = new Array<number>(count).fill(0);
  const explicit = nums(entity, 42);
  // LWPOLYLINE repeats 10/20/(42) per vertex; when every vertex carries a bulge they line up, and
  // when only some do the file cannot be read exactly here: take them in order, which is right for the common cases.
  for (let i = 0; i < Math.min(count, explicit.length); i++) bulges[i] = explicit[i];
  return bulges;
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
  const radius = Math.max(rx, ry);
  const step = tolerance < radius ? 2 * Math.acos(1 - tolerance / radius) : Math.PI;
  const perTurn = Math.ceil(Math.min(Math.max(TAU / step, MIN_TURN), MAX_TURN) / 4) * 4;
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

/** Largest factor by which the transform lengthens a segment (its greatest singular value). */
function maxStretch(m: Matrix): number {
  const p = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3]) / 2;
  const q = (m[0] * m[0] + m[1] * m[1] - m[2] * m[2] - m[3] * m[3]) / 2;
  const r = m[0] * m[2] + m[1] * m[3];
  return Math.sqrt(p + Math.hypot(q, r));
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
  // Greedy: from each unused path, keep appending whichever path starts (or ends) where the chain ends.
  const used = new Array<boolean>(open.length).fill(false);
  for (let s = 0; s < open.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const points: Polygon = [...open[s]];
    let extended = true;
    while (extended && !near(points[0], points[points.length - 1])) {
      extended = false;
      const tail = points[points.length - 1];
      for (let i = 0; i < open.length; i++) {
        if (used[i]) continue;
        const candidate = open[i];
        if (near(candidate[0], tail)) points.push(...candidate.slice(1));
        else if (near(candidate[candidate.length - 1], tail)) points.push(...candidate.slice(0, -1).reverse());
        else continue;
        used[i] = true;
        extended = true;
        break;
      }
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
