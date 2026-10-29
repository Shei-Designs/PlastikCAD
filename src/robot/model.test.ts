import { describe, expect, it } from 'vitest';
import { meetingPoint } from './model';

describe('meetingPoint', () => {
  it('is the middle of the overlap of boxes that cross: an axle through a wheel gives the hub', () => {
    expect(meetingPoint({ min: [-50, -3, -3], max: [50, 3, 3] }, { min: [20, -20, -20], max: [30, 20, 20] })).toEqual([25, 0, 0]);
  });
  it('is the center of the shared face of boxes that touch', () => {
    expect(meetingPoint({ min: [0, 0, 0], max: [10, 10, 10] }, { min: [10, 2, 0], max: [30, 8, 10] })).toEqual([10, 5, 5]);
  });
  it('is the middle of the gap where boxes stand apart', () => {
    expect(meetingPoint({ min: [0, 0, 0], max: [10, 10, 10] }, { min: [14, 0, 0], max: [20, 10, 10] })).toEqual([12, 5, 5]);
  });
});
