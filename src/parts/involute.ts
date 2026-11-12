// Involute tooth geometry.
//
// External teeth are generated the way a real gear is cut: a rack cutter
// (straight flanks, rounded tip) rolls on the pitch circle and the tooth is
// whatever the cutter leaves behind. The straight flank produces the involute,
// the rounded tip produces the trochoidal root fillet, and for low tooth counts
// the fillet eats into the involute (undercut) exactly as it would on a hobbed
// gear, so small pinions still mesh without interference.
import { tr } from '../i18n';
import { dedupe, TAU } from './math2d';
import type { Polygon, Quality, Vec2 } from './types';
import { lengthFixed, said } from '../units';

export interface ToothSpec {
  /** Tooth count. May be fractional (virtual tooth count of a bevel gear). */
  teeth: number;
  /** Transverse module, mm. */
  module: number;
  /** Transverse pressure angle, radians. */
  pressureAngle: number;
  /** Tip circle radius minus pitch radius, mm (profile shift included). */
  addendum: number;
  /** Pitch radius minus root circle radius, mm (profile shift included). */
  dedendum: number;
  /** Profile shift distance x·m, mm. */
  shift: number;
  /** Amount the tooth is thinned along the pitch circle, mm. */
  backlash: number;
  /** Tip rounding radius of the generating rack (root fillet), mm. */
  filletRadius: number;
}

export interface FlankSample {
  /** Radius, mm. */
  r: number;
  /** Angular half-thickness of the tooth at that radius, radians. */
  half: number;
}

export interface ToothProfile {
  /** One flank from the root circle to the tip circle. */
  flank: FlankSample[];
  pitchRadius: number;
  baseRadius: number;
  rootRadius: number;
  outerRadius: number;
  undercut: boolean;
  /** True when the flanks meet before reaching the nominal tip circle. */
  pointed: boolean;
}

export const inv = (a: number) => Math.tan(a) - a;

/** The most backlash a tooth of this module can give up and still have two flanks: 0.4 of the circular pitch. */
export const maxBacklash = (module: number) => 0.4 * Math.PI * module;

/** Backlash held to what the module allows, with a warning when it had to be reduced. */
export function clampBacklash(backlash: number, module: number, warnings: string[]): number {
  const limit = maxBacklash(module);
  if (backlash <= limit) return backlash;
  warnings.push(said((unit) => tr('Backlash was limited to {limit} so the teeth keep two flanks.', { limit: lengthFixed(limit, unit, 2) })));
  return limit;
}

export interface StandardToothOptions {
  teeth: number;
  /** Normal module, mm. */
  module: number;
  /** Normal pressure angle, degrees. */
  pressureAngle: number;
  /** Helix angle at the pitch circle, degrees. */
  helixAngle?: number;
  /** Profile shift coefficient x. */
  profileShift?: number;
  backlash?: number;
  /** Root clearance coefficient c* (0.25 is standard). */
  clearance?: number;
}

/** ISO 53 style full-depth tooth; for helical gears the inputs are in the normal plane. */
export function standardTooth(o: StandardToothOptions): ToothSpec {
  const beta = ((o.helixAngle ?? 0) * Math.PI) / 180;
  const an = (o.pressureAngle * Math.PI) / 180;
  const x = o.profileShift ?? 0;
  const c = o.clearance ?? 0.25;
  const mn = o.module;
  return {
    teeth: o.teeth,
    module: mn / Math.cos(beta),
    pressureAngle: Math.atan(Math.tan(an) / Math.cos(beta)),
    addendum: (1 + x) * mn,
    dedendum: (1 + c - x) * mn,
    shift: x * mn,
    backlash: o.backlash ?? 0,
    // Largest fillet that still stays inside the clearance zone.
    filletRadius: (c / (1 - Math.sin(an))) * mn,
  };
}

/** Smallest profile shift coefficient that avoids undercut. */
export const minShiftWithoutUndercut = (teeth: number, pressureAngleRad: number) =>
  1 - (teeth * Math.sin(pressureAngleRad) ** 2) / 2;

function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-14) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + t * rx, a[1] + t * ry];
}

/** Pitch and root circle radii of a tooth, which need no flank: the root circle never closes below 0.05 module. */
export function toothRadii(spec: ToothSpec): { pitch: number; root: number } {
  const r = (spec.teeth * spec.module) / 2;
  return { pitch: r, root: Math.max(r - spec.dedendum, 0.05 * spec.module) };
}

