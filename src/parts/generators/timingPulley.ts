// Timing belt pulleys. The groove shapes are parametric approximations of the
// belt standards (not the manufacturers' exact multi-arc forms): accurate in
// pitch, outside diameter and groove size, which is what matters at 3D printing
// tolerances. The fit can be tuned with the tooth clearance parameter.
import { tr } from '../../i18n';
import { addHubAndBore, boreGroup, boreRadius, boreShape, hubGroup } from '../features';
import type { BoreDefaults, HubDefaults } from '../features';
import { arc, arcN, arcSegments, dedupe, deg, polar, rotatePoint, TAU } from '../math2d';
import { extrude, revolve, union } from '../types';
import type { Polygon, Quality, Solid, Vec2 } from '../types';
import { lengthInfo, num, str } from './types';
import type { BuildResult, GeneratorDef, InfoItem, Params } from './types';
import { lengthFixed, lengthText, said } from '../../units';

interface BeltBase {
  label: string;
  pitch: number;
  /** Pitch line offset: the belt's pitch line runs this far outside the pulley OD. */
  plo: number;
  /** Groove depth below the OD. */
  depth: number;
  /** Flank angle measured from the groove centerline, degrees. */
  flankAngle: number;
  /** Radius rounding the corner between flank and OD. */
  tipFillet: number;
}

/** Curvilinear groove (GT2, HTD): a full-radius bottom with tangent flanks. */
interface RoundGroove extends BeltBase {
  kind: 'round';
  bottomRadius: number;
}

/** Trapezoidal groove (T, MXL, XL): flat bottom, straight flanks, filleted corners. */
interface FlatGroove extends BeltBase {
  kind: 'flat';
  /** Groove width at the OD (before the tip fillets). */
  width: number;
  rootFillet: number;
}

type BeltProfile = RoundGroove | FlatGroove;

const GT2: Record<string, BeltProfile> = {
  '2': { kind: 'round', label: 'GT2 2 mm', pitch: 2, plo: 0.254, depth: 0.76, bottomRadius: 0.555, flankAngle: 15, tipFillet: 0.15 },
  '3': { kind: 'round', label: 'GT2 3 mm', pitch: 3, plo: 0.381, depth: 1.169, bottomRadius: 0.85, flankAngle: 15, tipFillet: 0.25 },
  '5': { kind: 'round', label: 'GT2 5 mm', pitch: 5, plo: 0.5715, depth: 1.969, bottomRadius: 1.46, flankAngle: 15, tipFillet: 0.42 },
};

const HTD: Record<string, BeltProfile> = {
  '3M': { kind: 'round', label: 'HTD 3M', pitch: 3, plo: 0.381, depth: 1.28, bottomRadius: 0.87, flankAngle: 0, tipFillet: 0.28 },
  '5M': { kind: 'round', label: 'HTD 5M', pitch: 5, plo: 0.5715, depth: 2.16, bottomRadius: 1.49, flankAngle: 0, tipFillet: 0.45 },
  '8M': { kind: 'round', label: 'HTD 8M', pitch: 8, plo: 0.6858, depth: 3.6, bottomRadius: 2.55, flankAngle: 0, tipFillet: 0.75 },
};

const T_SERIES: Record<string, BeltProfile> = {
  'T2.5': { kind: 'flat', label: 'T2.5', pitch: 2.5, plo: 0.27, depth: 0.75, width: 1.75, flankAngle: 20, rootFillet: 0.2, tipFillet: 0.3 },
  T5: { kind: 'flat', label: 'T5', pitch: 5, plo: 0.425, depth: 1.25, width: 2.67, flankAngle: 20, rootFillet: 0.4, tipFillet: 0.6 },
  T10: { kind: 'flat', label: 'T10', pitch: 10, plo: 0.93, depth: 2.6, width: 5.3, flankAngle: 20, rootFillet: 0.6, tipFillet: 0.8 },
};

const IMPERIAL: Record<string, BeltProfile> = {
  MXL: { kind: 'flat', label: 'MXL (0.080")', pitch: 2.032, plo: 0.254, depth: 0.52, width: 1.32, flankAngle: 20, rootFillet: 0.13, tipFillet: 0.13 },
  XL: { kind: 'flat', label: 'XL (0.200")', pitch: 5.08, plo: 0.254, depth: 1.4, width: 3.05, flankAngle: 25, rootFillet: 0.4, tipFillet: 0.4 },
};

