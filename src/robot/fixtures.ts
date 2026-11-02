// The reference robots: a rover, a car, an arm and a quadruped built from
// shapes, which the tests export and simulate and which fixtures/robots
// holds for opening in the app. Each is as large as the motors in the
// catalogue can drive: the rover and car on 37 mm gearmotors (TurtleBot and
// 1/10 RC car class), the quadruped and arm on STS3215 smart servos (Pupper
// and SO-101 class), so that they sit at a believable size in a world.
import { defaultParams } from '../geometry/shapes';
import { emptyDoc } from '../model/file';
import type { Doc, SceneNode, ShapeKind, Vec3 } from '../model/types';
import { jointFit } from './defaults';
import { linkNodes } from './model';
import { motorFigures, motorOf } from './motors';
import { defaultJoint, defaultLink, defaultSensor } from './types';
import type { CollisionKind, Robot, RobotJoint } from './types';

let next = 0;
const id = (): string => `fx${String(++next).padStart(6, '0')}`;

function shape(kind: ShapeKind, name: string, pos: Vec3, size: Vec3, rot: Vec3 = [0, 0, 0], color = '#8fa3bf'): SceneNode {
  return { id: id(), name, type: 'shape', shape: kind, params: defaultParams(kind), pos, rot, size, hole: false, color };
}

/** A joint from `parent` to `child` at `origin` in the child's frame; its motor figures are fitted once the robot is whole. */
function joint(name: string, parent: SceneNode, child: SceneNode, origin: Vec3, over: Partial<RobotJoint>): RobotJoint {
  return { ...defaultJoint(id(), name, parent.id, child.id, origin), ...over };
}

/** The design, with every joint's effort, velocity and damping fitted to the sides it moves. */
function design(name: string, scene: SceneNode[], robot: Robot): Doc {
  const doc = emptyDoc();
  doc.name = name;
  doc.scene = scene;
  const nodes = linkNodes(scene);
  doc.robot = { ...robot, joints: robot.joints.map((j) => ({ ...j, ...(j.motor ? motorFigures(motorOf(j.motor)!) : jointFit(robot, nodes, j)), ...(j.velocity !== 90 ? { velocity: j.velocity } : {}) })) };
  return doc;
}

/** A box on four wheels: the wheels lie along X (cylinders turned 90° about Y), so it drives along Y. */
function rover(): Doc {
  const body = shape('box', 'Body', [0, 0, 80], [240, 320, 80]);
  const wheels = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => shape('cylinder', `Wheel ${sx < 0 ? 'left' : 'right'} ${sy < 0 ? 'back' : 'front'}`, [sx * 140, sy * 110, 50], [100, 100, 40], [0, 90, 0], '#e8853a')));
  const joints = wheels.map((w) => joint(`${w.name} joint`, body, w, [0, 0, 0], { type: 'continuous', motor: '37d-70' }));
  const sideOf = (w: SceneNode) => (w.pos[0] < 0 ? 'left' : 'right');
  // A coarse scanner on the body's top, above the wheels: 130 mm up, so a range much past 4 m would read the floor at the far end.
  const lidar = { ...defaultSensor(id(), 'Lidar', 'lidar', body.id, [0, 0, 50]), lidar: { samples: 36, hfov: 360, min: 100, max: 4000 } };
  // An IMU at the body's center, for odometry.
  const imu = defaultSensor(id(), 'IMU', 'imu', body.id, [0, 0, 0]);
  // A small color camera at the front of the body's top, turned to look the way the rover drives (+Y) and tilted 20° down at the floor ahead; its near clip is short so the floor at the bottom of the picture stays inside it.
  const camera = { ...defaultSensor(id(), 'Camera', 'camera', body.id, [0, 165, 40]), rot: [0, 20, 90] as Vec3, camera: { hfov: 80, width: 320, height: 240, near: 50, far: 10000 } };
  return design('Reference rover', [body, ...wheels], {
    root: body.id,
    base: 'free',
    links: [{ ...defaultLink(body.id), collision: 'box' }, ...wheels.map((w) => ({ ...defaultLink(w.id), collision: 'cylinder' as CollisionKind, friction: 1 }))],
    joints,
    sensors: [lidar, imu, camera],
    drive: { kind: 'differential', roles: Object.fromEntries(joints.map((j, i) => [j.id, sideOf(wheels[i])])) },
    control: true,
  });
}

/** A three-joint arm on a plate bolted to the bench: a turret turning about Z, then two segments turning about X. */
function arm(): Doc {
  const plate = shape('box', 'Base plate', [0, 0, 7.5], [120, 120, 15]);
  const turret = shape('cylinder', 'Turret', [0, 0, 37.5], [75, 75, 45], [0, 0, 0], '#e8853a');
  const upper = shape('box', 'Upper arm', [0, 0, 150], [30, 30, 180]);
  const fore = shape('box', 'Forearm', [0, 0, 315], [24, 24, 150]);
  return design('Reference arm', [plate, turret, upper, fore], {
    root: plate.id,
    base: 'fixed',
    links: [{ ...defaultLink(plate.id), collision: 'box' }, { ...defaultLink(turret.id), collision: 'cylinder' }, { ...defaultLink(upper.id), collision: 'box' }, { ...defaultLink(fore.id), collision: 'box' }],
    joints: [
      joint('Turret joint', plate, turret, [0, 0, -22.5], { axis: [0, 0, 1], lower: -170, upper: 170, motor: 'sts3215' }),
      joint('Shoulder', turret, upper, [0, 0, -90], { axis: [1, 0, 0], lower: -90, upper: 90, motor: 'sts3215' }),
      joint('Elbow', upper, fore, [0, 0, -75], { axis: [1, 0, 0], lower: -120, upper: 120, motor: 'xl430' }),
    ],
    sensors: [],
    control: true,
  });
}

