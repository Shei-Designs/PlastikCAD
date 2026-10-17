import { describe, expect, it } from 'vitest';
import { fmt } from './format';

describe('fmt', () => {
  it('trims trailing zeros and keeps zero unsigned', () => {
    expect(fmt(12.5)).toBe('12.5');
    expect(fmt(10)).toBe('10');
    expect(fmt(-1 / 3)).toBe('-0.333333');
    expect(fmt(-0.0000001)).toBe('0');
    expect(fmt(0)).toBe('0');
  });

  it('leaves the exponent of a very large number alone', () => {
    expect(fmt(1.5e30)).toBe('1.5e+30');
    expect(fmt(1e21)).toBe('1e+21');
    expect(fmt(-2e100)).toBe('-2e+100');
  });
});
