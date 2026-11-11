/** Fixed-point number with trailing zeros trimmed ("12.5", "-0.333333", "0"). */
export function fmt(v: number, decimals = 6): string {
  let s = v.toFixed(decimals);
  if (s.includes('.') && !s.includes('e')) s = s.replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

export const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const encodeText = (s: string): Uint8Array => new TextEncoder().encode(s);

/** As many characters as are gathered before they are turned into bytes and handed on. */
const PIECE = 1 << 16;

/**
 * Lines of text handed on as bytes a piece at a time. A mesh of millions of
 * triangles written as one string, or as a list of its lines, takes many
 * times the room of the file it becomes, and past a few hundred megabytes is
 * longer than a string can be.
 */
export class TextPieces {
  private pending = '';
  private readonly encoder = new TextEncoder();

  constructor(private readonly sink: (bytes: Uint8Array) => void) {}

  /** Adds a line and the line break after it. */
  line(text: string): void {
    this.pending += text;
    this.pending += '\n';
    if (this.pending.length >= PIECE) this.flush();
  }

  /** Hands on what is left. */
  flush(): void {
    if (this.pending) this.sink(this.encoder.encode(this.pending));
    this.pending = '';
  }
}

/** The pieces end to end, as one array. */
export function joinBytes(pieces: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const piece of pieces) length += piece.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

/**
 * The time to stamp the entries of a zip with. The format holds a date from
 * 1980 to 2099 and the packer refuses any other, which would stop an export on
 * a device whose clock was never set; such a clock is taken to the nearer end.
 */
export function zipTime(now = Date.now()): number {
  return Math.min(Math.max(now, new Date(1980, 0, 1, 0, 0, 2).getTime()), new Date(2099, 11, 31, 23, 59, 58).getTime());
}
