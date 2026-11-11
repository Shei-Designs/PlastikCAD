// The boxes a value is typed in after a click on a grip: what each one would
// set, where it goes on screen so that it reads like a dimension line, and
// how the boxes follow the camera or go away when the view turns.
import { Vector3 } from 'three';
import type { Quaternion } from 'three';
import { tr, trx } from '../i18n';
import { boundsCenter } from '../model/math';
import type { Vec3 } from '../model/types';
import { MOVE_ARROW_PIXELS } from './handles';
import type { Handle, Handles } from './handles';
import { ARROW_HEAD, SLIDE_ARROW } from './markers';
import { AXIS_COLORS, pixelSize, toClient } from './stage';
import type { Stage } from './stage';
import type { HandlePrompt } from './types';

/** A typing box sits this far out from the edge it measures: clear of the grip drawn there. */
const PROMPT_PAD = 14; // px
/** A box beside a grip starts this far from the grip's center, and no box comes nearer than this to the edge of the view (more at the top, under the toolbar). */
const PROMPT_BESIDE = 30; // px
const PROMPT_MARGIN = 8; // px
const PROMPT_MARGIN_TOP = 52; // px
const PROMPT_BOX: [number, number] = [100, 28]; // px, about the size of a box

/** The edges of the view on screen, as `getBoundingClientRect` gives them. */
export interface ViewRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Where the boxes go on screen. Each box is pushed out from its anchor along
 * the way out of the object there, which is the way from the object's middle
 * through the edge, square to the edge as seen on screen, far enough that the
 * box's near corner sits a pad off the anchor. That holds for an edge behind
 * the object too: the box then lies over the object, but on the side a
 * dimension of that edge would be read from. The boxes are the same size at
 * any zoom, so a small-looking object gets them hugging its edges just the
 * same; two that would still land on each other are moved apart.
 */