export function toothProfile(spec: ToothSpec, q: Quality): ToothProfile {
  const { teeth: z, module: m, pressureAngle: alpha } = spec;
  const { pitch: r, root: rf } = toothRadii(spec);
  const rb = r * Math.cos(alpha);
  const ra = Math.max(r + spec.addendum, rf + 0.05 * m);
  const tanA = Math.tan(alpha);
  const sinA = Math.sin(alpha);
  const cosA = Math.cos(alpha);

  // Rack frame: s along the pitch line (0 = center of the rack tooth, i.e. the
  // center of the gear's tooth space), h = depth below the rolling pitch line.
  const hTip = r - rf;
  const halfWidth = (h: number) => (Math.PI * m) / 4 + spec.backlash / 2 - (h + spec.shift) * tanA;
  const rhoMax = Math.max(0, (halfWidth(hTip) * cosA) / (1 - sinA));
  const rho = Math.min(spec.filletRadius, rhoMax);
  const hc = hTip - rho;
  const sc = Math.max(0, halfWidth(hc) - rho / cosA);

  // Position in the gear frame of rack point (s, h) after the gear has turned
  // by theta. The tooth space is centered on +Y.
  const roll = (s: number, h: number, theta: number): Vec2 => {
    const u = s + r * theta;
    const v = r - h;
    return [u * Math.cos(theta) - v * Math.sin(theta), u * Math.sin(theta) + v * Math.cos(theta)];
  };

  // Root fillet: envelope of the rounded cutter tip. The contact normal always
  // passes through the pitch point, which gives theta for each arc direction.
  const nFillet = Math.max(4, Math.ceil(q.flank * 0.6));
  const fillet: Vec2[] = [];
  for (let i = 0; i <= nFillet; i++) {
    const phi = ((Math.PI / 2 - alpha) * i) / nFillet;
    const theta = (hc * Math.tan(phi) - sc) / r;
    fillet.push(roll(sc + rho * Math.sin(phi), hc + rho * Math.cos(phi), theta));
  }

  // Involute: envelope of the straight flank, from the end of the fillet (or
  // the base circle, whichever comes first) up to the tip circle.
  const hLimit = r * sinA * sinA; // deeper flank points would cut below the base circle
  const hT = hc + rho * sinA;
  const undercut = hT > hLimit + 1e-9;
  const hStart = Math.min(hT, hLimit);
  const hEnd = -(Math.sqrt(Math.max(ra * ra - rb * rb, 0)) - r * sinA) * sinA;
  const involute: Vec2[] = [];
  if (hEnd < hStart) {
    const n = Math.max(2, q.flank);
    for (let i = 0; i <= n; i++) {
      const h = hStart + ((hEnd - hStart) * i) / n;
      const s = halfWidth(h);
      involute.push(roll(s, h, (h / tanA - s) / r));
    }
  }

  let curve: Vec2[];
  if (undercut && involute.length > 1) {
    // The fillet crosses the involute; keep the fillet up to the crossing and
    // the involute beyond it.
    let hit: { i: number; j: number; p: Vec2 } | null = null;
    for (let i = 0; i < fillet.length - 1 && !hit; i++)
      for (let j = 0; j < involute.length - 1; j++) {
        const p = segmentIntersection(fillet[i], fillet[i + 1], involute[j], involute[j + 1]);
        if (p) {
          hit = { i, j, p };
          break;
        }
      }
    if (hit) {
      curve = [...fillet.slice(0, hit.i + 1), hit.p, ...involute.slice(hit.j + 1)];
    } else {
      const r0 = Math.hypot(involute[0][0], involute[0][1]);
      curve = [...fillet.filter((p) => Math.hypot(p[0], p[1]) < r0), ...involute];
    }
  } else {
    curve = [...fillet, ...involute.slice(1)];
  }

  // Convert to (radius, half-thickness) and clip at the tip circle and at the
  // tooth center line (pointed teeth).
  const halfPitch = Math.PI / z;
  const flank: FlankSample[] = [];
  let pointed = false;
  for (const [x, y] of curve) {
    const sample = { r: Math.hypot(x, y), half: halfPitch - Math.atan2(x, y) };
    const prev = flank[flank.length - 1];
    if (prev && sample.r <= prev.r + 1e-9) continue;
    if (prev && (sample.r > ra + 1e-9 || sample.half < 0)) {
      let t = 1;
      if (sample.r > ra) t = Math.min(t, (ra - prev.r) / (sample.r - prev.r));
      if (sample.half < 0) {
        const tp = prev.half / (prev.half - sample.half);
        if (tp < t) {
          t = tp;
          pointed = true;
        }
      }
      flank.push({ r: prev.r + (sample.r - prev.r) * t, half: Math.max(0, prev.half + (sample.half - prev.half) * t) });
      break;
    }
    flank.push(sample);
  }

  return {
    flank,
    pitchRadius: r,
    baseRadius: rb,
    rootRadius: rf,
    outerRadius: flank[flank.length - 1].r,
    undercut,
    pointed,
  };
}

