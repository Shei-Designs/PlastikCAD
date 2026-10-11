// A gear's mate, worked out from the gear itself: the second gear of a pair,
// the ring a pinion runs inside, or the rack it runs along, with the tooth
// count asked for, placed at the working center distance on the chosen side
// and turned so that the teeth are already meshed. Printing tolerances are two
// plain figures: backlash thins the new gear's teeth, and the extra center
// distance backs the pair off a little further.
//
// Positions here are between axes: the gear's axis (its generator's origin) and
// the mate's generator origin, in the plate's XY. Where each part's box center
// falls relative to that origin is the caller's business.
import type { PartNode } from '../model/types';
import { inv } from './involute';
import type { Params } from './generators/types';

export type MateKind = 'gear' | 'ring' | 'rack';

export interface MateRequest {
  kind: MateKind;
  /** Teeth on the mate (for a rack, the number of teeth along it). */
  teeth: number;
  /** Tooth thinning on the mate, mm. */
  backlash: number;
  /** Added to the center distance (for a ring, taken off it), mm. */
  extra: number;
  /** Which side of the gear the mate goes, degrees anticlockwise from +X. */
  angle: number;
}

export interface Mate {
  part: string;
  params: Params;
  /** From the gear's axis to the mate's own origin, in the plate's XY. */
  offset: [number, number];
  /** The mate's turn about Z, degrees. */
  rotation: number;
  /** Center distance (for a rack, from the gear's axis to the pitch line), mm. */
  center: number;
  /** Mate teeth over gear teeth; NaN for a rack. */
  ratio: number;
  warnings: string[];
}

/** What can mate with a gear of this kind. */
export function mateKinds(part: string): MateKind[] {
  if (part === 'spur') return ['gear', 'ring', 'rack'];
  if (part === 'helical' || part === 'herringbone') return ['gear'];
  return [];
}

export const MATE_KIND_LABELS: Record<MateKind, string> = { gear: 'Gear', ring: 'Ring', rack: 'Rack' };

/** `deg` brought into (−period/2, period/2]. */
const wrap = (deg: number, period: number): number => {
  let d = deg % period;
  if (d > period / 2) d -= period;
  if (d <= -period / 2) d += period;
  return d;
};

const num = (p: Params, key: string, fallback = 0): number => {
  const v = Number(p[key]);
  return Number.isFinite(v) ? v : fallback;
};

/** Newton's method for the inverse of the involute function. */
function invInverse(value: number): number {
  let a = Math.cbrt(3 * value);
  for (let i = 0; i < 8; i++) a -= (inv(a) - value) / Math.tan(a) ** 2;
  return a;
}

