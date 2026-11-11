// The names and colors of the solids in a STEP file, read from its text. The
// library that reads the shapes (see importStep.ts) is built without the part
// that reads those, so a bracket drawn green in a CAD program and called
// "Bracket" came in gray and numbered. A STEP file is text, though, and says
// both in so many words: this reads the solids it lists, in the order it
// lists them, each with its name, its color, how many faces it has and where
// three of its corners are. The last two are for the reader to hold against
// the solids it built, so that a name is only ever given to the solid it is of.
import type { Vec3 } from '../model/types';

/** A solid as the file's text has it. */
export interface StepSolid {
  /** Its own name, or its product's; undefined when the file gives it none worth showing. */
  name?: string;
  /** `#rrggbb`. */
  color?: string;
  faces: number;
  /**
   * Up to three of its corners, in the file's own units and in the solid's own frame: a file that
   * places its shapes says where a solid is elsewhere, so only how far apart they are tells.
   */
  corners: Vec3[];
}

type Arg = string | number | { ref: number } | { word: string } | Arg[] | null;
interface Entity {
  type: string;
  args: Arg[];
}

const isRef = (a: Arg | undefined): a is { ref: number } => typeof a === 'object' && a !== null && !Array.isArray(a) && 'ref' in a;
const refs = (a: Arg | undefined): number[] => (Array.isArray(a) ? a.filter(isRef).map((r) => r.ref) : isRef(a) ? [a.ref] : []);

/** The kinds of entity gone through one by one; every other is only looked up when one of these names it. */
const LISTED = /^(MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|STYLED_ITEM|SHAPE_DEFINITION_REPRESENTATION|SHAPE_REPRESENTATION_RELATIONSHIP|[A-Z_]*SHAPE_REPRESENTATION)$/;

/** The file's entities by their number, each read from the text when it is asked for. */
class Entities {
  /** Where each entity's type begins in the text, by its number. */
  private readonly at = new Map<number, number>();
  readonly listed = new Map<string, number[]>();

  constructor(private readonly text: string) {
    // Every statement begins "#12 = " at the start of the file or after the ";" that ends the one before; a string may hold both.
    const head = /#(\d+)\s*=\s*([A-Z0-9_]*)/y;
    let i = text.indexOf('DATA;');
    i = i < 0 ? 0 : i + 5;
    const n = text.length;
    while (i < n) {
      while (i < n && text.charCodeAt(i) <= 32) i++;
      const c = text.charCodeAt(i);
      if (c === 35) {
        head.lastIndex = i;
        const m = head.exec(text);
        if (m) {
          const id = Number(m[1]);
          this.at.set(id, head.lastIndex - m[2].length);
          if (LISTED.test(m[2])) {
            const kind = /SHAPE_REPRESENTATION$/.test(m[2]) ? 'SHAPE_REPRESENTATION' : m[2];
            const list = this.listed.get(kind);
            if (list) list.push(id);
            else this.listed.set(kind, [id]);
          }
          i = head.lastIndex;
        }
      }
      // On to the ";" that ends the statement, past any string on the way.
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 39) {
          i++;
          while (i < n && (text.charCodeAt(i) !== 39 || text.charCodeAt(i + 1) === 39)) i += text.charCodeAt(i) === 39 ? 2 : 1;
        } else if (d === 59) break;
        i++;
      }
      i++;
    }
  }

  get(id: number): Entity | null {
    const start = this.at.get(id);
    if (start === undefined) return null;
    const { text } = this;
    let i = start;
    while (i < text.length && /[A-Z0-9_]/.test(text[i])) i++;
    const type = text.slice(start, i);
    // An entity of several kinds at once ("( A(...) B(...) )") is none of those read here.
    if (!type) return null;
    while (text.charCodeAt(i) <= 32) i++;
    if (text[i] !== '(') return null;
    const read = (): Arg[] => {
      const out: Arg[] = [];
      i++;
      for (;;) {
        while (text.charCodeAt(i) <= 32) i++;
        const c = text[i];
        if (c === undefined) return out;
        if (c === ')') {
          i++;
          return out;
        }
        if (c === ',') i++;
        else if (c === '(') out.push(read());
        else if (c === "'") {
          let s = '';
          i++;
          for (;;) {
            const end = text.indexOf("'", i);
            if (end < 0) {
              i = text.length;
              break;
            }
            s += text.slice(i, end);
            i = end + 1;
            if (text[i] !== "'") break;
            s += "'";
            i++;
          }
          out.push(decoded(s));
        } else if (c === '#') {
          let j = i + 1;
          while (text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++;
          out.push({ ref: Number(text.slice(i + 1, j)) });
          i = j;
        } else if (c === '$' || c === '*') {
          out.push(null);
          i++;
        } else if (c === '.') {
          const end = text.indexOf('.', i + 1);
          out.push({ word: text.slice(i + 1, end < 0 ? i + 1 : end) });
          i = end < 0 ? text.length : end + 1;
        } else {
          let j = i;
          while (j < text.length && !/[,()\s]/.test(text[j])) j++;
          const word = text.slice(i, j);
          // A number, or a typed value ("LENGTH_MEASURE(1.)"), whose own brackets are read as a list after it.
          const value = Number(word);
          out.push(word !== '' && Number.isFinite(value) ? value : { word });
          i = j === i ? i + 1 : j;
        }
      }
    };
    return { type, args: read() };
  }
}

