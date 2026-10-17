// Features shared by most rotating parts: shaft bore, hub and set screws.
import { arc, arcSegments, circle, regularPolygon, TAU } from './math2d';
import { cylinder, difference, extrude, rotate, translate, union } from './types';
import type { Quality, Shape2D, Solid, Vec2 } from './types';
import { num, str } from './generators/types';
import type { ParamDef, ParamGroup, Params } from './generators/types';

/** Which way a helix winds: the one choice every threaded or helical part offers, in the same words. */
export const handParam: ParamDef = {
  type: 'select',
  key: 'hand',
  label: 'Hand',
  default: 'right',
  help: 'Which way the helix winds. Right-handed is the usual thread; a helical gear and its mate have opposite hands.',
  options: [
    { value: 'right', label: 'Right-handed' },
    { value: 'left', label: 'Left-handed' },
  ],
};
export const isLeftHanded = (p: Params): boolean => str(p, 'hand') === 'left';

export interface BoreDefaults {
  type?: 'none' | 'round' | 'd' | 'hex' | 'keyway';
  diameter?: number;
  flat?: number;
}

export function boreGroup(d: BoreDefaults = {}): ParamGroup {
  const has = (p: Params) => p.boreType !== 'none';
  return {
    title: 'Bore',
    params: [
      {
        type: 'select',
        key: 'boreType',
        label: 'Shape',
        default: d.type ?? 'round',
        options: [
          { value: 'none', label: 'None' },
          { value: 'round', label: 'Round' },
          { value: 'd', label: 'D-shaft' },
          { value: 'hex', label: 'Hex' },
          { value: 'keyway', label: 'Round + keyway' },
        ],
      },
      {
        type: 'number',
        key: 'boreDiameter',
        label: 'Diameter',
        help: 'Shaft diameter. For a hex bore this is the distance across flats.',
        default: d.diameter ?? 5,
        min: 1,
        max: 100,
        step: 0.1,
        unit: 'mm',
        visible: has,
      },
      {
        type: 'number',
        key: 'boreFlat',
        label: 'D-flat thickness',
        help: 'Shaft thickness measured from the flat to the opposite side (4.5 mm on a NEMA 17 shaft).',
        default: d.flat ?? 4.5,
        min: 0.5,
        max: 100,
        step: 0.1,
        unit: 'mm',
        visible: (p) => p.boreType === 'd',
      },
      {
        type: 'number',
        key: 'keyWidth',
        label: 'Key width',
        default: 2,
        min: 0.5,
        max: 30,
        step: 0.1,
        unit: 'mm',
        visible: (p) => p.boreType === 'keyway',
      },
      {
        type: 'number',
        key: 'keyDepth',
        label: 'Key depth',
        help: 'Depth of the keyway measured from the bore surface.',
        default: 1,
        min: 0.2,
        max: 20,
        step: 0.1,
        unit: 'mm',
        visible: (p) => p.boreType === 'keyway',
      },
      {
        type: 'number',
        key: 'boreClearance',
        label: 'Fit clearance',
        help: 'Added to the bore size to compensate for printer shrinkage. 0.1–0.3 mm is typical for FDM.',
        default: 0.2,
        min: 0,
        max: 1,
        step: 0.05,
        unit: 'mm',
        visible: has,
      },
    ],
  };
}

export interface HubDefaults {
  height?: number;
  diameter?: number;
  setScrews?: number;
  setScrewDiameter?: number;
}

export function hubGroup(d: HubDefaults = {}): ParamGroup {
  const has = (p: Params) => num(p, 'hubHeight') > 0;
  return {
    title: 'Hub',
    params: [
      {
        type: 'number',
        key: 'hubHeight',
        label: 'Height',
        help: 'Set to 0 for no hub.',
        default: d.height ?? 0,
        min: 0,
        max: 100,
        step: 0.5,
        unit: 'mm',
      },
      {
        type: 'number',
        key: 'hubDiameter',
        label: 'Diameter',
        default: d.diameter ?? 12,
        min: 2,
        max: 200,
        step: 0.5,
        unit: 'mm',
        visible: has,
      },
      {
        type: 'number',
        key: 'setScrews',
        label: 'Set screws',
        help: 'Radial holes through the hub. The first lines up with the D-flat / keyway; a second one sits 90° from it.',
        default: d.setScrews ?? 0,
        min: 0,
        max: 4,
        step: 1,
        integer: true,
        visible: has,
      },
      {
        type: 'number',
        key: 'setScrewDiameter',
        label: 'Set screw hole',
        help: 'Hole diameter: use the tap-drill size (2.5 mm for M3) to cut threads directly into the plastic.',
        default: d.setScrewDiameter ?? 2.8,
        min: 1,
        max: 12,
        step: 0.1,
        unit: 'mm',
        visible: (p) => has(p) && num(p, 'setScrews') > 0,
      },
    ],
  };
}

