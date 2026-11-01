// The reference robots (fixtures.ts) built with the real kernel. They must
// pass the checks and export cleanly in every format; with ROBOT_FIXTURES_OUT
// set, their MuJoCo models are written there for tools/mujoco_smoke.py to
// simulate, their ROS and SDF packages under its ros/ and sdf/ for
// tools/ros_smoke.sh, their Isaac Sim stages under usd/ for
// tools/isaac_stage_smoke.sh, and the designs themselves are saved under
// fixtures/robots for opening in the app.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initKernel, robotGeometry } from '../geometry/kernel';
import { serializeDoc } from '../model/file';
import { checkRobot } from './check';
import { buildIsaacStage, buildMjcfModel, buildRobotPackage, buildSdfModel } from './export';
import type { RobotPackage } from './export';
import { ROBOTS } from './fixtures';
import { linkNodes, linkOf } from './model';

beforeAll(async () => {
  await initKernel();
});

function write(pkg: RobotPackage, out: string): void {
  for (const f of pkg.files) {
    const path = join(out, pkg.name, f.name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, f.bytes);
  }
}

describe.each(ROBOTS)('the reference $file', ({ file, make }) => {
  it('passes the checks and exports in every format', () => {
    const doc = make();
    // ROBOT_FIXTURES_WORLD=rough|slope puts every reference robot's MuJoCo model on that floor, for the smoke test.
    const world = process.env.ROBOT_FIXTURES_WORLD;
    const robot = doc.robot!;
    const nodes = linkNodes(doc.scene);
    const geo = robotGeometry(nodes, Object.fromEntries(nodes.map((n) => [n.id, linkOf(robot, n.id).collision])), true);
    const geometry = new Map(geo.map((g) => [g.id, g]));
    expect(checkRobot(doc, new Map(geo.map((g) => [g.id, g.props])), robot)).toEqual([]);
    const packages = [buildRobotPackage(doc, geometry, robot), buildSdfModel(doc, geometry, robot), buildMjcfModel(doc, geometry, robot, world === 'rough' || world === 'slope' ? world : 'flat'), buildIsaacStage(doc, geometry, robot)];
    for (const pkg of packages) expect(pkg.warnings).toEqual([]);
    const out = process.env.ROBOT_FIXTURES_OUT;
    if (out) {
      write(packages[0], join(out, 'ros'));
      write(packages[1], join(out, 'sdf'));
      write(packages[2], out);
      write(packages[3], join(out, 'usd'));
      writeFileSync(join('fixtures', 'robots', `${file}.plastikcad`), serializeDoc(doc));
    }
  });
});
