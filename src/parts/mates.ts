// A gear's mate, worked out from the gear itself: the second gear of a pair,
// the ring a pinion runs inside, or the rack it runs along, with the tooth
// count asked for, placed at the working center distance on the chosen side
// and turned so that the teeth are already meshed. Printing tolerances are two
// plain figures: backlash thins the new gear's teeth, and the extra center
// distance backs the pair off a little further.
//
// Positions here are between origins: from the gear's generator origin (its
// axis, at its bottom face) to the mate's, in the plate's frame. Where each
// part's box center falls relative to that origin is the caller's business.
import { tr } from '../i18n';
import { eulerOf, multiply, rotation } from '../model/math';
import type { Mat } from '../model/math';
import type { PartNode, Vec3 } from '../model/types';
import { inv } from './involute';
import { bevelApexHeight } from './generators/bevel';
import { RACK_BASE_HEIGHT, rackPitchLine } from './generators/gears';
import { chainPitch } from './generators/sprocket';
import { beltPitch } from './generators/timingPulley';
import type { Params } from './generators/types';

export type MateKind = 'gear' | 'ring' | 'rack' | 'wheel' | 'bevel' | 'pulley' | 'sprocket';

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
  /** For a pulley or sprocket: the teeth of the belt or the links of the chain that joins the two. Left out, a usual length is taken (see `usualSpan`). */
  span?: number;
}

export interface Mate {
  part: string;
  params: Params;
  /** From the gear's origin to the mate's own origin, in the plate's frame. */
  offset: Vec3;
  /** The mate's turn, as a node's rotation (degrees about X, then Y, then Z). */
  rotation: Vec3;
  /** Center distance (for a rack, from the gear's axis to the pitch line), mm. */
  center: number;
  /** Mate teeth over gear teeth (or worm starts); NaN for a rack. */
  ratio: number;
  warnings: string[];
  /** Something worth knowing about the mate that is not a problem. */
  note?: string;
  /** What to call the part when its kind's own name would mislead (a helical gear used as a worm wheel). */
  name?: string;
}

/** What can mate with a gear of this kind. */
export function mateKinds(part: string): MateKind[] {
  if (part === 'spur') return ['gear', 'ring', 'rack'];
  if (part === 'helical' || part === 'herringbone') return ['gear'];
  if (part === 'worm') return ['wheel'];
  if (part === 'bevel') return ['bevel'];
  if (beltPitch(part, {}) !== undefined) return ['pulley'];
  if (part === 'sprocket') return ['sprocket'];
  return [];
}

export const MATE_KIND_LABELS: Record<MateKind, string> = { gear: tr('Gear'), ring: tr('Ring'), rack: tr('Rack'), wheel: tr('Worm wheel'), bevel: tr('Bevel gear'), pulley: tr('Pulley'), sprocket: tr('Sprocket') };

/** A bevel gear's cone angle already names its mate's tooth count; the wizard cannot change it. */
export function fixedMateTeeth(source: PartNode): number | null {
  return source.part === 'bevel' ? Math.max(1, Math.round(num(source.params, 'mateTeeth', 20))) : null;
}

/** What a ratio is counted against: a gear's teeth, a worm's starts. */
export function sourceTeeth(source: PartNode): number {
  const p = source.params;
  return Math.max(1, Math.round(num(p, source.part === 'worm' ? 'starts' : 'teeth', source.part === 'worm' ? 1 : 20)));
}

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
  if (Math.abs(value) < 1e-12) return 0;
  let a = Math.cbrt(3 * value);
  for (let i = 0; i < 8; i++) a -= (inv(a) - value) / Math.tan(a) ** 2;
  return a;
}

/**
 * The diameter a belt or chain goes round on a wheel of `teeth`: the circle whose rim is as long as the
 * teeth are pitches. A belt's pitch line is that circle; a chain lies on it a pitch per tooth, which is
 * how its length is counted.
 */
const wrapDiameter = (pitch: number, teeth: number): number => (teeth * pitch) / Math.PI;

