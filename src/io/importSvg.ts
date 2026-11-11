import { plural, tr } from '../i18n';
import type { OutlineShape, Polygon } from '../model/types';
import { applyTo, maxStretch, mul, signedArea, TOLERANCE, turnSegments } from './outline';
import type { Matrix } from './outline';
import { XmlScanner, xmlTree } from './xml';
import type { XmlElement } from './xml';

/** Segments per curve that is not straight, however small: imports are often scaled up afterwards. */
const MIN_CURVE = 4;
const MAX_CURVE = 1000;

/** Millimeters per CSS pixel, the size of a user unit unless the root element says otherwise. */
const PX = 25.4 / 96;
/** CSS pixels per unit. */
const UNITS: Record<string, number> = { '': 1, px: 1, mm: 96 / 25.4, cm: 960 / 25.4, in: 96, pt: 96 / 72, pc: 16 };

/** Points closer than this (mm) are one point. */
const MERGE = 1e-6;
/** Contours enclosing less than this (mm²) are lines or dots, not shapes. */
const MIN_AREA = 1e-6;

/** Elements whose content is not drawn where it is written, if at all. */
const SKIPPED = new Set(['defs', 'clipPath', 'mask', 'pattern', 'symbol', 'marker', 'metadata', 'foreignObject']);

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;

/** What an element hands down to its children. */
interface Frame {
  /** From the element's coordinates to millimeters, Y up. */
  transform: Matrix;
  evenodd: boolean;
  /** `visibility`, which a child may switch back on. */
  visible: boolean;
  /** `display: none`, or inside an element like <defs>: nothing below is drawn. */
  skip: boolean;
  /** The `fill` in force, as written. */
  fill?: string;
}

/** Above the outermost element: CSS pixels to millimeters, and SVG's Y axis (down) to ours (up). */
const ROOT: Frame = { transform: [PX, 0, 0, -PX, 0, 0], evenodd: false, visible: true, skip: false };

/**
 * SVG artwork as filled outlines in millimeters. Every subpath is closed and
 * treated as filled whatever its `fill` and `stroke` say: drawings made for a
 * laser cutter are hairline strokes with no fill, and they are the ones worth
 * extruding.
 *
 * A <use> draws the element it names again where it says (see `Copies`), and
 * the rules of a <style> block are applied where their selectors are plain:
 * a tag, classes, an id (see `styleRules`).
 *
 * Not supported: <text>, <image>, selectors that reach across elements, and
 * stroke widths. What a drawing holds of these is said in `warnings`, a
 * sentence each.
 */
