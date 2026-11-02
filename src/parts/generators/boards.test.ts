import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from '../evaluate';
import { QUALITY } from '../types';
import { ALL_BOARDS, BOARDS, arduino, esp32, jetson, raspberryPi } from './boards';
import { defaultParams } from './types';
import type { GeneratorDef, Params } from './types';

beforeAll(async () => {
  await initKernel();
});

const q = QUALITY.normal;
const params = (def: GeneratorDef, over: Params = {}): Params => ({ ...defaultParams(def), ...over });
const made = (def: GeneratorDef, over: Params = {}) => {
  const r = def.build(params(def, over), q);
  return { ...r, stats: evaluate(r.solid).stats };
};
const extent = (s: { min: number[]; max: number[] }, axis: number) => s.max[axis] - s.min[axis];
const disc = (d: number) => (Math.PI / 4) * d * d;

describe('dev board mounts', () => {
  it('builds every board in every form', () => {
    for (const def of BOARDS)
      for (const board of ALL_BOARDS.filter((b) => def.groups[0].params[0].type === 'select' && def.groups[0].params[0].options.some((o) => o.value === b.id)))
        for (const form of ['standoffs', 'holes', 'blank', 'corners']) {
          const r = made(def, { board: board.id, form });
          expect(r.stats.volume, `${board.id} ${form}`).toBeGreaterThan(0);
        }
  });

  it('every board has its holes inside its outline and an M-size the drills know', () => {
    for (const b of ALL_BOARDS) {
      for (const [x, y] of b.holes) {
        expect(x, b.id).toBeGreaterThan(0);
        expect(x, b.id).toBeLessThan(b.length);
        expect(y, b.id).toBeGreaterThan(0);
        expect(y, b.id).toBeLessThan(b.width);
      }
      if (b.holes.length) expect(b.holeDiameter, b.id).toBeGreaterThan(0);
    }
  });

  it('puts Pi standoffs 58 × 49 mm apart, drilled for the screw', () => {
    const r = made(raspberryPi, { board: 'pi4', form: 'standoffs', postHeight: 6, postDiameter: 6, holeKind: 'tap' });
    expect(r.warnings).toEqual([]);
    // Four posts: their centers span 58 × 49, plus a radius each side.
    expect(extent(r.stats, 0)).toBeCloseTo(58 + 6, 1);
    expect(extent(r.stats, 1)).toBeCloseTo(49 + 6, 1);
    expect(extent(r.stats, 2)).toBeCloseTo(6, 6);
    const tap = 2.1;
    expect(r.stats.volume / (4 * (disc(6) - disc(tap)) * 6)).toBeGreaterThan(0.99);
    expect(r.info.find((i) => i.label === 'Hole spacing')?.value).toBe('58.00 × 49.00 mm');
    // A base plate under them keeps its floor: the holes stop at the plate.
    const based = made(raspberryPi, { board: 'pi4', form: 'standoffs', base: 'plate', baseMargin: 3, baseThickness: 2 });
    expect(extent(based.stats, 0)).toBeCloseTo(85 + 6, 1);
    expect(extent(based.stats, 1)).toBeCloseTo(56 + 6, 1);
    expect(extent(based.stats, 2)).toBeCloseTo(8, 6);
    expect(based.stats.volume).toBeGreaterThan(r.stats.volume + 0.98 * (85 + 6) * (56 + 6) * 2 * 0.98);
  });

  it('widens posts that would leave no wall round the hole', () => {
    const r = made(arduino, { board: 'uno', form: 'standoffs', postDiameter: 3, holeKind: 'insert' });
    expect(r.warnings.some((w) => w.includes('widened'))).toBe(true);
    expect(extent(r.stats, 2)).toBeCloseTo(6, 6);
  });

  it('makes a hole template of clearance pins', () => {
    const r = made(raspberryPi, { board: 'pico', form: 'holes', holeKind: 'clearance', holeLength: 20 });
    expect(extent(r.stats, 0)).toBeCloseTo(47 + 2.4, 1);
    expect(extent(r.stats, 1)).toBeCloseTo(11.4 + 2.4, 1);
    expect(r.stats.volume / (4 * disc(2.4) * 20)).toBeGreaterThan(0.99);
  });

  it('makes a blank the size of the board, or a pocket cutter grown by the gap', () => {
    const board = made(raspberryPi, { board: 'pi-zero-2', form: 'blank', blankGap: 0, blankThickness: 1.6 });
    expect(extent(board.stats, 0)).toBeCloseTo(65, 3);
    expect(extent(board.stats, 1)).toBeCloseTo(30, 3);
    expect(extent(board.stats, 2)).toBeCloseTo(1.6, 6);
    // The corners are rounded and the holes are through it.
    expect(board.stats.volume).toBeLessThan(65 * 30 * 1.6 - 4 * disc(2.75) * 1.6 * 0.99);
    const pocket = made(raspberryPi, { board: 'pi-zero-2', form: 'blank', blankGap: 0.5, blankThickness: 3 });
    expect(extent(pocket.stats, 0)).toBeCloseTo(66, 3);
    expect(extent(pocket.stats, 1)).toBeCloseTo(31, 3);
    expect(pocket.stats.volume).toBeGreaterThan(66 * 31 * 3 * 0.99);
  });

  it('holds a board without holes between corner stops, and says so when standoffs were asked for', () => {
    const r = made(esp32, { board: 'nodemcu-32s', form: 'standoffs' });
    expect(r.warnings.some((w) => w.includes('no mounting holes'))).toBe(true);
    const stops = made(esp32, { board: 'nodemcu-32s', form: 'corners', stopGap: 0.3, stopThickness: 2, stopLength: 8, stopHeight: 5 });
    expect(extent(stops.stats, 0)).toBeCloseTo(48.3 + 2 * 0.3 + 2 * 2, 6);
    expect(extent(stops.stats, 1)).toBeCloseTo(25.4 + 2 * 0.3 + 2 * 2, 6);
    expect(extent(stops.stats, 2)).toBeCloseTo(5, 6);
    // Eight legs of 2 × (8 + 2) less the four shared corners, plus the fill of the four 1 mm rounded corners.
    const cornerFill = 4 * (1 - Math.PI / 4) * 1.3 * 1.3;
    expect(stops.stats.volume).toBeCloseTo((8 * 2 * 10 - 4 * 2 * 2 + cornerFill) * 5, 0);
  });

  it('draws the Arduino notches and seats the corner stops in them', () => {
    const blank = made(arduino, { board: 'uno', form: 'blank', blankGap: 0, blankThickness: 1.6 });
    expect(blank.warnings).toEqual([]);
    expect(extent(blank.stats, 0)).toBeCloseTo(68.58, 3);
    expect(extent(blank.stats, 1)).toBeCloseTo(53.34, 3);
    // The rectangle less the narrow strips, the two 45° jogs, the chamfer, three radii and four holes.
    const notches = 2.54 * 2.54 + 2.54 * (53.34 - 40.386) + 2 * 0.5 * 2.54 * 2.54 + 0.5 * 1.524 * 1.524 + 3 * (1 - Math.PI / 4);
    expect(blank.stats.volume).toBeCloseTo((68.58 * 53.34 - notches - 4 * disc(3.2)) * 1.6, 0);
    const mega = made(arduino, { board: 'mega', form: 'blank' });
    expect(extent(mega.stats, 0)).toBeCloseTo(101.6, 3);
    expect(mega.stats.volume).toBeCloseTo((101.6 * 53.34 - notches - 6 * disc(3.2)) * 1.6, 0);
    // Stops: the plain L volume plus the notch they fill at each right-hand corner.
    const stops = made(arduino, { board: 'uno', form: 'corners', stopGap: 0.3, stopThickness: 2, stopLength: 8, stopHeight: 5 });
    expect(extent(stops.stats, 0)).toBeCloseTo(68.58 + 2 * 0.3 + 2 * 2, 6);
    const plain = (8 * 2 * 10 - 4 * 2 * 2) * 5;
    expect(stops.stats.volume).toBeGreaterThan(plain + 2 * 2.54 * 2.54 * 5);
    expect(stops.stats.volume).toBeLessThan(plain + 2 * (2.54 * 8 + 10) * 5);
  });

  it('allows for the antenna that reaches past the end of a DevKitC', () => {
    // The blank and the pocket run on to the end of the module.
    const blank = made(esp32, { board: 'esp32-devkitc', form: 'blank', blankGap: 0 });
    expect(extent(blank.stats, 0)).toBeCloseTo(48.26 + 6.04, 3);
    expect(extent(blank.stats, 1)).toBeCloseTo(27.94, 3);
    const pocket = made(esp32, { board: 'esp32-devkitc', form: 'blank', blankGap: 0.5, blankThickness: 4 });
    expect(extent(pocket.stats, 0)).toBeCloseTo(48.26 + 6.04 + 1, 3);
    expect(pocket.stats.volume).toBeGreaterThan((49.26 * 28.94 + 6.54 * 19) * 4 * 0.99);
    // The stops across the antenna end keep out of the module's way.
    const stops = made(esp32, { board: 'esp32-devkitc', form: 'corners', stopGap: 0.3, stopThickness: 2, stopLength: 8, stopHeight: 5 });
    expect(stops.info.some((i) => i.label.includes('antenna end'))).toBe(true);
    expect(extent(stops.stats, 0)).toBeCloseTo(48.26 + 2 * 0.3 + 2 * 2, 6);
    const endLeg = (27.94 - 18) / 2 - 0.3 - 0.5;
    const cornerFill = 4 * (1 - Math.PI / 4) * 1.3 * 1.3;
    expect(stops.stats.volume).toBeCloseTo((6 * 2 * 10 + 2 * 2 * (endLeg + 2) - 4 * 2 * 2 + cornerFill) * 5, 0);
  });
  it('models the board with its connectors in place, reaching out past the edge', () => {
    // A Pi 4 with the plugs reaching 15 mm: the USB end reaches +X, the power side reaches -Y.
    const r = made(raspberryPi, { board: 'pi4', form: 'connectors', reach: 15, fit: 'plug' });
    expect(r.warnings).toEqual([]);
    expect(r.stats.max[0]).toBeCloseTo(85 + 15, 3);
    expect(r.stats.min[0]).toBeCloseTo(0, 3);
    expect(r.stats.min[1]).toBeCloseTo(-15, 3);
    expect(r.stats.max[1]).toBeCloseTo(56, 3);
    // The micro HDMI plug (7 high on a 3 mm socket) hangs 0.4 below the PCB underside; the USB stacks' plugs reach 8.5 above their 8 mm center.
    expect(r.stats.min[2]).toBeCloseTo(1.6 + 1.5 - 3.5, 3);
    expect(r.stats.max[2]).toBeCloseTo(1.6 + 8 + 8.5, 3);
    expect(r.info.find((i) => i.label === 'Base')?.value).toContain('0.4 mm below');
    // Socket bodies alone stop at the edge plus their own protrusion when the reach is 0.
    const flush = made(raspberryPi, { board: 'pi4', form: 'connectors', reach: 0, fit: 'body' });
    expect(flush.stats.max[0]).toBeCloseTo(85 + 3, 3);
    expect(flush.stats.min[1]).toBeCloseTo(-2.5, 3);
    expect(flush.stats.volume).toBeLessThan(r.stats.volume);
    // Boards with sockets on the left edge reach -X.
    const uno = made(arduino, { board: 'uno', form: 'connectors', reach: 10, fit: 'body' });
    expect(uno.stats.min[0]).toBeCloseTo(-10, 3);
    // The Nano's one socket stands for every Nano's: the classic's mini-B body 1.8 mm out, centered on the 17.78 mm width, with an
    // opening that takes a USB-C plug's width and a micro-B plug's height.
    const nano = made(arduino, { board: 'nano', form: 'connectors', reach: 0, fit: 'body' });
    expect(nano.warnings).toEqual([]);
    expect(nano.stats.min[0]).toBeCloseTo(-1.8, 3);
    const nanoPlug = made(arduino, { board: 'nano', form: 'connectors', reach: 10, fit: 'plug' });
    expect(nanoPlug.stats.min[0]).toBeCloseTo(-10, 3);
    expect(nanoPlug.stats.max[2]).toBeCloseTo(1.6 + 3.9 / 2 + 8.5 / 2, 3);
    expect(nanoPlug.info.find((i) => i.label.startsWith('USB'))?.value).toContain('plug 12.35 × 8.5');
    // The Jetson carriers put every port along the bottom long edge: the parts reach -Y by the protrusion, and the HDMI and
    // DisplayPort stack is the tallest body on the Nano kit, the USB pairs on the Orin kit.
    const nanoKit = made(jetson, { board: 'jetson-nano', form: 'connectors', reach: 0, fit: 'body' });
    expect(nanoKit.warnings).toEqual([]);
    expect(nanoKit.stats.min[1]).toBeCloseTo(-1.6, 3);
    expect(nanoKit.stats.max[1]).toBeCloseTo(79, 3);
    expect(nanoKit.stats.max[2]).toBeCloseTo(1.6 + 19.4, 3);
    const orin = made(jetson, { board: 'jetson-orin-nano', form: 'connectors', reach: 0, fit: 'body' });
    expect(orin.stats.max[2]).toBeCloseTo(1.6 + 16.5, 3);
    expect(orin.info.find((i) => i.label === 'DisplayPort')?.value).toContain('22.80 mm along the bottom edge');
    // The two ESP32 kits without a maker drawing have their micro USB centered on the width, 1 mm out.
    for (const [board, width] of [['esp32-devkit-v1', 28.2], ['nodemcu-32s', 25.4]] as const) {
      const r = made(esp32, { board, form: 'connectors', reach: 0, fit: 'body' });
      expect(r.warnings).toEqual([]);
      expect(r.stats.min[0]).toBeCloseTo(-1, 3);
      const usb = r.info.find((i) => i.label === 'Micro USB')!.value;
      expect(usb).toContain(`${(Math.round(width * 5) / 10).toFixed(2)} mm along the left edge`);
    }
  });
});
