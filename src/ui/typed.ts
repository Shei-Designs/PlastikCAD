import { fromUnit } from '../units';
import type { Unit } from '../units';

/** The limits a number box keeps its value within, and for a length the unit it is typed in. */
export interface NumberLimits {
  min?: number;
  max?: number;
  integer?: boolean;
  unit?: Unit;
}

/**
 * The number a box takes from what was typed in it: read with a comma or a
 * point for the decimals, rounded for a whole-number box and brought within
 * its limits. A length typed in `unit` is taken in millimeters, as its limits
 * are. Null when the text is empty or not a number, which changes nothing.
 */
export function typedNumber(raw: string, { min = -Infinity, max = Infinity, integer = false, unit = 'mm' }: NumberLimits = {}): number | null {
  const parsed = Number(raw.replace(',', '.'));
  if (raw.trim() === '' || !Number.isFinite(parsed)) return null;
  const value = fromUnit(parsed, unit);
  return Math.min(max, Math.max(min, integer ? Math.round(value) : value));
}