/** A body on four two-segment legs, hips and knees turning about Y, feet on the floor. */
function quadruped(): Doc {
  const body = shape('box', 'Body', [0, 0, 230], [260, 120, 60]);
  const scene = [body];
  const joints: RobotJoint[] = [];
  const links = [{ ...defaultLink(body.id), collision: 'box' as CollisionKind }];
  const feet: Robot['sensors'] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const leg = `${sy < 0 ? 'rear' : 'front'} ${sx < 0 ? 'left' : 'right'}`;
      const upper = shape('box', `Upper leg ${leg}`, [sx * 110, sy * 72, 150], [24, 24, 100], [0, 0, 0], '#e8853a');
      const lower = shape('box', `Lower leg ${leg}`, [sx * 110, sy * 72, 50], [20, 20, 100]);
      scene.push(upper, lower);
      links.push({ ...defaultLink(upper.id), collision: 'box' }, { ...defaultLink(lower.id), collision: 'box', friction: 1 });
      joints.push(joint(`Hip ${leg}`, body, upper, [0, 0, 50], { axis: [0, 1, 0], lower: -60, upper: 60, motor: 'sts3215' }), joint(`Knee ${leg}`, upper, lower, [0, 0, 50], { axis: [0, 1, 0], lower: -90, upper: 90, motor: 'sts3215' }));
      // The foot feels the floor: a touch sensor at the shin's bottom.
      feet.push(defaultSensor(id(), `Foot ${leg}`, 'touch', lower.id, [0, 0, -50]));
    }
  }
  // An IMU at the body's center: what a gait controller reads first.
  const imu = defaultSensor(id(), 'IMU', 'imu', body.id, [0, 0, 0]);
  return design('Reference quadruped', scene, { root: body.id, base: 'free', links, joints, sensors: [...feet, imu], control: true });
}

/** A car: driven rear wheels, and front wheels on knuckles that steering joints turn, as an Ackermann drive. */
function car(): Doc {
  const body = shape('box', 'Body', [0, 0, 70], [200, 440, 80]);
  const rear = [-1, 1].map((sx) => shape('cylinder', `Rear wheel ${sx < 0 ? 'left' : 'right'}`, [sx * 120, -160, 45], [90, 90, 36], [0, 90, 0], '#e8853a'));
  const knuckles = [-1, 1].map((sx) => shape('box', `Knuckle ${sx < 0 ? 'left' : 'right'}`, [sx * 122, 160, 45], [40, 40, 40]));
  const front = [-1, 1].map((sx) => shape('cylinder', `Front wheel ${sx < 0 ? 'left' : 'right'}`, [sx * 162, 160, 45], [90, 90, 36], [0, 90, 0], '#e8853a'));
  const drive = rear.map((w) => joint(`${w.name} joint`, body, w, [0, 0, 0], { type: 'continuous', motor: '37d-70' }));
  const steer = knuckles.map((k) => joint(`${k.name} steering`, body, k, [0, 0, 0], { axis: [0, 0, 1], lower: -30, upper: 30, motor: 'mg996r' }));
  const roll = front.map((w, i) => joint(`${w.name} joint`, knuckles[i], w, [0, 0, 0], { type: 'continuous' }));
  const scene = [body, ...rear, ...knuckles, ...front];
  // A depth camera at the front of the body's top, looking the way the car drives (+Y), mounted upside down (rolled 180°) as a bracket often has it.
  const depth = { ...defaultSensor(id(), 'Depth', 'depth', body.id, [0, 225, 40]), rot: [180, 0, 90] as Vec3, camera: { hfov: 80, width: 320, height: 240, near: 100, far: 10000 } };
  return design('Reference car', scene, {
    root: body.id,
    base: 'free',
    links: [{ ...defaultLink(body.id), collision: 'box' }, ...knuckles.map((k) => ({ ...defaultLink(k.id), collision: 'box' as CollisionKind })), ...[...rear, ...front].map((w) => ({ ...defaultLink(w.id), collision: 'cylinder' as CollisionKind, friction: 1 }))],
    joints: [...drive, ...steer, ...roll],
    sensors: [depth],
    drive: { kind: 'ackermann', roles: { [drive[0].id]: 'left', [drive[1].id]: 'right', [steer[0].id]: 'steer-left', [steer[1].id]: 'steer-right' } },
    control: false,
  });
}

export const ROBOTS: { file: string; make: () => Doc }[] = [
  { file: 'rover', make: rover },
  { file: 'car', make: car },
  { file: 'arm', make: arm },
  { file: 'quadruped', make: quadruped },
];