export function placePrompt(prompt: HandlePrompt, onScreen: (p: Vector3) => { clientX: number; clientY: number }, view: ViewRect): HandlePrompt {
  const EPS = 1e-3;
  const center = onScreen(new Vector3(...prompt.center));
  const [bw, bh] = PROMPT_BOX;
  /**
   * The center of a box pushed out from `at` along `n`: its near corner a pad off `at` when `n` is well
   * off the axes, sliding towards centered on the pad line as `n` lines up with an axis. The slide is
   * continuous, so a small change of view moves the box a little rather than snapping it across.
   */
  const centerFor = (at: { clientX: number; clientY: number }, n: [number, number], pad = PROMPT_PAD): [number, number] => {
    const lean = (c: number) => Math.max(-1, Math.min(1, c / 0.45));
    return [at.clientX + n[0] * pad + lean(n[0]) * (bw / 2), at.clientY + n[1] * pad + lean(n[1]) * (bh / 2)];
  };
  const dirOnScreen = (from: Vec3, dir: Vec3): [number, number] => {
    const a = onScreen(new Vector3(...from));
    const b = onScreen(new Vector3(from[0] + dir[0] * EPS, from[1] + dir[1] * EPS, from[2] + dir[2] * EPS));
    return [b.clientX - a.clientX, b.clientY - a.clientY];
  };
  const unit = ([x, y]: [number, number]): [number, number] | null => {
    const l = Math.hypot(x, y);
    return l < 1e-9 ? null : [x / l, y / l];
  };
  const fields = prompt.fields.map((field) => {
    const at = onScreen(new Vector3(...field.anchor));
    if (field.beside) {
      // To the right of the grip, or to the left when the right would run off the view.
      const right = at.clientX + PROMPT_BESIDE + bw / 2;
      const cx = right + bw / 2 + PROMPT_MARGIN <= view.right ? right : at.clientX - PROMPT_BESIDE - bw / 2;
      return { ...field, clientX: cx, clientY: at.clientY };
    }
    if (field.keepOut) {
      // Away from the object's middle, starting at the handle's middle, out until the box clears the handle by a pad.
      const pts = field.keepOut.map((p) => onScreen(new Vector3(...p)));
      const box = { l: Math.min(...pts.map((p) => p.clientX)), r: Math.max(...pts.map((p) => p.clientX)), t: Math.min(...pts.map((p) => p.clientY)), b: Math.max(...pts.map((p) => p.clientY)) };
      const mid = { clientX: (box.l + box.r) / 2, clientY: (box.t + box.b) / 2 };
      let n = unit([mid.clientX - center.clientX, mid.clientY - center.clientY]) ?? [0, -1];
      if (field.heading && n[0] * field.heading[0] + n[1] * field.heading[1] < 0) n = [-n[0], -n[1]];
      const clear = (cx: number, cy: number) => cx + bw / 2 + PROMPT_PAD / 2 <= box.l || cx - bw / 2 - PROMPT_PAD / 2 >= box.r || cy + bh / 2 + PROMPT_PAD / 2 <= box.t || cy - bh / 2 - PROMPT_PAD / 2 >= box.b;
      let t = 0;
      while (t < 400 && !clear(mid.clientX + n[0] * t, mid.clientY + n[1] * t)) t += 2;
      return { ...field, heading: n, clientX: mid.clientX + n[0] * t, clientY: mid.clientY + n[1] * t };
    }
    // Out of the object on screen: away from the box's reference point, a fixed way out, or away from the middle; then square to the edge.
    const from = field.ref ? onScreen(new Vector3(...field.ref)) : center;
    let n: [number, number] | null = field.out ? unit(dirOnScreen(field.anchor, field.out)) : null;
    n ??= unit([at.clientX - from.clientX, at.clientY - from.clientY]);
    const e = field.along ? unit(dirOnScreen(field.anchor, field.along)) : null;
    if (n && e) {
      const d = n[0] * e[0] + n[1] * e[1];
      n = unit([n[0] - d * e[0], n[1] - d * e[1]]) ?? n;
    }
    n ??= [0, 1];
    // The side was settled when the boxes first appeared; a zoom or pan afterwards must not swap it.
    if (field.heading && n[0] * field.heading[0] + n[1] * field.heading[1] < 0) n = [-n[0], -n[1]];
    const [cx, cy] = centerFor(at, n, field.pad);
    return { ...field, heading: n, clientX: cx, clientY: cy };
  });
  // Boxes that would overlap are moved apart along the line between them until they clear.
  for (let a = 0; a < fields.length; a++)
    for (let b = a + 1; b < fields.length; b++) {
      const dx = fields[b].clientX - fields[a].clientX;
      const dy = fields[b].clientY - fields[a].clientY;
      if (Math.abs(dx) >= bw || Math.abs(dy) >= bh) continue;
      // Clear whichever way needs the smaller move, up and down for a level pair.
      const needX = bw - Math.abs(dx);
      const needY = bh - Math.abs(dy);
      if (needY <= needX) {
        const sign = dy >= 0 ? 1 : -1;
        fields[a].clientY -= (sign * (needY + 2)) / 2;
        fields[b].clientY += (sign * (needY + 2)) / 2;
      } else {
        const sign = dx >= 0 ? 1 : -1;
        fields[a].clientX -= (sign * (needX + 2)) / 2;
        fields[b].clientX += (sign * (needX + 2)) / 2;
      }
    }
  // What each box measures, on screen.
  for (const f of fields) {
    if (!f.span) continue;
    const a = onScreen(new Vector3(...f.span.from));
    const b = onScreen(new Vector3(...f.span.to));
    f.ends = [
      [a.clientX, a.clientY],
      [b.clientX, b.clientY],
    ];
  }
  // Nothing goes off the view: a box that would is brought back to the margin.
  for (const f of fields) {
    f.clientX = Math.min(Math.max(f.clientX, view.left + PROMPT_MARGIN + bw / 2), view.right - PROMPT_MARGIN - bw / 2);
    f.clientY = Math.min(Math.max(f.clientY, view.top + PROMPT_MARGIN_TOP + bh / 2), view.bottom - PROMPT_MARGIN - bh / 2);
  }
  return { ...prompt, fields };
}

export class HandlePrompts {
  /** The typing boxes on show, with the camera's heading when they appeared: a turn takes them away, a zoom or pan moves them. */
  current: { prompt: HandlePrompt; heading: Quaternion; handle: Handle } | null = null;