/** Extra height of the toothed section over the belt width. */
const BELT_MARGIN = 1;
/** Small step left between the OD and the start of the flange chamfer, so the two surfaces never coincide. */
const FLANGE_STEP = 0.1;

/**
 * Half of one groove, for a groove centered on the +X axis: points from the
 * bottom center (on the axis) up the +Y flank to where the tip fillet meets
 * the outside circle of radius `ro`. Null when the grooves would overlap.
 */
function halfGroove(b: BeltProfile, ro: number, clearance: number, halfPitch: number, q: Quality): Vec2[] | null {
  const phi = deg(b.flankAngle);
  const dir: Vec2 = [Math.cos(phi), Math.sin(phi)]; // along the flank, outward
  const n: Vec2 = [-Math.sin(phi), Math.cos(phi)]; // flank normal, into the material
  const xBottom = ro - (b.depth + clearance);

  // Root arc: center and radius of the arc joining the groove bottom to the flank.
  let rootR: number;
  let rootC: Vec2;
  if (b.kind === 'round') {
    rootR = b.bottomRadius + clearance;
    rootC = [xBottom + rootR, 0];
  } else {
    const hw = b.width / 2;
    const onOd: Vec2 = [Math.sqrt(ro * ro - hw * hw) + clearance * n[0], hw + clearance * n[1]];
    const center = (r: number): Vec2 => {
      const qx = onOd[0] - r * n[0];
      const qy = onOd[1] - r * n[1];
      return [xBottom + r, qy + ((xBottom + r - qx) / dir[0]) * dir[1]];
    };
    rootR = b.rootFillet;
    rootC = center(rootR);
    for (let i = 0; i < 24 && rootC[1] < 0; i++) {
      rootR *= 0.75;
      rootC = center(rootR);
    }
    if (rootC[1] < 0) {
      rootR = 0;
      rootC = center(0);
    }
    if (rootC[1] < 0) return null;
  }
  const flankStart: Vec2 = [rootC[0] + rootR * n[0], rootC[1] + rootR * n[1]];

  // Tip fillet: a circle tangent to the flank and (from inside) to the outside circle.
  const tip = (rt: number) => {
    const q0: Vec2 = [flankStart[0] + rt * n[0], flankStart[1] + rt * n[1]];
    const bq = q0[0] * dir[0] + q0[1] * dir[1];
    const disc = bq * bq - (q0[0] * q0[0] + q0[1] * q0[1] - (ro - rt) * (ro - rt));
    if (disc < 0) return null;
    const t = -bq + Math.sqrt(disc);
    if (t < 0) return null;
    const center: Vec2 = [q0[0] + t * dir[0], q0[1] + t * dir[1]];
    return { center, angle: Math.atan2(center[1], center[0]) };
  };
  // Shrink the fillet until a little land is left between neighboring grooves.
  const limit = halfPitch * 0.97;
  let rt = b.tipFillet;
  let fillet = tip(rt);
  for (let i = 0; i < 24 && (!fillet || fillet.angle > limit); i++) {
    rt *= 0.75;
    fillet = tip(rt);
  }
  if (!fillet || fillet.angle > limit) {
    rt = 0;
    fillet = tip(0);
  }
  if (!fillet || fillet.angle >= halfPitch) return null;

  const pts: Vec2[] = [[xBottom, 0]];
  const rootEnd = Math.PI / 2 + phi;
  if (rootR > 1e-6) {
    pts.push(...arc(rootC[0], rootC[1], rootR, Math.PI, rootEnd, arcN(q, rootR, Math.PI - rootEnd)));
  } else {
    pts.push(rootC);
  }
  if (rt > 1e-6) {
    const a0 = phi - Math.PI / 2;
    pts.push(...arc(fillet.center[0], fillet.center[1], rt, a0, fillet.angle, arcN(q, rt, fillet.angle - a0)));
  } else {
    pts.push(fillet.center);
  }
  return dedupe(pts, 1e-6);
}

/** CCW outline of the toothed section, or null when the grooves would overlap. */
function pulleyOutline(b: BeltProfile, teeth: number, clearance: number, q: Quality): Polygon | null {
  const ro = (teeth * b.pitch) / Math.PI / 2 - b.plo;
  const step = TAU / teeth;
  const half = halfGroove(b, ro, clearance, step / 2, q);
  if (!half) return null;
  const last = half[half.length - 1];
  const landStart = Math.atan2(last[1], last[0]);
  const landAngle = step - 2 * landStart;
  const landN = arcSegments(q, landAngle);

  const pts: Vec2[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    for (let k = half.length - 1; k >= 1; k--) pts.push(rotatePoint([half[k][0], -half[k][1]], a));
    for (const pt of half) pts.push(rotatePoint(pt, a));
    for (let j = 1; j < landN; j++) pts.push(polar(ro, a + landStart + (landAngle * j) / landN));
  }
  return dedupe(pts, 1e-6);
}

