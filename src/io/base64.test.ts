import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, decodeFloat32, decodeUint32, encodeFloat32, encodeUint32 } from './base64';

describe('base64', () => {
  it('matches the standard encoding', () => {
    const hello = new TextEncoder().encode('hello');
    expect(bytesToBase64(hello)).toBe('aGVsbG8=');
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('+//+');
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    expect([...base64ToBytes('aGVsbG8=')]).toEqual([...hello]);
    expect(base64ToBytes('').length).toBe(0);
  });

  it('round-trips every length around the padding and chunk boundaries', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 24575, 24576, 24577, 49152, 49153, 49154]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
      const text = bytesToBase64(bytes);
      expect(text.length).toBe(Math.ceil(n / 3) * 4);
      expect(text).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      const back = base64ToBytes(text);
      expect(back.length).toBe(n);
      expect(back.every((v, i) => v === bytes[i])).toBe(true);
    }
  });

  it('accepts text without padding or broken into lines', () => {
    expect([...base64ToBytes('aGVsbG8')]).toEqual([...base64ToBytes('aGVsbG8=')]);
    expect([...base64ToBytes('aGVs\r\nbG8=\n')]).toEqual([...base64ToBytes('aGVsbG8=')]);
  });

  it('round-trips typed arrays bit for bit', () => {
    const floats = new Float32Array([0, -0, 1.5, -2.25, 1e-30, 3.4e38, Infinity, NaN, Math.PI]);
    const back = decodeFloat32(encodeFloat32(floats));
    expect(back).toBeInstanceOf(Float32Array);
    expect([...new Uint32Array(back.buffer, back.byteOffset, back.length)]).toEqual([...new Uint32Array(floats.buffer)]);
    const ints = new Uint32Array([0, 1, 255, 256, 0x12345678, 0xffffffff]);
    expect([...decodeUint32(encodeUint32(ints))]).toEqual([...ints]);
    // Little-endian: the low byte comes first.
    expect(encodeUint32(new Uint32Array([0x04030201]))).toBe('AQIDBA==');
    expect(decodeFloat32('').length).toBe(0);
  });

  it('encodes only the part of the buffer an array covers, at any offset', () => {
    const buffer = new ArrayBuffer(64);
    new Uint8Array(buffer).fill(0xaa);
    const view = new Float32Array(buffer, 12, 3);
    view.set([1, 2, 3]);
    const text = encodeFloat32(view);
    expect(text).toBe(encodeFloat32(new Float32Array([1, 2, 3])));
    const back = decodeFloat32(text);
    expect([...back]).toEqual([1, 2, 3]);
    // The decoded array owns its memory.
    expect(back.byteOffset).toBe(0);
    expect(back.buffer.byteLength).toBe(12);
  });

  it('copes with arrays of several megabytes', () => {
    const floats = Float32Array.from({ length: 700_000 }, (_, i) => Math.sin(i) * 1000);
    expect(floats.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    const text = encodeFloat32(floats);
    expect(text.length).toBe(Math.ceil(floats.byteLength / 3) * 4);
    const back = decodeFloat32(text);
    expect(back.length).toBe(floats.length);
    expect(back.every((v, i) => v === floats[i])).toBe(true);

    const ints = Uint32Array.from({ length: 400_000 }, (_, i) => (i * 2654435761) >>> 0);
    const backInts = decodeUint32(encodeUint32(ints));
    expect(backInts.length).toBe(ints.length);
    expect(backInts.every((v, i) => v === ints[i])).toBe(true);
  });
});
