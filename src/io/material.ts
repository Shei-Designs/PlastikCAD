// What the mesh importers read a material with: its color as `#rrggbb`, and
// the kind of picture a file name says it is.
import type { ImportedImage } from './import';

export function imageMime(name: string): ImportedImage['mime'] | undefined {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : undefined;
}

/** sRGB hex from channels in 0..1. */
export function hex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear to sRGB, in 0..1. */
export const srgb = (c: number): number => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
};
