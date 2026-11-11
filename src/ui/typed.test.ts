import { describe, expect, it } from 'vitest';
import { typedNumber } from './typed';

describe('typedNumber', () => {
  it('reads a number typed with a point or a comma', () => {
    expect(typedNumber('12.5')).toBe(12.5);
    expect(typedNumber('12,5')).toBe(12.5);
    expect(typedNumber(' -3 ')).toBe(-3);
  });

  it('brings an out-of-range value within the limits', () => {
    expect(typedNumber('500', { min: 1, max: 100 })).toBe(100);
    expect(typedNumber('-4', { min: 1, max: 100 })).toBe(1);
  });

  it('rounds for a whole-number box', () => {
    expect(typedNumber('2.6', { integer: true })).toBe(3);
    expect(typedNumber('0.2', { min: 1, integer: true })).toBe(1);
  });

  it('takes nothing from an empty box or from text that is not a number', () => {
    expect(typedNumber('')).toBeNull();
    expect(typedNumber('   ')).toBeNull();
    expect(typedNumber('abc')).toBeNull();
    expect(typedNumber('1e999')).toBeNull();
  });
});
