// A picture written as a PNG file: what a reader makes when a file carries
// its colors in a form the design keeps as a picture (the colors of a PLY
// file's corners). Opaque, eight bits a channel, no more than that.
import { zlibSync } from 'fflate';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}

function crc(bytes: Uint8Array, from: number, to: number): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG file of `width` by `height` pixels from `rgb`, three bytes a pixel, row by row from the top. */
export function writePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  // Each row goes in behind a byte that says it is stored as it is.
  const rows = new Uint8Array(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) rows.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const data = zlibSync(rows, { level: 6 });
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bits a channel
  header[9] = 2; // red, green, blue
  const chunks: [string, Uint8Array][] = [
    ['IHDR', header],
    ['IDAT', data],
    ['IEND', new Uint8Array(0)],
  ];
  const out = new Uint8Array(SIGNATURE.length + chunks.reduce((n, [, body]) => n + 12 + body.length, 0));
  out.set(SIGNATURE);
  const all = new DataView(out.buffer);
  let at = SIGNATURE.length;
  for (const [name, body] of chunks) {
    all.setUint32(at, body.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = name.charCodeAt(i);
    out.set(body, at + 8);
    all.setUint32(at + 8 + body.length, crc(out, at + 4, at + 8 + body.length));
    at += 12 + body.length;
  }
  return out;
}
