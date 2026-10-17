// Texture coordinates for a mesh: where on a picture each corner of each
// triangle lands. Nothing here touches the DOM or the kernel; the pixels are
// composed elsewhere (see viewer/skin.ts) and the mesh comes from the worker.
//
// Two ways a picture reaches a surface. A picture node is a sheet that
// projects onto the surfaces it is grouped with: flat, straight through the
// sheet onto the first surface that faces it; wrapped, inwards from a band
// around its axis onto the first surface that faces outwards. A texture
// covers an object's whole surface: wrapped once around the object's vertical
// axis, or tiled from whichever side each triangle faces most.
//
// Corners are unindexed, three per triangle (see RenderMesh), in the built
// frame of the object (see builtSize). v runs upwards, as in a GL texture.
// Round things are measured from the front: the middle of a band, and of a
// wrapped texture, faces -Y, which is where the Front view looks from.
import { apply, invert } from '../model/math';
import type { Mat } from '../model/math';
import type { PictureMapping, Vec3 } from '../model/types';

/** A picture sheet relative to the mesh it projects onto: its matrix takes the unit sheet into the mesh's frame. */
export interface Projector {
  matrix: Mat;
  mapping: PictureMapping;
  /** Degrees of the circumference a wrapped picture covers. */
  angle: number;
  /** Where the picture sits in the atlas: u0, v0, u1, v1. */
  rect: [number, number, number, number];
}

/**
 * A corner that no picture reaches samples this point, far outside the atlas,
 * where clamping to the edge gives the object's own color (the atlas has a
 * border of it). Far enough out that no corner near a picture lands on it.
 */
export const FILL_UV: [number, number] = [-4, -4];

/** A face must turn at least this much towards a picture to receive it (keeps grazing faces clean). */
const FACING = 0.1;
/**
 * How far in front of a picture a surface may sit and still receive it: a
 * sheet sunk a little into a surface still prints, as does a band set a hair
 * smaller than the object. Beyond that a surface is in front of the picture,
 * not behind it (a mug's handle outside the band), and is left alone.
 */
const FLAT_REACH = 0.5;
const WRAP_REACH = 0.52;
/** Pixels across the depth map that tells the first surface behind a picture from those behind it. */
const DEPTH_MAP = 256;

/** Angle round the Z axis from the front (-Y), counter-clockwise seen from above, in (-π, π]. */
export function azimuth(x: number, y: number): number {
  const a = Math.atan2(y, x) + Math.PI / 2;
  return a > Math.PI ? a - 2 * Math.PI : a;
}

const faceNormal = (p: Float32Array, i: number): Vec3 => {
  const ux = p[i + 3] - p[i];
  const uy = p[i + 4] - p[i + 1];
  const uz = p[i + 5] - p[i + 2];
  const vx = p[i + 6] - p[i];
  const vy = p[i + 7] - p[i + 1];
  const vz = p[i + 8] - p[i + 2];
  const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const len = Math.hypot(...n) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
};

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A direction (not a point) taken through the linear part of a matrix. */
const direction = (m: Mat, d: Vec3): Vec3 => [m[0] * d[0] + m[3] * d[1] + m[6] * d[2], m[1] * d[0] + m[4] * d[1] + m[7] * d[2], m[2] * d[0] + m[5] * d[1] + m[8] * d[2]];

