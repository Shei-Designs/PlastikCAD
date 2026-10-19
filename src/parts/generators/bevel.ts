import { addHubAndBore, boreGroup, boreRadius, hubGroup } from '../features';
import { clampBacklash, gearOutline, standardTooth, toothProfile } from '../involute';
import { arcSegments, toDeg, TAU } from '../math2d';
import { triangulate } from '../meshUtil';
import { intersection, mirror, revolve, translate } from '../types';
import type { Polygon, Quality, Solid, Vec2 } from '../types';
import { degrees, mm, num } from './types';
import type { GeneratorDef, InfoItem, Params } from './types';

// Straight bevel gear for shafts at 90°.
//
// Tooth form uses Tredgold's approximation: the profile on the back cone at
// the large end is that of a spur gear with teeth/cos(pitch angle) teeth, and
// every tooth surface is a straight line to the pitch cone apex. That is the
// usual construction for cut and printed bevel gears.

export const bevelGear: GeneratorDef = {
  id: 'bevel',
  name: 'Bevel gear',
  category: 'gears',
  summary: 'Conical gear for shafts meeting at 90°.',
  groups: [
    {
      title: 'Gear',
      params: [
        {
          type: 'number',
          key: 'module',
          label: 'Module',
          help: 'Tooth size at the large end. Both gears of a pair share it.',
          default: 2,
          min: 0.3,
          max: 20,
          step: 0.1,
          unit: 'mm',
        },
        { type: 'number', key: 'teeth', label: 'Teeth', default: 20, min: 8, max: 200, step: 1, integer: true },
        {
          type: 'number',
          key: 'mateTeeth',
          label: 'Mating gear teeth',
          help: 'Sets the mating gear\'s tooth count, which determines the cone angle.',
          default: 20,
          min: 8,
          max: 200,
          step: 1,
          integer: true,
        },
        {
          type: 'number',
          key: 'faceWidth',
          label: 'Face width',
          help: 'Tooth length along the cone. Usually no more than a third of the cone distance.',
          default: 8,
          min: 1,
          max: 100,
          step: 0.5,
          unit: 'mm',
        },
        {
          type: 'number',
          key: 'baseThickness',
          label: 'Base thickness',
          help: 'Material behind the tooth roots at the large end.',
          default: 3,
          min: 0.5,
          max: 50,
          step: 0.5,
          unit: 'mm',
        },
      ],
    },
    {
      title: 'Teeth',
      params: [
        { type: 'number', key: 'pressureAngle', label: 'Pressure angle', default: 20, min: 14.5, max: 30, step: 0.5, unit: '°' },
        {
          type: 'number',
          key: 'backlash',
          label: 'Backlash',
          help: 'Thins each tooth by this amount so printed gears run freely.',
          default: 0.1,
          min: 0,
          max: 1,
          step: 0.01,
          unit: 'mm',
        },
        { type: 'number', key: 'clearance', label: 'Root clearance', default: 0.25, min: 0.1, max: 0.5, step: 0.05 },
      ],
    },
    hubGroup({ diameter: 16 }),
    boreGroup({ diameter: 5 }),
  ],
  build(p: Params, q: Quality) {
    const warnings: string[] = [];
    const z = Math.round(num(p, 'teeth'));
    const zMate = Math.round(num(p, 'mateTeeth'));
    const m = num(p, 'module');
    const delta = Math.atan2(z, zMate); // pitch cone half-angle
    const sinD = Math.sin(delta);
    const cosD = Math.cos(delta);
    const r = (m * z) / 2;
    const coneDistance = r / sinD;
    let face = num(p, 'faceWidth');
    if (face > coneDistance / 2) {
      face = coneDistance / 2;
      warnings.push(`Face width was limited to ${face.toFixed(1)} mm (half the cone distance).`);
    } else if (face > coneDistance / 3 + 1e-6) {
      warnings.push('Face width is more than a third of the cone distance; the small ends of the teeth get very thin.');
    }

    // Spur gear equivalent on the back cone.
    const spec = standardTooth({
      teeth: z / cosD,
      module: m,
      pressureAngle: num(p, 'pressureAngle'),
      backlash: clampBacklash(num(p, 'backlash'), m, warnings),
      clearance: num(p, 'clearance'),
    });
    const profile = toothProfile(spec, q);
    if (profile.undercut) warnings.push('The teeth are undercut; use more teeth or a larger pressure angle for stronger teeth.');
    // Angles around the gear axis are 1/cos(delta) times those on the developed back cone.
    const wrapped = { ...profile, flank: profile.flank.map((s) => ({ r: s.r, half: s.half / cosD })) };
    const developed = gearOutline(wrapped, z, q);
    const rv = profile.pitchRadius;

    // Coordinates: axis = Z, pitch apex at the origin, gear body below it.
    // A back-cone point at distance t outward from the pitch circle sits at
    // radius r + t·cos(delta), height -coneDistance·cos(delta) + t·sin(delta).
    const backCone = (t: number, scale = 1): Vec2 => [scale * (r + t * cosD), scale * (-coneDistance * cosD + t * sinD)];
    const addendum = profile.outerRadius - rv;
    const dedendum = rv - profile.rootRadius;
    const tOut = addendum + m;
    const tBack = Math.min(dedendum + num(p, 'baseThickness'), (0.98 * r) / cosD);
    const k = (coneDistance - face) / coneDistance;
    const back = backCone(-tBack);
    const front = backCone(-dedendum, k);

    // Tooth cone: every outline point joined to the apex, closed off by a
    // vertical skirt down to a flat floor below the gear.
    const over = 1.02;
    const floor = back[1] - 1;
    const ring: Polygon = [];
    const positions: number[] = [0, 0, 0];
    for (const [x, y] of developed) {
      const radius = Math.hypot(x, y);
      const angle = Math.atan2(y, x);
      const [rho, a] = backCone(radius - rv, over);
      ring.push([rho * Math.cos(angle), rho * Math.sin(angle)]);
      positions.push(rho * Math.cos(angle), rho * Math.sin(angle), a);
    }
    const n = ring.length;
    for (const [x, y] of ring) positions.push(x, y, floor);
    const triangles: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const pi = 1 + i;
      const pj = 1 + j;
      const si = 1 + n + i;
      const sj = 1 + n + j;
      triangles.push(0, pi, pj, pi, si, sj, pi, sj, pj);
    }
    const cap = triangulate(ring);
    for (let i = 0; i < cap.length; i += 3) triangles.push(1 + n + cap[i], 1 + n + cap[i + 2], 1 + n + cap[i + 1]);
    const teeth: Solid = { op: 'mesh', positions, triangles };

    // Blank: the region between the back cone and the front cone, with flat
    // back and front faces inside the tooth roots.
    const blank: Polygon = [backCone(tOut), back, [0, back[1]], [0, front[1]], front, backCone(tOut, k)];
    const segments = Math.max(48, arcSegments(q, TAU));
    // Height of the tooth tips at the front, which rise above the flat front face.
    const peak = backCone(addendum, k)[1] - back[1];
    const gear = translate(intersection(teeth, revolve(blank, segments)), [0, 0, -back[1]]);

    if (boreRadius(p) > front[0] - 0.5 * m) warnings.push('The bore breaks into the teeth at the small end.');
    if (num(p, 'hubHeight') > 0 && num(p, 'hubDiameter') / 2 > back[0]) warnings.push('The hub is wider than the back face of the gear.');

    // The hub goes on the back (large) face so it cannot foul the mating gear: turn the gear over
    // (a mirror, so the D-flat and set screws keep their sides), add hub and bore, turn it back so
    // the part rests on the hub.
    const flipped = translate(mirror(gear, [0, 0, 1]), [0, 0, peak]);
    const withHub = addHubAndBore(flipped, 0, peak, p, q, warnings, backCone(tOut)[0]);
    const solid = translate(mirror(withHub.solid, [0, 0, 1]), [0, 0, withHub.height]);

    const info: InfoItem[] = [
      { label: 'Pitch diameter', value: mm(2 * r) },
      { label: 'Outside diameter', value: mm(2 * (r + addendum * cosD)) },
      { label: 'Pitch cone angle', value: degrees(toDeg(delta)) },
      { label: 'Cone distance', value: mm(coneDistance) },
      { label: 'Apex to mounting face', value: mm(-back[1] + (withHub.height - peak)) },
      { label: 'Ratio', value: `1 : ${(zMate / z).toFixed(3).replace(/\.?0+$/, '')}` },
      { label: 'Total height', value: mm(withHub.height) },
    ];
    return { solid, info, warnings };
  },
};