export function parseSvg(bytes: Uint8Array, warnings: string[] = []): { shapes: OutlineShape[]; color?: string }[] {
  const scan = new XmlScanner(toUtf8(bytes));
  const stack: Frame[] = [];
  // The name of the element each frame is of, to match closing tags against, and how many of each name are open.
  const open: string[] = [];
  const openCount = new Map<string, number>();
  // Shapes by fill color, in the order the colors first appear; a shape without one goes under undefined.
  const parts = new Map<string | undefined, OutlineShape[]>();
  let count = 0;
  let sawRoot = false;
  // What is there to be seen but is not read: copies of what cannot be found, lettering, pictures, and style rules.
  const left = { use: 0, text: 0, image: 0, style: false, rules: 0 };
  // The copies and the style sheet need the document whole, which is read only when it has either.
  const whole = wholeOf(toUtf8(bytes));
  const sheet: Rule[] = [];
  if (whole.failed) left.style = whole.styled;
  else for (const text of whole.styles) left.rules += styleRules(text, sheet);

  /** One element that may have an outline: what it adds to the drawing, and what it leaves out. Returns the frame its children are under. */
  const draw = (name: string, attrs: Record<string, string>, frame: Frame, depth: number): Frame => {
    if (name === 'use') {
      const target = whole.failed ? undefined : whole.ids.get((attrs.href ?? attrs['xlink:href'] ?? '').replace(/^#/, ''));
      if (!target || depth >= MAX_USE_DEPTH) left.use++;
      else {
        // The copy stands where the <use> says, under whatever the <use> itself was given.
        const placed = { ...frame, transform: mul(frame.transform, [1, 0, 0, 1, lengthOr(attrs.x, 0), lengthOr(attrs.y, 0)]) };
        drawTree(target, placed, depth + 1, true);
      }
      return frame;
    }
    if (name === 'image') left.image++;
    else if (name === 'text') {
      left.text++;
      // Its lines and spans are part of it, not lettering of their own.
      return { ...frame, skip: true };
    }
    const contours = outline(name, attrs, frame.transform);
    if (contours.length) {
      if (++count > MAX_SHAPES) throw new Error(tr('This SVG has too many shapes to open.'));
      const color = cssColor(frame.fill);
      const list = parts.get(color) ?? [];
      list.push({ contours, evenodd: frame.evenodd });
      parts.set(color, list);
    }
    return frame;
  };

  /** An element a <use> names, and everything in it, drawn under `parent`. A <symbol> is drawn only as the thing named. */
  let copied = 0;
  const drawTree = (element: XmlElement, parent: Frame, depth: number, named: boolean): void => {
    // Counted whether or not it draws anything: a <use> of a <use> of nothing costs as much to go through.
    if (++copied > MAX_SHAPES) throw new Error(tr('This SVG has too many shapes to open.'));
    const name = element.name.replace(/^svg:/, '');
    if (SKIPPED.has(name) && !(named && name === 'symbol')) return;
    let frame = inherit(parent, name, element.attrs, sheet);
    if (frame.skip) return;
    if (frame.visible) frame = draw(name, element.attrs, frame, depth);
    if (frame.skip) return;
    for (const child of element.children) drawTree(child, frame, depth, false);
  };

  while (scan.next()) {
    const name = scan.name().replace(/^svg:/, '');
    if (scan.closing) {
      // Closes the nearest element of that name and whatever was left open inside it; one that closes nothing is passed over.
      if (!openCount.get(name)) continue;
      const at = open.lastIndexOf(name);
      for (let i = at; i < open.length; i++) openCount.set(open[i], openCount.get(open[i])! - 1);
      open.length = at;
      stack.length = at;
      continue;
    }
    const parent = stack[stack.length - 1] ?? ROOT;
    let frame = parent;
    if (!parent.skip) {
      if (SKIPPED.has(name)) frame = { ...parent, skip: true };
      else {
        const attrs = scan.attrs();
        frame = inherit(parent, name, attrs, sheet);
        if (name === 'svg') {
          frame.transform = mul(frame.transform, sawRoot ? innerViewport(attrs) : rootViewport(attrs));
          sawRoot = true;
        } else if (sawRoot && frame.visible && !frame.skip) frame = draw(name, attrs, frame, 0);
      }
    }
    if (scan.selfClosing) continue;
    stack.push(frame);
    open.push(name);
    openCount.set(name, (openCount.get(name) ?? 0) + 1);
  }

  if (!sawRoot) throw new Error(tr('This is not an SVG file.'));
  if (count === 0) throw new Error(tr('This SVG has no shapes that can be extruded.'));
  if (left.use) warnings.push(plural(left.use, '{n} copy of another shape (<use>) was left out.', '{n} copies of other shapes (<use>) were left out.'));
  if (left.text) warnings.push(plural(left.text, '{n} piece of text was left out. Turn text into paths in the drawing program.', '{n} pieces of text were left out. Turn text into paths in the drawing program.'));
  if (left.image) warnings.push(plural(left.image, '{n} picture was left out.', '{n} pictures were left out.'));
  if (left.style) warnings.push(tr('Its style sheet was not read: colors and hidden shapes set there are not applied.'));
  else if (left.rules) warnings.push(plural(left.rules, '{n} rule of its style sheet was not read: colors and hidden shapes set there are not applied.', '{n} rules of its style sheet were not read: colors and hidden shapes set there are not applied.'));
  return [...parts].map(([color, shapes]) => (color ? { shapes, color } : { shapes }));
}

const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  lime: '#00ff00',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  orange: '#ffa500',
  purple: '#800080',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  maroon: '#800000',
  navy: '#000080',
  teal: '#008080',
  olive: '#808000',
  brown: '#a52a2a',
  pink: '#ffc0cb',
  gold: '#ffd700',
};

/** `#rrggbb` from a CSS fill (`#rgb`, `#rrggbb`, `rgb(...)` or a common name); undefined for none, or anything else. */
export function cssColor(fill: string | undefined): string | undefined {
  if (!fill || fill === 'none' || fill === 'transparent') return undefined;
  const s = fill.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return `#${[...m[1]].map((c) => c + c).join('')}`;
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return `#${m[1]}`;
  m = /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)/.exec(s);
  if (m) {
    const channel = (v: string) => Math.round(Math.min(255, Math.max(0, v.endsWith('%') ? (parseFloat(v) * 255) / 100 : parseFloat(v))));
    return `#${[m[1], m[2], m[3]].map((v) => channel(v).toString(16).padStart(2, '0')).join('')}`;
  }
  return NAMED_COLORS[s];
}

