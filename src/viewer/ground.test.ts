import { describe, expect, it } from 'vitest';
import { gridLines, plateGrid } from './ground';

/** How many lines a grid has: four points to a pair of crossing lines. */
const lines = (half: number, step: number, skip: number): number => gridLines(half, step, skip).getAttribute('position').count / 4;

describe('the plate\'s grid', () => {
  it('is 200 mm square under a small design, with a heavy line every 10 mm and a light one every millimeter', () => {
    expect(plateGrid(100, 'mm')).toEqual({ half: 100, major: 10, minor: 1 });
    expect(plateGrid(120, 'mm')).toEqual({ half: 150, major: 10, minor: 1 });
  });

  it('grows with the design in millimeters, its lines further apart', () => {
    expect(plateGrid(160, 'mm')).toEqual({ half: 200, major: 10, minor: 5 });
    expect(plateGrid(300, 'mm')).toEqual({ half: 300, major: 10, minor: 5 });
    expect(plateGrid(301, 'mm')).toEqual({ half: 500, major: 100, minor: 50 });
    expect(plateGrid(3000, 'mm')).toEqual({ half: 3000, major: 100, minor: 50 });
  });

  it('goes to meters under a design of meters, a meter in quarters, and to tens of meters past thirty', () => {
    expect(plateGrid(3001, 'mm')).toEqual({ half: 5000, major: 1000, minor: 250 });
    expect(plateGrid(30_000, 'mm')).toEqual({ half: 30_000, major: 1000, minor: 250 });
    expect(plateGrid(30_001, 'mm')).toEqual({ half: 50_000, major: 10_000, minor: 2500 });
    expect(plateGrid(2_000_000, 'mm')).toEqual({ half: 2_000_000, major: 100_000, minor: 25_000 });
  });

  it('is 10 in square in inches, with a heavy line every inch and a light one every eighth', () => {
    expect(plateGrid(100, 'in')).toEqual({ half: 127, major: 25.4, minor: 3.175 });
  });

  it('grows with the design in inches: by five inches, the light lines then every half inch', () => {
    expect(plateGrid(130, 'in')).toEqual({ half: 254, major: 25.4, minor: 3.175 });
    expect(plateGrid(400, 'in')).toEqual({ half: 508, major: 25.4, minor: 12.7 });
    // Thirty inches each way, to the line.
    expect(plateGrid(762, 'in')).toEqual({ half: 762, major: 25.4, minor: 12.7 });
  });

  it('goes to feet, then to yards with a light line every foot, then to tens of yards', () => {
    const [foot, yard] = [304.8, 914.4];
    expect(plateGrid(763, 'in')).toEqual({ half: 5 * foot, major: foot, minor: foot / 2 });
    expect(plateGrid(30 * foot, 'in')).toEqual({ half: 30 * foot, major: foot, minor: foot / 2 });
    expect(plateGrid(30 * foot + 1, 'in')).toEqual({ half: 15 * yard, major: yard, minor: foot });
    expect(plateGrid(30 * yard, 'in')).toEqual({ half: 30 * yard, major: yard, minor: foot });
    expect(plateGrid(30 * yard + 1, 'in')).toEqual({ half: 50 * yard, major: 10 * yard, minor: 10 * foot });
  });

  it('never has more than thirty heavy lines each way, nor more than a few hundred light ones', () => {
    for (const unit of ['mm', 'in'] as const) {
      for (let wanted = 100; wanted < 5e7; wanted *= 1.37) {
        const { half, major, minor } = plateGrid(wanted, unit);
        expect(half).toBeGreaterThanOrEqual(wanted - 1e-6);
        expect(half / major).toBeLessThanOrEqual(30 + 1e-9);
        expect(half / minor).toBeLessThanOrEqual(150 + 1e-9);
        // The heavy lines fall on light ones: a light step goes into a heavy one a whole number of times.
        expect(Math.abs(major / minor - Math.round(major / minor))).toBeLessThan(1e-9);
      }
    }
  });

  it('draws the heavy lines on whole inches and the light ones between them', () => {
    const { half, major, minor } = plateGrid(100, 'in');
    // Five inches each way and the middle; seven eighths between each pair.
    expect(lines(half, major, 0)).toBe(11);
    expect(lines(half, minor, major)).toBe(70);
    const heavy = gridLines(half, major, 0).getAttribute('position');
    expect([...Array(11).keys()].map((i) => heavy.getX(i * 4))).toEqual([-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((n) => Math.fround(n * 25.4)));
  });
});
