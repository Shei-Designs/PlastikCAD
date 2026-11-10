/** The limits a number box keeps its value within. */
export interface NumberLimits {
  min?: number;
  max?: number;
  integer?: boolean;
}

/**
 * The number a box takes from what was typed in it: read with a comma or a
 * point for the decimals, rounded for a whole-number box and brought within
 * its limits. Null when the text is empty or not a number, which changes nothing.
 */
export function typedNumber(raw: string, { min = -Infinity, max = Infinity, integer = false }: NumberLimits = {}): number | null {
  const parsed = Number(raw.replace(',', '.'));
  if (raw.trim() === '' || !Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, integer ? Math.round(parsed) : parsed));
}