/** The scanner reads UTF-8; the occasional UTF-16 file announces itself with a byte order mark. */
function toUtf8(bytes: Uint8Array): Uint8Array {
  const le = bytes[0] === 0xff && bytes[1] === 0xfe;
  const be = bytes[0] === 0xfe && bytes[1] === 0xff;
  if (!le && !be) return bytes;
  return new TextEncoder().encode(new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(bytes));
}

// ---------------------------------------------------------------------------
// Copies and style sheets

/** A <use> inside what a <use> draws, this deep at most: a drawing that names itself would otherwise never end. */
const MAX_USE_DEPTH = 8;
/** Shapes in one drawing, and elements gone through for its copies: a few lines of <use> upon <use> can ask for millions. */
const MAX_SHAPES = 100_000;

/** What reading a drawing whole gives: the elements that carry an id, for <use>, and the text of its style sheets. */
interface Whole {
  ids: Map<string, XmlElement>;
  styles: string[];
  /** The drawing could not be read whole; `styled` then says whether it has a style sheet that goes unread. */
  failed: boolean;
  styled: boolean;
}

const has = (bytes: Uint8Array, word: string): boolean => {
  const code = [...word].map((c) => c.charCodeAt(0));
  outer: for (let i = bytes.indexOf(code[0]); i >= 0; i = bytes.indexOf(code[0], i + 1)) {
    for (let k = 1; k < code.length; k++) if (bytes[i + k] !== code[k]) continue outer;
    return true;
  }
  return false;
};

/** The drawing read whole, if it has a <use> or a <style> to need it: most have neither, and are read in one pass without. */
function wholeOf(bytes: Uint8Array): Whole {
  const out: Whole = { ids: new Map(), styles: [], failed: false, styled: has(bytes, '<style') || has(bytes, ':style') };
  if (!out.styled && !has(bytes, '<use') && !has(bytes, ':use')) return out;
  let root: XmlElement | null;
  try {
    root = xmlTree(bytes);
  } catch {
    return { ...out, failed: true };
  }
  const walk = (element: XmlElement): void => {
    // The first of an id is the one meant, as in a browser.
    if (element.attrs.id && !out.ids.has(element.attrs.id)) out.ids.set(element.attrs.id, element);
    if (element.name.replace(/^svg:/, '') === 'style') out.styles.push(element.text);
    for (const child of element.children) walk(child);
  };
  if (root) walk(root);
  return out;
}

/** A rule of a style sheet whose selector is plain: a tag, classes and an id, any of them, on the one element. */
interface Rule {
  tag?: string;
  id?: string;
  classes: string[];
  /** An id outweighs any number of classes, a class any tag; of equals the later rule wins, so rules are kept in order. */
  weight: number;
  values: Record<string, string>;
}

const SELECTOR = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)$/;

/**
 * Adds the rules of a style sheet to `sheet`, in order. Returns how many
 * rules it could not read: at-rules, and selectors that say more than what
 * one element is (descendants, attributes, states).
 */