/** How far the teeth of a wheel reach from its axis, near enough to keep two wheels from touching: a sprocket's pins sit at the corners of a polygon. */
const reach = (kind: MateKind, pitch: number, teeth: number): number => (kind === 'sprocket' ? pitch / Math.sin(Math.PI / teeth) : (teeth * pitch) / Math.PI) / 2;

/** The pitch length of an open belt (or chain) round two wheels of pitch diameters `d1` and `d2` whose centers are `c` apart. */
function wrapLength(d1: number, d2: number, c: number): number {
  const half = Math.abs(d2 - d1) / 2;
  const lean = Math.asin(Math.min(1, half / c));
  return 2 * Math.sqrt(Math.max(0, c * c - half * half)) + (Math.PI * (d1 + d2)) / 2 + 2 * lean * half;
}

/** The pitch of the belt or chain a pulley or sprocket takes. */
const drivePitch = (source: PartNode): number => beltPitch(source.part, source.params) ?? chainPitch(source.params);

/**
 * The belt teeth or chain links offered for a pair until a count is typed: enough for the wheels to
 * stand about their two diameters apart, and for a chain an even number (an odd one needs an offset link).
 */
export function usualSpan(source: PartNode, kind: MateKind, teeth: number): number {
  const pitch = drivePitch(source);
  const d1 = wrapDiameter(pitch, sourceTeeth(source));
  const d2 = wrapDiameter(pitch, Math.max(1, Math.round(teeth)));
  const span = Math.ceil(wrapLength(d1, d2, d1 + d2) / pitch);
  return kind === 'sprocket' ? span + (span % 2) : span;
}

/**
 * The second pulley of a belt drive, or sprocket of a chain drive: the same part with the tooth count
 * asked for, as far away as the belt or chain of `span` pitches is long, on the side asked for and
 * turned as its partner is (a belt or chain meets the teeth wherever they are).
 */
function driveMate(source: PartNode, req: MateRequest, warnings: string[]): Mate {
  const kind = req.kind;
  const pitch = drivePitch(source);
  const z1 = sourceTeeth(source);
  const z2 = Math.max(1, Math.round(req.teeth));
  const d1 = wrapDiameter(pitch, z1);
  const d2 = wrapDiameter(pitch, z2);
  // Closer than this the two would touch: their teeth a pitch apart.
  const least = reach(kind, pitch, z1) + reach(kind, pitch, z2) + pitch;
  const shortest = Math.ceil(wrapLength(d1, d2, least) / pitch);
  let span = Math.round(req.span ?? usualSpan(source, kind, z2));
  if (span < shortest) {
    warnings.push(
      kind === 'sprocket'
        ? tr('The chain is too short for these sprockets; the shortest that fits has {n} links.', { n: shortest })
        : tr('The belt is too short for these pulleys; the shortest that fits has {n} teeth.', { n: shortest }),
    );
    span = shortest;
  }
  const length = span * pitch;
  // The length grows with the distance, so the distance for a length is found by halving.
  let lo = Math.abs(d2 - d1) / 2;
  let hi = length / 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (wrapLength(d1, d2, mid) < length) lo = mid;
    else hi = mid;
  }
  const center = (lo + hi) / 2;
  const theta = (req.angle * Math.PI) / 180;
  const mate: Mate = {
    part: source.part,
    params: { ...source.params, teeth: z2 },
    offset: [center * Math.cos(theta), center * Math.sin(theta), 0],
    rotation: [0, 0, source.rot[2]],
    center,
    ratio: z2 / z1,
    warnings,
  };
  if (kind === 'sprocket' && span % 2) mate.note = tr('A chain of an odd number of links needs an offset link.');
  else if (kind === 'pulley') mate.note = tr('Belt length {length} mm', { length: Number(length.toFixed(2)) });
  return mate;
}

