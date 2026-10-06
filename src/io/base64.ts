// Base64 for the typed arrays stored in design files. `btoa` / `atob` exist in
// browsers, workers and node alike (unlike `Buffer`), but work on "binary
// strings", so the bytes go through them in chunks: one `fromCharCode` call
// over a multi-megabyte array would overflow the call stack.

// A multiple of 3 bytes (and of 4 characters), so that chunks encode without padding and simply concatenate.
const CHUNK = 3 * 8192;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])));
  }
  return parts.join('');
}

export function base64ToBytes(s: string): Uint8Array {
  if (/[^A-Za-z0-9+/]/.test(s)) s = s.replace(/[\s=]+/g, '');
  const bytes = new Uint8Array(Math.floor((s.length * 3) / 4));
  const step = (CHUNK / 3) * 4;
  let o = 0;
  for (let i = 0; i < s.length; i += step) {
    const bin = atob(s.slice(i, i + step));
    for (let j = 0; j < bin.length; j++) bytes[o++] = bin.charCodeAt(j);
  }
  return bytes;
}

// The typed-array helpers assume a little-endian platform (every one this app
// runs on). Decoding returns a view of a freshly made buffer, so alignment is
// never a concern however the source array was offset.

const viewBytes = (a: Float32Array | Uint32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

export const encodeFloat32 = (a: Float32Array): string => bytesToBase64(viewBytes(a));
export const encodeUint32 = (a: Uint32Array): string => bytesToBase64(viewBytes(a));

export function decodeFloat32(s: string): Float32Array {
  const bytes = base64ToBytes(s);
  return new Float32Array(bytes.buffer, 0, bytes.length >> 2);
}

export function decodeUint32(s: string): Uint32Array {
  const bytes = base64ToBytes(s);
  return new Uint32Array(bytes.buffer, 0, bytes.length >> 2);
}
