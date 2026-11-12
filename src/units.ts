// The unit lengths are shown and typed in: millimeters or inches. A design is
// in millimeters whichever it is, and so is everything the app works with;
// only what is read off the screen and typed into it goes through here.
import { trx } from './i18n';

export type Unit = 'mm' | 'in';

export const UNITS: readonly Unit[] = ['mm', 'in'];

const MM_PER_INCH = 25.4;

/** The unit as it is written after a figure. */
const NAMES: Record<Unit, string> = { mm: 'mm', in: trx('unit', 'in') };
export const unitName = (unit: Unit): string => NAMES[unit];

/** A length in millimeters, in `unit`. */
export const toUnit = (mm: number, unit: Unit): number => (unit === 'in' ? mm / MM_PER_INCH : mm);

/**
 * A length in `unit`, in millimeters: to a millionth of one, which takes off
 * the noise of the product (0.7874 in is 19.99996 mm, not 19.999959999999998).
 */
export const fromUnit = (value: number, unit: Unit): number => (unit === 'in' ? Number((value * MM_PER_INCH).toFixed(6)) : value);

/** The decimals of a figure that has `places` of them in millimeters: two more in inches, four at the most. */
export const unitPlaces = (places: number, unit: Unit): number => (unit === 'in' ? Math.min(4, places + 2) : places);

/** A length's figure in `unit`, without trailing zeros; `places` are its decimals in millimeters. */
export const lengthFigure = (mm: number, unit: Unit, places = 2): string => String(Number(toUnit(mm, unit).toFixed(unitPlaces(places, unit))));

/** A length with its unit after it. */
export const lengthText = (mm: number, unit: Unit, places = 2): string => `${lengthFigure(mm, unit, places)} ${unitName(unit)}`;

/** A length's figure in `unit` with all its decimals, as a table of figures gives it ("40.00"). */
export const figureFixed = (mm: number, unit: Unit, places = 2): string => toUnit(mm, unit).toFixed(unitPlaces(places, unit));

/** The same with its unit after it. */
export const lengthFixed = (mm: number, unit: Unit, places = 2): string => `${figureFixed(mm, unit, places)} ${unitName(unit)}`;

/** The lengths that make up a size, as "20 × 30 × 5 mm". */
export const sizeText = (mm: readonly number[], unit: Unit, places = 2): string => `${mm.map((v) => lengthFigure(v, unit, places)).join(' × ')} ${unitName(unit)}`;

/** An area in square millimeters, in the square of `unit`, with that after it. */
export const areaText = (mm2: number, unit: Unit, places = 1): string => `${Number(toUnit(toUnit(mm2, unit), unit).toFixed(unitPlaces(places, unit)))} ${unitName(unit)}²`;

/**
 * What an arrow key adds to a box whose step is `step` millimeters, in
 * millimeters. In inches it is a twentieth of an inch for each millimeter of
 * the step (0.05 in for 1 mm): a round figure of about the same size.
 */
export const keyStep = (step: number, unit: Unit): number => (unit === 'in' ? fromUnit(step / 20, 'in') : step);

// --- sentences that name lengths ------------------------------------------------

/** What a sentence reads in inches, by what it reads in millimeters (see `said`). The oldest go first when there are many. */
const IN_INCHES = new Map<string, string>();
const SENTENCES_KEPT = 4000;

/**
 * A sentence that names lengths the user set (a part's warning, a robot's), which `text` writes for a unit. What
 * comes back is the sentence in millimeters: that is how it is kept, compared and dismissed. `inUnit` gives what
 * the same sentence reads in the unit the user works in. One that names a standard's own figure (the pitch a
 * metric thread may have) is written plainly, and reads the same in both.
 */
export function said(text: (unit: Unit) => string): string {
  const sentence = text('mm');
  if (!IN_INCHES.has(sentence) && IN_INCHES.size >= SENTENCES_KEPT) IN_INCHES.delete(IN_INCHES.keys().next().value as string);
  IN_INCHES.set(sentence, text('in'));
  return sentence;
}

/** A sentence `said` gave, as it reads in `unit`; any other sentence as it is. */
export const inUnit = (sentence: string, unit: Unit): string => (unit === 'in' ? (IN_INCHES.get(sentence) ?? sentence) : sentence);

// --- the snap step -------------------------------------------------------------

/** The parts of an inch the snap step can be, as what the inch is divided by. */
const INCH_PARTS = [32, 16, 8, 4, 2, 1];

const SNAP_STEPS: Record<Unit, readonly number[]> = {
  mm: [0, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  in: [0, ...INCH_PARTS.map((n) => MM_PER_INCH / n)],
};

/** The snap steps on offer in `unit`, in millimeters; 0 is no snapping. */
export const snapSteps = (unit: Unit): readonly number[] => SNAP_STEPS[unit];

/** One of `snapSteps(unit)` as it is written: an inch's as a fraction. */
export function snapLabel(step: number, unit: Unit): string {
  if (unit === 'mm') return `${step} ${unitName('mm')}`;
  const parts = Math.round(MM_PER_INCH / step);
  return `${parts === 1 ? '1' : `1/${parts}`} ${unitName('in')}`;
}

/** The step of `unit` nearest to `step`; no snapping stays no snapping. */
export function nearestSnap(step: number, unit: Unit): number {
  if (step === 0) return 0;
  return SNAP_STEPS[unit].filter((s) => s > 0).reduce((best, s) => (Math.abs(s - step) < Math.abs(best - step) ? s : best));
}