export function mateOf(source: PartNode, req: MateRequest): Mate {
  const p = source.params;
  const warnings: string[] = [];
  const z1 = Math.max(1, Math.round(num(p, 'teeth', 20)));
  const z2 = Math.max(1, Math.round(req.teeth));
  const mn = num(p, 'module', 2);
  const an = (num(p, 'pressureAngle', 20) * Math.PI) / 180;
  const helix = (num(p, 'helixAngle', 0) * Math.PI) / 180;
  const x1 = num(p, 'profileShift', 0);
  // Transverse module and pressure angle: what the gears actually mesh with in the plane.
  const mt = mn / Math.cos(helix);
  const at = Math.atan(Math.tan(an) / Math.cos(helix));
  const theta = req.angle;
  const dir: [number, number] = [Math.cos((theta * Math.PI) / 180), Math.sin((theta * Math.PI) / 180)];
  const rz1 = source.rot[2];
  if (Math.abs(source.rot[0]) > 1e-9 || Math.abs(source.rot[1]) > 1e-9) warnings.push('The gear is tilted; the mate is placed as if it lay flat.');
  if (source.flip?.some(Boolean)) warnings.push('The gear is mirrored; the mate is placed as if it were not.');
  if (source.size.some((s, i) => Math.abs(s - source.natural[i]) > 1e-6 * Math.max(1, source.natural[i]))) {
    warnings.push('The gear has been resized, so its teeth no longer match its module; the mate fits the unresized gear.');
  }
  // How far the gear is turned back from having a tooth centered on the line of centers.
  const p1 = 360 / z1;
  const delta = wrap(theta - rz1, p1);
  const ratio = z2 / z1;

  if (req.kind === 'gear') {
    // Working center distance of an external pair, the mate unshifted.
    const nominal = (mt * (z1 + z2)) / 2;
    const invW = inv(at) + (2 * x1 * Math.tan(at)) / (z1 + z2);
    const working = Math.abs(x1) < 1e-9 ? nominal : (nominal * Math.cos(at)) / Math.cos(invInverse(invW));
    const center = working + req.extra;
    const p2 = 360 / z2;
    // A tooth space of the mate faces the gear; turning the gear back by delta turned the mate on by delta at the ratio.
    const rotation = theta + 180 - p2 / 2 + delta * (z1 / z2);
    const params: Params = { ...p, teeth: z2, backlash: req.backlash, profileShift: 0 };
    if (source.part !== 'spur') params.hand = p.hand === 'left' ? 'right' : 'left';
    return { part: source.part, params, offset: [dir[0] * center, dir[1] * center], rotation, center, ratio, warnings };
  }

  if (req.kind === 'ring') {
    if (z2 <= z1 + 4) warnings.push('A ring needs a good few more teeth than the pinion inside it.');
    if (Math.abs(x1) > 1e-9) warnings.push('The ring is laid out for an unshifted pinion; the profile shift is ignored.');
    const center = (mt * (z2 - z1)) / 2 - req.extra;
    // The ring's tooth spaces are centered on its own +X: one goes on the line of centers, which from
    // the ring's center points back at the gear. Pinion and ring turn the same way.
    const rotation = theta + 180 - delta * (z1 / z2);
    const params: Params = {
      module: mn,
      teeth: z2,
      pressureAngle: num(p, 'pressureAngle', 20),
      backlash: req.backlash,
      clearance: num(p, 'clearance', 0.25),
      faceWidth: num(p, 'faceWidth', 10),
      sunTeeth: z1,
    };
    return { part: 'ring', params, offset: [dir[0] * center, dir[1] * center], rotation, center, ratio, warnings };
  }

  // A rack: its pitch line a pitch radius (plus the extra) from the gear's axis, teeth facing the gear.
  // The rack's origin is its bottom corner; its teeth point along its own +Y, which is turned to face the gear.
  const r1 = (mt * z1) / 2 + x1 * mn;
  const center = r1 + req.extra;
  const c = num(p, 'clearance', 0.25);
  const base = 6;
  const pitch = Math.PI * mn;
  const length = z2 * pitch;
  const pitchLine = base + (1 + c) * mn;
  // Tooth spaces sit at whole pitches from the rack's end. Turning the gear back by delta carried the
  // rack back along with it, so the space that faces the gear's nearest tooth is that far off the line of
  // centers; the rack is then centered on the gear as nearly as whole pitches allow.
  const carried = -r1 * ((delta * Math.PI) / 180);
  const along = -length / 2 + wrap(carried + length / 2, pitch);
  const rotation = theta + 90;
  const across: [number, number] = [-dir[1], dir[0]];
  const offset: [number, number] = [dir[0] * (center + pitchLine) + across[0] * along, dir[1] * (center + pitchLine) + across[1] * along];
  const params: Params = {
    module: mn,
    teeth: z2,
    faceWidth: num(p, 'faceWidth', 10),
    baseHeight: base,
    helixAngle: 0,
    herringbone: false,
    pressureAngle: num(p, 'pressureAngle', 20),
    backlash: req.backlash,
    clearance: c,
  };
  return { part: 'rack', params, offset, rotation, center, ratio: Number.NaN, warnings };
}
