import { describe, expect, it } from 'vitest';
import { areaText, figureFixed, fromUnit, inUnit, keyStep, lengthFigure, lengthFixed, lengthText, nearestSnap, noted, said, sizeText, snapLabel, snapSteps, toUnit, unitName, unitPlaces } from './units';

describe('a length in a unit', () => {
  it('is itself in millimeters, either way', () => {
    expect(toUnit(12.5, 'mm')).toBe(12.5);
    expect(fromUnit(12.5, 'mm')).toBe(12.5);
  });

  it('is 25.4 to the inch', () => {
    expect(toUnit(25.4, 'in')).toBe(1);
    expect(toUnit(127, 'in')).toBe(5);
    expect(fromUnit(1, 'in')).toBe(25.4);
    expect(fromUnit(0.5, 'in')).toBe(12.7);
    expect(fromUnit(-2, 'in')).toBe(-50.8);
  });

  it('comes back from inches without the noise of the product', () => {
    expect(0.7874 * 25.4).not.toBe(19.99996);
    expect(fromUnit(0.7874, 'in')).toBe(19.99996);
    expect(fromUnit(0.1, 'in')).toBe(2.54);
    expect(fromUnit(3 / 32, 'in')).toBe(2.38125);
  });

  it('is not a number where what was given is not one', () => {
    expect(fromUnit(Number.NaN, 'in')).toBeNaN();
    expect(fromUnit(Infinity, 'in')).toBe(Infinity);
  });
});

describe('the decimals of a figure', () => {
  it('are two more in inches than in millimeters, four at the most', () => {
    expect([0, 1, 2, 3, 4].map((p) => unitPlaces(p, 'mm'))).toEqual([0, 1, 2, 3, 4]);
    expect([0, 1, 2, 3, 4].map((p) => unitPlaces(p, 'in'))).toEqual([2, 3, 4, 4, 4]);
  });
});

describe('a length as it is written', () => {
  it('drops trailing zeros', () => {
    expect(lengthFigure(20, 'mm')).toBe('20');
    expect(lengthFigure(12.345, 'mm')).toBe('12.35');
    expect(lengthFigure(12.345, 'mm', 1)).toBe('12.3');
    expect(lengthFigure(20, 'in')).toBe('0.7874');
    expect(lengthFigure(25.4, 'in')).toBe('1');
    expect(lengthFigure(12.7, 'in')).toBe('0.5');
    expect(lengthFigure(20, 'in', 1)).toBe('0.787');
    expect(lengthFigure(20, 'in', 0)).toBe('0.79');
    expect(lengthFigure(-0.00001, 'in')).toBe('0');
  });

  it('has its unit after it', () => {
    expect(unitName('mm')).toBe('mm');
    expect(unitName('in')).toBe('in');
    expect(lengthText(20, 'mm')).toBe('20 mm');
    expect(lengthText(20, 'in')).toBe('0.7874 in');
    expect(lengthText(1.2346, 'mm', 3)).toBe('1.235 mm');
    expect(lengthText(1.2346, 'in', 3)).toBe('0.0486 in');
  });

  it('keeps every decimal in a table of figures', () => {
    expect(figureFixed(40, 'mm')).toBe('40.00');
    expect(lengthFixed(40, 'mm')).toBe('40.00 mm');
    expect(lengthFixed(40, 'mm', 1)).toBe('40.0 mm');
    expect(lengthFixed(50.8, 'in')).toBe('2.0000 in');
    expect(lengthFixed(40, 'in', 1)).toBe('1.575 in');
  });

  it('joins the lengths of a size', () => {
    expect(sizeText([20, 30, 5], 'mm')).toBe('20 × 30 × 5 mm');
    expect(sizeText([25.4, 50.8, 20], 'in')).toBe('1 × 2 × 0.7874 in');
    expect(sizeText([20.04, 30], 'mm', 1)).toBe('20 × 30 mm');
  });

  it('gives an area in the square of the unit', () => {
    expect(areaText(100, 'mm')).toBe('100 mm²');
    expect(areaText(12.34, 'mm')).toBe('12.3 mm²');
    expect(areaText(645.16, 'in')).toBe('1 in²');
    expect(areaText(100, 'in')).toBe('0.155 in²');
  });
});

