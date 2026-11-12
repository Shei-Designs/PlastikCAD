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
    expect(plateGrid(3001, 'mm')).toEqual({ half: 5000, major: 1000, minor: 500 });
  });

  it('is 10 in square in inches, with a heavy line every inch and a light one every eighth', () => {
    expect(plateGrid(100, 'in')).toEqual({ half: 127, major: 25.4, minor: 3.175 });
  });

  it('grows with the design in inches: by five inches, then on tens of inches', () => {
    expect(plateGrid(130, 'in')).toEqual({ half: 254, major: 25.4, minor: 3.175 });
    expect(plateGrid(400, 'in')).toEqual({ half: 508, major: 25.4, minor: 12.7 });
    expect(plateGrid(762, 'in')).toEqual({ half: 762, major: 25.4, minor: 12.7 });
    expect(plateGrid(763, 'in')).toEqual({ half: 1270, major: 254, minor: 127 });
    expect(plateGrid(7621, 'in')).toEqual({ half: 12700, major: 2540, minor: 1270 });
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
