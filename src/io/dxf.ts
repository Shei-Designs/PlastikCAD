import { APP_NAME } from '../appInfo';
import type { Polygon } from '../model/types';
import { traceArcs } from './arcs';
import { encodeText, fmt } from './format';
import { bounds } from './outline';

const LAYER = 'OUTLINE';

// Written as DXF R12 (AC1009) with POLYLINE/VERTEX/SEQEND rather than R2000
// LWPOLYLINE: R12 needs no handles, subclass markers, BLOCK_RECORD tables or
// OBJECTS section, all of which AutoCAD insists on for AC1015 files, and every
// importer (AutoCAD, Fusion, FreeCAD, LibreCAD, Inkscape, laser software) reads
// it. $INSUNITS=4 (mm) is not an R12 variable, but readers that know it use it
// and the rest skip it.
//
// Round things go out round: a contour that is a circle as a CIRCLE, and the
// arcs of any other as bulges on its polyline (see arcs.ts), which R12 has.
export function writeDxf(outline: Polygon[], name: string): Uint8Array {
  const out: (string | number)[] = [];
  const add = (...pairs: (string | number)[]) => out.push(...pairs);
  const contours = outline.filter((c) => c.length >= 2);
  const b = contours.length ? bounds(contours) : { min: [0, 0], max: [0, 0] };

  add(999, `${APP_NAME} - ${name.replace(/[\r\n]+/g, ' ')} - units: millimeters`);
  add(0, 'SECTION', 2, 'HEADER');
  add(9, '$ACADVER', 1, 'AC1009');
  add(9, '$INSUNITS', 70, 4);
  add(9, '$MEASUREMENT', 70, 1);
  add(9, '$EXTMIN', 10, fmt(b.min[0]), 20, fmt(b.min[1]), 30, 0);
  add(9, '$EXTMAX', 10, fmt(b.max[0]), 20, fmt(b.max[1]), 30, 0);
  add(0, 'ENDSEC');

  add(0, 'SECTION', 2, 'TABLES');
  add(0, 'TABLE', 2, 'LTYPE', 70, 1);
  add(0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, 0);
  add(0, 'ENDTAB');
  add(0, 'TABLE', 2, 'LAYER', 70, 1);
  add(0, 'LAYER', 2, LAYER, 70, 0, 62, 7, 6, 'CONTINUOUS');
  add(0, 'ENDTAB');
  add(0, 'ENDSEC');

  add(0, 'SECTION', 2, 'ENTITIES');
  for (const contour of contours) {
    const traced = traceArcs(contour);
    if ('circle' in traced) {
      add(0, 'CIRCLE', 8, LAYER, 10, fmt(traced.circle.center[0]), 20, fmt(traced.circle.center[1]), 30, 0, 40, fmt(traced.circle.radius));
      continue;
    }
    add(0, 'POLYLINE', 8, LAYER, 66, 1, 70, 1, 10, 0, 20, 0, 30, 0); // 70=1: closed
    // Each vertex is where a side begins: the last side leads back to the first vertex. A side that is an
    // arc is said by its bulge, the tangent of a quarter of the angle it goes round, counterclockwise positive.
    let [x, y] = traced.start;
    for (const side of traced.sides) {
      add(0, 'VERTEX', 8, LAYER, 10, fmt(x), 20, fmt(y), 30, 0);
      if (side.arc) add(42, fmt(Math.tan(side.arc.sweep / 4), 9));
      [x, y] = side.to;
    }
    add(0, 'SEQEND', 8, LAYER);
  }
  add(0, 'ENDSEC');
  add(0, 'EOF');

  return encodeText(out.join('\r\n') + '\r\n');
}
