import { addHubAndBore, boreGroup, boreRadius, boreShape, handParam, hubGroup, isLeftHanded } from '../features';
import { clampBacklash, gearOutline, minShiftWithoutUndercut, ringOutline, standardTooth, toothProfile } from '../involute';
import { arc, arcSegments, circle, deg, toDeg, TAU } from '../math2d';
import { shearedPrism } from '../meshUtil';
import { extrude, intersection, mirror, translate, union } from '../types';
import type { Polygon, Quality, Solid, Vec2 } from '../types';
import { bool, mm, num } from './types';
import type { GeneratorDef, InfoItem, ParamDef, ParamGroup, Params } from './types';

const moduleParam: ParamDef = {
  type: 'number',
  key: 'module',
  label: 'Module',
  help: 'Tooth size: pitch diameter ÷ number of teeth. Meshing gears must share the same module.',
  default: 2,
  min: 0.3,
  max: 20,
  step: 0.1,
  unit: 'mm',
};

const teethParam = (def: number, min = 5): ParamDef => ({
  type: 'number',
  key: 'teeth',
  label: 'Teeth',
  default: def,
  min,
  max: 300,
  step: 1,
  integer: true,
});

const faceWidthParam: ParamDef = {
  type: 'number',
  key: 'faceWidth',
  label: 'Face width',
  help: 'Thickness of the toothed part.',
  default: 10,
  min: 1,
  max: 200,
  step: 0.5,
  unit: 'mm',
};

const toothFormGroup = (opts: { shift?: boolean } = {}): ParamGroup => ({
  title: 'Tooth form',
  params: [
    {
      type: 'number',
      key: 'pressureAngle',
      label: 'Pressure angle',
      help: '20° is the modern standard. Meshing gears must use the same angle.',
      default: 20,
      min: 14.5,
      max: 30,
      step: 0.5,
      unit: '°',
    },
    ...(opts.shift
      ? [
          {
            type: 'number',
            key: 'profileShift',
            label: 'Profile shift',
            help: 'Shifts the teeth outward (positive) to strengthen small pinions and avoid undercut. Changes the center distance.',
            default: 0,
            min: -0.5,
            max: 1,
            step: 0.05,
          } satisfies ParamDef,
        ]
      : []),
    {
      type: 'number',
      key: 'backlash',
      label: 'Backlash',
      help: 'Thins each tooth by this amount so printed gears run freely. 0.05–0.2 mm is typical for FDM.',
      default: 0.1,
      min: 0,
      max: 1,
      step: 0.01,
      unit: 'mm',
    },
    {
      type: 'number',
      key: 'clearance',
      label: 'Root clearance',
      help: 'Extra depth at the tooth root as a fraction of the module (0.25 is standard).',
      default: 0.25,
      min: 0.1,
      max: 0.5,
      step: 0.05,
    },
  ],
});

/** Twist slices so that helical flanks stay smooth without wasting triangles. */
const twistDivisions = (twistDeg: number, q: Quality) => Math.max(2, Math.ceil(Math.abs(twistDeg) / (360 / q.circle)));

type GearKind = 'spur' | 'helical' | 'herringbone';

