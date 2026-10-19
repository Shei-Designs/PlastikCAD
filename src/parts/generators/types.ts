import type { Quality, Shape2D, Solid } from '../types';

export type ParamValue = number | string | boolean;
export type Params = Record<string, ParamValue>;

interface BaseParam {
  key: string;
  label: string;
  /** Short explanation shown as a tooltip / hint. */
  help?: string;
  /** Hide the control when this returns false. */
  visible?: (p: Params) => boolean;
}

export interface NumberParam extends BaseParam {
  type: 'number';
  default: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  integer?: boolean;
}

export interface SelectParam extends BaseParam {
  type: 'select';
  default: string;
  options: { value: string; label: string }[];
}

export interface BooleanParam extends BaseParam {
  type: 'boolean';
  default: boolean;
}

export type ParamDef = NumberParam | SelectParam | BooleanParam;

export interface ParamGroup {
  title: string;
  params: ParamDef[];
}

export interface InfoItem {
  label: string;
  value: string;
}

export interface BuildResult {
  solid: Solid;
  /** 2D outline for DXF/SVG export and thumbnails, when the part has a meaningful one. */
  outline?: Shape2D;
  /** Derived dimensions worth showing to the user (pitch diameter, outside diameter, ...). */
  info: InfoItem[];
  /** Things that went wrong or were overridden; shown as warnings. */
  warnings: string[];
  /** Things worth knowing about the chosen model (what fits it, what to check); shown quietly. */
  notes?: string[];
}

export type Category = 'gears' | 'pulleys' | 'screws' | 'frames' | 'ducts' | 'boards' | 'fans' | 'cutouts' | 'motors';

export interface GeneratorDef {
  id: string;
  name: string;
  category: Category;
  summary: string;
  groups: ParamGroup[];
  build(p: Params, q: Quality): BuildResult;
}

export const num = (p: Params, key: string): number => {
  const v = Number(p[key]);
  if (!Number.isFinite(v)) throw new Error(`Parameter "${key}" is not a number`);
  return v;
};
export const str = (p: Params, key: string): string => String(p[key]);
export const bool = (p: Params, key: string): boolean => Boolean(p[key]);

/** Format a length for the info panel. */
export const mm = (v: number, digits = 2) => `${v.toFixed(digits)} mm`;
export const degrees = (v: number, digits = 2) => `${v.toFixed(digits)}°`;

export function defaultParams(def: GeneratorDef): Params {
  const p: Params = {};
  for (const g of def.groups) for (const d of g.params) p[d.key] = d.default;
  return p;
}

/** Coerce arbitrary (e.g. persisted) values onto the generator's schema. */
export function sanitizeParams(def: GeneratorDef, raw: Params | undefined): Params {
  const p = defaultParams(def);
  if (!raw) return p;
  // Designs saved before every helix shared one "hand" choice stored a left-handed switch instead.
  if (typeof raw.leftHanded === 'boolean' && raw.hand === undefined && 'hand' in p) raw = { ...raw, hand: raw.leftHanded ? 'left' : 'right' };
  for (const g of def.groups)
    for (const d of g.params) {
      const v = raw[d.key];
      if (v === undefined) continue;
      if (d.type === 'number') {
        let n = Number(v);
        if (!Number.isFinite(n)) continue;
        if (d.integer) n = Math.round(n);
        p[d.key] = Math.min(d.max, Math.max(d.min, n));
      } else if (d.type === 'select') {
        if (d.options.some((o) => o.value === v)) p[d.key] = v;
      } else {
        p[d.key] = Boolean(v);
      }
    }
  return p;
}