  constructor(
    private readonly stage: Pick<Stage, 'camera' | 'renderer' | 'events' | 'height' | 'requestRender'>,
    private readonly handles: Handles,
  ) {}

  /** Of some points in the object's frame, the one nearest the camera. */
  private nearest<T extends { at: Vec3 }>(choices: T[]): T {
    let best = choices[0];
    let bestD = this.handles.framePoint(best.at).distanceTo(this.stage.camera.position);
    for (const c of choices.slice(1)) {
      const d = this.handles.framePoint(c.at).distanceTo(this.stage.camera.position);
      if (d < bestD) [best, bestD] = [c, d];
    }
    return best;
  }

  /** A direction of the object's frame, in the scene. */
  private frameDir(local: Vec3): Vec3 {
    return this.handles.framePoint(local).sub(this.handles.framePoint([0, 0, 0])).normalize().toArray() as Vec3;
  }

  /**
   * What typing a value for this handle would set. Each box sits just outside
   * the middle of an edge running along the dimension it changes, on the side
   * of the grip (or the side facing the camera), so it reads like a dimension
   * line and keeps off the object.
   */
  private promptFor(handle: Handle): HandlePrompt | null {
    const f = this.handles.frame;
    if (!f) return null;
    const k = handle.kind;
    const [hx, hy, hz] = f.half;
    const center = this.handles.framePoint([0, 0, 0]).toArray() as Vec3;
    type Field = HandlePrompt['fields'][number];
    /**
     * A box on the middle of an edge of the frame: `at` its middle, `along` its run, `ref` the point it
     * keeps away from. For the bottom edges that is the middle of the bottom face: seen from above, a
     * box on a back edge then goes up the picture, over the object but on the side the edge is read
     * from, rather than down into the drawing of the underside.
     */
    const edge = (tag: string, name: string, axis: 0 | 1, value: number, at: Vec3, along: Vec3, ref: Vec3): Field => ({
      tag,
      name,
      color: AXIS_COLORS[axis],
      value,
      span: { from: this.handles.framePoint([at[0] - along[0] * hx, at[1] - along[1] * hy, at[2]]).toArray() as Vec3, to: this.handles.framePoint([at[0] + along[0] * hx, at[1] + along[1] * hy, at[2]]).toArray() as Vec3 },
      anchor: this.handles.framePoint(at).toArray() as Vec3,
      ref: this.handles.framePoint(ref).toArray() as Vec3,
      along: this.frameDir(along),
      clientX: 0,
      clientY: 0,
    });
    let made: HandlePrompt | null = null;
    switch (k.type) {
      case 'height':
        // Right beside the height grip, so that it stays to hand on a big object seen close up; level with
        // the grip, it covers neither the grip nor the move arrows in the middle.
        made = {
          kind: k,
          unit: 'mm',
          center,
          fields: [
            {
              tag: trx('size', 'H'),
              name: tr('Height'),
              color: AXIS_COLORS[2],
              value: hz * 2,
              span: { from: this.handles.framePoint([0, 0, -hz]).toArray() as Vec3, to: this.handles.framePoint([0, 0, hz]).toArray() as Vec3 },
              anchor: handle.object.getWorldPosition(new Vector3()).toArray() as Vec3,
              beside: true,
              clientX: 0,
              clientY: 0,
            },
          ],
        };
        break;
      case 'resize': {
        const fields: Field[] = [];
        if (k.sx !== 0) {
          // Width goes on a bottom edge running along X: at the grip's side, else the side facing the camera.
          const side = k.sy !== 0 ? k.sy : this.nearest([{ at: [0, -hy, -hz] as Vec3, s: -1 }, { at: [0, hy, -hz] as Vec3, s: 1 }]).s;
          fields.push(edge(trx('size', 'W'), tr('Width'), 0, hx * 2, [0, side * hy, -hz], [1, 0, 0], [0, 0, -hz]));
        }
        if (k.sy !== 0) {
          const side = k.sx !== 0 ? k.sx : this.nearest([{ at: [-hx, 0, -hz] as Vec3, s: -1 }, { at: [hx, 0, -hz] as Vec3, s: 1 }]).s;
          fields.push(edge(trx('size', 'D'), tr('Depth'), 1, hy * 2, [side * hx, 0, -hz], [0, 1, 0], [0, 0, -hz]));
        }
        made = { kind: k, unit: 'mm', center, fields };
        break;
      }
      case 'move':
        // Only the Z arrow has a value worth typing: how high the selection stands. The box sits past the arrow's head.
        // Along the object's own Z (Object axes) there is no height worth typing.
        if (k.axis === 2 && !f.local) {
          // The rise from the plate to the bottom, drawn up the middle; nothing to draw while it sits on the plate.
          const [cx, cy] = boundsCenter(f.bounds);
          const z = f.bounds.min[2];
          made = {
            kind: k,
            unit: 'mm',
            center,
            fields: [
              {
                tag: 'Z',
                name: trx('above the plate', 'Base height'),
                color: AXIS_COLORS[2],
                value: z,
                ...(Math.abs(z) > 1e-6 ? { span: { from: [cx, cy, 0] as Vec3, to: [cx, cy, z] as Vec3 } } : {}),
                anchor: handle.object.position.toArray() as Vec3,
                out: [0, 0, 1],
                pad: MOVE_ARROW_PIXELS * (SLIDE_ARROW.to + ARROW_HEAD) + PROMPT_PAD,
                clientX: 0,
                clientY: 0,
              },
            ],
          };
        }
        break;
      case 'rotate': {
        // The arc with its two arrowheads, sampled, so that the box can keep off the whole of it.
        const ring = handle.object;
        const keepOut = [0, 0.25, 0.5, 0.75, 1].map((t) => new Vector3(Math.cos((t * Math.PI) / 2), Math.sin((t * Math.PI) / 2), 0));
        keepOut.push(new Vector3(1.2, -0.35, 0), new Vector3(-0.35, 1.2, 0), new Vector3(0, 0, 0));
        // The line the turn goes about, through the pivot and a little past the box either way.
        const pivot: Vec3 = f.single ? [...f.single.pos] : boundsCenter(f.bounds);
        const reach = f.half[k.axis] + 24 * pixelSize(this.stage, new Vector3(...pivot));
        const dir = this.handles.frameAxis(k.axis).multiplyScalar(reach);
        const from = new Vector3(...pivot).sub(dir).toArray() as Vec3;
        const to = new Vector3(...pivot).add(dir).toArray() as Vec3;
        made = {
          kind: k,
          unit: '°',
          center,
          fields: [
            {
              tag: 'XYZ'[k.axis],
              name: tr('Turn about {axis}', { axis: 'XYZ'[k.axis] }),
              color: AXIS_COLORS[k.axis],
              value: 0,
              span: { from, to, axis: true },
              anchor: ring.getWorldPosition(new Vector3()).toArray() as Vec3,
              keepOut: keepOut.map((p) => ring.localToWorld(p).toArray() as Vec3),
              clientX: 0,
              clientY: 0,
            },
          ],
        };
        break;
      }
      default:
        return null;
    }
    return made && this.place(made);
  }

  private place(prompt: HandlePrompt): HandlePrompt {
    return placePrompt(prompt, (p) => toClient(this.stage, p), this.stage.renderer.domElement.getBoundingClientRect());
  }

  /** Brings up the boxes for a handle that was clicked, if it has a value worth typing. */
  show(handle: Handle): void {
    const prompt = this.promptFor(handle);
    if (prompt) {
      this.current = { prompt, heading: this.stage.camera.quaternion.clone(), handle };
      this.stage.requestRender();
      this.stage.events.onHandleClick(prompt);
    }
  }

  /** Take the typing boxes away (the boxes call this too when they close themselves). */
  dismiss(): void {
    if (!this.current) return;
    this.current = null;
    this.stage.events.onHandleClick(null);
    this.stage.requestRender();
  }

  /** After the camera moved: boxes follow a zoom or a pan, and go away when the view turns. */
  follow(): void {
    if (!this.current) return;
    if (this.stage.camera.quaternion.angleTo(this.current.heading) > 1e-4) {
      this.dismiss();
      return;
    }
    const prompt = this.place(this.current.prompt);
    this.current = { ...this.current, prompt };
    this.stage.events.onHandleClick(prompt);
  }
}
