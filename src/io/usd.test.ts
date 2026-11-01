import { describe, expect, it } from 'vitest';
import { principalAxes, usdName, writeUsda } from './usd';
import type { UsdModel } from './usd';

/** A two-link cart: a box body on a wheel, a camera and a lidar on the body, driven by cmd_vel. */
const cart = (): UsdModel => ({
  name: 'Test cart',
  root: 'body',
  fixedBase: false,
  links: [
    {
      name: 'body',
      pos: [0, 0, 0],
      inertial: { mass: 0.2, origin: [0, 0, 0.03], inertia: [2e-4, 3e-4, 4e-4, 0, 0, 0] },
      visual: [{ mesh: { positions: new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0, 0, 0.1]), triangles: new Uint32Array([0, 1, 2, 0, 1, 3]) }, color: [1, 0.5, 0] }],
      collision: [{ box: [0.1, 0.1, 0.05], origin: [0, 0, 0.025], rpy: [0, 0, 0] }],
      friction: 0.6,
    },
    { name: 'wheel', pos: [0, -0.06, 0.02], inertial: { mass: 0.01, origin: [0, 0, 0], inertia: [1e-6, 1e-6, 2e-6, 0, 0, 0] }, visual: [], collision: [{ cylinder: { radius: 0.02, length: 0.01 }, origin: [0, 0, 0], rpy: [Math.PI / 2, 0, 0] }], friction: 1 },
  ],
  joints: [{ name: 'wheel_joint', type: 'continuous', parent: 'body', child: 'wheel', origin: [0, -0.06, 0.02], axis: [0, 1, 0], limit: { lower: 0, upper: 0, effort: 0.1, velocity: 20 }, dynamics: { damping: 0, friction: 0.001 }, loop: false, drive: 'velocity' }],
  sensors: [
    { name: 'cam', kind: 'camera', link: 'body', xyz: [0.05, 0, 0.04], rpy: [0, 0.2, 0], rate: 30, camera: { hfov: Math.PI / 2, width: 640, height: 480, near: 0.02, far: 10 }, lidar: { samples: 0, hfov: 0, min: 0, max: 0 }, touch: 0 },
    { name: 'scan', kind: 'lidar', link: 'body', xyz: [0, 0, 0.06], rpy: [0, 0, 0], rate: 10, camera: { hfov: 0, width: 0, height: 0, near: 0, far: 0 }, lidar: { samples: 36, hfov: 2 * Math.PI, min: 0.1, max: 4 }, touch: 0 },
  ],
  drive: { kind: 'differential', left: ['wheel_joint'], right: [], steer: [], wheelRadius: 0.02, wheelSeparation: 0.12, maxWheelSpeed: 20 },
  controlled: [],
});