/** A string as the file writes it, its letters outside ASCII, spelled out in hexadecimal as the standard has it, put back. */
function decoded(s: string): string {
  return s
    .replace(/\\X2\\((?:[0-9A-F]{4})+)\\X0\\/g, (_, hex: string) => (hex.match(/.{4}/g) ?? []).map((h) => String.fromCharCode(parseInt(h, 16))).join(''))
    .replace(/\\X\\([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\\/g, '\\');
}

/** The file as text. The standard keeps to ASCII; programs that write other letters straight in mostly write UTF-8, and the rest Latin-1. */
function textOf(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/** The names a writer gives when it was given none. */
const noName = (name: string): boolean => name.trim() === '' || /^(none|unnamed|solid|shape|body|open cascade step translator.*)$/i.test(name.trim());

const PREDEFINED: Record<string, string> = { red: '#ff0000', green: '#00ff00', blue: '#0000ff', yellow: '#ffff00', magenta: '#ff00ff', cyan: '#00ffff', black: '#000000', white: '#ffffff' };

/**
 * The solids of a STEP file as its text lists them, in that order; null when
 * the text holds none, or is too long to go through (the shapes are then read
 * without their names).
 */
export function stepSolids(bytes: Uint8Array): StepSolid[] | null {
  if (bytes.length > 64 * 1024 * 1024) return null;
  const all = new Entities(textOf(bytes));
  const breps = [...(all.listed.get('MANIFOLD_SOLID_BREP') ?? []), ...(all.listed.get('BREP_WITH_VOIDS') ?? [])].sort((a, b) => a - b);
  if (breps.length === 0) return null;

  /** The color a style comes to: the first one found through what it names, a few steps down. */
  const colorOf = (id: number, depth = 0): string | undefined => {
    const e = all.get(id);
    if (!e || depth > 8) return undefined;
    if (e.type === 'COLOUR_RGB') {
      const rgb = e.args.slice(1, 4).map((v) => (typeof v === 'number' ? Math.round(Math.min(1, Math.max(0, v)) * 255) : NaN));
      return rgb.length === 3 && rgb.every(Number.isFinite) ? `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}` : undefined;
    }
    if (e.type === 'DRAUGHTING_PRE_DEFINED_COLOUR') return typeof e.args[0] === 'string' ? PREDEFINED[e.args[0].toLowerCase()] : undefined;
    for (const arg of e.args) for (const next of refs(arg)) {
      const found = colorOf(next, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  /** What is given a color, by its number: a solid, or a face of one. */
  const styled = new Map<number, string>();
  for (const id of all.listed.get('STYLED_ITEM') ?? []) {
    const e = all.get(id);
    const item = e ? refs(e.args[2])[0] : undefined;
    if (!e || item === undefined) continue;
    const color = refs(e.args[1]).map((style) => colorOf(style)).find(Boolean);
    if (color && !styled.has(item)) styled.set(item, color);
  }

  // The product each shape belongs to, by the number of the representation that holds the shape.
  const productOf = new Map<number, string>();
  for (const id of all.listed.get('SHAPE_DEFINITION_REPRESENTATION') ?? []) {
    const e = all.get(id);
    const [definition] = refs(e?.args[0]);
    const [representation] = refs(e?.args[1]);
    if (definition === undefined || representation === undefined) continue;
    // Its shape, the definition that is of, that one's formation, and the product: each names the next.
    let at: Entity | null = all.get(definition);
    for (let step = 0; at && at.type !== 'PRODUCT' && step < 4; step++) {
      const next: number | undefined = at.args.flatMap(refs).find((r) => /^PRODUCT/.test(all.get(r)?.type ?? ''));
      at = next === undefined ? null : all.get(next);
    }
    if (at?.type !== 'PRODUCT') continue;
    const name = [at.args[1], at.args[0]].find((v): v is string => typeof v === 'string' && !noName(v));
    if (name) productOf.set(representation, name);
  }
  // A product's shape may be said in a second representation, tied to the first.
  const tied = new Map<number, number[]>();
  for (const id of all.listed.get('SHAPE_REPRESENTATION_RELATIONSHIP') ?? []) {
    const e = all.get(id);
    const [a] = refs(e?.args[2]);
    const [b] = refs(e?.args[3]);
    if (a === undefined || b === undefined) continue;
    tied.set(a, [...(tied.get(a) ?? []), b]);
    tied.set(b, [...(tied.get(b) ?? []), a]);
  }
  const holder = new Map<number, number>();
  for (const id of all.listed.get('SHAPE_REPRESENTATION') ?? []) for (const item of refs(all.get(id)?.args[1])) if (!holder.has(item)) holder.set(item, id);

  /** The corners of a face, through its bounds, their edges and those edges' ends; `into` takes those not in it yet, up to three. */
  const cornersOf = (face: number, into: Vec3[]): void => {
    let frontier = [face];
    for (let depth = 0; depth < 6 && frontier.length && into.length < 3; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        const e = all.get(id);
        if (!e) continue;
        if (e.type === 'VERTEX_POINT') {
          const point = all.get(refs(e.args[1])[0] ?? -1);
          const xyz = point?.type === 'CARTESIAN_POINT' && Array.isArray(point.args[1]) ? point.args[1] : null;
          if (xyz && xyz.length === 3 && xyz.every((v) => typeof v === 'number')) {
            const at = xyz as Vec3;
            if (into.length < 3 && !into.some((c) => c[0] === at[0] && c[1] === at[1] && c[2] === at[2])) into.push(at);
          }
          continue;
        }
        // Down the face's own outline only: not into the surface it lies on, nor the curve of an edge.
        if (e.type === 'ADVANCED_FACE' || e.type === 'FACE_BOUND' || e.type === 'FACE_OUTER_BOUND' || e.type === 'EDGE_LOOP' || e.type === 'VERTEX_LOOP') next.push(...refs(e.args[1]));
        else if (e.type === 'ORIENTED_EDGE') next.push(...refs(e.args[3]));
        else if (e.type === 'EDGE_CURVE') next.push(...refs(e.args[1]), ...refs(e.args[2]));
      }
      frontier = next;
    }
  };

  const solids: StepSolid[] = [];
  for (const id of breps) {
    const brep = all.get(id);
    if (!brep) return null;
    // Its outer shell, and for a solid with hollows inside it their shells as well.
    const shells = [...refs(brep.args[1]), ...refs(brep.args[2])];
    const faces = shells.flatMap((id) => {
      const shell = all.get(id);
      // A hollow is its shell seen from the other side: the shell is named, not written again.
      return refs((shell?.type === 'ORIENTED_CLOSED_SHELL' ? all.get(refs(shell.args[2])[0] ?? -1) : shell)?.args[1]);
    });
    const solid: StepSolid = { faces: faces.length, corners: [] };
    for (const face of faces) {
      if (solid.corners.length === 3) break;
      cornersOf(face, solid.corners);
    }
    const own = typeof brep.args[0] === 'string' && !noName(brep.args[0]) ? brep.args[0] : undefined;
    const held = holder.get(id);
    const name = own ?? (held === undefined ? undefined : (productOf.get(held) ?? (tied.get(held) ?? []).map((other) => productOf.get(other)).find(Boolean)));
    if (name) solid.name = name;
    // The solid's own color, or failing that the one most of its faces have.
    let color = styled.get(id);
    if (!color) {
      const counts = new Map<string, number>();
      for (const face of faces) {
        const c = styled.get(face);
        if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      color = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    }
    if (color) solid.color = color;
    solids.push(solid);
  }
  return solids;
}

/** What tells a solid the reader built from the others: how many faces it has, and where its corners are (three numbers each, in millimeters). */
export interface SolidMarks {
  faces: number;
  corners: number[];
}

/** The units a STEP file may be written in, in millimeters: the reader has turned the shapes into millimeters, the text has not. */
const UNITS = [1, 25.4, 1000, 10, 304.8, 0.001];

/**
 * Whether the solids the text lists are those the reader built, one for one
 * and in the same order. The text lists them in an order of its own, and a
 * file that places one shape several times lists it once: so they count as
 * the same only when there are as many of each and every solid of the text
 * is found in its part: corners as far from each other as the three the text
 * gives (a file that places its shapes moves them, but not their corners
 * apart), in one unit for the whole file; or, where the text gives fewer
 * than two corners, as many faces.
 */
export function sameSolids(said: StepSolid[], marks: SolidMarks[]): boolean {
  if (said.length !== marks.length) return false;
  const apart = (a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): number => Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]);
  // Each part's corners once, and no more of them than can be gone through pair by pair.
  const own = marks.map((mark) => {
    const seen = new Set<string>();
    const corners: number[] = [];
    for (let k = 0; k < mark.corners.length && corners.length < 3 * 1500; k += 3) {
      const key = `${mark.corners[k].toFixed(4)},${mark.corners[k + 1].toFixed(4)},${mark.corners[k + 2].toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      corners.push(mark.corners[k], mark.corners[k + 1], mark.corners[k + 2]);
    }
    return corners;
  });
  const same = (found: number, wanted: number): boolean => Math.abs(found - wanted) <= 1e-3 + 1e-6 * wanted;
  return UNITS.some((unit) =>
    said.every((solid, i) => {
      if (solid.corners.length < 2) return solid.faces === marks[i].faces;
      const corners = own[i];
      const [a, b, c] = solid.corners;
      const ab = apart(a, 0, b, 0) * unit;
      for (let u = 0; u < corners.length; u += 3) {
        for (let v = 0; v < corners.length; v += 3) {
          if (v === u || !same(apart(corners, u, corners, v), ab)) continue;
          if (!c) return true;
          const [ac, bc] = [apart(a, 0, c, 0) * unit, apart(b, 0, c, 0) * unit];
          for (let w = 0; w < corners.length; w += 3) if (w !== u && w !== v && same(apart(corners, u, corners, w), ac) && same(apart(corners, v, corners, w), bc)) return true;
        }
      }
      return false;
    }),
  );
}