const unit = (v: Vec3): Vec3 => {
  const len = Math.hypot(...v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
};

/** A mesh with texture coordinates: unindexed corners with their normals, as a RenderMesh, and two floats per corner. */
export interface SkinMesh {
  positions: Float32Array;
  normals: Float32Array;
  uv: Float32Array;
  /** When triangles were cut: for each, the triangle of the mesh it came from. Absent, they are the mesh's own. */
  faces?: Uint32Array;
}

/** A triangle in a picture's own space: where each corner lands (0..1 across and up) and how deep it lies. */
interface Landing {
  uv: [number, number][];
  /** Towards the picture is larger: a flat sheet's z, a band's radius. */
  depth: number[];
  facing: boolean;
}

/** The picture a triangle took and where its corners land on it (0..1 across and up). */
interface Taken {
  pic: number;
  uv: [number, number][];
}

/**
 * Which picture each triangle takes: the first one it faces, lies under and is
 * not hidden from by a surface in between; null where it samples the fill.
 */
function takePictures(positions: Float32Array, pictures: Projector[]): (Taken | null)[] {
  const count = positions.length / 9;
  const taken: (Taken | null)[] = new Array(count).fill(null);
  const corners: Vec3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  pictures.forEach((pic, p) => {
    const inv = invert(pic.matrix);
    const landings: (Landing | null)[] = new Array(count);
    for (let t = 0; t < count; t++) {
      const i = t * 9;
      const n = faceNormal(positions, i);
      for (let c = 0; c < 3; c++) corners[c] = apply(inv, [positions[i + c * 3], positions[i + c * 3 + 1], positions[i + c * 3 + 2]]);
      landings[t] = pic.mapping === 'flat' ? flatLanding(pic, n, corners) : wrapLanding(pic, n, corners);
    }
    // Whatever lies under the picture, facing it or not, can hide what is behind it.
    const nearest = depthMap(landings);
    for (let t = 0; t < count; t++) {
      const landing = landings[t];
      if (taken[t] || !landing || !landing.facing || nearest.hidden(landing)) continue;
      taken[t] = { pic: p, uv: landing.uv };
    }
  });
  return taken;
}

/** Each corner's place in the atlas: its picture's cell, or the fill. */
function atlasUVs(taken: (Taken | null)[], pictures: Projector[]): Float32Array {
  const uv = new Float32Array(taken.length * 6);
  for (let t = 0; t < taken.length; t++) {
    const got = taken[t];
    if (!got) {
      for (let c = 0; c < 3; c++) uv.set(FILL_UV, (t * 3 + c) * 2);
      continue;
    }
    const [u0, v0, u1, v1] = pictures[got.pic].rect;
    for (let c = 0; c < 3; c++) {
      uv[(t * 3 + c) * 2] = u0 + got.uv[c][0] * (u1 - u0);
      uv[(t * 3 + c) * 2 + 1] = v0 + got.uv[c][1] * (v1 - v0);
    }
  }
  return uv;
}

/**
 * Texture coordinates from pictures projected onto the mesh. Each triangle
 * takes the first picture it faces, lies under and is not hidden from by a
 * surface in between; the rest of the surface samples the fill. A triangle
 * that reaches past the picture's edge keeps its coordinates past the edge
 * (see `clipPictures` for one that stops there).
 */
export function projectPictures(positions: Float32Array, pictures: Projector[]): Float32Array {
  return atlasUVs(takePictures(positions, pictures), pictures);
}

/** A corner being cut: where it is on the picture, in the mesh, and its normal. */
interface Cut {
  u: number;
  v: number;
  p: Vec3;
  n: Vec3;
}

/** Corners this close to a picture's edge count as on it, so no sliver is cut off. */
const CUT_EPS = 1e-6;

/** Splits a convex polygon along a line: what lies on the side where `side` is positive, and what lies on the other. */
function splitPolygon(poly: Cut[], side: (c: Cut) => number): { kept: Cut[]; cut: Cut[] } {
  const d = poly.map(side);
  if (d.every((x) => x >= -CUT_EPS)) return { kept: poly, cut: [] };
  if (d.every((x) => x <= CUT_EPS)) return { kept: [], cut: poly };
  const kept: Cut[] = [];
  const cut: Cut[] = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const a = poly[i];
    if (d[i] >= -CUT_EPS) kept.push(a);
    if (d[i] <= CUT_EPS) cut.push(a);
    if ((d[i] > CUT_EPS && d[j] < -CUT_EPS) || (d[i] < -CUT_EPS && d[j] > CUT_EPS)) {
      const b = poly[j];
      const t = d[i] / (d[i] - d[j]);
      const mix = (x: number, y: number) => x + (y - x) * t;
      const m: Cut = {
        u: mix(a.u, b.u),
        v: mix(a.v, b.v),
        p: [mix(a.p[0], b.p[0]), mix(a.p[1], b.p[1]), mix(a.p[2], b.p[2])],
        n: unit([mix(a.n[0], b.n[0]), mix(a.n[1], b.n[1]), mix(a.n[2], b.n[2])]),
      };
      kept.push(m);
      cut.push(m);
    }
  }
  return { kept, cut };
}

