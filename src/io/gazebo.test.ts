import { describe, expect, it } from 'vitest';
import { driveXml } from './gazebo';

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