describe('the step of an arrow key', () => {
  it('is the box\'s own in millimeters', () => {
    expect(keyStep(1, 'mm')).toBe(1);
    expect(keyStep(0.05, 'mm')).toBe(0.05);
  });

  it('is a twentieth of an inch for each millimeter of it, in inches', () => {
    expect(keyStep(1, 'in')).toBe(1.27);
    expect(toUnit(keyStep(1, 'in'), 'in')).toBeCloseTo(0.05, 12);
    expect(toUnit(keyStep(0.1, 'in'), 'in')).toBeCloseTo(0.005, 12);
    expect(toUnit(keyStep(10, 'in'), 'in')).toBeCloseTo(0.5, 12);
  });
});

describe('the snap steps', () => {
  it('are the usual ones in millimeters', () => {
    expect(snapSteps('mm')).toEqual([0, 0.1, 0.25, 0.5, 1, 2, 5, 10]);
    expect(snapSteps('mm').slice(1).map((s) => snapLabel(s, 'mm'))).toEqual(['0.1 mm', '0.25 mm', '0.5 mm', '1 mm', '2 mm', '5 mm', '10 mm']);
  });

  it('are halvings of an inch in inches, kept in millimeters and written as fractions', () => {
    expect(snapSteps('in')).toEqual([0, 0.79375, 1.5875, 3.175, 6.35, 12.7, 25.4]);
    expect(snapSteps('in').slice(1).map((s) => snapLabel(s, 'in'))).toEqual(['1/32 in', '1/16 in', '1/8 in', '1/4 in', '1/2 in', '1 in']);
  });

  it('move to the nearest step of the other unit', () => {
    expect(nearestSnap(1, 'in')).toBe(0.79375);
    expect(nearestSnap(0.1, 'in')).toBe(0.79375);
    expect(nearestSnap(2, 'in')).toBe(1.5875);
    expect(nearestSnap(5, 'in')).toBe(6.35);
    expect(nearestSnap(10, 'in')).toBe(12.7);
    expect(nearestSnap(0.79375, 'mm')).toBe(1);
    expect(nearestSnap(3.175, 'mm')).toBe(2);
    expect(nearestSnap(6.35, 'mm')).toBe(5);
    expect(nearestSnap(25.4, 'mm')).toBe(10);
  });

  it('stay as they are in their own unit, and off stays off', () => {
    for (const unit of ['mm', 'in'] as const) {
      for (const step of snapSteps(unit)) expect(nearestSnap(step, unit)).toBe(step);
      expect(nearestSnap(0, unit)).toBe(0);
    }
  });
});

describe('a sentence that names lengths', () => {
  it('is kept as it reads in millimeters, and read in inches when asked', () => {
    const sentence = said((unit) => `The wall was thinned to ${lengthFixed(2.5, unit, 1)}.`);
    expect(sentence).toBe('The wall was thinned to 2.5 mm.');
    expect(inUnit(sentence, 'mm')).toBe(sentence);
    expect(inUnit(sentence, 'in')).toBe('The wall was thinned to 0.098 in.');
  });

  it('keeps a note written at the start for good, however many sentences come after', () => {
    const note = noted((unit) => `Four holes on a ${lengthText(31, unit)} square.`);
    for (let i = 0; i < 5000; i++) said((unit) => `Limited to ${lengthFixed(i / 10, unit, 1)}.`);
    expect(note).toBe('Four holes on a 31 mm square.');
    expect(inUnit(note, 'in')).toBe('Four holes on a 1.2205 in square.');
    // The oldest of the passing sentences are gone, and read as they were written.
    expect(inUnit('Limited to 0.0 mm.', 'in')).toBe('Limited to 0.0 mm.');
    expect(inUnit('Limited to 499.9 mm.', 'in')).toBe('Limited to 19.681 in.');
  });

  it('reads the same in both units when it was written plainly', () => {
    expect(inUnit('The pitch was limited to 4 mm for this diameter.', 'in')).toBe('The pitch was limited to 4 mm for this diameter.');
  });
});