/** The four edges of a picture, as the side of each a corner lies on (positive inside). */
const PICTURE_EDGES: ((c: Cut) => number)[] = [(c) => c.u, (c) => 1 - c.u, (c) => c.v, (c) => 1 - c.v];

/**
 * The mesh with texture coordinates from pictures projected onto it, as
 * `projectPictures`, but a triangle that reaches past a picture's edge is cut
 * along the edge: the part under the picture keeps it and the rest samples the
 * fill, instead of running on into whatever lies next to the picture in the
 * atlas. The corners come back unchanged when nothing had to be cut.
 */
export function clipPictures(positions: Float32Array, normals: Float32Array, pictures: Projector[]): SkinMesh {
  const taken = takePictures(positions, pictures);
  const inside = (c: [number, number]) => c[0] >= -CUT_EPS && c[0] <= 1 + CUT_EPS && c[1] >= -CUT_EPS && c[1] <= 1 + CUT_EPS;
  const whole = taken.every((got) => !got || got.uv.every(inside));
  if (whole) return { positions, normals, uv: atlasUVs(taken, pictures) };
  const outP: number[] = [];
  const outN: number[] = [];
  const outUV: number[] = [];
  const outFace: number[] = [];
  let from = 0;
  // A convex polygon goes out as a fan of triangles, in the order it came so that it keeps facing outwards.
  const emit = (poly: Cut[], rect: Projector['rect'] | null) => {
    for (let k = 1; k + 1 < poly.length; k++) {
      outFace.push(from);
      for (const c of [poly[0], poly[k], poly[k + 1]]) {
        outP.push(c.p[0], c.p[1], c.p[2]);
        outN.push(c.n[0], c.n[1], c.n[2]);
        if (rect) outUV.push(rect[0] + c.u * (rect[2] - rect[0]), rect[1] + c.v * (rect[3] - rect[1]));
        else outUV.push(FILL_UV[0], FILL_UV[1]);
      }
    }
  };
  for (let t = 0; t < taken.length; t++) {
    const got = taken[t];
    const i = t * 9;
    from = t;
    const poly: Cut[] = [0, 1, 2].map((c) => ({
      u: got ? got.uv[c][0] : 0,
      v: got ? got.uv[c][1] : 0,
      p: [positions[i + c * 3], positions[i + c * 3 + 1], positions[i + c * 3 + 2]],
      n: [normals[i + c * 3], normals[i + c * 3 + 1], normals[i + c * 3 + 2]],
    }));
    if (!got) {
      emit(poly, null);
      continue;
    }
    let kept = poly;
    for (const edge of PICTURE_EDGES) {
      const split = splitPolygon(kept, edge);
      emit(split.cut, null);
      kept = split.kept;
      if (kept.length < 3) break;
    }
    emit(kept, pictures[got.pic].rect);
  }
  return { positions: Float32Array.from(outP), normals: Float32Array.from(outN), uv: Float32Array.from(outUV), faces: Uint32Array.from(outFace) };
}

/** Where a triangle lands on a flat sheet's picture, or null if it lies wholly beside it. */
function flatLanding(pic: Projector, normal: Vec3, q: Vec3[]): Landing | null {
  // The sheet prints onto what lies behind it (-Z of its frame), not onto what sits in front of it.
  if ((q[0][2] + q[1][2] + q[2][2]) / 3 > FLAT_REACH) return null;
  const uv = q.map((p): [number, number] => [p[0] + 0.5, p[1] + 0.5]);
  if (!underPicture(uv)) return null;
  // The sheet faces +Z of its own frame; a face receives the picture when it looks back at the sheet.
  return { uv, depth: q.map((p) => p[2]), facing: dot(normal, unit(direction(pic.matrix, [0, 0, 1]))) >= FACING };
}