/** Cross-section of the bore, or null when the part is solid. The D-flat and keyway face +X. */
export function boreShape(p: Params, q: Quality): Shape2D | null {
  const type = str(p, 'boreType');
  if (type === 'none') return null;
  const c = num(p, 'boreClearance');
  const r = (num(p, 'boreDiameter') + c) / 2;
  const n = Math.max(24, arcSegments(q, TAU));
  if (type === 'hex') return [regularPolygon(6, r)];
  if (type === 'd') {
    const xf = num(p, 'boreFlat') + c / 2 - r; // x of the flat (shaft spans -r .. xf)
    if (xf >= r || xf <= -r) return [circle(r, n)];
    const phi = Math.acos(xf / r);
    return [arc(0, 0, r, phi, TAU - phi, n)];
  }
  if (type === 'keyway') {
    const w = Math.min(num(p, 'keyWidth') + c, 1.9 * r);
    const top = r + num(p, 'keyDepth') + c / 2;
    const phi = Math.asin(w / 2 / r);
    const pts: Vec2[] = arc(0, 0, r, phi, TAU - phi, n);
    pts.push([top, -w / 2], [top, w / 2]);
    return [pts];
  }
  return [circle(r, n)];
}

/** Largest radius reached by the bore cut-out (used for sanity warnings). */
export function boreRadius(p: Params): number {
  const type = str(p, 'boreType');
  if (type === 'none') return 0;
  const r = (num(p, 'boreDiameter') + num(p, 'boreClearance')) / 2;
  if (type === 'hex') return r / Math.cos(Math.PI / 6);
  if (type === 'keyway') return r + num(p, 'keyDepth');
  return r;
}

/**
 * Adds the hub on top of `body` (which spans zBottom..zTop), then cuts the bore
 * through everything and drills the set screw holes. `outerRadius` is the body's
 * reach from the axis: a bore that would swallow the body and the hub is left out.
 */
export function addHubAndBore(
  body: Solid,
  zBottom: number,
  zTop: number,
  p: Params,
  q: Quality,
  warnings: string[],
  outerRadius = Infinity,
): { solid: Solid; height: number } {
  const hubH = num(p, 'hubHeight');
  const hubR = num(p, 'hubDiameter') / 2;
  let solid = body;
  let top = zTop;
  const cuts: Solid[] = [];
  if (boreRadius(p) >= Math.max(outerRadius, hubH > 0 ? hubR : 0)) {
    warnings.push('The bore is wider than the part, so it was left out.');
    p = { ...p, boreType: 'none' };
  }

  if (hubH > 0) {
    const embed = Math.min(0.05, (zTop - zBottom) / 2);
    const segs = Math.max(32, arcSegments(q, TAU));
    solid = union(solid, translate(cylinder(hubR, hubH + embed, segs), [0, 0, zTop - embed]));
    top = zTop + hubH;
    if (boreRadius(p) >= hubR - 0.4) warnings.push('The hub wall around the bore is very thin.');

    const count = Math.round(num(p, 'setScrews'));
    const sd = num(p, 'setScrewDiameter');
    if (count > 0) {
      if (hubH < sd + 1) {
        warnings.push('The hub is too short for the set screw holes; they were skipped.');
      } else {
        // Two set screws sit 90° apart (the usual pulley arrangement); more are spaced evenly.
        const step = count === 2 ? 90 : 360 / count;
        for (let i = 0; i < count; i++) {
          const hole = translate(rotate(cylinder(sd / 2, hubR + 1, 24), [0, 90, 0]), [0, 0, zTop + hubH / 2]);
          cuts.push(rotate(hole, [0, 0, step * i]));
        }
      }
    }
  }

  const bore = boreShape(p, q);
  if (bore) cuts.push(translate(extrude(bore, top - zBottom + 2), [0, 0, zBottom - 1]));
  return { solid: difference(solid, ...cuts), height: top - zBottom };
}
