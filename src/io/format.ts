/** Fixed-point number with trailing zeros trimmed ("12.5", "-0.333333", "0"). */
export function fmt(v: number, decimals = 6): string {
  let s = v.toFixed(decimals);
  if (s.includes('.') && !s.includes('e')) s = s.replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

export const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const encodeText = (s: string): Uint8Array => new TextEncoder().encode(s);
