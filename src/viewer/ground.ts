// The floor under the design: the build plate's grid lines, and the ground of
// a test drive when it is not the plate.
import { BoxGeometry, BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, PlaneGeometry } from 'three';
import type { Object3D } from 'three';
import { terrain, worldBlocks } from '../io/mjcf';
import { fromUnit, toUnit } from '../units';
import type { Unit } from '../units';
import type { ViewerOptions } from './types';

/**
 * The floor of a test drive, as the MuJoCo model has it: the rough field's
 * 64×64 heights over 6 m, 30 mm high; a 10 m plane tilted 0.14 rad about X;
 * or the blocks of a course of steps or a ramp standing on the plate ahead of
 * the robot. Sand-colored and faceted, so that the bumps read.
 */
export function groundMesh(ground: NonNullable<ViewerOptions['ground']>, color: number): Object3D {
  const material = new MeshStandardMaterial({ color, roughness: 0.95, metalness: 0, flatShading: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
  const kind = ground.world;
  if (kind === 'steps' || kind === 'ramp') {
    const group = new Group();
    for (const b of worldBlocks(kind, ground.forward)) {
      const mesh = new Mesh(new BoxGeometry(b.size[0] * 1000, b.size[1] * 1000, b.size[2] * 1000), material);
      mesh.position.set(b.pos[0] * 1000, b.pos[1] * 1000, b.pos[2] * 1000);
      mesh.rotation.set(0, -b.pitch, b.yaw, 'ZYX');
      mesh.renderOrder = -1;
      group.add(mesh);
    }
    return group;
  }
  let geometry: BufferGeometry;
  if (kind === 'rough') {
    const n = 64;
    const heights = terrain(n);
    const size = 6000;
    const plane = new PlaneGeometry(size, size, n - 1, n - 1);
    const pos = plane.getAttribute('position') as BufferAttribute;
    for (let v = 0; v < pos.count; v++) {
      // MuJoCo stores rows along Y, the first row at the least Y; a PlaneGeometry's vertices run from +Y down.
      const j = Math.round((pos.getX(v) / size + 0.5) * (n - 1));
      const i = Math.round((pos.getY(v) / size + 0.5) * (n - 1));
      pos.setZ(v, heights[i * n + j] * 30);
    }
    plane.computeVertexNormals();
    geometry = plane;
  } else {
    geometry = new PlaneGeometry(10000, 10000);
    geometry.rotateX(0.14);
  }
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = -1;
  return mesh;
}

/** Frees a ground's meshes; a course shares one material among its blocks. */
export function disposeGround(ground: Object3D): void {
  const materials = new Set<MeshStandardMaterial>();
  ground.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      materials.add(o.material as MeshStandardMaterial);
    }
  });
  for (const m of materials) m.dispose();
}

/**
 * The steps the heavy lines of the plate's grid can have, in the unit's own measure and smallest first, each with
 * the step of the light lines between them: every 10 mm, every 100 mm and every meter, with a light line half
 * way and a meter in quarters; every inch, every foot and every yard, with a light line half way and a yard in feet.
 */
const RUNGS: Record<Unit, readonly (readonly [major: number, minor: number])[]> = {
  mm: [
    [10, 5],
    [100, 50],
    [1000, 250],
  ],
  in: [
    [1, 0.5],
    [12, 6],
    [36, 12],
  ],
};
/** The light lines under a small design, where the smallest heavy step can be split finer: millimeters, eighths of an inch. */
const FINE: Record<Unit, number> = { mm: 1, in: 0.125 };
/** The most heavy lines each way before they go to the next step. */
const MOST = 30;

/**
 * The plate's grid for a design that reaches `wanted` mm from the middle: how far the grid runs each way, and the
 * steps of its heavy and its light lines, in millimeters. The grid grows with the design, five heavy steps at a
 * time, and with more than thirty heavy lines each way they go to the next step of the unit (see `RUNGS`); past
 * the last, to ten times it, and ten times that. A design the size of a room is so drawn in meters, or in yards,
 * with no more lines than a small one has.
 */
export function plateGrid(wanted: number, unit: Unit): { half: number; major: number; minor: number } {
  // In the unit's own measure, where the steps are whole: thirty inches are 762 mm, and 25.4 times thirty is not quite.
  const reach = Number(toUnit(wanted, unit).toFixed(6));
  const rungs = RUNGS[unit];
  let [major, minor] = rungs.find(([step]) => reach <= MOST * step) ?? rungs[rungs.length - 1];
  while (reach > MOST * major) {
    major *= 10;
    minor *= 10;
  }
  const half = Math.ceil(reach / (major * 5)) * 5 * major;
  // A line every millimeter on a big plate is more lines than it is help.
  if (major === rungs[0][0] && half <= MOST * major / 2) minor = FINE[unit];
  return { half: fromUnit(half, unit), major: fromUnit(major, unit), minor: fromUnit(minor, unit) };
}

export function gridLines(half: number, step: number, skipStep: number): BufferGeometry {
  const pts: number[] = [];
  const n = Math.round(half / step);
  for (let i = -n; i <= n; i++) {
    if (skipStep && i % Math.round(skipStep / step) === 0) continue;
    const v = i * step;
    pts.push(v, -half, 0, v, half, 0, -half, v, 0, half, v, 0);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
  return g;
}
