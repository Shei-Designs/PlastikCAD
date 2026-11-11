import { describe, expect, it } from 'vitest';
import { driveXml, sensorXml, worldXml } from './gazebo';
import type { GazeboSensor } from './gazebo';

describe('driveXml', () => {
  const shared = { baseFrame: 'Body', wheelRadius: 0.02, wheelSeparation: 0.092 };
  it('writes the Ackermann steering plugin with its geometry', () => {
    const xml = driveXml({ ...shared, kind: 'ackermann', leftJoints: ['rl'], rightJoints: ['rr'], leftSteer: 'sl', rightSteer: 'sr', wheelBase: 0.1, kingpinWidth: 0.094, steeringLimit: 0.5236 });
    expect(xml).toContain('gz-sim-ackermann-steering-system');
    expect(xml).toMatch(/<left_joint>rl<\/left_joint>\s*<right_joint>rr<\/right_joint>\s*<left_steering_joint>sl<\/left_steering_joint>\s*<right_steering_joint>sr<\/right_steering_joint>\s*<kingpin_width>0.094<\/kingpin_width>\s*<steering_limit>0.5236<\/steering_limit>\s*<wheel_base>0.1<\/wheel_base>/);
    expect(xml).toContain('<child_frame_id>Body</child_frame_id>');
  });
  it('writes the mecanum plugin with a wheel at each corner', () => {
    const xml = driveXml({ ...shared, kind: 'mecanum', frontLeft: 'fl', frontRight: 'fr', rearLeft: 'rl', rearRight: 'rr', wheelBase: 0.1 });
    expect(xml).toContain('gz-sim-mecanum-drive-system');
    expect(xml).toMatch(/<front_left_joint>fl<\/front_left_joint>\s*<front_right_joint>fr<\/front_right_joint>\s*<back_left_joint>rl<\/back_left_joint>\s*<back_right_joint>rr<\/back_right_joint>\s*<wheelbase>0.1<\/wheelbase>/);
  });
  it('writes the differential plugin with every wheel on each side', () => {
    const xml = driveXml({ ...shared, kind: 'differential', leftJoints: ['l1', 'l2'], rightJoints: ['r1', 'r2'] });
    expect(xml).toContain('gz-sim-diff-drive-system');
    expect(xml.match(/<left_joint>/g)?.length).toBe(2);
    expect(xml.match(/<right_joint>/g)?.length).toBe(2);
  });
});

describe('sensorXml', () => {
  const lidar = (samples: number, hfov: number): GazeboSensor => ({ name: 'scan', frame: 'scan_link', kind: 'lidar', rate: 10, camera: { hfov: 1, width: 1, height: 1, near: 0.1, far: 1 }, lidar: { samples, hfov, min: 0.1, max: 10 } });
  const sweep = (xml: string) => [Number(/<min_angle>([^<]+)</.exec(xml)![1]), Number(/<max_angle>([^<]+)</.exec(xml)![1])];
  it('stops a full-circle lidar one step short, so its first and last rays are not the same ray', () => {
    const [min, max] = sweep(sensorXml(lidar(36, 2 * Math.PI)));
    expect(min).toBeCloseTo(-Math.PI, 5);
    // 36 rays 10° apart: the last looks 10° short of where the first does.
    expect(max - min).toBeCloseTo((2 * Math.PI * 35) / 36, 5);
  });
  it('sweeps a narrower lidar from end to end', () => {
    const [min, max] = sweep(sensorXml(lidar(90, Math.PI)));
    expect([min, max]).toEqual([expect.closeTo(-Math.PI / 2, 5), expect.closeTo(Math.PI / 2, 5)]);
  });
});

describe('worldXml', () => {
  it('names its light and floor clear of the robot spawned beside them', () => {
    for (const robot of ['rover', 'sun', 'ground_plane']) {
      const names = [...worldXml(robot).matchAll(/<(?:light|model)[^>]* name="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set([...names, robot]).size).toBe(names.length + 1);
    }
  });
});
