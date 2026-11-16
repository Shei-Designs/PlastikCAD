// Wheels for robots: a plain wheel, and a mecanum wheel whose rollers lean 45°
// to its axle so that four of them move a robot any way over the floor. Both
// stand on the plate with the axle along Z, like every round part.
//
// A mecanum wheel's rollers are barrels: seen along the axle their outsides
// together make the wheel's circle, so the wheel rolls smoothly from one
// roller onto the next. The roller's outline is worked out from that circle
// (see `rollerOutline`), not drawn by eye.
//
// The sizes offered are those sold as "48 mm", "60 mm" and so on. Vendors do
// not agree on widths and roller counts for one diameter; each row is one
// vendor's wheel:
//   48 mm   24.5 wide, 9 rollers   DFRobot FIT0765 product page
//   60 mm   31 wide, 8 rollers     RobotDigg 60 mm aluminum wheel listing (a Yahboom 60 mm is 30.6 wide with 9)
//   80 mm   37.4 wide, 9 rollers   Yahboom 80 mm wheel, from a reseller's listing: unverified
//   100 mm  50 wide, 9 rollers     Nexus Robot datasheet (part 14092)
//   152 mm  55.5 wide, 15 rollers  Nexus Robot datasheet and SuperDroid listing
//   203 mm  78 wide, 12 rollers    SuperDroid listing of the Nexus wheel; the Nexus Robot datasheet gives 67 wide: the width is unverified
// The roller's own diameter and length are not taken from any vendor: they
// follow from the diameter, the width and the count.
import { tr, trx } from '../../i18n';
import { addHubAndBore, boreGroup, boreRadius, boreShape, hubGroup } from '../features';
import { arc, arcSegments, circle, TAU } from '../math2d';
import { cylinder, intersection, revolve, rotate, translate, union } from '../types';
import type { Polygon, Quality, Solid, Vec2, Vec3 } from '../types';
import { lengthInfo, num, str } from './types';
import type { BuildResult, GeneratorDef, Params } from './types';

/** How far the wheel rolls in one turn. */
const travel = (diameter: number) => lengthInfo(tr('Travel per turn'), Math.PI * diameter, 1);

const disc = (r: number, q: Quality): Polygon => circle(r, q.circle);

// ---------------------------------------------------------------------------
// Plain wheel
// ---------------------------------------------------------------------------

function buildWheel(p: Params, q: Quality): BuildResult {
  const warnings: string[] = [];
  const R = num(p, 'diameter') / 2;
  const W = num(p, 'width');
  // The tread's edges are rounded by no more than the wheel has room for; a hair of flat is kept between them.
  const edge = Math.max(0, Math.min(num(p, 'edge'), W / 2 - 0.01, R / 2));
  const web = num(p, 'web');
  const hubbed = num(p, 'hubHeight') > 0;
  // What stays the wheel's full width round the axle, for the shaft and the hub to hold on to.
  const boss = Math.max(boreRadius(p) + Math.max(2, 0.08 * R), hubbed ? num(p, 'hubDiameter') / 2 : 0, 0.15 * R);
  const inner = R - Math.max(num(p, 'rim'), edge + 0.5);
  const depth = (W - web) / 2;
  const dished = web > 0 && depth > 0.05 && inner - boss > 1;

  // The outline, (radius, height) from the axle up the side.
  const profile: Polygon = [[0, 0]];
  if (dished) profile.push([boss, 0], [boss, depth], [inner, depth], [inner, 0]);
  if (edge > 0) {
    const n = Math.max(3, Math.round(q.circle / 16));
    profile.push(...arc(R - edge, edge, edge, -Math.PI / 2, 0, n), ...arc(R - edge, W - edge, edge, 0, Math.PI / 2, n));
  } else profile.push([R, 0], [R, W]);
  if (dished) profile.push([inner, W], [inner, W - depth], [boss, W - depth], [boss, W]);
  profile.push([0, W]);

  const { solid, height } = addHubAndBore(revolve(profile, Math.max(48, arcSegments(q, TAU))), 0, W, p, q, warnings, R);
  return {
    solid,
    outline: [disc(R, q), ...(boreShape(p, q) ?? [])],
    info: [lengthInfo(tr('Outside diameter'), 2 * R), lengthInfo(tr('Width'), W), lengthInfo(tr('Total height'), height), travel(2 * R)],
    warnings,
  };
}