function buildPulley(profiles: Record<string, BeltProfile>, p: Params, q: Quality): BuildResult {
  const b = profiles[str(p, 'profile')];
  if (!b) throw new Error(`Unknown belt profile "${str(p, 'profile')}"`);
  const teeth = Math.round(num(p, 'teeth'));
  let clearance = num(p, 'toothClearance');
  const warnings: string[] = [];

  // Grooves grown by the clearance can meet; back the clearance off until a land is left between them.
  let toothed = pulleyOutline(b, teeth, clearance, q);
  while (!toothed && clearance > 0) {
    clearance = Math.max(0, Math.round((clearance - 0.01) * 100) / 100);
    toothed = pulleyOutline(b, teeth, clearance, q);
  }
  if (!toothed) throw new Error(tr('The belt grooves overlap: use more teeth.'));
  if (clearance < num(p, 'toothClearance')) warnings.push(said((unit) => tr('The tooth clearance was reduced to {clearance} so the grooves do not overlap.', { clearance: lengthFixed(clearance, unit, 2) })));

  const pitchD = (teeth * b.pitch) / Math.PI;
  const od = pitchD - 2 * b.plo;
  const ro = od / 2;
  const rootR = ro - b.depth - clearance;

  const mode = str(p, 'flanges');
  const hasBottom = mode === 'both' || mode === 'bottom';
  const hasTop = mode === 'both' || mode === 'top';
  const fh = num(p, 'flangeHeight');
  const fx = num(p, 'flangeExtra');
  const rf = ro + fx;
  const zTeeth = hasBottom ? fh : 0;
  const zTop = zTeeth + num(p, 'beltWidth') + BELT_MARGIN + (hasTop ? fh : 0);

  // The toothed prism runs the full height; the flanges are revolved discs with
  // a 45° chamfer on the belt side (which also lets the top one print unsupported).
  const parts: Solid[] = [extrude([toothed], zTop)];
  const run = Math.min(Math.max(fx - FLANGE_STEP, 0), fh);
  const segs = Math.max(48, arcSegments(q, TAU));
  if (hasBottom) {
    parts.push(revolve(dedupe([[0, 0], [rf, 0], [rf, fh - run], [rf - run, fh], [0, fh]]), segs));
  }
  if (hasTop) {
    const z0 = zTop - fh;
    parts.push(revolve(dedupe([[0, z0], [rf - run, z0], [rf, z0 + run], [rf, zTop], [0, zTop]]), segs));
  }

  if (boreRadius(p) > rootR - 1) warnings.push(said((unit) => tr('The bore leaves less than {least} of material below the belt grooves.', { least: lengthText(1, unit, 0) })));
  const { solid, height } = addHubAndBore(union(...parts), 0, zTop, p, q, warnings, hasBottom || hasTop ? rf : ro);

  const info: InfoItem[] = [
    lengthInfo(tr('Pitch diameter'), pitchD),
    lengthInfo(tr('Outside diameter'), od),
    lengthInfo(tr('Root diameter'), 2 * rootR),
  ];
  if (hasBottom || hasTop) info.push(lengthInfo(tr('Flange diameter'), 2 * rf));
  info.push(lengthInfo(tr('Belt pitch'), b.pitch, 3), lengthInfo(tr('Total height'), height));

  return { solid, outline: [toothed, ...(boreShape(p, q) ?? [])], info, warnings };
}

interface PulleyFamily {
  id: string;
  name: string;
  summary: string;
  profiles: Record<string, BeltProfile>;
  defaultProfile: string;
  beltWidth: number;
  clearance: number;
  hub: HubDefaults;
  bore: BoreDefaults;
}

