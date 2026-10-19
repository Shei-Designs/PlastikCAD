import { APP_NAME } from '../app';
import type { MeshData } from '../geometry/mesh';

/** Binary STL: 80-byte header, uint32 triangle count, then 50 bytes per facet. */
export function writeStl(mesh: MeshData, name: string, units = 'mm'): Uint8Array {
  const { positions: p, triangles: t } = mesh;
  const count = t.length / 3;
  const bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);

  // Must not start with "solid", or some readers mistake the file for ASCII STL.
  const header = `${APP_NAME} binary STL (${units}) - ${name}`;
  for (let i = 0; i < Math.min(80, header.length); i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, count, true);

  let o = 84;
  for (let i = 0; i < count; i++) {
    const a = t[i * 3] * 3;
    const b = t[i * 3 + 1] * 3;
    const c = t[i * 3 + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    view.setFloat32(o, nx, true);
    view.setFloat32(o + 4, ny, true);
    view.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      view.setFloat32(o, p[v], true);
      view.setFloat32(o + 4, p[v + 1], true);
      view.setFloat32(o + 8, p[v + 2], true);
      o += 12;
    }
    o += 2; // attribute byte count, left at 0
  }
  return bytes;
}