function styleRules(text: string, sheet: Rule[]): number {
  let unread = 0;
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of css.split('}')) {
    const brace = block.indexOf('{');
    if (brace < 0) continue;
    const values: Record<string, string> = {};
    for (const declaration of block.slice(brace + 1).split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) values[declaration.slice(0, colon).trim().toLowerCase()] = declaration.slice(colon + 1);
    }
    for (const selector of block.slice(0, brace).split(',')) {
      const match = SELECTOR.exec(selector.trim());
      if (!match || (!match[1] && !match[2])) {
        unread++;
        continue;
      }
      const rule: Rule = { classes: [], weight: 0, values };
      if (match[1] && match[1] !== '*') {
        rule.tag = match[1];
        rule.weight += 1;
      }
      for (const part of match[2].match(/[.#][\w-]+/g) ?? []) {
        if (part[0] === '#') {
          rule.id = part.slice(1);
          rule.weight += 100;
        } else {
          rule.classes.push(part.slice(1));
          rule.weight += 10;
        }
      }
      sheet.push(rule);
    }
  }
  return unread;
}

/** Whether a rule's selector takes this element. */
function takes(rule: Rule, element: string, attrs: Record<string, string>): boolean {
  if (rule.tag && rule.tag !== element) return false;
  if (rule.id && rule.id !== attrs.id) return false;
  if (rule.classes.length === 0) return true;
  const classes = (attrs.class ?? '').split(/\s+/);
  return rule.classes.every((c) => classes.includes(c));
}

// ---------------------------------------------------------------------------
// Attributes

// Written so that a run of digits can be read one way only: a number of thousands of digits followed by something
// that is not a length would otherwise be tried in as many ways as it has digits.
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const NUMBERS = new RegExp(NUMBER, 'g');
const LENGTH = new RegExp(`^\\s*(${NUMBER})\\s*([a-zA-Z%]*)\\s*$`);

const numbers = (s: string | undefined): number[] => (s?.match(NUMBERS) ?? []).map(Number);

/** A length in user units (CSS pixels); NaN if it is missing, a percentage or relative to a font. */
function length(s: string | undefined): number {
  const m = s === undefined ? null : LENGTH.exec(s);
  return m ? Number(m[1]) * (UNITS[m[2].toLowerCase()] ?? NaN) : NaN;
}

const lengthOr = (s: string | undefined, fallback: number): number => {
  const v = length(s);
  return Number.isFinite(v) ? v : fallback;
};

/** A property set by `style="..."` or, failing that, by the rules of the style sheet that take the element, or by the attribute of the same name. */
function property(element: string, attrs: Record<string, string>, name: string, sheet: Rule[]): string | undefined {
  let value = attrs[name];
  // Of the rules that take the element, the weightiest says; of two as weighty, the later.
  let weight = -1;
  for (const rule of sheet) {
    if (rule.weight < weight || rule.values[name] === undefined || !takes(rule, element, attrs)) continue;
    value = rule.values[name];
    weight = rule.weight;
  }
  if (attrs.style) {
    for (const declaration of attrs.style.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0 && declaration.slice(0, colon).trim().toLowerCase() === name) value = declaration.slice(colon + 1);
    }
  }
  return value?.replace(/!\s*important/i, '').trim().toLowerCase();
}

function inherit(parent: Frame, element: string, attrs: Record<string, string>, sheet: Rule[]): Frame {
  const frame = { ...parent };
  if (attrs.transform) frame.transform = mul(parent.transform, parseTransform(attrs.transform));
  const rule = property(element, attrs, 'fill-rule', sheet);
  if (rule === 'evenodd') frame.evenodd = true;
  else if (rule === 'nonzero') frame.evenodd = false;
  const visibility = property(element, attrs, 'visibility', sheet);
  if (visibility === 'hidden' || visibility === 'collapse') frame.visible = false;
  else if (visibility === 'visible') frame.visible = true;
  if (property(element, attrs, 'display', sheet) === 'none') frame.skip = true;
  const fill = property(element, attrs, 'fill', sheet);
  if (fill !== undefined && fill !== 'inherit') frame.fill = fill;
  return frame;
}