/** Where a triangle lands on a wrapped picture, or null if it lies wholly beside it or straddles the seam. */
function wrapLanding(pic: Projector, normal: Vec3, q: Vec3[]): Landing | null {
  const span = (Math.min(360, Math.max(1, pic.angle)) * Math.PI) / 180;
  const angles = q.map((p) => azimuth(p[0], p[1]));
  // The seam, opposite the middle of the picture, must not be smeared across a triangle that straddles it.
  if (Math.max(...angles) - Math.min(...angles) > Math.PI) return null;
  const uv = q.map((p, c): [number, number] => [0.5 + angles[c] / span, p[2] + 0.5]);
  if (!underPicture(uv)) return null;
  // Outwards from the axis at the triangle's middle, in the mesh's frame. The band prints inwards
  // onto what lies within it, not onto what sticks out past it.
  const mid: Vec3 = [(q[0][0] + q[1][0] + q[2][0]) / 3, (q[0][1] + q[1][1] + q[2][1]) / 3, 0];
  const radius = Math.hypot(mid[0], mid[1]);
  if (radius > WRAP_REACH || radius < 1e-9) return null;
  const facing = dot(normal, unit(direction(pic.matrix, mid))) >= FACING;
  return { uv, depth: q.map((p) => Math.hypot(p[0], p[1])), facing };
}

/** False when the triangle lies wholly beside, above or below the picture, so no part of it can show. */
function underPicture(local: [number, number][]): boolean {
  for (const axis of [0, 1]) {
    if (local.every((p) => p[axis] < 0) || local.every((p) => p[axis] > 1)) return false;
  }
  return true;
}

/** Every pixel of the depth map a triangle covers, with the triangle's depth there. */
function rasterize(l: Landing, N: number, visit: (index: number, depth: number) => void): void {
  const [a, b, c] = l.uv;
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(area) < 1e-12) return;
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) * N));
  const x1 = Math.min(N - 1, Math.ceil(Math.max(a[0], b[0], c[0]) * N));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) * N));
  const y1 = Math.min(N - 1, Math.ceil(Math.max(a[1], b[1], c[1]) * N));
  for (let y = y0; y <= y1; y++) {
    const py = (y + 0.5) / N;
    for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5) / N;
      // Barycentric weights of the pixel's middle; inside when none is negative.
      const wb = ((px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1])) / area;
      const wc = ((b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1])) / area;
      const wa = 1 - wb - wc;
      if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
      visit(y * N + x, wa * l.depth[0] + wb * l.depth[1] + wc * l.depth[2]);
    }
  }
}

/**
 * The nearest surface at every point of the picture, from every triangle under
 * it: a triangle is hidden when, over the part of it that lies under the
 * picture, another surface mostly sits between it and the picture.
 */
function depthMap(landings: (Landing | null)[]): { hidden(landing: Landing): boolean } {
  const N = DEPTH_MAP;
  const map = new Float32Array(N * N).fill(-Infinity);
  let lowest = Infinity;
  let highest = -Infinity;
  for (const l of landings) {
    if (!l) continue;
    for (const d of l.depth) {
      if (d < lowest) lowest = d;
      if (d > highest) highest = d;
    }
    rasterize(l, N, (index, d) => {
      if (d > map[index]) map[index] = d;
    });
  }
  // A surface has to sit clearly behind another to count as hidden by it.
  const slack = 0.01 * (highest - lowest) + 1e-9;
  return {
    hidden(l) {
      let seen = 0;
      let covered = 0;
      rasterize(l, N, (index, d) => {
        if (map[index] > d + slack) covered++;
        else seen++;
      });
      if (seen + covered > 0) return covered > seen;
      // Too small to touch a pixel's middle (a sliver along an edge): judged at its own middle.
      const u = (l.uv[0][0] + l.uv[1][0] + l.uv[2][0]) / 3;
      const v = (l.uv[0][1] + l.uv[1][1] + l.uv[2][1]) / 3;
      if (u < 0 || u > 1 || v < 0 || v > 1) return false;
      const d = (l.depth[0] + l.depth[1] + l.depth[2]) / 3;
      return map[Math.min(N - 1, Math.floor(v * N)) * N + Math.min(N - 1, Math.floor(u * N))] > d + slack;
    },
  };
}

