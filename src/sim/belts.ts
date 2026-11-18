// How far each track's belt has run in a test drive, read from the wheels that
// stand in for it: the simulation has no belt, but the belt goes round with
// those wheels, so the lugs are drawn as far along as the wheels have turned.
// A track that slips or stalls shows the speed its wheels really have.
import { determinant } from '../model/math';
import type { Mat } from '../model/math';
import type { Vec3 } from '../model/types';

/** A track as the simulation has it: its body and the bodies of its wheels, as the frame's poses count them. */
export interface BeltTrack {
  /** The design object the track is. */
  node: string;
  body: number;
  wheels: number[];
  /** The way the axles run, in the design's axes, such that a turn about it carries the belt forward along its path: a unit vector. */
  axis: Vec3;
  /** The wheels' radius as the part's settings have it: a turn of one radian carries the belt this far along its path, mm. */
  radius: number;
}

/**
 * The axis a track's belt is turned about and how far a radian carries it, from where the part stands (see
 * `Track.toDesign`): the belt's path goes round the part's -Y, and a mirrored part's goes round the other way.
 */
export function beltAxis(toDesign: Mat): { axis: Vec3; mirrored: boolean } {
  const y: Vec3 = [-toDesign[3], -toDesign[4], -toDesign[5]];
  const n = Math.hypot(...y) || 1;
  const mirrored = determinant(toDesign) < 0;
  // A mirror turns a turn about an axis into the opposite turn about the mirrored axis.
  return { axis: y.map((v) => (mirrored ? -v : v) / n) as Vec3, mirrored };
}

/** The wheels of a track among a model's bodies: those the export named after the track's own body, in their order. */
export function beltWheels(bodies: string[], track: string, taken: (name: string) => boolean): number[] {
  const found: { index: number; n: number }[] = [];
  bodies.forEach((name, index) => {
    if (!name.startsWith(`${track}_wheel_`) || taken(name)) return;
    const n = Number(name.slice(track.length + 7));
    if (Number.isInteger(n) && n > 0) found.push({ index, n });
  });
  return found.sort((a, b) => a.n - b.n).map((f) => f.index);
}

/** How far a wheel is turned against its track about `axis`, radians within a turn; both as the frame's poses have them (7 numbers each: xyz, then quaternion wxyz). */
function turnOf(poses: Float64Array, track: number, wheel: number, axis: Vec3): number {
  const [tw, tx, ty, tz] = [poses[7 * track + 3], -poses[7 * track + 4], -poses[7 * track + 5], -poses[7 * track + 6]];
  const [ww, wx, wy, wz] = [poses[7 * wheel + 3], poses[7 * wheel + 4], poses[7 * wheel + 5], poses[7 * wheel + 6]];
  // The wheel's turn as its track sees it: the track's turn undone, then the wheel's.
  const w = tw * ww - tx * wx - ty * wy - tz * wz;
  const x = tw * wx + tx * ww + ty * wz - tz * wy;
  const y = tw * wy - tx * wz + ty * ww + tz * wx;
  const z = tw * wz + tx * wy - ty * wx + tz * ww;
  return 2 * Math.atan2(x * axis[0] + y * axis[1] + z * axis[2], w);
}

/**
 * Follows the belts of a drive's tracks from frame to frame. A pose tells a wheel's turn only within one turn,
 * so each wheel's turn since the frame before is added up; the belt has run as far as its wheels have on average.
 */
export class BeltWatch {
  private last = new Map<string, number[]>();
  private travel = new Map<string, number>();

  constructor(private readonly tracks: BeltTrack[] = []) {}

  /** The start pose again: no belt has run. */
  clear(): Map<string, number> {
    this.last.clear();
    this.travel = new Map(this.tracks.map((t) => [t.node, 0]));
    return this.travel;
  }

  /** How far each track's belt has run along its path by this frame, mm as the part's settings have it, by the track's object. */
  see(poses: Float64Array): Map<string, number> {
    const next = new Map<string, number>();
    for (const t of this.tracks) {
      const turns = t.wheels.map((w) => turnOf(poses, t.body, w, t.axis));
      const before = this.last.get(t.node);
      let turned = 0;
      if (before && turns.length > 0) {
        for (let i = 0; i < turns.length; i++) {
          // The short way round: a wheel turns far less than half a turn between two frames.
          let d = (turns[i] - before[i]) % (2 * Math.PI);
          if (d > Math.PI) d -= 2 * Math.PI;
          else if (d < -Math.PI) d += 2 * Math.PI;
          turned += d;
        }
        turned /= turns.length;
      }
      this.last.set(t.node, turns);
      next.set(t.node, (this.travel.get(t.node) ?? 0) + turned * t.radius);
    }
    this.travel = next;
    return next;
  }
}