function parseTransform(s: string): Matrix {
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  // From the start of a word only, so that a long word with no bracket after it is gone through once.
  const re = /\b([a-zA-Z]+)\s*\(([^)]*)\)/g;
  for (let match = re.exec(s); match; match = re.exec(s)) {
    const a = numbers(match[2]);
    let t: Matrix | undefined;
    switch (match[1]) {
      case 'matrix':
        if (a.length >= 6) t = [a[0], a[1], a[2], a[3], a[4], a[5]];
        break;
      case 'translate':
        if (a.length >= 1) t = [1, 0, 0, 1, a[0], a[1] ?? 0];
        break;
      case 'scale':
        if (a.length >= 1) t = [a[0], 0, 0, a[1] ?? a[0], 0, 0];
        break;
      case 'rotate':
        if (a.length >= 1) {
          const cos = Math.cos(a[0] * RAD);
          const sin = Math.sin(a[0] * RAD);
          t = [cos, sin, -sin, cos, 0, 0];
          // About a center: move it to the origin, turn, move it back.
          if (a.length >= 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
        }
        break;
      case 'skewX':
        if (a.length >= 1) t = [1, 0, Math.tan(a[0] * RAD), 1, 0, 0];
        break;
      case 'skewY':
        if (a.length >= 1) t = [1, Math.tan(a[0] * RAD), 0, 1, 0, 0];
        break;
    }
    if (t) m = mul(m, t);
  }
  return m;
}

/** `viewBox`, if it is there and encloses something. */
function viewBox(attrs: Record<string, string>): number[] | undefined {
  const box = numbers(attrs.viewBox);
  return box.length === 4 && box[2] > 0 && box[3] > 0 ? box : undefined;
}

/** Maps a viewBox onto a viewport `width` x `height` (NaN when unknown) the way `preserveAspectRatio` asks. */
function fit(box: number[], width: number, height: number, attrs: Record<string, string>): Matrix {
  let sx = width / box[2];
  let sy = height / box[3];
  if (!(sx > 0) && !(sy > 0)) sx = sy = 1;
  else if (!(sx > 0)) sx = sy;
  else if (!(sy > 0)) sy = sx;
  const aspect = attrs.preserveAspectRatio ?? '';
  // Unless told to stretch, the drawing keeps its proportions and fits inside
  // the viewport (or covers it). Where it sits in the spare room is of no
  // interest: the caller recenters the result.
  if (!aspect.includes('none')) sx = sy = aspect.includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy);
  return [sx, 0, 0, sy, -box[0] * sx, -box[1] * sy];
}

/**
 * User units of the outermost <svg> to CSS pixels. With a physical size and a
 * viewBox the drawing says how big a user unit is; without, a user unit is a pixel.
 */
function rootViewport(attrs: Record<string, string>): Matrix {
  const box = viewBox(attrs);
  return box ? fit(box, length(attrs.width), length(attrs.height), attrs) : [1, 0, 0, 1, 0, 0];
}

/** A nested <svg> places its content at x, y and may rescale it. */
function innerViewport(attrs: Record<string, string>): Matrix {
  const place: Matrix = [1, 0, 0, 1, lengthOr(attrs.x, 0), lengthOr(attrs.y, 0)];
  const box = viewBox(attrs);
  return box ? mul(place, fit(box, length(attrs.width), length(attrs.height), attrs)) : place;
}

// ---------------------------------------------------------------------------
// Shapes