/** An object's own texture, over its whole surface. */
export interface Covering {
  mode: 'wrap' | 'tile';
  /** Millimeters per repeat, for a tiled picture. */
  scale: number;
  /** Degrees a wrapped picture is turned round the axis; at 0 its middle faces the front (-Y). */
  turn?: number;
  /** Built units to millimeters along each axis (the mesh is in the built frame). */
  mm: Vec3;
  /** Lowest and highest Z of the mesh, for the wrapped picture's height. */
  z: [number, number];
}

/**
 * Texture coordinates covering the whole mesh. Wrapped: once around the Z
 * axis, from the bottom to the top. Tiled: each triangle from the axis it
 * faces most, every `scale` mm, so a pattern reads the same on every side.
 */
export function coverSurface(positions: Float32Array, cover: Covering): Float32Array {
  const uv = new Float32Array((positions.length / 3) * 2);
  const height = Math.max(cover.z[1] - cover.z[0], 1e-9);
  const turn = ((cover.turn ?? 0) * Math.PI) / 180;
  for (let i = 0; i < positions.length; i += 9) {
    if (cover.mode === 'wrap') {
      const us: number[] = [];
      for (let c = 0; c < 3; c++) {
        // Kept within a turn, so the seam fix below sees the corners as the seam does.
        const a = azimuth(positions[i + c * 3], positions[i + c * 3 + 1]) - turn;
        us.push(0.5 + (a - 2 * Math.PI * Math.round(a / (2 * Math.PI))) / (2 * Math.PI));
        uv[(i / 3 + c) * 2 + 1] = (positions[i + c * 3 + 2] - cover.z[0]) / height;
      }
      // Across the seam the picture repeats: the corners on the low side are carried a turn on.
      const seam = Math.max(...us) - Math.min(...us) > 0.5;
      for (let c = 0; c < 3; c++) uv[(i / 3 + c) * 2] = seam && us[c] < 0.5 ? us[c] + 1 : us[c];
      continue;
    }
    const n = faceNormal(positions, i);
    const ax = Math.abs(n[0]);
    const ay = Math.abs(n[1]);
    const az = Math.abs(n[2]);
    // The two axes across the dominant one, kept right-handed as seen from outside.
    const [a, b, flip] = az >= ax && az >= ay ? [0, 1, n[2] < 0] : ax >= ay ? [1, 2, n[0] < 0] : [0, 2, n[1] > 0];
    for (let c = 0; c < 3; c++) {
      const pa = (positions[i + c * 3 + a] * cover.mm[a]) / cover.scale;
      const pb = (positions[i + c * 3 + b] * cover.mm[b]) / cover.scale;
      uv[(i / 3 + c) * 2] = flip ? -pa : pa;
      uv[(i / 3 + c) * 2 + 1] = pb;
    }
  }
  return uv;
}

/** Coordinates of a picture's own sheet (built at unit size), showing the whole picture once. */
export function sheetUVs(positions: Float32Array, mapping: PictureMapping, angle: number): Float32Array {
  const uv = new Float32Array((positions.length / 3) * 2);
  const span = (Math.min(360, Math.max(1, angle)) * Math.PI) / 180;
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = [positions[i], positions[i + 1], positions[i + 2]];
    if (mapping === 'flat') uv.set([x + 0.5, y + 0.5], (i / 3) * 2);
    else uv.set([0.5 + azimuth(x, y) / span, z + 0.5], (i / 3) * 2);
  }
  return uv;
}