function involuteGear(kind: GearKind): GeneratorDef {
  const helical = kind !== 'spur';
  const main: ParamDef[] = [moduleParam, teethParam(kind === 'spur' ? 20 : 24), faceWidthParam];
  if (helical) {
    main.push({
      type: 'number',
      key: 'helixAngle',
      label: 'Helix angle',
      help: 'Angle of the teeth to the axis. Meshing gears need the same angle and opposite hands.',
      default: kind === 'helical' ? 20 : 30,
      min: 1,
      max: 45,
      step: 1,
      unit: '°',
    });
    main.push(
      kind === 'helical'
        ? handParam
        : { ...handParam, help: 'Which way the lower half of the teeth winds. A herringbone gear and its mate have opposite hands.' },
    );
  }

  const names: Record<GearKind, [string, string]> = {
    spur: ['Spur gear', 'Straight-toothed involute gear.'],
    helical: ['Helical gear', 'Angled teeth for smoother, quieter running.'],
    herringbone: ['Herringbone gear', 'Double helical: quiet, self-centering, no axial thrust.'],
  };

  return {
    id: kind,
    name: names[kind][0],
    category: 'gears',
    summary: names[kind][1],
    groups: [
      { title: 'Gear', params: main },
      toothFormGroup({ shift: true }),
      hubGroup({ diameter: 16 }),
      boreGroup({ diameter: 5 }),
    ],
    build(p: Params, q: Quality) {
      const warnings: string[] = [];
      const z = Math.round(num(p, 'teeth'));
      const mn = num(p, 'module');
      const b = num(p, 'faceWidth');
      const x = num(p, 'profileShift');
      const helix = helical ? num(p, 'helixAngle') : 0;
      const spec = standardTooth({
        teeth: z,
        module: mn,
        pressureAngle: num(p, 'pressureAngle'),
        helixAngle: helix,
        profileShift: x,
        backlash: clampBacklash(num(p, 'backlash'), mn, warnings),
        clearance: num(p, 'clearance'),
      });
      const profile = toothProfile(spec, q);
      const outline = gearOutline(profile, z, q);
      const r = profile.pitchRadius;

      let body: Solid;
      if (!helical) {
        body = extrude([outline], b);
      } else {
        const sign = isLeftHanded(p) ? -1 : 1;
        const length = kind === 'herringbone' ? b / 2 : b;
        const twist = sign * toDeg((length * Math.tan(deg(helix))) / r);
        const half = extrude([outline], length, { twist, divisions: twistDivisions(twist, q) });
        body = kind === 'herringbone' ? union(half, translate(mirror(half, [0, 0, 1]), [0, 0, b])) : half;
      }

      if (profile.undercut) {
        const xMin = minShiftWithoutUndercut(z, spec.pressureAngle);
        warnings.push(
          `The teeth are undercut, which weakens them. A profile shift of ${(Math.ceil(xMin * 20) / 20).toFixed(2)} or more avoids it.`,
        );
      }
      if (profile.pointed) warnings.push('The teeth come to a point before reaching full height; reduce the profile shift.');
      if (boreRadius(p) > profile.rootRadius - 0.75 * mn) warnings.push('The bore leaves very little material below the teeth.');

      const { solid, height } = addHubAndBore(body, 0, b, p, q, warnings, profile.outerRadius);
      const bore = boreShape(p, q);

      const info: InfoItem[] = [
        { label: 'Pitch diameter', value: mm(2 * r) },
        { label: 'Outside diameter', value: mm(2 * profile.outerRadius) },
        { label: 'Root diameter', value: mm(2 * profile.rootRadius) },
      ];
      if (helical) info.push({ label: 'Transverse module', value: mm(spec.module, 3) });
      info.push({ label: 'Total height', value: mm(height) });

      return { solid, outline: bore ? [outline, ...bore] : [outline], info, warnings };
    },
  };
}

export const spurGear = involuteGear('spur');
export const helicalGear = involuteGear('helical');
export const herringboneGear = involuteGear('herringbone');