/** The closed contours of one element, in millimeters. Empty for elements that enclose no area. */
function outline(name: string, attrs: Record<string, string>, m: Matrix): Polygon[] {
  // Curves are flattened in the element's own coordinates, so the tolerance
  // has to be brought there: divide by the most the transform stretches anything.
  const stretch = maxStretch(m);
  if (!(stretch > 0) || !Number.isFinite(stretch)) return [];
  const tolerance = TOLERANCE / stretch;

  let contours: Polygon[];
  switch (name) {
    case 'path':
      contours = pathContours(attrs.d ?? '', tolerance);
      break;
    case 'rect':
      contours = rect(attrs, tolerance);
      break;
    case 'circle': {
      const r = lengthOr(attrs.r, 0);
      contours = ellipse(lengthOr(attrs.cx, 0), lengthOr(attrs.cy, 0), r, r, tolerance);
      break;
    }
    case 'ellipse': {
      // A missing radius means "the same as the other one".
      const rx = length(attrs.rx);
      const ry = length(attrs.ry);
      contours = ellipse(
        lengthOr(attrs.cx, 0),
        lengthOr(attrs.cy, 0),
        Number.isFinite(rx) ? rx : ry,
        Number.isFinite(ry) ? ry : rx,
        tolerance,
      );
      break;
    }
    case 'polygon':
    case 'polyline': {
      const p = numbers(attrs.points);
      const contour: Polygon = [];
      for (let i = 0; i + 1 < p.length; i += 2) contour.push([p[i], p[i + 1]]);
      contours = [contour];
      break;
    }
    default:
      // Groups, and everything that has no area of its own (<line>, <text>, <image>, ...).
      return [];
  }

  const out: Polygon[] = [];
  for (const contour of contours) {
    const cleaned = clean(contour.map((p) => applyTo(m, p)));
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/** Drops repeated points; undefined if what is left encloses nothing. */
function clean(contour: Polygon): Polygon | undefined {
  const out: Polygon = [];
  for (const p of contour) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return undefined;
    const last = out[out.length - 1];
    if (!last || Math.abs(p[0] - last[0]) > MERGE || Math.abs(p[1] - last[1]) > MERGE) out.push(p);
  }
  // A path that returns to its start before closing repeats its first point.
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first[0] - last[0]) > MERGE || Math.abs(first[1] - last[1]) > MERGE) break;
    out.pop();
  }
  return out.length >= 3 && Math.abs(signedArea(out)) >= MIN_AREA ? out : undefined;
}

function ellipse(cx: number, cy: number, rx: number, ry: number, tolerance: number): Polygon[] {
  if (!(rx > 0 && ry > 0)) return [];
  const n = turnSegments(Math.max(rx, ry), tolerance);
  const contour: Polygon = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    contour.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return [contour];
}

function rect(attrs: Record<string, string>, tolerance: number): Polygon[] {
  const x = lengthOr(attrs.x, 0);
  const y = lengthOr(attrs.y, 0);
  const w = lengthOr(attrs.width, 0);
  const h = lengthOr(attrs.height, 0);
  if (!(w > 0 && h > 0)) return [];
  // One corner radius stands in for the other when only one is given.
  let rx = length(attrs.rx);
  let ry = length(attrs.ry);
  if (!(rx >= 0)) rx = ry >= 0 ? ry : 0;
  if (!(ry >= 0)) ry = rx;
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);
  if (!(rx > 0 && ry > 0)) {
    return [
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
    ];
  }
  const contour: Polygon = [];
  const n = turnSegments(Math.max(rx, ry), tolerance) / 4;
  // Corner centers, in the order the outline visits them, each with the angle its arc starts at.
  const corners = [
    [x + w - rx, y + ry, -TAU / 4],
    [x + w - rx, y + h - ry, 0],
    [x + rx, y + h - ry, TAU / 4],
    [x + rx, y + ry, TAU / 2],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = start + (i / n) * (TAU / 4);
      contour.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
  }
  return [contour];
}

// ---------------------------------------------------------------------------
// Path data

const PATH_NUMBER = new RegExp(NUMBER, 'y');
/** How many numbers each command takes. */
const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/**
 * The subpaths of a path's `d` attribute as polygons, curves flattened to
 * `tolerance`. As the SVG specification asks, a path with an error in it is
 * drawn up to the error.
 */