function makePulley(f: PulleyFamily): GeneratorDef {
  const hasFlange = (p: Params) => p.flanges !== 'none';
  return {
    id: f.id,
    name: f.name,
    category: 'pulleys',
    summary: f.summary,
    groups: [
      {
        title: tr('Belt'),
        params: [
          {
            type: 'select',
            key: 'profile',
            label: tr('Profile'),
            default: f.defaultProfile,
            options: Object.entries(f.profiles).map(([value, b]) => ({ value, label: b.label })),
          },
          { type: 'number', key: 'teeth', label: tr('Teeth'), default: 20, min: 10, max: 200, step: 1, integer: true },
          {
            type: 'number',
            key: 'beltWidth',
            label: tr('Belt width'),
            help: tr('Sets the belt width the toothed section is cut for.'),
            default: f.beltWidth,
            min: 2,
            max: 100,
            step: 0.5,
            unit: 'mm',
          },
          {
            type: 'number',
            key: 'toothClearance',
            label: tr('Tooth clearance'),
            help: tr('Enlarges every belt groove by this much on all sides.'),
            default: f.clearance,
            min: 0,
            max: 0.5,
            step: 0.01,
            unit: 'mm',
          },
        ],
      },
      {
        title: tr('Flanges'),
        params: [
          {
            type: 'select',
            key: 'flanges',
            label: tr('Flanges'),
            default: 'both',
            options: [
              { value: 'both', label: tr('Both sides') },
              { value: 'bottom', label: tr('Bottom only') },
              { value: 'top', label: tr('Top only (hub side)') },
              { value: 'none', label: tr('None') },
            ],
          },
          { type: 'number', key: 'flangeHeight', label: tr('Thickness'), default: 1, min: 0.4, max: 10, step: 0.1, unit: 'mm', visible: hasFlange },
          {
            type: 'number',
            key: 'flangeExtra',
            label: tr('Overhang'),
            help: tr('Sets how far the flange extends beyond the teeth.'),
            default: 1,
            min: 0.2,
            max: 10,
            step: 0.1,
            unit: 'mm',
            visible: hasFlange,
          },
        ],
      },
      hubGroup(f.hub),
      boreGroup(f.bore),
    ],
    build: (p, q) => buildPulley(f.profiles, p, q),
  };
}

export const gt2Pulley = makePulley({
  id: 'gt2-pulley',
  name: tr('GT2 timing pulley'),
  summary: tr('Pulley for GT2 / 2GT belts.'),
  profiles: GT2,
  defaultProfile: '2',
  beltWidth: 6,
  clearance: 0.05,
  hub: { height: 6, diameter: 14, setScrews: 2, setScrewDiameter: 2.8 },
  bore: { type: 'round', diameter: 5 },
});

export const htdPulley = makePulley({
  id: 'htd-pulley',
  name: tr('HTD timing pulley'),
  summary: tr('Pulley for HTD 3M / 5M / 8M round-tooth belts.'),
  profiles: HTD,
  defaultProfile: '5M',
  beltWidth: 15,
  clearance: 0.1,
  hub: { height: 8, diameter: 22, setScrews: 2, setScrewDiameter: 3.3 },
  bore: { type: 'round', diameter: 8 },
});

export const tPulley = makePulley({
  id: 't-pulley',
  name: tr('T-series timing pulley'),
  summary: tr('Pulley for metric trapezoidal T2.5 / T5 / T10 belts.'),
  profiles: T_SERIES,
  defaultProfile: 'T5',
  beltWidth: 10,
  clearance: 0.1,
  hub: { height: 8, diameter: 22, setScrews: 2, setScrewDiameter: 3.3 },
  bore: { type: 'round', diameter: 8 },
});

export const mxlPulley = makePulley({
  id: 'mxl-pulley',
  name: tr('MXL / XL timing pulley'),
  summary: tr('Pulley for imperial trapezoidal MXL (0.080") and XL (0.200") belts.'),
  profiles: IMPERIAL,
  defaultProfile: 'MXL',
  beltWidth: 6.5,
  clearance: 0.05,
  hub: { height: 6, diameter: 14, setScrews: 2, setScrewDiameter: 2.8 },
  bore: { type: 'round', diameter: 5 },
});

const FAMILIES: Record<string, Record<string, BeltProfile>> = { 'gt2-pulley': GT2, 'htd-pulley': HTD, 't-pulley': T_SERIES, 'mxl-pulley': IMPERIAL };

/** The pitch (mm from tooth to tooth along the belt) of a pulley with these settings; undefined for a part that is no timing pulley. */
export function beltPitch(part: string, p: Params): number | undefined {
  const profiles = FAMILIES[part];
  if (!profiles) return undefined;
  return (profiles[String(p.profile)] ?? Object.values(profiles)[0]).pitch;
}