export function mateOf(source: PartNode, req: MateRequest): Mate {
  const p = source.params;
  const warnings: string[] = [];
  if (req.kind === 'pulley' || req.kind === 'sprocket') {
    if (Math.abs(source.rot[0]) > 1e-9 || Math.abs(source.rot[1]) > 1e-9) warnings.push(tr('The part is tilted; the mate is placed as if it stood upright.'));
    if (source.size.some((s, i) => Math.abs(s - source.natural[i]) > 1e-6 * Math.max(1, source.natural[i]))) {
      warnings.push(tr('The part has been resized, so its teeth no longer match its pitch; the mate fits the unresized part.'));
    }
    return driveMate(source, req, warnings);
  }
  if (Math.abs(source.rot[0]) > 1e-9 || Math.abs(source.rot[1]) > 1e-9) warnings.push(tr('The gear is tilted; the mate is placed as if it stood upright.'));
  if (source.flip?.some(Boolean)) warnings.push(tr('The gear is mirrored; the mate is placed as if it were not.'));
  if (source.size.some((s, i) => Math.abs(s - source.natural[i]) > 1e-6 * Math.max(1, source.natural[i]))) {
    warnings.push(tr('The gear has been resized, so its teeth no longer match its module; the mate fits the unresized gear.'));
  }
  if (req.kind === 'wheel') return wormWheel(source, req, warnings);
  if (req.kind === 'bevel') return bevelMate(source, req, warnings);
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
  // How far the gear is turned back from having a tooth centered on the line of centers.
  const p1 = 360 / z1;
  const delta = wrap(theta - rz1, p1);
  const ratio = z2 / z1;

  if (req.kind === 'gear') {
    // Working center distance of an external pair, the mate unshifted. The shift is a share of the normal
    // module; in the plane the gears mesh in that is x·cos β of the transverse one, at tan αt = tan αn / cos β,
    // so the two cosines cancel and the normal pressure angle is what the shift goes with.
    const nominal = (mt * (z1 + z2)) / 2;
    const invW = inv(at) + (2 * x1 * Math.tan(an)) / (z1 + z2);
    if (invW <= 0) warnings.push(tr('The profile shift is too negative for the pair to mesh; the mate is placed at the nominal center distance.'));
    const working = Math.abs(x1) < 1e-9 || invW <= 0 ? nominal : (nominal * Math.cos(at)) / Math.cos(invInverse(invW));
    const center = working + req.extra;
    const p2 = 360 / z2;
    // A tooth space of the mate faces the gear; turning the gear back by delta turned the mate on by delta at the ratio.
    const rotation = theta + 180 - p2 / 2 + delta * (z1 / z2);
    const params: Params = { ...p, teeth: z2, backlash: req.backlash, profileShift: 0 };
    if (source.part !== 'spur') params.hand = p.hand === 'left' ? 'right' : 'left';
    return { part: source.part, params, offset: [dir[0] * center, dir[1] * center, 0], rotation: [0, 0, rotation], center, ratio, warnings };
  }

  if (req.kind === 'ring') {
    if (z2 <= z1 + 4) warnings.push(tr('A ring needs a good few more teeth than the pinion inside it.'));
    if (Math.abs(x1) > 1e-9) warnings.push(tr('The ring is laid out for an unshifted pinion; the profile shift is ignored.'));
    const center = (mt * (z2 - z1)) / 2 - req.extra;
    // The pinion meshes on its far side from the ring's center, where a pinion with an odd tooth count has
    // a space opposite the tooth that faces the center: its turn is counted from a tooth on that side.
    const inside = wrap(theta + 180 - rz1, p1);
    // The ring's tooth spaces are centered on its own +X: one goes on the line of centers, which from
    // the ring's center points back at the gear. Pinion and ring turn the same way.
    const rotation = theta + 180 - inside * (z1 / z2);
    const params: Params = {
      module: mn,
      teeth: z2,
      pressureAngle: num(p, 'pressureAngle', 20),
      backlash: req.backlash,
      clearance: num(p, 'clearance', 0.25),
      faceWidth: num(p, 'faceWidth', 10),
      sunTeeth: z1,
    };
    return { part: 'ring', params, offset: [dir[0] * center, dir[1] * center, 0], rotation: [0, 0, rotation], center, ratio, warnings };
  }

  // A rack: its pitch line a pitch radius (plus the extra) from the gear's axis, teeth facing the gear.
  // The rack's origin is its bottom corner; its teeth point along its own +Y, which is turned to face the gear.
  const r1 = (mt * z1) / 2 + x1 * mn;
  const center = r1 + req.extra;
  const c = num(p, 'clearance', 0.25);
  const base = RACK_BASE_HEIGHT;
  const pitch = Math.PI * mn;
  const length = z2 * pitch;
  const pitchLine = rackPitchLine(base, c, mn);
  // Tooth spaces sit at whole pitches from the rack's end. Turning the gear back by delta carried the
  // rack back along with it (a rack rolls on the gear's reference circle, whatever the profile shift),
  // so the space that faces the gear's nearest tooth is that far off the line of centers; the rack is
  // then centered on the gear as nearly as whole pitches allow.
  const carried = -((mt * z1) / 2) * ((delta * Math.PI) / 180);
  const along = -length / 2 + wrap(carried + length / 2, pitch);
  const rotation = theta + 90;
  const across: [number, number] = [-dir[1], dir[0]];
  const offset: Vec3 = [dir[0] * (center + pitchLine) + across[0] * along, dir[1] * (center + pitchLine) + across[1] * along, 0];
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
  return { part: 'rack', params, offset, rotation: [0, 0, rotation], center, ratio: Number.NaN, warnings };
}