describe('writeUsda', () => {
  it('writes an articulation of rigid links with masses, meshes, collisions, joints and drives', () => {
    const usda = writeUsda(cart());
    expect(usda.startsWith('#usda 1.0\n(')).toBe(true);
    expect(usda).toContain('metersPerUnit = 1');
    expect(usda).toContain('upAxis = "Z"');
    expect(usda).toContain('def Xform "Test_cart" (\n        prepend apiSchemas = ["PhysicsArticulationRootAPI", "PhysxArticulationAPI"]');
    // A free base has no joint to the world; a fixed one would.
    expect(usda).not.toContain('root_joint');
    expect(usda).toContain('def Xform "body" (\n            prepend apiSchemas = ["PhysicsRigidBodyAPI", "PhysicsMassAPI"]');
    expect(usda).toContain('float physics:mass = 0.2');
    expect(usda).toContain('point3f physics:centerOfMass = (0, 0, 0.03)');
    expect(usda).toContain('float3 physics:diagonalInertia = (0.0002, 0.0003, 0.0004)');
    expect(usda).toContain('rel material:binding = </World/Looks/color_ff8000>');
    expect(usda).toContain('int[] faceVertexCounts = [3, 3]');
    expect(usda).toContain('int[] faceVertexIndices = [0, 1, 2, 0, 1, 3]');
    expect(usda).toContain('def Cube "collision_0"');
    expect(usda).toContain('float3 xformOp:scale = (0.1, 0.1, 0.05)');
    expect(usda).toContain('def Cylinder "collision_0"');
    expect(usda).toContain('rel material:binding:physics = </World/PhysicsMaterials/friction_0_6>');
    // The wheel joint: body to wheel at the wheel's frame, axis X turned onto the design's Y, a velocity drive damped by effort over speed.
    expect(usda).toContain('def PhysicsRevoluteJoint "wheel_joint" (\n                prepend apiSchemas = ["PhysxJointAPI", "PhysicsDriveAPI:angular", "PhysicsJointStateAPI:angular"]');
    expect(usda).toContain('rel physics:body0 = </World/Test_cart/body>');
    expect(usda).toContain('rel physics:body1 = </World/Test_cart/wheel>');
    expect(usda).toContain('point3f physics:localPos0 = (0, -0.06, 0.02)');
    expect(usda).toContain('quatf physics:localRot0 = (0.707107, 0, 0, 0.707107)');
    expect(usda).not.toContain('physics:lowerLimit');
    expect(usda).toContain('float drive:angular:physics:damping = 0.005');
    expect(usda).toContain('float drive:angular:physics:maxForce = 0.1');
    expect(usda).toContain('float drive:angular:physics:stiffness = 0');
    // The floor, the lights and the physics scene.
    expect(usda).toContain('def PhysicsScene "physicsScene"');
    expect(usda).toContain('def Plane "collision"');
    expect(usda).toContain('def DomeLight "Dome"');
  });

  it('writes the sensors as Isaac prims and a ROS 2 graph that drives and publishes', () => {
    const usda = writeUsda(cart());
    // The camera looks down the frame's X: USD cameras look down -Z, so the frame is turned; the focal length gives a 90° picture on USD's film back.
    expect(usda).toContain('def Camera "cam"');
    expect(usda).toContain('float2 clippingRange = (0.02, 10)');
    expect(usda).toContain('float focalLength = 10.4775');
    expect(usda).toContain('float verticalAperture = 15.716');
    expect(usda).toContain('def OmniLidar "scan" (\n                prepend apiSchemas = ["OmniSensorGenericLidarCoreAPI"]');
    expect(usda).toContain('uint omni:sensor:Core:reportRateBaseHz = 360');
    expect(usda).toContain('uint omni:sensor:Core:scanRateBaseHz = 10');
    expect(usda).toContain('float omni:sensor:Core:farRangeM = 4');
    expect(usda).toContain('float omni:sensor:Core:validEndAzimuthDeg = 360');
    const graph = usda.slice(usda.indexOf('def OmniGraph "ROS2"'));
    for (const type of ['omni.graph.action.OnPlaybackTick', 'isaacsim.ros2.bridge.ROS2Context', 'isaacsim.ros2.bridge.ROS2SubscribeTwist', 'isaacsim.robot.wheeled_robots.DifferentialController', 'isaacsim.core.nodes.IsaacArticulationController', 'isaacsim.ros2.bridge.ROS2PublishJointState', 'isaacsim.core.nodes.IsaacComputeOdometry', 'isaacsim.ros2.bridge.ROS2PublishOdometry', 'isaacsim.ros2.bridge.ROS2CameraHelper', 'isaacsim.ros2.bridge.ROS2RtxLidarHelper'])
      expect(graph).toContain(`token node:type = "${type}"`);
    expect(graph).toContain('custom string inputs:topicName = "cmd_vel"');
    expect(graph).toContain('custom double inputs:wheelDistance = 0.12');
    expect(graph).toContain('custom token[] inputs:jointNames = ["wheel_joint"]');
    expect(graph).toContain('prepend uint inputs:execIn.connect = </World/ROS2/tick.outputs:tick>');
    expect(graph).toContain('custom rel inputs:cameraPrim = </World/Test_cart/body/cam>');
    expect(graph).toContain('custom string inputs:topicName = "scan/scan"');
    expect(graph).toContain('custom string inputs:topicName = "cam/image"');
  });

  it('bolts a fixed base to the world and wires joint_command for controlled joints; a partial lidar sweeps about its X', () => {
    const m = cart();
    m.fixedBase = true;
    m.drive = null;
    m.controlled = ['wheel_joint'];
    m.joints[0] = { ...m.joints[0], type: 'revolute', limit: { lower: -1, upper: 1, effort: 2, velocity: 3 }, drive: 'position' };
    m.sensors[1].lidar = { samples: 90, hfov: Math.PI / 2, min: 0.05, max: 6 };
    const usda = writeUsda(m);
    expect(usda).toContain('def PhysicsFixedJoint "root_joint"');
    expect(usda).toContain('rel physics:body1 = </World/Test_cart/body>');
    expect(usda).toContain('float physics:lowerLimit = -57.2958');
    expect(usda).toContain('float physics:upperLimit = 57.2958');
    expect(usda).toContain('float drive:angular:physics:stiffness = 20');
    expect(usda).toContain('float drive:angular:physics:damping = 1');
    expect(usda).toContain('token node:type = "isaacsim.ros2.bridge.ROS2SubscribeJointState"');
    expect(usda).not.toContain('IsaacComputeOdometry');
    expect(usda).toContain('float omni:sensor:Core:validStartAzimuthDeg = -45');
    expect(usda).toContain('float omni:sensor:Core:validEndAzimuthDeg = 45');
    expect(usda).toContain('uint omni:sensor:Core:reportRateBaseHz = 900');
  });

  it('names prims the way USD allows', () => {
    expect(usdName('Reference rover')).toBe('Reference_rover');
    expect(usdName('3 wheels')).toBe('_3_wheels');
    expect(usdName('ok_name')).toBe('ok_name');
  });
});

describe('principalAxes', () => {
  it('leaves a diagonal tensor as it is', () => {
    const { moments, axes } = principalAxes([1, 2, 3, 0, 0, 0]);
    expect(moments).toEqual([1, 2, 3]);
    expect(axes).toEqual([1, 0, 0, 0]);
  });

  it('finds the moments and a right-handed frame of a turned tensor', () => {
    // A rod along the XY diagonal: equal xx and yy with a negative xy product; its principal moments are 1 ± 0.5 and 2.
    const { moments, axes } = principalAxes([1, 1, 2, -0.5, 0, 0]);
    expect(moments.map((v) => Math.round(v * 1000) / 1000).sort()).toEqual([0.5, 1.5, 2]);
    const n = Math.hypot(...axes);
    expect(n).toBeCloseTo(1, 6);
    // Turned 45° about Z (a quaternion of half that angle), one way or the other.
    expect(Math.abs(axes[3])).toBeCloseTo(Math.sin(Math.PI / 8), 3);
    expect(Math.abs(axes[0])).toBeCloseTo(Math.cos(Math.PI / 8), 3);
    expect(axes[1]).toBeCloseTo(0, 6);
    expect(axes[2]).toBeCloseTo(0, 6);
  });
});