export const ringGear: GeneratorDef = {
  id: 'ring',
  name: 'Internal ring gear',
  category: 'gears',
  summary: 'Teeth on the inside, for planetary gear sets.',
  groups: [
    {
      title: 'Gear',
      params: [
        moduleParam,
        teethParam(40, 12),
        faceWidthParam,
        {
          type: 'number',
          key: 'rimThickness',
          label: 'Rim thickness',
          help: 'Material left outside the tooth roots.',
          default: 4,
          min: 0.5,
          max: 100,
          step: 0.5,
          unit: 'mm',
        },
        {
          type: 'number',
          key: 'sunTeeth',
          label: 'Sun gear teeth',
          help: 'Sets the sun gear size for the planet and ratio readouts.',
          default: 16,
          min: 5,
          max: 200,
          step: 1,
          integer: true,
        },
      ],
    },
    toothFormGroup(),
  ],
  build(p: Params, q: Quality) {
    const warnings: string[] = [];
    const z = Math.round(num(p, 'teeth'));
    const m = num(p, 'module');
    const ring = ringOutline(
      { teeth: z, module: m, pressureAngle: deg(num(p, 'pressureAngle')), backlash: clampBacklash(num(p, 'backlash'), m, warnings), clearance: num(p, 'clearance') },
      q,
    );
    const outer = ring.rootRadius + num(p, 'rimThickness');
    const shape = [circle(outer, Math.max(48, arcSegments(q, TAU))), ring.outline];
    const height = num(p, 'faceWidth');

    const sun = Math.round(num(p, 'sunTeeth'));
    const info: InfoItem[] = [
      { label: 'Pitch diameter', value: mm(2 * ring.pitchRadius) },
      { label: 'Inside diameter', value: mm(2 * ring.innerRadius) },
      { label: 'Outside diameter', value: mm(2 * outer) },
    ];
    if (sun >= z - 4) {
      warnings.push('The sun gear is too large for this ring.');
    } else {
      const planet = (z - sun) / 2;
      info.push({ label: `Planet teeth (sun ${sun}T)`, value: Number.isInteger(planet) ? `${planet}` : `${planet} — not a whole number` });
      if (!Number.isInteger(planet)) warnings.push('Ring teeth minus sun teeth must be even for the planets to fit.');
      // Planets can be evenly spaced when (ring + sun) divides by their count, and they must not touch.
      const counts = [2, 3, 4, 5, 6].filter((k) => (z + sun) % k === 0 && (sun + planet) * Math.sin(Math.PI / k) > planet + 2);
      info.push({ label: 'Evenly spaced planets', value: counts.length ? counts.join(', ') : 'none' });
      info.push({ label: 'Ratio, sun to carrier', value: `${(1 + z / sun).toFixed(3).replace(/\.?0+$/, '')} : 1` });
    }
    info.push({ label: 'Total height', value: mm(height) });
    return { solid: extrude(shape, height), outline: shape, info, warnings };
  },
};

/** Upper edge of a rack from x=0 to x=teeth·pitch (left to right), starting and ending mid tooth space. */
function rackTopEdge(o: {
  teeth: number;
  first: number;
  pitch: number;
  alpha: number;
  addendum: number;
  dedendum: number;
  backlash: number;
  fillet: number;
  pitchLine: number;
  q: Quality;
}): Vec2[] {
  const tanA = Math.tan(o.alpha);
  const cosA = Math.cos(o.alpha);
  const sinA = Math.sin(o.alpha);
  const yRoot = o.pitchLine - o.dedendum;
  const yTip = o.pitchLine + o.addendum;
  const half = (y: number) => o.pitch / 4 - o.backlash / 2 - (y - o.pitchLine) * tanA;
  const rhoMax = Math.max(0, ((o.pitch / 4 + o.backlash / 2 - o.dedendum * tanA) * cosA) / (1 - sinA));
  const rho = Math.min(o.fillet, rhoMax * 0.999);
  const s = half(yRoot + rho) + rho / cosA; // fillet center offset from the tooth center
  const wTip = Math.max(half(yTip), 0);
  const n = Math.max(2, Math.ceil(o.q.flank / 3));
  const pts: Vec2[] = [];
  for (let i = o.first; i < o.first + o.teeth; i++) {
    const xc = (i + 0.5) * o.pitch;
    if (rho > 1e-6) pts.push(...arc(xc - s, yRoot + rho, rho, -Math.PI / 2, -o.alpha, n));
    else pts.push([xc - s, yRoot]);
    pts.push([xc - wTip, yTip]);
    if (wTip > 1e-9) pts.push([xc + wTip, yTip]);
    if (rho > 1e-6) pts.push(...arc(xc + s, yRoot + rho, rho, Math.PI + o.alpha, 1.5 * Math.PI, n));
    else pts.push([xc + s, yRoot]);
  }
  return pts;
}