export const wheel: GeneratorDef = {
  id: 'wheel',
  name: trx('part', 'Wheel'),
  category: 'wheels',
  summary: tr('Plain wheel with a flat or rounded tread.'),
  groups: [
    {
      title: trx('part', 'Wheel'),
      params: [
        { type: 'number', key: 'diameter', label: tr('Diameter'), default: 65, min: 10, max: 500, step: 1, unit: 'mm' },
        { type: 'number', key: 'width', label: tr('Width'), default: 26, min: 2, max: 200, step: 0.5, unit: 'mm' },
        { type: 'number', key: 'edge', label: tr('Edge radius'), help: tr('Rounds the edges of the tread. 0 leaves them sharp.'), default: 3, min: 0, max: 100, step: 0.5, unit: 'mm' },
        { type: 'number', key: 'web', label: tr('Web thickness'), help: tr('Sets the thickness of the disc between the hub and the rim. 0 makes the wheel solid.'), default: 8, min: 0, max: 200, step: 0.5, unit: 'mm' },
        { type: 'number', key: 'rim', label: tr('Rim thickness'), default: 6, min: 1, max: 100, step: 0.5, unit: 'mm', visible: (p) => num(p, 'web') > 0 },
      ],
    },
    hubGroup({ height: 0, diameter: 16, setScrews: 1, setScrewDiameter: 2.8 }),
    boreGroup({ type: 'round', diameter: 5 }),
  ],
  build: buildWheel,
};

// ---------------------------------------------------------------------------
// Mecanum wheel
// ---------------------------------------------------------------------------

interface Size {
  diameter: number;
  width: number;
  rollers: number;
}

/** The wheels sold under a diameter: where each row comes from is told at the top of the file. */
const SIZES: Record<string, Size> = {
  '48': { diameter: 48, width: 24.5, rollers: 9 },
  '60': { diameter: 60, width: 31, rollers: 8 },
  '80': { diameter: 80, width: 37.4, rollers: 9 },
  '100': { diameter: 100, width: 50, rollers: 9 },
  '152': { diameter: 152, width: 55.5, rollers: 15 },
  '203': { diameter: 203, width: 78, rollers: 12 },
};

export const MECANUM_SIZES = Object.keys(SIZES);

const isCustom = (p: Params) => !(str(p, 'size') in SIZES);
/** A figure of the size chosen, for its control to read while the size holds it. */
const ofSize = (key: keyof Size) => (p: Params) => SIZES[str(p, 'size')]?.[key] ?? num(p, key);

/**
 * A mecanum wheel's rollers, in the wheel's own frame: the axle is Z, the wheel spans `width` along it
 * and its middle plane is half way up. All lengths in mm.
 */
export interface MecanumRollers {
  /** How many rollers there are, evenly spaced round the axle; the first sits on +X. */
  count: number;
  /** The wheel's radius: the circle the rollers' outsides make, seen along the axle. */
  radius: number;
  /** The wheel's width along the axle. */
  width: number;
  /** Radius of the circle the rollers' middles sit on, in the wheel's middle plane. */
  circle: number;
  /** A roller's radius at its middle, where it is thickest. */
  rollerRadius: number;
  /** A roller's radius at its ends. */
  endRadius: number;
  /** A roller's length along its own axis. */
  rollerLength: number;
  /**
   * Which way the rollers lean: a roller's axis is its circle's tangent (counterclockwise seen from +Z)
   * plus `lean` times Z, as a unit vector. 1 for a left wheel, -1 for a right one.
   */
  lean: 1 | -1;
  /** The angle about the axle over which one roller touches the floor, radians; under 2π / count the rollers leave gaps. */
  reach: number;
}

/**
 * Where a roller that touches the wheel's circle has its surface: for a point `s` along the roller's
 * axis from its middle, the place along the axis and the radius there of the point that lies on the
 * circle. The circle's normal there is the line out from the axle, and it meets the roller's axis at
 * `s`; it is not square to that axis, which is why the two differ from `s` and the plain gap.
 */
function onCircle(R: number, c: number, s: number): Vec2 {
  const gap = R - Math.hypot(c, s * Math.SQRT1_2);
  const sin = Math.sin(Math.atan2(s * Math.SQRT1_2, c));
  return [s + gap * sin * Math.SQRT1_2, gap * Math.sqrt(1 - (sin * sin) / 2)];
}

/** The widest, the narrowest and the fewest a mecanum wheel may be given. */
const MECANUM = { diameter: { min: 30, max: 300 }, width: { min: 10, max: 150 }, rollers: { min: 6, max: 20 } };

/**
 * The rollers of a mecanum wheel part, from its settings: all a simulator needs to stand in for them.
 * A roller's thickness follows from the count (its neighbours must clear it) and its length from the
 * width (it must fit between the side plates).
 */
