// What the mesh importers read a material with: its color as `#rrggbb`, and
// the kind of picture a file name says it is.
import type { Companion, ImportedImage } from './import';

export function imageMime(name: string): ImportedImage['mime'] | undefined {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : undefined;
}

/** The file name a reference ends in, folders dropped. */
export const baseOf = (ref: string): string => ref.replace(/\\/g, '/').split('/').pop() ?? ref;

/** A companion file by the name a file refers to it by, ignoring folders and case. */
export function findCompanion(companions: Companion[], ref: string): Companion | undefined {
  const base = baseOf(ref).toLowerCase();
  return base ? companions.find((c) => baseOf(c.name).toLowerCase() === base) : undefined;
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