export const rack: GeneratorDef = {
  id: 'rack',
  name: 'Gear rack',
  category: 'gears',
  summary: 'Straight toothed bar that turns rotation into linear motion.',
  groups: [
    {
      title: 'Rack',
      params: [
        moduleParam,
        { ...teethParam(12, 2), max: 400 } as ParamDef,
        faceWidthParam,
        {
          type: 'number',
          key: 'baseHeight',
          label: 'Base height',
          help: 'Material below the tooth roots.',
          default: 6,
          min: 0.5,
          max: 100,
          step: 0.5,
          unit: 'mm',
        },
        {
          type: 'number',
          key: 'helixAngle',
          label: 'Helix angle',
          help: '0 for a straight rack. Match the helix angle of the pinion; the sign sets the slant direction.',
          default: 0,
          min: -45,
          max: 45,
          step: 1,
          unit: '°',
        },
        {
          type: 'boolean',
          key: 'herringbone',
          label: 'Herringbone',
          default: false,
          visible: (p) => num(p, 'helixAngle') !== 0,
        },
      ],
    },
    toothFormGroup(),
  ],
  build(p: Params, q: Quality) {
    const warnings: string[] = [];
    const mn = num(p, 'module');
    const n = Math.round(num(p, 'teeth'));
    const b = num(p, 'faceWidth');
    const base = num(p, 'baseHeight');
    const backlash = clampBacklash(num(p, 'backlash'), mn, warnings);
    const helix = deg(num(p, 'helixAngle'));
    const c = num(p, 'clearance');
    const an = deg(num(p, 'pressureAngle'));
    const alpha = Math.atan(Math.tan(an) / Math.cos(helix));
    const pitch = (Math.PI * mn) / Math.cos(helix);
    const length = n * pitch;
    const pitchLine = base + (1 + c) * mn;
    const top = pitchLine + mn;

    const edge = (first: number, count: number) =>
      rackTopEdge({
        teeth: count,
        first,
        pitch,
        alpha,
        addendum: mn,
        dedendum: (1 + c) * mn,
        backlash,
        fillet: (c / (1 - Math.sin(an))) * mn,
        pitchLine,
        q,
      });
    const polygon = (first: number, count: number): Polygon => {
      const x0 = first * pitch;
      const x1 = (first + count) * pitch;
      return [[x0, 0], [x1, 0], [x1, base], ...edge(first, count).reverse(), [x0, base]];
    };
    const outline = polygon(0, n);

    let solid: Solid;
    if (helix === 0) {
      solid = extrude([outline], b);
    } else {
      // Slanted teeth: shear a longer rack and trim it back to square ends.
      const herringbone = bool(p, 'herringbone');
      const shear = Math.tan(helix);
      const run = Math.abs(shear) * (herringbone ? b / 2 : b);
      const extra = Math.ceil(run / pitch) + 1;
      const long = polygon(-extra, n + 2 * extra);
      let teeth: Solid;
      if (herringbone) {
        const shifted = long.map(([x, y]): Vec2 => [x + (shear * b) / 2, y]);
        teeth = union(shearedPrism(long, b / 2, shear), translate(shearedPrism(shifted, b / 2, -shear), [0, 0, b / 2]));
      } else {
        teeth = shearedPrism(long, b, shear);
      }
      const box: Polygon = [[0, -1], [length, -1], [length, top + 1], [0, top + 1]];
      solid = intersection(teeth, translate(extrude([box], b + 2), [0, 0, -1]));
    }

    const info: InfoItem[] = [
      { label: 'Length', value: mm(length) },
      { label: 'Tooth pitch', value: mm(pitch, 3) },
      { label: 'Pitch line height', value: mm(pitchLine) },
      { label: 'Total height', value: mm(top) },
    ];
    return { solid, outline: [outline], info, warnings };
  },
};