export function mecanumRollers(p: Params): MecanumRollers {
  const size: Size = SIZES[str(p, 'size')] ?? { diameter: num(p, 'diameter'), width: num(p, 'width'), rollers: Math.round(num(p, 'rollers')) };
  const R = size.diameter / 2;
  const W = size.width;
  const N = size.rollers;
  // The side plates take what the rollers leave; they are never thinner than this.
  const plate = Math.max(1, Math.min(0.05 * W, 4));
  const room = (W / 2 - plate) * Math.SQRT2;
  /** The longest roller of this middle radius that fits between the plates: half the stretch of its axis it is cut from. */
  const fitted = (r0: number): number => {
    const c = R - r0;
    // A roller is no longer than leaves its ends a third of its middle's thickness.
    const longest = Math.SQRT2 * Math.sqrt(Math.max(0, (R - 0.33 * r0) ** 2 - c * c));
    // Leaning 45°, a roller reaches along the axle by its half length and its end's radius, both over √2.
    const fits = (s: number) => {
      const [at, r] = onCircle(R, c, s);
      return at + r <= room;
    };
    if (fits(longest)) return longest;
    let lo = 0;
    let hi = longest;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const reachOf = (r0: number) => 2 * Math.atan2(fitted(r0) * Math.SQRT1_2, R - r0);
  // Neighbours stand 2·c·sin(π/N) apart round the circle and lean 45°, so their axes pass that over √2 from each other; a tenth is kept clear.
  const k = 0.9 * Math.SQRT1_2 * Math.sin(Math.PI / N);
  // On a wheel much narrower than it is wide across, the room between the plates sets the thickness instead.
  const thickest = Math.min((R * k) / (1 + k), 0.6 * room);
  // The rollers are as thick as that allows. Where such rollers would be too short to take over from one another,
  // thinner ones are tried: their ends are slimmer, so more of them fits between the plates. Where none will do,
  // the one that reaches farthest round is kept, and the wheel has gaps.
  let r0 = thickest;
  for (let i = 1; i <= 24 && reachOf(r0) < TAU / N; i++) {
    const thinner = thickest * (1 - i / 40);
    if (reachOf(thinner) > reachOf(r0)) r0 = thinner;
  }
  const c = R - r0;
  const half = fitted(r0);
  const [end, endRadius] = onCircle(R, c, half);
  return { count: N, radius: R, width: W, circle: c, rollerRadius: r0, endRadius, rollerLength: 2 * end, lean: str(p, 'hand') === 'right' ? -1 : 1, reach: 2 * Math.atan2(half * Math.SQRT1_2, c) };
}

/** A roller's outline: (place along its axis from its middle, radius there), from one end to the other in `steps` steps. */
export function rollerOutline(m: MecanumRollers, steps: number): Vec2[] {
  // The point of the axis whose normal from the axle reaches the roller's end.
  const half = Math.SQRT2 * m.circle * Math.tan(m.reach / 2);
  return Array.from({ length: steps + 1 }, (_, i) => onCircle(m.radius, m.circle, half * ((2 * i) / steps - 1)));
}

/** Where the middle of roller `i` is and which way its axis points (a unit vector), in the wheel's own frame. */
export function rollerPlace(m: MecanumRollers, i: number): { center: Vec3; axis: Vec3 } {
  const a = (TAU * i) / m.count;
  return { center: [m.circle * Math.cos(a), m.circle * Math.sin(a), m.width / 2], axis: [-Math.sin(a) * Math.SQRT1_2, Math.cos(a) * Math.SQRT1_2, m.lean * Math.SQRT1_2] };
}

function buildMecanum(p: Params, q: Quality): BuildResult {
  const warnings: string[] = [];
  const m = mecanumRollers(p);
  const { radius: R, width: W, circle: c, rollerRadius: r0, endRadius, rollerLength: L, count: N } = m;
  if (m.reach < TAU / N - 1e-9) warnings.push(tr('The rollers leave gaps between them. Add rollers or make the wheel wider.'));

  const around = Math.min(32, Math.max(12, Math.round(q.circle / 5)));
  const outline = rollerOutline(m, 2 * Math.max(3, Math.round(q.flank / 2)));
  // The barrel's flat sides are laid round the true roller, not inside it, and what then passes the wheel's circle is
  // cut off below: the wheel measures its diameter across, to the last bit.
  const out = 1.002 / Math.cos(Math.PI / around);
  const barrel = revolve([[0, -L / 2], ...outline.map(([s, r]): Vec2 => [r * out, s]), [0, L / 2]], around);
  // The axle each roller turns on, long enough to run into both plates.
  const pin = Math.max(0.5, 0.35 * endRadius);
  const reachZ = (L / 2 + endRadius) * Math.SQRT1_2;
  const plate = W / 2 - reachZ;
  const axle = translate(cylinder(pin, L + 4 * plate * Math.SQRT2, 12), [0, 0, -L / 2 - 2 * plate * Math.SQRT2]);
  // Standing on Z it is leant 45° about X, to the side the wheel's hand says, and set out on +X.
  const place = (s: Solid): Solid => translate(rotate(s, [-45 * m.lean, 0, 0]), [c, 0, W / 2]);
  const roller = place(barrel);
  const shaft = place(axle);

  // The side plates reach the rollers' ends and stop short of the floor; the drum between them clears the rollers.
  const ends = Math.hypot(c, L / 2 * Math.SQRT1_2);
  const clear = Math.max(1, 0.05 * R);
  const drum = Math.max(0.3 * R, c - r0 - Math.max(0.4, 0.04 * R));
  const plates = Math.max(drum, Math.min(ends + pin + 0.5, R - clear));
  const segments = Math.max(48, arcSegments(q, TAU));
  const spool: Polygon = [[0, 0], [plates, 0], [plates, plate], [drum, plate], [drum, W - plate], [plates, W - plate], [plates, W], [0, W]];
  const turned = (s: Solid) => Array.from({ length: N }, (_, i) => rotate(s, [0, 0, (360 * i) / N]));
  // The axles are cut off where they come out of the plates.
  const shafts = intersection(union(...turned(shaft)), cylinder(plates, W, segments));
  const rollers = intersection(union(...turned(roller)), cylinder(R, W, 4 * Math.ceil(segments / 4)));
  const body = union(revolve(spool, segments), shafts, rollers);

  if (boreRadius(p) > drum - 1 && boreRadius(p) < plates) warnings.push(tr('The bore is as wide as the drum the rollers sit round.'));
  const { solid, height } = addHubAndBore(body, 0, W, p, q, warnings, plates);
  return {
    solid,
    outline: [disc(R, q), ...(boreShape(p, q) ?? [])],
    info: [
      lengthInfo(tr('Outside diameter'), 2 * R),
      lengthInfo(tr('Width'), W),
      { label: tr('Rollers'), value: String(N) },
      lengthInfo(tr('Roller diameter'), 2 * r0, 1),
      lengthInfo(tr('Roller length'), L, 1),
      lengthInfo(tr('Total height'), height),
      travel(2 * R),
    ],
    warnings,
  };
}

export const mecanumWheel: GeneratorDef = {
  id: 'mecanum-wheel',
  name: tr('Mecanum wheel'),
  category: 'wheels',
  summary: tr('Wheel with rollers set at 45°, for a robot that drives sideways.'),
  groups: [
    {
      title: trx('part', 'Wheel'),
      params: [
        {
          type: 'select',
          key: 'size',
          label: tr('Size'),
          default: '100',
          options: [...MECANUM_SIZES.map((value) => ({ value, label: `${value} mm` })), { value: 'custom', label: trx('wheel', 'Custom') }],
        },
        { type: 'number', key: 'diameter', label: tr('Diameter'), default: 100, min: MECANUM.diameter.min, max: MECANUM.diameter.max, step: 1, unit: 'mm', visible: isCustom, shown: ofSize('diameter') },
        { type: 'number', key: 'width', label: tr('Width'), default: 50, min: MECANUM.width.min, max: MECANUM.width.max, step: 0.5, unit: 'mm', visible: isCustom, shown: ofSize('width') },
        { type: 'number', key: 'rollers', label: tr('Rollers'), default: 9, min: MECANUM.rollers.min, max: MECANUM.rollers.max, step: 1, integer: true, visible: isCustom, shown: ofSize('rollers') },
        {
          type: 'select',
          key: 'hand',
          label: trx('wheel', 'Hand'),
          default: 'left',
          help: tr('Selects which way the rollers lean.'),
          options: [
            { value: 'left', label: trx('wheel', 'Left'), note: tr('For the front left and rear right corners.') },
            { value: 'right', label: trx('wheel', 'Right'), note: tr('For the front right and rear left corners.') },
          ],
        },
      ],
    },
    hubGroup({ height: 0, diameter: 20, setScrews: 1, setScrewDiameter: 3.3 }),
    boreGroup({ type: 'round', diameter: 6 }),
  ],
  // The other hand's wheel is this one's mirror image in Y: the rollers stand evenly round from +X, and the bore's flat and key face +X.
  mirrored: (p) => ({ ...p, hand: str(p, 'hand') === 'right' ? 'left' : 'right' }),
  build: buildMecanum,
};

export const WHEELS: GeneratorDef[] = [wheel, mecanumWheel];