/** Rotation about a horizontal axis at `azimuth` degrees from +X, by `degrees` (right-hand rule). */
function aboutHorizontal(azimuth: number, degrees: number): Mat {
  return multiply(multiply(rotation([0, 0, azimuth]), rotation([degrees, 0, 0])), rotation([0, 0, -azimuth]));
}

/**
 * The wheel a worm drives: a helical gear cut at the worm's lead angle, same hand, standing on
 * edge beside the worm with its axis across the line of centers, halfway up the worm. In the
 * wheel's middle plane (the plane through the worm's axis) the worm's thread is a rack, and the
 * wheel is turned so that a tooth space sits on the thread crest there.
 */
function wormWheel(source: PartNode, req: MateRequest, warnings: string[]): Mate {
  const p = source.params;
  const m = num(p, 'module', 1);
  const starts = Math.max(1, Math.round(num(p, 'starts', 1)));
  const alpha = (num(p, 'pressureAngle', 20) * Math.PI) / 180;
  const d = num(p, 'pitchDiameter', 12);
  const length = num(p, 'length', 20);
  const left = p.hand === 'left';
  const z2 = Math.max(1, Math.round(req.teeth));
  const pitch = Math.PI * m;
  const lead = pitch * starts;
  const lambda = Math.atan(lead / (Math.PI * d));
  const r1 = d / 2;
  const r2 = (m * z2) / 2;
  const center = r1 + r2 + req.extra;
  // A face about three quarters of the worm's diameter is the usual proportion.
  const faceWidth = Math.max(1, Math.round((0.75 * d) / 0.5) * 0.5);
  const params: Params = {
    module: m * Math.cos(lambda),
    teeth: z2,
    faceWidth,
    helixAngle: (lambda * 180) / Math.PI,
    hand: left ? 'left' : 'right',
    pressureAngle: (Math.atan(Math.tan(alpha) * Math.cos(lambda)) * 180) / Math.PI,
    backlash: req.backlash,
    profileShift: 0,
  };
  if (lambda < (1 * Math.PI) / 180) warnings.push(tr('The lead angle is under 1°, which the helical gear cannot follow exactly.'));

  const theta = (req.angle * Math.PI) / 180;
  const dir: Vec3 = [Math.cos(theta), Math.sin(theta), 0];
  const across: Vec3 = [-dir[1], dir[0], 0];
  // Where the thread crest crosses the line of centers: at worm angle φ a crest sits at
  // pitch/2 + lead·φ/2π (minus that for a left-hand thread), repeating every pitch.
  const phi = theta - (source.rot[2] * Math.PI) / 180;
  const zMid = length / 2;
  const crest = pitch / 2 + ((left ? -1 : 1) * lead * phi) / (2 * Math.PI);
  const zCrest = crest + Math.round((zMid - crest) / pitch) * pitch;
  // The wheel's tooth centers twist with height; at its middle plane they sit this far round from its +X.
  const twistMid = ((left ? -1 : 1) * (faceWidth / 2) * Math.tan(lambda)) / r2;
  const p2 = (2 * Math.PI) / z2;
  // Turning the wheel about its axis carries its near side up the worm by r2 per radian.
  const psi = (zCrest - zMid) / r2 - twistMid - p2 / 2;
  // Base pose: the wheel's +X faces the worm, its axis runs across, then it is turned by psi about that axis.
  const base: Mat = [-dir[0], -dir[1], 0, 0, 0, 1, across[0], across[1], 0, 0, 0, 0];
  const pose = multiply(aboutHorizontal(req.angle + 90, (psi * 180) / Math.PI), base);
  const origin: Vec3 = [dir[0] * center - (across[0] * faceWidth) / 2, dir[1] * center - (across[1] * faceWidth) / 2, zMid];
  return {
    part: 'helical',
    name: tr('Worm wheel'),
    params,
    offset: origin,
    rotation: eulerOf(pose),
    center,
    ratio: z2 / starts,
    warnings,
    note: tr('A plain helical gear cut at the lead angle, not a throated wheel: it meshes along a line, which prints fine but carries less load.'),
  };
}

