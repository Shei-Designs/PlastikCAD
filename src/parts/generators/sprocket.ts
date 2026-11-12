// Roller chain sprockets. The tooth form is the classic drafting construction:
// a roller seat arc on the pitch circle, joined tangentially to flank arcs
// centered on the neighboring rollers, with the tips cut at the outside diameter.
import { tr } from '../../i18n';
import { addHubAndBore, boreGroup, boreRadius, boreShape, hubGroup } from '../features';
import { arc, arcN, arcSegments, dedupe, polar, rotatePoint, TAU } from '../math2d';
import { extrude, intersection, revolve } from '../types';
import type { Polygon, Quality, Solid, Vec2 } from '../types';
import { bool, lengthInfo, mm, num, str } from './types';
import type { BuildResult, GeneratorDef, Params } from './types';

interface Chain {
  label: string;
  pitch: number;
  /** Roller diameter. */
  roller: number;
  /** Width between the inner plates. */
  width: number;
}

const CHAINS: Record<string, Chain> = {
  '25': { label: '#25 (1/4")', pitch: 6.35, roller: 3.3, width: 3.18 },
  '35': { label: '#35 (3/8")', pitch: 9.525, roller: 5.08, width: 4.77 },
  '40': { label: '#40 (1/2")', pitch: 12.7, roller: 7.92, width: 7.85 },
  '41': { label: tr('#41 (1/2" narrow)'), pitch: 12.7, roller: 7.77, width: 6.35 },
  'bike-1/8': { label: tr('Bicycle 1/2" × 1/8"'), pitch: 12.7, roller: 7.75, width: 3.175 },
  'bike-3/32': { label: tr('Bicycle 1/2" × 3/32"'), pitch: 12.7, roller: 7.75, width: 2.38 },
  '05B': { label: '05B (8 mm)', pitch: 8, roller: 5, width: 3 },
  '06B': { label: '06B (3/8")', pitch: 9.525, roller: 6.35, width: 5.72 },
  '08B': { label: '08B (1/2")', pitch: 12.7, roller: 8.51, width: 7.75 },
};

interface SprocketGeometry {
  outline: Polygon;
  pitchR: number;
  outerR: number;
  seatR: number;
}

function sprocketOutline(chain: Chain, teeth: number, clearance: number, q: Quality): SprocketGeometry {
  const p = chain.pitch;
  const half = Math.PI / teeth;
  const step = TAU / teeth;
  const pitchR = p / (2 * Math.sin(half));
  const seatR = 0.5025 * chain.roller + 0.04 + clearance;
  const flankR = p - seatR;
  // Where the two flanks of a tooth would meet in a point.
  const pointR = pitchR * Math.cos(half) + Math.sqrt(flankR * flankR - (p * p) / 4);
  const outerR = Math.min((p * (0.6 + 1 / Math.tan(half))) / 2, pointR);
  const pointed = outerR >= pointR - 1e-9;

  // One cell: the seat of roller 0 (centered on +X) and the tooth up to roller 1.
  const c0: Vec2 = [pitchR, 0];
  const c1 = polar(pitchR, step);
  const cell: Vec2[] = [];
  const seatSweep = Math.PI - 2 * half;
  cell.push(...arc(c0[0], c0[1], seatR, -Math.PI / 2 - half, -Math.PI / 2 - half - seatSweep, arcN(q, seatR, seatSweep, 4)));

  // Angle (about a roller center, measured from its radial direction) at which the flank ends.
  let flankEnd: number;
  if (pointed) {
    const tip = polar(pointR, half);
    flankEnd = Math.atan2(tip[1] - c0[1], tip[0] - c0[0]);
  } else {
    flankEnd = Math.acos((outerR * outerR - pitchR * pitchR - flankR * flankR) / (2 * pitchR * flankR));
  }
  const flankSweep = Math.PI / 2 + half - flankEnd;
  const flankN = arcN(q, flankR, flankSweep, 3);
  // Leading flank, centered on the next roller; its first point is the end of the seat.
  const lead = arc(c1[0], c1[1], flankR, step - Math.PI / 2 - half, step - flankEnd, flankN);
  cell.push(...lead.slice(1));
  if (!pointed) {
    const end = lead[lead.length - 1];
    const a0 = Math.atan2(end[1], end[0]);
    const a1 = step - a0;
    const n = arcSegments(q, a1 - a0);
    for (let j = 1; j < n; j++) cell.push(polar(outerR, a0 + ((a1 - a0) * j) / n));
  }
  // Trailing flank, centered on this roller; its last point starts the next seat.
  const trail = arc(c0[0], c0[1], flankR, flankEnd, Math.PI / 2 + half, flankN);
  cell.push(...trail.slice(pointed ? 1 : 0, -1));

  const pts: Vec2[] = [];
  for (let i = 0; i < teeth; i++) for (const pt of cell) pts.push(rotatePoint(pt, i * step));
  return { outline: dedupe(pts, 1e-6), pitchR, outerR, seatR };
}

