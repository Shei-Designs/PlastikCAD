// The floor under the design: the build plate's grid lines, and the ground of
// a test drive when it is not the plate.
import { BoxGeometry, BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, PlaneGeometry } from 'three';
import type { Object3D } from 'three';
import { terrain, worldBlocks } from '../io/mjcf';
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