/**
 * The other gear of a bevel pair, for shafts at 90°: the gear's own "mating gear teeth" already
 * fixed its cone angle, so the mate has that many teeth and the gear's count in turn. It stands
 * on its side with its axis through the gear's cone apex, body pointing away, turned about that
 * axis so that a tooth space meets the gear's tooth on the line where the pitch cones touch.
 */
function bevelMate(source: PartNode, req: MateRequest, warnings: string[]): Mate {
  const p = source.params;
  const z1 = Math.max(1, Math.round(num(p, 'teeth', 20)));
  const z2 = Math.max(1, Math.round(num(p, 'mateTeeth', 20)));
  const m = num(p, 'module', 2);
  /** Height of the pitch cone apex above the part's mounting face (its origin): the generator's own figure, a missing setting made up. */
  const apexHeight = (z: number, zMate: number): number =>
    bevelApexHeight({
      module: m,
      teeth: z,
      mateTeeth: zMate,
      pressureAngle: num(p, 'pressureAngle', 20),
      clearance: num(p, 'clearance', 0.25),
      baseThickness: num(p, 'baseThickness', 3),
      hubHeight: num(p, 'hubHeight', 0),
    });
  const params: Params = { ...p, teeth: z2, mateTeeth: z1, backlash: req.backlash };
  const apex1 = apexHeight(z1, z2);
  const apex2 = apexHeight(z2, z1);

  const theta = req.angle;
  const dir: Vec3 = [Math.cos((theta * Math.PI) / 180), Math.sin((theta * Math.PI) / 180), 0];
  const across: Vec3 = [-dir[0 + 1], dir[0], 0];
  // How far the gear is turned back from having a tooth on the line of contact.
  const p1 = 360 / z1;
  const p2 = 360 / z2;
  const delta = wrap(theta - source.rot[2], p1);
  // Base pose: the mate's axis points at the apex along -dir, its +X tooth lies on the line of contact
  // (straight down from the apex, where the pitch cones touch). A half tooth puts a space there instead;
  // the gear's own turn-back carries the mate on at the ratio.
  const base: Mat = [0, 0, -1, -across[0], -across[1], 0, -dir[0], -dir[1], 0, 0, 0, 0];
  const psi = p2 / 2 + delta * (z1 / z2);
  const pose = multiply(aboutHorizontal(theta, -psi), base);
  const reach = apex2 + req.extra;
  const offset: Vec3 = [dir[0] * reach, dir[1] * reach, apex1];
  const coneDistance = (m * z1) / 2 / Math.sin(Math.atan2(z1, z2));
  return {
    part: 'bevel',
    params,
    offset,
    rotation: eulerOf(pose),
    center: coneDistance,
    ratio: z2 / z1,
    warnings,
    note: tr('The tooth count is set by this gear’s cone angle. The mate’s axis passes through the cone apex, at right angles.'),
  };
}