function build(p: Params, q: Quality): BuildResult {
  const chain = CHAINS[str(p, 'chain')];
  if (!chain) throw new Error(`Unknown chain "${str(p, 'chain')}"`);
  const teeth = Math.round(num(p, 'teeth'));
  const warnings: string[] = [];
  const { outline, pitchR, outerR, seatR } = sprocketOutline(chain, teeth, num(p, 'rollerClearance'), q);
  const rootR = pitchR - seatR;

  const custom = num(p, 'thickness');
  const t = custom > 0 ? custom : 0.93 * chain.width;
  if (custom > chain.width) warnings.push(tr('The sprocket is thicker than the gap between the chain plates.'));

  let body: Solid = extrude([outline], t);
  if (bool(p, 'chamfer')) {
    // Taper the tooth sides toward the tip so the chain feeds on easily.
    const ch = Math.min(0.13 * chain.pitch, 0.3 * t);
    const h = Math.min(2 * ch, outerR - rootR);
    const e = 0.25 * h;
    const blank: Polygon = [
      [0, 0],
      [outerR - h, 0],
      [outerR + e, ch * 1.25],
      [outerR + e, t - ch * 1.25],
      [outerR - h, t],
      [0, t],
    ];
    body = intersection(body, revolve(blank, Math.max(48, arcSegments(q, TAU))));
  }

  if (boreRadius(p) > rootR - 1) warnings.push(tr('The bore leaves less than 1 mm of material below the teeth.'));
  const { solid, height } = addHubAndBore(body, 0, t, p, q, warnings, outerR);

  return {
    solid,
    outline: [outline, ...(boreShape(p, q) ?? [])],
    info: [
      lengthInfo(tr('Pitch diameter'), 2 * pitchR),
      lengthInfo(tr('Outside diameter'), 2 * outerR),
      lengthInfo(tr('Root diameter'), 2 * rootR),
      { label: tr('Chain pitch'), value: mm(chain.pitch, 3) },
      { label: tr('Roller diameter'), value: mm(chain.roller) },
      lengthInfo(tr('Thickness'), t),
      lengthInfo(tr('Total height'), height),
    ],
    warnings,
  };
}

export const sprocket: GeneratorDef = {
  id: 'sprocket',
  name: tr('Chain sprocket'),
  category: 'pulleys',
  summary: tr('Sprocket for roller chain: ANSI #25–#41, British 05B–08B and bicycle chain.'),
  groups: [
    {
      title: tr('Chain'),
      params: [
        {
          type: 'select',
          key: 'chain',
          label: tr('Chain'),
          default: '25',
          options: Object.entries(CHAINS).map(([value, c]) => ({ value, label: c.label })),
        },
        { type: 'number', key: 'teeth', label: tr('Teeth'), default: 16, min: 8, max: 120, step: 1, integer: true },
        {
          type: 'number',
          key: 'thickness',
          label: tr('Thickness'),
          help: tr('Sets the tooth width. 0 fits the chain automatically.'),
          default: 0,
          min: 0,
          max: 30,
          step: 0.1,
          unit: 'mm',
        },
        {
          type: 'number',
          key: 'rollerClearance',
          label: tr('Roller clearance'),
          help: tr('Adds this much to the radius of the roller seats.'),
          default: 0.1,
          min: 0,
          max: 0.5,
          step: 0.01,
          unit: 'mm',
        },
        {
          type: 'boolean',
          key: 'chamfer',
          label: tr('Chamfer tooth sides'),
          help: tr('Tapers the teeth toward the tip.'),
          default: true,
        },
      ],
    },
    hubGroup({ height: 6, diameter: 16, setScrews: 1, setScrewDiameter: 3.3 }),
    boreGroup({ type: 'round', diameter: 8 }),
  ],
  build,
};

/** The pitch (mm from pin to pin) of the chain a sprocket with these settings takes. */
export function chainPitch(p: Params): number {
  return (CHAINS[String(p.chain)] ?? Object.values(CHAINS)[0]).pitch;
}

