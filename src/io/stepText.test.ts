import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sameSolids, stepSolids } from './stepText';
import type { SolidMarks, StepSolid } from './stepText';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const file = (lines: string[]): Uint8Array => bytes(['ISO-10303-21;', 'HEADER;', "FILE_NAME('a;b','2026',(''),(''),'','','');", 'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n'));

/** A triangle of a face with corners at three points: enough of a solid for its corners to be found. */
const face = (id: number, points: [number, number, number][]): string[] => {
  const lines = [`#${id} = ADVANCED_FACE('',(#${id + 1}),#9000,.T.);`, `#${id + 1} = FACE_OUTER_BOUND('',#${id + 2},.T.);`, `#${id + 2} = EDGE_LOOP('',(${points.map((_, k) => `#${id + 10 + k * 10}`).join(',')}));`];
  points.forEach(([x, y, z], k) => {
    const at = id + 10 + k * 10;
    const next = id + 10 + ((k + 1) % points.length) * 10;
    lines.push(`#${at} = ORIENTED_EDGE('',*,*,#${at + 1},.T.);`, `#${at + 1} = EDGE_CURVE('',#${at + 2},#${next + 2},#9001,.T.);`, `#${at + 2} = VERTEX_POINT('',#${at + 3});`, `#${at + 3} = CARTESIAN_POINT('',(${x},${y},${z}.));`);
  });
  return lines;
};

describe('the names and colors a STEP file says', () => {
  it('reads each solid with its own name, or its product\'s, and its color', () => {
    const solids = stepSolids(
      file([
        // A solid named by its product, through a second representation tied to the product's own; colored as a whole.
        "#1 = PRODUCT('P-1','Bracket','',(#2));",
        "#3 = PRODUCT_DEFINITION_FORMATION('','',#1);",
        "#4 = PRODUCT_DEFINITION('design','',#3,#5);",
        "#6 = PRODUCT_DEFINITION_SHAPE('','',#4);",
        '#7 = SHAPE_DEFINITION_REPRESENTATION(#6,#8);',
        "#8 = SHAPE_REPRESENTATION('',(#90),#91);",
        "#10 = SHAPE_REPRESENTATION_RELATIONSHIP('','',#8,#11);",
        "#11 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#90,#20),#91);",
        "#20 = MANIFOLD_SOLID_BREP('',#21);",
        "#21 = CLOSED_SHELL('',(#100,#200));",
        ...face(100, [[0, 0, 0], [40, 0, 0], [0, 30, 0]]),
        ...face(200, [[0, 0, 10], [40, 0, 10], [0, 30, 10]]),
        "#30 = STYLED_ITEM('color',(#31),#20);",
        '#31 = PRESENTATION_STYLE_ASSIGNMENT((#32));',
        "#32 = SURFACE_STYLE_USAGE(.BOTH.,#33);",
        "#33 = SURFACE_SIDE_STYLE('',(#34));",
        "#34 = SURFACE_STYLE_FILL_AREA(#35);",
        "#35 = FILL_AREA_STYLE('',(#36));",
        "#36 = FILL_AREA_STYLE_COLOUR('',#37);",
        "#37 = COLOUR_RGB('',0.,0.6,0.2);",
        // A solid with a name of its own, which says more than its product's; colored face by face, two to one.
        "#40 = MANIFOLD_SOLID_BREP('Shaft; long, #1 = it''s \\X2\\00D8\\X0\\5',#41);",
        "#41 = CLOSED_SHELL('',(#300,#400,#500));",
        ...face(300, [[5, 0, 0], [5, 0, 60], [0, 5, 0]]),
        ...face(400, [[5, 0, 0], [5, 0, 60], [0, 5, 60]]),
        ...face(500, [[5, 0, 0], [0, 5, 0], [0, 5, 60]]),
        "#50 = STYLED_ITEM('',(#51),#300);",
        "#51 = PRESENTATION_STYLE_ASSIGNMENT((#52));",
        "#52 = SURFACE_STYLE_USAGE(.BOTH.,#53);",
        "#53 = SURFACE_SIDE_STYLE('',(#54));",
        "#54 = SURFACE_STYLE_FILL_AREA(#55);",
        "#55 = FILL_AREA_STYLE('',(#56));",
        "#56 = FILL_AREA_STYLE_COLOUR('',#57);",
        "#57 = DRAUGHTING_PRE_DEFINED_COLOUR('red');",
        "#58 = STYLED_ITEM('',(#51),#400);",
        "#59 = STYLED_ITEM('',(#31),#500);",
        // A solid with a hollow inside it, and no name anyone gave it.
        "#60 = BREP_WITH_VOIDS('NONE',#61,(#62));",
        "#61 = CLOSED_SHELL('',(#600));",
        "#62 = ORIENTED_CLOSED_SHELL('',*,#61,.F.);",
        ...face(600, [[1, 1, 1], [2, 1, 1], [1, 2, 1]]),
        // An entity of several kinds at once, and a typed value: read past.
        "#70 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );",
        "#71 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#70,'distance_accuracy_value','');",
      ]),
    );
    expect(solids).toEqual([
      { name: 'Bracket', color: '#009933', faces: 2, corners: [[0, 0, 0], [40, 0, 0], [0, 30, 0]] },
      { name: "Shaft; long, #1 = it's Ø5", color: '#ff0000', faces: 3, corners: [[5, 0, 0], [5, 0, 60], [0, 5, 0]] },
      { faces: 2, corners: [[1, 1, 1], [2, 1, 1], [1, 2, 1]] },
    ]);
  });

  it('reads the names a CAD program wrote, letters outside ASCII and all', () => {
    const named = stepSolids(new Uint8Array(readFileSync(fileURLToPath(new URL('../../fixtures/step/named.step', import.meta.url)))));
    expect(named?.map((s) => [s.name, s.faces])).toEqual([
      ['Bracket', 6],
      ['Shaft', 3],
      ['Knob été', 1],
    ]);
    // What a writer names by its own name is no name.
    const kit = stepSolids(new Uint8Array(readFileSync(fileURLToPath(new URL('../../fixtures/step/plate-and-post.step', import.meta.url)))));
    expect(kit?.map((s) => s.name)).toEqual([undefined, undefined]);
  });

  it('has nothing to say of a file without solids', () => {
    expect(stepSolids(file(["#1 = CARTESIAN_POINT('',(0.,0.,0.));"]))).toBeNull();
    expect(stepSolids(bytes('not a STEP file'))).toBeNull();
    expect(stepSolids(new Uint8Array(0))).toBeNull();
  });
});

describe('the solids of the text held against those that were built', () => {
  const said: StepSolid[] = [
    { name: 'Plate', faces: 6, corners: [[0, 0, 0], [40, 0, 0], [0, 30, 0]] },
    { name: 'Post', faces: 3, corners: [[5, 0, 0], [5, 0, 60]] },
    { name: 'Ball', faces: 1, corners: [[0, 0, -8]] },
  ];
  /** The corners of a solid as it was built: those given, moved and turned as a file that places its shapes does, in `unit`s. */
  const built = (faces: number, points: number[][], unit = 1, shift = [0, 0, 0]): SolidMarks => ({
    faces,
    // A quarter turn about Z, then the shift.
    corners: points.flatMap(([x, y, z]) => [-y * unit + shift[0], x * unit + shift[1], z * unit + shift[2]]),
  });
  const plate = [[0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0], [0, 0, 10], [40, 0, 10], [40, 30, 10], [0, 30, 10]];
  const post = [[5, 0, 0], [5, 0, 60]];
  const ball = [[0, 0, -8], [0, 0, 8]];

  it('takes them for the same when each is found where it should be, wherever the file placed it', () => {
    expect(sameSolids(said, [built(6, plate), built(3, post, 1, [60, 0, 0]), built(1, ball, 1, [100, 0, 20])])).toBe(true);
    // Written in inches or in meters: the one unit for the whole file.
    expect(sameSolids(said, [built(6, plate, 25.4), built(3, post, 25.4), built(1, ball, 25.4)])).toBe(true);
    expect(sameSolids(said, [built(6, plate, 1000), built(3, post, 1000), built(1, ball, 1000)])).toBe(true);
    expect(sameSolids(said, [built(6, plate, 25.4), built(3, post, 1), built(1, ball, 1)])).toBe(false);
  });

  it('does not when there are more or fewer of them, when they come in another order, or when one is another shape', () => {
    // A shape placed twice is listed once.
    expect(sameSolids(said, [built(6, plate), built(3, post), built(3, post, 1, [20, 0, 0]), built(1, ball)])).toBe(false);
    expect(sameSolids(said, [built(3, post), built(6, plate), built(1, ball)])).toBe(false);
    // A post of another length; a plate of another width.
    expect(sameSolids(said, [built(6, plate), built(3, [[5, 0, 0], [5, 0, 50]]), built(1, ball)])).toBe(false);
    expect(sameSolids(said, [built(6, plate.map(([x, y, z]) => [x * 1.1, y, z])), built(3, post), built(1, ball)])).toBe(false);
    // With one corner to go by, or none, the faces are counted instead.
    expect(sameSolids(said, [built(6, plate), built(3, post), built(2, ball)])).toBe(false);
    expect(sameSolids([], [])).toBe(true);
  });
});