function pathContours(d: string, tolerance: number): Polygon[] {
  const contours: Polygon[] = [];
  let contour: Polygon | undefined;
  let at = 0;
  // Current point, and the start of the current subpath.
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // Last control point, for the smooth commands, and the kind of curve it belongs to.
  let controlX = 0;
  let controlY = 0;
  let curve = '';
  let command = '';
  let moved = false;
  const args = [0, 0, 0, 0, 0, 0, 0];

  const skipSeparators = () => {
    for (; at < d.length; at++) {
      const c = d.charCodeAt(at);
      if (c !== 32 && c !== 44 && !(c >= 9 && c <= 13)) break;
    }
  };
  const number = (): number => {
    skipSeparators();
    PATH_NUMBER.lastIndex = at;
    const m = PATH_NUMBER.exec(d);
    if (!m) return NaN;
    at = PATH_NUMBER.lastIndex;
    return Number(m[0]);
  };
  // Arc flags are single digits and may run straight into the next number: "a1 1 0 01.5 0".
  const flag = (): number => {
    skipSeparators();
    const c = d.charCodeAt(at);
    if (c !== 48 && c !== 49) return NaN;
    at++;
    return c - 48;
  };
  // After "Z" the next subpath starts where the closed one did, even without an "M".
  const begin = () => (contour ??= [[x, y]]);
  const lineTo = (nx: number, ny: number) => {
    begin().push([nx, ny]);
    x = nx;
    y = ny;
  };

  for (;;) {
    skipSeparators();
    if (at >= d.length) break;
    const c = d[at];
    if (/[a-zA-Z]/.test(c)) {
      command = c;
      at++;
    } else if (command === '' || command === 'Z' || command === 'z') break;
    const lower = command.toLowerCase();
    const arity = ARITY[lower];
    // Path data must open with a move.
    if (arity === undefined || (!moved && lower !== 'm')) break;
    let ok = true;
    for (let i = 0; i < arity; i++) {
      args[i] = lower === 'a' && (i === 3 || i === 4) ? flag() : number();
      if (Number.isNaN(args[i])) ok = false;
    }
    if (!ok) break;
    // Relative commands measure from the current point.
    const relative = command === lower;
    const ox = relative ? x : 0;
    const oy = relative ? y : 0;
    const previous = curve;
    curve = '';

    switch (lower) {
      case 'm':
        if (contour) contours.push(contour);
        x = startX = ox + args[0];
        y = startY = oy + args[1];
        contour = [[x, y]];
        moved = true;
        // Further coordinate pairs after a move are lines.
        command = relative ? 'l' : 'L';
        break;
      case 'z':
        if (contour) contours.push(contour);
        contour = undefined;
        x = startX;
        y = startY;
        break;
      case 'l':
        lineTo(ox + args[0], oy + args[1]);
        break;
      case 'h':
        lineTo(ox + args[0], y);
        break;
      case 'v':
        lineTo(x, oy + args[0]);
        break;
      case 'c':
      case 's': {
        let i = 0;
        let x1 = x;
        let y1 = y;
        if (lower === 'c') {
          x1 = ox + args[i++];
          y1 = oy + args[i++];
        } else if (previous === 'c') {
          // Smooth: the first control point mirrors the previous curve's last.
          x1 = 2 * x - controlX;
          y1 = 2 * y - controlY;
        }
        const x2 = ox + args[i++];
        const y2 = oy + args[i++];
        const nx = ox + args[i++];
        const ny = oy + args[i++];
        cubic(begin(), x, y, x1, y1, x2, y2, nx, ny, tolerance);
        controlX = x2;
        controlY = y2;
        curve = 'c';
        x = nx;
        y = ny;
        break;
      }
      case 'q':
      case 't': {
        let i = 0;
        let x1 = x;
        let y1 = y;
        if (lower === 'q') {
          x1 = ox + args[i++];
          y1 = oy + args[i++];
        } else if (previous === 'q') {
          x1 = 2 * x - controlX;
          y1 = 2 * y - controlY;
        }
        const nx = ox + args[i++];
        const ny = oy + args[i++];
        // The same curve as a cubic, to flatten it with the same code.
        cubic(
          begin(),
          x,
          y,
          x + ((x1 - x) * 2) / 3,
          y + ((y1 - y) * 2) / 3,
          nx + ((x1 - nx) * 2) / 3,
          ny + ((y1 - ny) * 2) / 3,
          nx,
          ny,
          tolerance,
        );
        controlX = x1;
        controlY = y1;
        curve = 'q';
        x = nx;
        y = ny;
        break;
      }
      case 'a': {
        const nx = ox + args[5];
        const ny = oy + args[6];
        arc(begin(), x, y, args[0], args[1], args[2] * RAD, args[3] !== 0, args[4] !== 0, nx, ny, tolerance);
        x = nx;
        y = ny;
        break;
      }
    }
  }
  if (contour) contours.push(contour);
  return contours;
}