/** Angular half-thickness of the tooth at radius `radius` (linear interpolation between samples). */
export function halfThicknessAt(profile: ToothProfile, radius: number): number {
  const f = profile.flank;
  if (radius <= f[0].r) return f[0].half;
  for (let i = 1; i < f.length; i++) {
    if (radius <= f[i].r) {
      const t = (radius - f[i - 1].r) / (f[i].r - f[i - 1].r);
      return f[i - 1].half + (f[i].half - f[i - 1].half) * t;
    }
  }
  return f[f.length - 1].half;
}

/** Points along a circular arc strictly between two angles (ends excluded). */
function innerArc(radius: number, a0: number, a1: number, q: Quality): Vec2[] {
  const n = Math.ceil((Math.abs(a1 - a0) / TAU) * q.circle);
  const pts: Vec2[] = [];
  for (let i = 1; i < n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return pts;
}

/** Closed CCW outline of an external gear. Tooth 0 is centered on +X (rotated by `phase`). */
export function gearOutline(profile: ToothProfile, teeth: number, q: Quality, phase = 0): Polygon {
  const f = profile.flank;
  const root = f[0];
  const tip = f[f.length - 1];
  const pitch = TAU / teeth;
  const pts: Vec2[] = [];
  for (let i = 0; i < teeth; i++) {
    const c = phase + i * pitch;
    for (const s of f) pts.push([s.r * Math.cos(c - s.half), s.r * Math.sin(c - s.half)]);
    pts.push(...innerArc(tip.r, c - tip.half, c + tip.half, q));
    if (tip.half > 1e-9) for (let k = f.length - 1; k >= 0; k--) pts.push([f[k].r * Math.cos(c + f[k].half), f[k].r * Math.sin(c + f[k].half)]);
    else for (let k = f.length - 2; k >= 0; k--) pts.push([f[k].r * Math.cos(c + f[k].half), f[k].r * Math.sin(c + f[k].half)]);
    pts.push(...innerArc(root.r, c + root.half, c + pitch - root.half, q));
  }
  return dedupe(pts, 1e-9);
}

export interface RingSpec {
  teeth: number;
  module: number;
  /** Radians. */
  pressureAngle: number;
  backlash: number;
  /** Root clearance coefficient. */
  clearance: number;
}

export interface RingProfile {
  /** CCW outline of the toothed hole. */
  outline: Polygon;
  pitchRadius: number;
  /** Radius of the tooth tips (smallest radius of the hole). */
  innerRadius: number;
  /** Radius of the tooth roots (largest radius of the hole). */
  rootRadius: number;
}

/**
 * Internal (ring) gear. The hole has the shape of the mating external gear's
 * teeth: involute flanks between the ring's tip circle and its root circle.
 */
export function ringOutline(spec: RingSpec, q: Quality): RingProfile {
  const { teeth: z, module: m, pressureAngle: alpha } = spec;
  const r = (z * m) / 2;
  const rb = r * Math.cos(alpha);
  // The involute does not exist below the base circle, so short teeth are capped there.
  const ri = Math.max(r - m, rb + 0.02 * m);
  const ro = r + (1 + spec.clearance) * m;
  const spaceHalf = ((Math.PI * m) / 2 + spec.backlash) / (2 * r);
  const halfAt = (radius: number) => spaceHalf + inv(alpha) - inv(Math.acos(rb / radius));

  const n = Math.max(3, q.flank);
  const flank: FlankSample[] = [];
  for (let i = 0; i <= n; i++) {
    // Uniform in tangent length, which is denser near the base circle where the curvature is highest.
    const t0 = Math.sqrt(ri * ri - rb * rb);
    const t1 = Math.sqrt(ro * ro - rb * rb);
    const t = t0 + ((t1 - t0) * i) / n;
    const radius = Math.sqrt(rb * rb + t * t);
    const half = halfAt(radius);
    if (half < 0) {
      const prev = flank[flank.length - 1];
      if (prev) {
        const k = prev.half / (prev.half - half);
        flank.push({ r: prev.r + (radius - prev.r) * k, half: 0 });
      }
      break;
    }
    flank.push({ r: radius, half });
  }

  const inner = flank[0];
  const outer = flank[flank.length - 1];
  const pitch = TAU / z;
  const pts: Vec2[] = [];
  for (let i = 0; i < z; i++) {
    const c = i * pitch;
    for (const s of flank) pts.push([s.r * Math.cos(c - s.half), s.r * Math.sin(c - s.half)]);
    pts.push(...innerArc(outer.r, c - outer.half, c + outer.half, q));
    for (let k = flank.length - (outer.half > 1e-9 ? 1 : 2); k >= 0; k--)
      pts.push([flank[k].r * Math.cos(c + flank[k].half), flank[k].r * Math.sin(c + flank[k].half)]);
    pts.push(...innerArc(inner.r, c + inner.half, c + pitch - inner.half, q));
  }
  return { outline: dedupe(pts, 1e-9), pitchRadius: r, innerRadius: inner.r, rootRadius: outer.r };
}