/** Appends a cubic Bézier from (x0, y0), which is already there, as line segments. */
function cubic(
  out: Polygon,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tolerance: number,
): void {
  // Many drawings write their straight edges as curves, with the control
  // points on the chord; those need no extra points.
  const dx = x3 - x0;
  const dy = y3 - y0;
  const chord = dx * dx + dy * dy;
  const along1 = (x1 - x0) * dx + (y1 - y0) * dy;
  const along2 = (x2 - x0) * dx + (y2 - y0) * dy;
  const off = Math.max(Math.abs((x1 - x0) * dy - (y1 - y0) * dx), Math.abs((x2 - x0) * dy - (y2 - y0) * dx));
  const onChord = (along: number) => along >= 0 && along <= chord;
  const straight = chord > 0 && off <= tolerance * 0.01 * Math.sqrt(chord) && onChord(along1) && onChord(along2);
  // n even steps in the parameter stray from the curve by at most
  // max|B''| / (8·n²), and the second derivative of a cubic is at most six
  // times the larger second difference of its control points.
  const bend = Math.max(Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3));
  const exact = Math.ceil(Math.sqrt((0.75 * bend) / tolerance));
  const n = straight ? 1 : Math.min(MAX_CURVE, Math.max(MIN_CURVE, exact || 0));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const e = t * t * t;
    out.push([a * x0 + b * x1 + c * x2 + e * x3, a * y0 + b * y1 + c * y2 + e * y3]);
  }
  out.push([x3, y3]);
}

/** Appends an elliptical arc from (x0, y0), which is already there, in SVG's endpoint form. */
function arc(
  out: Polygon,
  x0: number,
  y0: number,
  rx: number,
  ry: number,
  rotation: number,
  large: boolean,
  sweep: boolean,
  x1: number,
  y1: number,
  tolerance: number,
): void {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (x0 === x1 && y0 === y1) return;
  if (rx === 0 || ry === 0) {
    out.push([x1, y1]);
    return;
  }
  // Conversion to center form, from the implementation notes of the SVG specification.
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = (x0 - x1) / 2;
  const dy = (y0 - y1) / 2;
  const px = cos * dx + sin * dy;
  const py = -sin * dx + cos * dy;
  // Radii too small to span the endpoints are scaled up until they just do.
  const lambda = (px * px) / (rx * rx) + (py * py) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const denominator = rx * rx * py * py + ry * ry * px * px;
  const k = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - denominator) / denominator));
  const cxp = (k * rx * py) / ry;
  const cyp = (-k * ry * px) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x1) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y1) / 2;
  const start = Math.atan2((py - cyp) / ry, (px - cxp) / rx);
  let delta = Math.atan2((-py - cyp) / ry, (-px - cxp) / rx) - start;
  if (sweep && delta < 0) delta += TAU;
  else if (!sweep && delta > 0) delta -= TAU;

  // Points at the multiples of the step that lie strictly inside the arc, in the direction it runs.
  const step = (TAU / turnSegments(Math.max(rx, ry), tolerance)) * Math.sign(delta);
  const first = Math.floor(start / step + 1e-9) + 1;
  const last = Math.ceil((start + delta) / step - 1e-9) - 1;
  // Endpoints a rounding error apart leave no angle to sweep: the step is then
  // zero and the bounds infinite, and the loop would never end.
  if (!(Math.abs(delta) > 0) || !Number.isFinite(step) || step === 0 || !Number.isFinite(first) || !Number.isFinite(last)) {
    out.push([x1, y1]);
    return;
  }
  for (let i = first; i <= last; i++) {
    const ex = rx * Math.cos(i * step);
    const ey = ry * Math.sin(i * step);
    out.push([cx + cos * ex - sin * ey, cy + sin * ex + cos * ey]);
  }
  out.push([x1, y1]);
}
