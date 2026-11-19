"""Opens every exported Isaac Sim stage under a folder, plays it, talks to it
over ROS 2 and says whether it behaves. Run through isaac_stage_smoke.sh,
which finds Isaac Sim's Python and its bundled ROS 2 libraries:

    pnpm smoke:usd

For each <folder>/<name>/<name>.usda: the stage is opened as a user would
(no import, no script), a wall is put a meter ahead of the robot, and it is
played for a few seconds while a ROS 2 node in the same process drives it
(cmd_vel, ackermann_cmd or joint_command, by what the stage's graph takes)
and listens to what it publishes. A driven robot must move, a fixed one must
not, nothing may collapse, every joint and visual mesh must be there, joint
states and clock must arrive, odometry must agree with the robot's pose, a
lidar must see the wall at a meter with as many rays as the design has, an
IMU must read gravity straight up, a camera must send pictures, and a picture
of the scene is saved under <folder>/../pictures. Exit code 1 on any failure,
2 when isaacsim is missing.
"""
import glob
import json
import math
import os
import re
import subprocess
import sys

SECONDS = 3.0
SPEED = 0.3  # m/s asked of a rover
# A mecanum drive told to go forward, slide or turn goes this share of what was asked at least and at most (its
# rollers slip a little, and it takes a moment to get going), and strays no farther than this another way (m, rad).
MECANUM_LEAST, MECANUM_MOST, MECANUM_STRAY = 0.8, 1.05, 0.05
# A mecanum drive told nothing holds against a push along or across of this share of its weight, moving no farther
# than this in 3 s (m), and slides at the second share: its rollers, at 45°, hold up to 0.71 under a friction of 1,
# and MuJoCo holds the reference rover up to 0.65 or 0.7 with its wheels turned any way. Isaac holds it 2 to 4 mm at
# 0.5 and up to 0.65 or 0.7 with its four wheels turned alike, but lets go along it at 0.6 with them turned unlike
# (one wheel on two rollers, the next on one), whatever the solver's passes, step rate or rollers' inertia. With its
# rollers on plain joints out of the articulation it walked off along a diagonal at 0.5, 150 to 200 mm.
MECANUM_HOLD, MECANUM_SLIDE, MECANUM_CREEP = 0.5, 0.8, 0.015
# A rover on tracks (a row of wheels each side stands in for a belt) told to go back goes between these shares of
# what was asked, and told to turn on the spot at 1 rad/s between these shares of it: a long contact skids. Plain
# Coulomb friction under its eight wheels a side, carrying alike, turns the reference rover 67 %, as Isaac does
# (steadily; the smoke's count takes in the start); MuJoCo turns it 41 to 46 %, Gazebo 73 %. When its wheels gave
# under it, it stood on one diagonal's end wheels as it turned, went 48 % and strayed 39 mm, 51 mm the other way. It
# strays no farther than this (m, rad).
TRACK_STRAIGHT, TRACK_TURN, TRACK_STRAY = (0.9, 1.05), (0.35, 0.85), 0.01
# A rover with two wheels a side, which slide as it turns, told to turn on the spot at 1 rad/s. Plain friction under
# four wheels that carry alike turns it t²/(t² + L²) of that, t from side to side and L from axle to axle: 62 % for
# the reference rover, wider than long, and 20 % for the long one. It must turn between these shares of what plain
# friction gives, about its own middle: it ends no farther from where it stood than this (m).
SKID_TURN, SKID_STRAY = (0.8, 1.1), 0.05
# A rover on one wheel a side and a caster slides no wheel to turn: told to go back, and to turn on the spot at
# 1 rad/s, it does each between these shares of what was asked, the turn about the middle of its axle, and strays
# no farther than this another way (m, rad). The reference one turns 99.6 % of what it is told and ends 2 mm from
# where it stood; it goes back 1.08 of the way, the run-on after the stop counted in, as it is for every rover here.
# On plain cylinders, which PhysX loads to one side, it turned 81 to 89 %.
TWO_STRAIGHT, TWO_TURN, TWO_STRAY = (0.9, 1.15), (0.95, 1.03), 0.03
MUST_MOVE = 0.1  # m
MAY_SETTLE = 0.02  # m the base may drop while settling
WALL_AT = 1.0  # m ahead
# A car told to go straight back for this long goes between these shares of what was asked, strays no farther to
# a side than this (m) and turns no more than this (rad); steered this far (rad) either way it goes round the
# circle its wheelbase makes within these shares of its radius, and the two circles differ by no more than this
# share of it. (The reference car goes 1.02 of the way back, 1 mm aside, turning 0.04°, and round circles of 1.020
# and 1.021 of the radius, the same every run. With its free front wheels dragging as a motor's would, and every
# contact rigid, it turned 0.26° on the way back, by the order its wheels came in the file; with its front wheels
# driven backwards, as a stage once had them, it went 0.95 of the way, turning 2.5°, round circles of 1.11 and 1.12.)
CAR_SECONDS, CAR_STEER = 6.0, 0.3
CAR_STRAIGHT, CAR_STRAY, CAR_VEER, CAR_CIRCLE, CAR_ALIKE = (0.97, 1.06), 0.01, math.radians(0.15), (0.97, 1.07), 0.03
# A wheel stands on a ridge round its middle, and the rest of it is a cylinder a little lower. PhysX gives a body a
# whole step's gravity before it solves the step's contacts, so a low cylinder nearer the floor than a body falls in
# a step (g dt², 2.7 mm at sixty steps a second) is in the solve: it bears no weight and still adds to the wheel's
# grip, the same on a wheel of any size (15 % at half a millimeter off, 9 to 12 % at one, 5 % at two under a
# friction of 0.3, none from three; at 120 steps a second, where a body falls 0.7 mm, none from one millimeter).
# Every stage's wheels are held to this many falls of clearance (the 4 mm they have are 1.47 at sixty steps a
# second); a wheel under 5 mm in radius, which has not the room, to a low cylinder no more than a fifth of its radius.
TREAD_CLEAR, TREAD_SMALL = 1.2, 0.21


def stage_of(folder):
    name = os.path.basename(folder)
    path = os.path.join(folder, f'{name}.usda')
    return path if os.path.exists(path) else None


def read_stage(path):
    """What the text promises: the ROS topics it subscribes to, the lidars' ray counts, the sensors by kind."""
    text = open(path, encoding='utf-8').read()
    topics = set(re.findall(r'inputs:topicName = "([^"]+)"', text))
    lidars = {m.group(1): int(m.group(2)) for m in re.finditer(r'string omni:sensor:modelName = "([^"]+)"[^}]*?uint omni:sensor:tickRate|def OmniLidar "([^"]+)"', text) if False}
    lidars = {}
    for m in re.finditer(r'def OmniLidar "([^"]+)"', text):
        block = text[m.end():m.end() + 6000]
        rays = re.search(r'uint omni:sensor:Core:reportRateBaseHz = (\d+)', block)
        rate = re.search(r'uint omni:sensor:Core:scanRateBaseHz = (\d+)', block)
        lidars[m.group(1)] = int(rays.group(1)) // max(int(rate.group(1)), 1) if rays and rate else None
    # Where each joint begins, radians or meters, for those the stage gives a start.
    starts = {}
    # The joints a drive holds at a position, and those that close a loop from outside the articulation.
    held, loops = [], []
    # The joints commanded by torque, with the most each can push: nothing holds them until efforts arrive.
    torques = {}
    # Where each joint is, in its parent's frame.
    places = {}
    for m in re.finditer(r'def Physics(Revolute|Prismatic)Joint "([^"]+)"', text):
        after = text[m.end():]
        # Up to the next joint, however deep it is indented: a joint with no start must not be read as having its neighbor's.
        nxt = re.search(r'\n\s*def Physics', after)
        block = after[:nxt.start()] if nxt else after[:8000]
        at = re.search(r'float state:(?:angular|linear):physics:position = ([-0-9.e]+)', block)
        if at:
            starts[m.group(2)] = math.radians(float(at.group(1))) if m.group(1) == 'Revolute' else float(at.group(1))
        top = re.search(r'float drive:(?:angular|linear):physics:maxForce = ([-0-9.e]+)', block)
        if 'custom token robot:command = "effort"' in block and top:
            torques[m.group(2)] = float(top.group(1))
        gain = re.search(r'float drive:(?:angular|linear):physics:stiffness = ([-0-9.e]+)', block)
        if gain and float(gain.group(1)) > 0:
            held.append(m.group(2))
        place = re.search(r'point3f physics:localPos0 = \(([^)]+)\)', block)
        if place:
            places[m.group(2)] = [float(v) for v in place.group(1).split(',')]
        if 'bool physics:excludeFromArticulation = 1' in block:
            loops.append(m.group(2))
    # What plain friction turns a rover on two wheels a side, of the turn asked: its wheels stand at the corners of a
    # box as wide as the drive says, and the box's diagonal tells how long.
    wheels = re.findall(r'custom token\[\] inputs:jointNames = \[([^\]]*)\]', text)
    across = re.search(r'custom double inputs:wheelDistance = ([-0-9.e]+)', text)
    corners = [places[n] for n in re.findall(r'"([^"]+)"', wheels[0]) if n in places] if wheels else []
    diagonal = max((math.dist(a[:2], b[:2]) for a in corners for b in corners), default=0.0)
    return {
        'plain_turn': float(across.group(1)) ** 2 / diagonal**2 if across and diagonal > 0 else None,
        'starts': starts,
        'torques': torques,
        'held': held,
        'loops': loops,
        'topics': topics,
        'cameras': re.findall(r'def Camera "([^"]+)"', text),
        'base_frame': (re.search(r'inputs:chassisFrameId = "([^"]+)"', text) or [None, None])[1],
        'imus': re.findall(r'def IsaacImuSensor "([^"]+)"', text),
        'touches': re.findall(r'def IsaacContactSensor "([^"]+)"', text),
        'lidars': lidars,
        'joints': re.findall(r'def Physics(?:Revolute|Prismatic)Joint "([^"]+)"', text),
        'fixed_base': 'def PhysicsFixedJoint "root_joint"' in text,
        'steps_per_second': next((int(m.group(1)) for m in re.finditer(r'uint physxScene:timeStepsPerSecond = (\d+)', text)), 0),
        # A mecanum drive's graph mixes a speed for each wheel.
        'mecanum': 'def OmniGraphNode "wheel0_linear"' in text,
        # Two wheels a side slide sideways as their rover turns.
        'skids': len(corners) == 4 and 'def OmniGraphNode "wheel0_linear"' not in text,
        # One wheel a side, and a caster: nothing slides as it turns.
        'two_wheels': len(corners) == 2 and 'def OmniGraphNode "wheel0_linear"' not in text,
        # A track's belt is stood in for by a row of wheels on hinges to it.
        'tracks': len(re.findall(r'def PhysicsRevoluteJoint "[^"]*_wheel_\d+_joint"', text)) >= 6,
        'meshes': len(re.findall(r'def Mesh "visual_\d+"', text)),
        # Each wheel's two cylinders: the name of its link, the low one's radius and the ridge's (m).
        'treads': [(m.group(1), float(m.group(2)), float(m.group(3))) for m in re.finditer(r'def Xform "([^"]+)" \((?:(?!def Xform)[\s\S])*?def Cylinder "collision_\d+" \((?:(?!def )[\s\S])*?double radius = ([-\d.e]+)(?:(?!def )[\s\S])*?\}\s*def Cylinder "collision_\d+_tread" \((?:(?!def )[\s\S])*?double radius = ([-\d.e]+)', text)],
        'wheels': re.findall(r'custom token\[\] inputs:jointNames = \[([^\]]*)\]', text),
        # A car's wheelbase, as its steering controller is given it.
        'wheel_base': next((float(m.group(1)) for m in re.finditer(r'custom double inputs:wheelBase = ([-\d.e]+)', text)), 0.0),
    }


def one(path, pictures):
    name = os.path.basename(os.path.dirname(path))
    info = read_stage(path)
    result = {'name': name, 'problems': [], 'notes': []}

    from isaacsim import SimulationApp
    app = SimulationApp({'headless': True, 'width': 960, 'height': 600})
    try:
        import numpy as np
        import omni.usd
        from pxr import Gf, Usd, UsdGeom, UsdPhysics, UsdShade
        from isaacsim.core.utils.extensions import enable_extension
        for ext in ('isaacsim.core.nodes', 'isaacsim.sensors.physics', 'isaacsim.sensors.experimental.physics', 'isaacsim.sensors.rtx', 'isaacsim.robot.wheeled_robots', 'isaacsim.ros2.bridge'):
            enable_extension(ext)
        app.update()
        app.update()
        from isaacsim.core.api import World
        from isaacsim.core.prims import Articulation
        from isaacsim.core.utils.viewports import set_camera_view
        from isaacsim.sensors.camera import Camera

        ctx = omni.usd.get_context()
        if not ctx.open_stage(path):
            result['problems'].append('the stage did not open')
            return
        # Read off the file, before anything runs (see TREAD_CLEAR).
        fall = 9.81 / (info['steps_per_second'] or 60) ** 2
        for link, low, whole in info['treads']:
            if whole - low < TREAD_CLEAR * fall and low > TREAD_SMALL * whole:
                result['problems'].append(f'{link}: its low cylinder is {1000 * (whole - low):.2f} mm off the floor, under {TREAD_CLEAR} of the {1000 * fall:.2f} mm a body falls in a step')
        if info['treads']:
            result['notes'].append(f"{len(info['treads'])} wheels on ridges, the rest {1000 * min(w - l for _, l, w in info['treads']):.1f} mm off the floor ({1000 * fall:.2f} mm falls in a step)")
        app.update()
        stage = ctx.get_stage()
        # Stepped as the stage asks to be, where it says: Isaac Sim's own sixty steps a second otherwise. The
        # stage's own physics settings are kept (its solver, where it names one), as they are for a user who
        # opens it and presses Play: the world's defaults would write over them. Sixty pictures a second, as
        # those defaults had it.
        world = World(stage_units_in_meters=1.0, set_defaults=False, rendering_dt=1.0 / 60, **({'physics_dt': 1.0 / info['steps_per_second']} if info['steps_per_second'] else {}))

        # The robot's articulation, its joints and meshes, as the stage has them.
        root = None
        joints, meshes, materials = [], [], 0
        for prim in stage.Traverse():
            if prim.HasAPI(UsdPhysics.ArticulationRootAPI) and root is None:
                root = str(prim.GetPath())
            if prim.IsA(UsdPhysics.Joint) and prim.GetName() != 'root_joint':
                joints.append(prim.GetName())
            if prim.IsA(UsdGeom.Mesh) and prim.GetName().startswith('visual_'):
                meshes.append(prim.GetName())
                if UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0]:
                    materials += 1
        result['joints'] = len(joints)
        result['meshes'] = len(meshes)
        if root is None:
            result['problems'].append('no articulation root')
            return
        missing = [j for j in info['joints'] if j not in joints]
        if missing:
            result['problems'].append(f"joints missing: {', '.join(missing)}")
        if len(meshes) != info['meshes']:
            result['problems'].append(f"{len(meshes)} visual meshes for {info['meshes']} in the file")
        if materials < len(meshes):
            result['problems'].append(f'{len(meshes) - materials} meshes have no material')

        # Which way the robot faces: the drive's forward is where the wall goes; without a drive, +Y.
        forward = np.array([0.0, 1.0, 0.0])
        robot = stage.GetPrimAtPath(root)
        # A driven robot's articulation begins at its footprint, a body among the links: the robot is the prim that holds them.
        if robot.HasAPI(UsdPhysics.RigidBodyAPI):
            robot = robot.GetParent()
        drive_kind = 'ackermann' if 'ackermann_cmd' in info['topics'] else 'twist' if 'cmd_vel' in info['topics'] else 'joints' if 'joint_command' in info['topics'] else None
        # A wall a meter ahead, half a meter wide and high, for the lidar to see.
        wall = UsdGeom.Cube.Define(stage, '/World/Wall')
        wall.CreateSizeAttr(1.0)
        xf = UsdGeom.Xformable(wall.GetPrim())
        xf.AddTranslateOp().Set(Gf.Vec3d(*(forward * WALL_AT + np.array([0, 0, 0.25]))))
        xf.AddScaleOp().Set(Gf.Vec3f(0.5, 0.05, 0.5) if abs(forward[1]) > 0.5 else Gf.Vec3f(0.05, 0.5, 0.5))
        UsdPhysics.CollisionAPI.Apply(wall.GetPrim())

        # ROS 2 in this process, through Isaac's bridge libraries.
        try:
            import rclpy
        except ImportError:
            import importlib
            importlib.import_module(f"{os.environ.get('ROS_DISTRO', 'jazzy')}.rclpy")
            import rclpy
        from geometry_msgs.msg import Twist
        from nav_msgs.msg import Odometry
        from rosgraph_msgs.msg import Clock
        from sensor_msgs.msg import Image, Imu, JointState, LaserScan
        rclpy.init()
        node = rclpy.create_node('plastikcad_smoke')
        got = {'joint_states': [], 'clock': [], 'odom': [], 'scan': {}, 'imu': {}, 'image': {}}
        node.create_subscription(JointState, 'joint_states', lambda m: got['joint_states'].append(m), 10)
        node.create_subscription(Clock, 'clock', lambda m: got['clock'].append(m), 10)
        node.create_subscription(Odometry, 'odom', lambda m: got['odom'].append(m), 10)
        for lidar in info['lidars']:
            got['scan'][lidar] = []
            node.create_subscription(LaserScan, f'{lidar}/scan', (lambda l: lambda m: got['scan'][l].append(m))(lidar), 10)
        for imu in info['imus']:
            got['imu'][imu] = []
            node.create_subscription(Imu, f'{imu}/imu', (lambda l: lambda m: got['imu'][l].append(m))(imu), 10)
        for cam in info['cameras']:
            got['image'][cam] = []
            topic = f'{cam}/image' if f'{cam}/image' in info['topics'] else f'{cam}/depth'
            node.create_subscription(Image, topic, (lambda l: lambda m: got['image'][l].append(m))(cam), 10)
        # Every frame a message is stamped with has to be in the transform tree, or nothing can place what it carries.
        from rclpy.qos import DurabilityPolicy, QoSProfile
        from tf2_msgs.msg import TFMessage
        frames = set()

        def on_tf(m):
            for t in m.transforms:
                frames.update((t.header.frame_id, t.child_frame_id))
        node.create_subscription(TFMessage, 'tf', on_tf, 50)
        node.create_subscription(TFMessage, 'tf_static', on_tf, QoSProfile(depth=50, durability=DurabilityPolicy.TRANSIENT_LOCAL))
        twist_pub = node.create_publisher(Twist, 'cmd_vel', 10)
        joint_pub = node.create_publisher(JointState, 'joint_command', 10)
        ackermann_pub = None
        if drive_kind == 'ackermann':
            from ackermann_msgs.msg import AckermannDriveStamped
            ackermann_pub = node.create_publisher(AckermannDriveStamped, 'ackermann_cmd', 10)

        camera = Camera(prim_path='/World/SmokeCamera', resolution=(960, 600))
        world.reset()
        camera.initialize()
        camera.set_clipping_range(0.01, 100.0)
        art = Articulation(prim_paths_expr=root)
        art.initialize()
        names = list(art.dof_names or [])
        result['dofs'] = names
        start = np.asarray(art.get_world_poses()[0][0]).copy()
        q0 = np.asarray(art.get_joint_positions())[0].copy()
        servo = None
        if drive_kind == 'joints' and names:
            # Ask the first joint for a quarter turn (or a centimeter) and see it get there.
            # A passive joint has no drive to tell: the first joint a drive holds, when the stage has one.
            servo = next((n for n in names if n in info['held']), None) or next((n for n in names if n not in info['torques']), None)
        dt = world.get_physics_dt()

        def run(seconds, command):
            # By the simulation's own clock: a step that renders moves it on by a frame, which a stage stepped
            # finer than sixty times a second takes several physics steps over.
            until = world.current_time + seconds - dt / 2
            i = 0
            while world.current_time < until:
                command(i)
                world.step(render=(i % 4 == 0))
                rclpy.spin_once(node, timeout_sec=0.0)
                i += 1

        def drive(speed, position):
            if drive_kind == 'twist':
                m = Twist()
                m.linear.x = speed
                twist_pub.publish(m)
            elif drive_kind == 'ackermann' and ackermann_pub is not None:
                m = AckermannDriveStamped()
                m.drive.speed = speed
                m.drive.steering_angle = 0.0
                ackermann_pub.publish(m)
            elif drive_kind == 'joints' and servo:
                # From where the joint began: a robot that starts crouched is not told to stand up.
                m = JointState()
                m.name = [servo]
                m.position = [float(q0[names.index(servo)]) + position]
                joint_pub.publish(m)

        # Standing still first: the sensors read the scene as built, the wall a meter ahead.
        touched, touch_error, pads = {}, None, []
        if info['touches']:
            try:
                from isaacsim.sensors.experimental.physics import ContactSensor
                pads = [(prim.GetName(), ContactSensor(str(prim.GetPath()))) for prim in stage.Traverse() if prim.GetTypeName() == 'IsaacContactSensor']
            except Exception as e:  # noqa: BLE001
                touch_error = f'contact sensors could not be read: {type(e).__name__}: {e}'
        run(1.0, lambda i: drive(0.0, 0.0))
        settled = np.asarray(art.get_world_poses()[0][0]).copy()
        # The touch pads are read standing too, before the servo is told to move: a walker with one leg swung up stands on the others.
        try:
            for pad, sensor in pads:
                reading = sensor.get_sensor_reading()
                touched[pad] = round(float(reading.value), 3) if reading.is_valid else None
        except Exception as e:  # noqa: BLE001
            touch_error = f'contact sensors could not be read: {type(e).__name__}: {e}'
        first_scans = {k: list(v) for k, v in got['scan'].items()}
        # The IMUs are judged standing still as well: a walker told to move one joint leans.
        still_imu = {k: v[-1] for k, v in got['imu'].items() if v}
        # Then driven, then left to stop, so the last odometry and the pose are of the same moment.
        run(SECONDS, lambda i: drive(SPEED, 0.5))
        run(0.5, lambda i: drive(0.0, 0.5))
        end = np.asarray(art.get_world_poses()[0][0])
        q = np.asarray(art.get_joint_positions())[0]
        # A simulation that blew up leaves no numbers, and every comparison with none passes.
        if not (np.all(np.isfinite(end)) and np.all(np.isfinite(q))):
            result['problems'].append('the simulation blew up: the pose or the joints are not numbers')
        moved = float(np.linalg.norm(end[:2] - start[:2]))
        dropped = float(start[2] - end[2])
        result['moved_mm'] = round(moved * 1000)
        result['dropped_mm'] = round(dropped * 1000)
        result['messages'] = {'joint_states': len(got['joint_states']), 'clock': len(got['clock']), 'odom': len(got['odom']),
                              'scan': {k: len(v) for k, v in got['scan'].items()}, 'imu': {k: len(v) for k, v in got['imu'].items()}, 'image': {k: len(v) for k, v in got['image'].items()}}

        if dropped < 0 and start[2] - settled[2] > 0:
            dropped = float(start[2] - settled[2])
        if info['fixed_base']:
            if moved > 0.001:
                result['problems'].append(f'fixed base moved {moved * 1000:.0f} mm')
        else:
            if drive_kind in ('twist', 'ackermann') and moved < MUST_MOVE:
                result['problems'].append(f'moved only {moved * 1000:.0f} mm in {SECONDS:.0f} s at {SPEED} m/s')
            if dropped > MAY_SETTLE and not info['torques']:
                result['problems'].append(f'the base dropped {dropped * 1000:.0f} mm: the robot collapsed')
        if servo:
            i = names.index(servo)
            result['servo_deg'] = round(float(math.degrees(q[i] - q0[i])), 1)
            if abs(q[i] - q0[i] - 0.5) > 0.1:
                result['problems'].append(f'{servo} told to go 0.5 rad on from where it began went {q[i] - q0[i]:.2f}')
            # A loop takes its passive joints along: with the servo moved, those no drive holds are no longer where they began.
            if info['loops']:
                carried = {n: round(float(q[k] - q0[k]), 3) for k, n in enumerate(names) if n not in info['held'] and n not in info['torques']}
                result['loop_carried'] = carried
                if carried and max(abs(v) for v in carried.values()) < 0.1:
                    result['problems'].append(f'the loop did not carry its passive joints when {servo} moved: {carried}')
        # Every joint with a start began there, and those not told to move are still there.
        if info['starts']:
            began = {j: float(q0[names.index(j)]) for j in info['starts'] if j in names}
            off = [f'{j} began at {began.get(j, float("nan")):.3f}, start {v:.3f}' for j, v in info['starts'].items() if not abs(began.get(j, float('nan')) - v) < 0.05]
            drift = [f'{j} is at {float(q[names.index(j)]):.3f}, start {v:.3f}' for j, v in info['starts'].items() if j in names and j != servo and j not in info['torques'] and abs(float(q[names.index(j)]) - v) > 0.15]
            result['starts_held'] = len(info['starts']) - len(off) - len(drift)
            result['problems'] += off + drift
        # A robot with no joint of its own (a rover on tracks) publishes no joint states at all.
        if not names:
            if got['joint_states']:
                result['problems'].append(f"joint_states arrived ({len(got['joint_states'])}) from a robot with no joint of its own")
        elif not got['joint_states']:
            result['problems'].append('no joint_states arrived')
        # The articulation holds a mecanum wheel's rollers' hinges too, which are the simulator's alone.
        elif set(got['joint_states'][-1].name) != {n for n in names if '_roller_' not in n}:
            result['problems'].append(f"joint_states names {list(got['joint_states'][-1].name)} are not the robot's own of the articulation's {names}")
        # A mecanum wheel's rollers are the simulator's alone: no joint state and no transform tells of one.
        told = sorted(n for n in set(got['joint_states'][-1].name if got['joint_states'] else []) | frames if '_roller_' in n)
        if told:
            result['problems'].append(f'the rollers are published: {told[:4]}')
        # Nor of a wheel that stands in for a track's belt.
        told = sorted(n for n in set(got['joint_states'][-1].name if got['joint_states'] else []) | frames if re.search(r'_wheel_\d+(_joint)?$', n))
        if info['tracks'] and told:
            result['problems'].append(f"the tracks' wheels are published: {told[:4]}")
        if not got['clock']:
            result['problems'].append('no clock arrived')
        if not info['fixed_base']:
            if not got['odom']:
                result['problems'].append('no odom arrived')
            else:
                o = got['odom'][-1].pose.pose.position
                if drive_kind in ('twist', 'ackermann'):
                    # A driven robot's odometry is given for its footprint, +X the way it faces: told to go
                    # forward, it has gone along +X by as far as it moved, whichever way the design faces.
                    off = float(np.hypot(o.x - moved, o.y))
                    result['odom_xy_mm'] = [round(o.x * 1000), round(o.y * 1000)]
                    child = got['odom'][-1].child_frame_id
                    if child != info['base_frame'] or 'def Xform "%s"' % child not in open(path, encoding='utf-8').read():
                        result['problems'].append(f'odom is given for "{child}", not the footprint "{info["base_frame"]}"')
                    if child not in frames or 'odom' not in frames:
                        result['problems'].append(f'the transform tree lacks odom or "{child}" ({", ".join(sorted(frames))})')
                else:
                    off = float(np.linalg.norm(np.array([o.x, o.y]) - (end[:2] - start[:2])))
                result['odom_error_mm'] = round(off * 1000)
                if off > 0.03:
                    result['problems'].append(f'odom is {off * 1000:.0f} mm off the pose')
        for lidar, rays in info['lidars'].items():
            scans = first_scans[lidar]
            if not scans:
                result['problems'].append(f'no scan from {lidar}')
                continue
            s = scans[-1]
            finite = [r for r in s.ranges if math.isfinite(r) and r > 0]
            result[f'{lidar}_rays'] = len(s.ranges)
            result[f'{lidar}_nearest_mm'] = round(min(finite) * 1000) if finite else None
            if rays and len(s.ranges) != rays:
                result['problems'].append(f'{lidar} scan has {len(s.ranges)} rays for {rays} in the design')
            if not finite or abs(min(finite) - (WALL_AT - 0.025 - abs(settled[1]))) > 0.15:
                result['problems'].append(f'{lidar} does not see the wall at about a meter: nearest {min(finite) if finite else None}')
        for imu, msgs in got['imu'].items():
            if not msgs:
                result['problems'].append(f'no imu from {imu}')
                continue
            # Once it has come to rest, for a robot that fell; standing still, for one that stands.
            a = (msgs[-1] if info['torques'] else still_imu.get(imu, msgs[-1])).linear_acceleration
            result[f'{imu}_g'] = [round(a.x, 2), round(a.y, 2), round(a.z, 2)]
            # A robot whose joints wait for efforts lies where it fell: its IMU still reads gravity, whichever way up.
            if info['torques']:
                if abs(math.sqrt(a.x**2 + a.y**2 + a.z**2) - 9.81) > 1.0:
                    result['problems'].append(f'{imu} reads ({a.x:.2f}, {a.y:.2f}, {a.z:.2f}), not gravity')
            elif abs(a.z - 9.81) > 1.0 or abs(a.x) > 1.0 or abs(a.y) > 1.0:
                result['problems'].append(f'{imu} reads ({a.x:.2f}, {a.y:.2f}, {a.z:.2f}), not gravity up')
        for cam, msgs in got['image'].items():
            if not msgs:
                result['problems'].append(f'no pictures from {cam}')
            else:
                result[f'{cam}_px'] = f'{msgs[-1].width}x{msgs[-1].height}'
                # ROS reads a picture in the camera's optical frame: Z out along the line of sight.
                if msgs[-1].header.frame_id != f'{cam}_optical_frame':
                    result['problems'].append(f'{cam} stamps its pictures with "{msgs[-1].header.frame_id}", not its optical frame')
        stamped = {f'{kind} of {k}': v[-1].header.frame_id for kind in ('scan', 'imu', 'image') for k, v in got[kind].items() if v}
        result['frames'] = len(frames)
        for what, frame in stamped.items():
            if frame not in frames:
                result['problems'].append(f'the {what} is stamped with "{frame}", which the transform tree does not have ({", ".join(sorted(frames))})')
        # Touch sensors: Isaac's contact sensor interface must read a force on each pad that stands on the floor.
        if info['touches']:
            if touch_error:
                result['problems'].append(touch_error)
            result['touch_N'] = touched
            quiet = [k for k, v in touched.items() if not v]
            # With nothing holding its joints the robot lies as it fell, on whatever it fell on.
            if len(quiet) == len(touched) and touched and not info['torques']:
                result['problems'].append('no contact sensor feels any force')
            # A reference robot's pads are its feet: standing still, it stands on all of them, not on three.
            elif quiet and not info['torques']:
                result['problems'].append(f'standing, {", ".join(quiet)} feel{"s" if len(quiet) == 1 else ""} nothing while the other pads do')

        # A joint commanded by torque goes the way its effort pushes it: full effort one way, then the other.
        if info['torques']:
            pushed = next(n for n in names if n in info['torques'])

            def push(sign):
                m = JointState()
                m.name = [pushed]
                m.effort = [sign * info['torques'][pushed]]
                joint_pub.publish(m)

            run(1.0, lambda i: push(1.0))
            up = float(np.asarray(art.get_joint_positions())[0][names.index(pushed)])
            run(1.0, lambda i: push(-1.0))
            down = float(np.asarray(art.get_joint_positions())[0][names.index(pushed)])
            result['effort_swing_deg'] = round(math.degrees(up - down), 1)
            if up - down < 0.1:
                result['problems'].append(f'{pushed} pushed with its full effort each way went from {up:.2f} to {down:.2f}')

        # A picture, aimed at the robot where it ended up.
        cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), ['default'], useExtentsHint=False)
        box = cache.ComputeWorldBound(robot).ComputeAlignedRange()
        center = np.array([(a + b) / 2 for a, b in zip(box.GetMin(), box.GetMax())])
        size = max(b - a for a, b in zip(box.GetMin(), box.GetMax()))
        eye = center + np.array([2.6, -2.6, 1.6]) * max(size, 0.1)
        set_camera_view(eye=eye, target=center, camera_prim_path='/World/SmokeCamera')
        for _ in range(40):
            world.step(render=True)
        rgba = camera.get_rgba()
        if rgba is not None and getattr(rgba, 'size', 0):
            from PIL import Image as PilImage
            os.makedirs(pictures, exist_ok=True)
            picture = os.path.join(pictures, f'isaac_stage_{name}.png')
            PilImage.fromarray(np.asarray(rgba)[:, :, :3].astype(np.uint8)).save(picture)
            result['picture'] = picture
            colors = len(np.unique(np.asarray(rgba)[:, :, :3].reshape(-1, 3), axis=0))
            if colors < 50:
                result['problems'].append(f'the picture shows {colors} colors: nothing rendered')
        # A mecanum drive, last of all: told to go back, to slide to its left and to turn on the spot, it does
        # each by about as much as asked and nothing else. Its footprint's +X is forward, +Y its left.
        def footprint():
            pos, quat = art.get_world_poses()
            w, x, y, z = (float(v) for v in np.asarray(quat)[0])
            return np.asarray(pos)[0][:2].copy(), math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))

        def told(vx, vy, wz):
            def send(i):
                m = Twist()
                m.linear.x, m.linear.y, m.angular.z = vx, vy, wz
                twist_pub.publish(m)
            at, yaw = footprint()
            # The turn is added up step by step: read end to end, one past a half turn would come back as the other way.
            spin = {'last': yaw, 'sum': 0.0}

            def follow():
                now = footprint()[1]
                spin['sum'] += (now - spin['last'] + math.pi) % (2 * math.pi) - math.pi
                spin['last'] = now

            def sent(i):
                send(i)
                follow()

            def stopped(i):
                twist_pub.publish(Twist())
                follow()

            run(SECONDS, sent)
            run(0.5, stopped)
            to = footprint()[0]
            follow()
            d = to - at
            turned = spin['sum']
            return float(d[0] * math.cos(yaw) + d[1] * math.sin(yaw)), float(-d[0] * math.sin(yaw) + d[1] * math.cos(yaw)), turned

        # A rover on tracks: told to go back and to turn on the spot, it does each within what a long contact that skids allows, and nothing else.
        if info['tracks'] and drive_kind == 'twist':
            went = {'back': told(-SPEED, 0.0, 0.0), 'turn': told(0.0, 0.0, 1.0)}
            result['tracks'] = {k: [round(v[0] * 1000), round(v[1] * 1000), round(v[2], 3)] for k, v in went.items()}
            for k, (i, ideal, unit, (least, most)) in {'back': (0, -SPEED * SECONDS, 'm', TRACK_STRAIGHT), 'turn': (2, 1.0 * SECONDS, 'rad', TRACK_TURN)}.items():
                if not least <= went[k][i] / ideal <= most:
                    result['problems'].append(f'tracks {k}: went {went[k][i]:.3f} {unit} of the {ideal:.3f} asked')
                stray = [abs(v) for j, v in enumerate(went[k]) if j != i]
                if stray[0] > TRACK_STRAY or stray[1] > TRACK_STRAY:
                    result['problems'].append(f'tracks {k}: strayed, forward {went[k][0]:.3f} m, left {went[k][1]:.3f} m, turn {went[k][2]:.3f} rad')
        # A rover whose wheels slide as it turns: told to turn on the spot, it does, as far as that sliding allows.
        if info['skids'] and drive_kind == 'twist':
            told(-SPEED, 0.0, 0.0)
            forward, left, turned = told(0.0, 0.0, 1.0)
            result['skid_turn'] = [round(forward * 1000), round(left * 1000), round(turned, 3)]
            plain = (info['plain_turn'] or 1.0) * 1.0 * SECONDS
            result['skid_turn'].append(f'{100 * turned / plain:.0f} % of the {plain:.3f} rad plain friction gives')
            if not SKID_TURN[0] <= turned / plain <= SKID_TURN[1]:
                result['problems'].append(f'turn on the spot: went {turned:.3f} rad of the {plain:.3f} plain friction gives ({1.0 * SECONDS:.3f} asked)')
            if math.hypot(forward, left) > SKID_STRAY:
                result['problems'].append(f'turn on the spot: strayed, forward {forward:.3f} m, left {left:.3f} m')
        # A rover on one wheel a side: told to go back and to turn on the spot, it does each as far as it is told,
        # the turn about the middle of its axle, where its base stands.
        if info['two_wheels'] and drive_kind == 'twist':
            went = {'back': told(-SPEED, 0.0, 0.0), 'turn': told(0.0, 0.0, 1.0)}
            result['two_wheels'] = {k: [round(v[0] * 1000), round(v[1] * 1000), round(v[2], 3)] for k, v in went.items()}
            for k, (i, ideal, unit, (least, most)) in {'back': (0, -SPEED * SECONDS, 'm', TWO_STRAIGHT), 'turn': (2, 1.0 * SECONDS, 'rad', TWO_TURN)}.items():
                if not least <= went[k][i] / ideal <= most:
                    result['problems'].append(f'two wheels {k}: went {went[k][i]:.3f} {unit} of the {ideal:.3f} asked')
                stray = [abs(v) for j, v in enumerate(went[k]) if j != i]
                if stray[0] > TWO_STRAY or stray[1] > TWO_STRAY:
                    result['problems'].append(f'two wheels {k}: strayed, forward {went[k][0]:.3f} m, left {went[k][1]:.3f} m, turn {went[k][2]:.3f} rad')
        # A car: told to go straight back it does, by about as much as asked and without turning or straying; told
        # to circle to its left and then to its right, it goes round the circle its wheelbase and the steering
        # angle make, the same either way.
        if drive_kind == 'ackermann' and ackermann_pub is not None and info['wheel_base'] > 0:
            def steered(speed, angle, seconds):
                def send(i):
                    m = AckermannDriveStamped()
                    m.drive.speed, m.drive.steering_angle = speed, angle
                    ackermann_pub.publish(m)
                at, yaw = footprint()
                seen = {'at': at, 'yaw': yaw, 'turned': 0.0, 'path': 0.0}

                def follow():
                    now_at, now = footprint()
                    seen['turned'] += (now - seen['yaw'] + math.pi) % (2 * math.pi) - math.pi
                    seen['path'] += float(np.linalg.norm(now_at - seen['at']))
                    seen['at'], seen['yaw'] = now_at, now

                def sent(i):
                    send(i)
                    follow()

                def stopped(i):
                    ackermann_pub.publish(AckermannDriveStamped())
                    follow()

                run(seconds, sent)
                run(0.5, stopped)
                d = seen['at'] - at
                return float(d[0] * math.cos(yaw) + d[1] * math.sin(yaw)), float(-d[0] * math.sin(yaw) + d[1] * math.cos(yaw)), seen['turned'], seen['path']

            # Back first, away from the wall it drove up to, and far enough to circle clear of it.
            back = steered(-SPEED, 0.0, CAR_SECONDS)
            result['car_back'] = [round(back[0] * 1000), round(back[1] * 1000), round(math.degrees(back[2]), 2)]
            if not CAR_STRAIGHT[0] <= back[0] / (-SPEED * CAR_SECONDS) <= CAR_STRAIGHT[1]:
                result['problems'].append(f'car straight back: went {-back[0]:.3f} m of the {SPEED * CAR_SECONDS:.3f} asked')
            if abs(back[1]) > CAR_STRAY or abs(back[2]) > CAR_VEER:
                result['problems'].append(f'car straight back: strayed {back[1]:.3f} m to its left and turned {math.degrees(back[2]):.2f} deg')
            ideal = info['wheel_base'] / math.tan(CAR_STEER)
            radii = []
            for side, angle in (('left', CAR_STEER), ('right', -CAR_STEER)):
                _, _, turned, path = steered(SPEED, angle, CAR_SECONDS)
                radius = path / abs(turned) if abs(turned) > 1e-3 else float('inf')
                radii.append(radius)
                if turned * angle <= 0 or not CAR_CIRCLE[0] <= radius / ideal <= CAR_CIRCLE[1]:
                    result['problems'].append(f'car circle to its {side}: radius {radius:.3f} m, turned {math.degrees(turned):.1f} deg, where steering {CAR_STEER} rad on a wheelbase of {info["wheel_base"]:.3f} m makes {ideal:.3f} m')
            result['car_circles_mm'] = [round(r * 1000) if math.isfinite(r) else None for r in radii]
            if abs(radii[0] - radii[1]) > CAR_ALIKE * ideal:
                result['problems'].append(f'car circles: {radii[0]:.3f} m to its left, {radii[1]:.3f} m to its right')
        if info['mecanum'] and drive_kind == 'twist':
            # Back first, away from the wall it drove up to.
            went = {'back': told(-SPEED, 0.0, 0.0), 'left': told(0.0, SPEED, 0.0), 'turn': told(0.0, 0.0, 1.0)}
            result['mecanum'] = {k: [round(v[0] * 1000), round(v[1] * 1000), round(v[2], 3)] for k, v in went.items()}
            for k, (i, ideal, unit) in {'back': (0, -SPEED * SECONDS, 'm'), 'left': (1, SPEED * SECONDS, 'm'), 'turn': (2, 1.0 * SECONDS, 'rad')}.items():
                if not MECANUM_LEAST <= went[k][i] / ideal <= MECANUM_MOST:
                    result['problems'].append(f'mecanum {k}: went {went[k][i]:.3f} {unit} of the {ideal:.3f} asked')
                stray = [abs(v) for j, v in enumerate(went[k]) if j != i]
                if stray[0] > MECANUM_STRAY or stray[1] > MECANUM_STRAY:
                    result['problems'].append(f'mecanum {k}: strayed, forward {went[k][0]:.3f} m, left {went[k][1]:.3f} m, turn {went[k][2]:.3f} rad')
            # Told nothing, and leaned so that its weight pushes it along, then across, at MECANUM_HOLD of itself, it
            # stays where it is; at MECANUM_SLIDE it slides (so the lean is felt).
            import omni.usd
            from pxr import Gf, UsdPhysics
            scene = next(p for p in omni.usd.get_context().get_stage().Traverse() if p.IsA(UsdPhysics.Scene))
            down = scene.GetAttribute('physics:gravityDirection').Get()
            held = {}
            for k, side in (('along', 0.0), ('across', math.pi / 2)):
                for pull in (MECANUM_HOLD, MECANUM_SLIDE):
                    at, yaw = footprint()
                    lean, way = math.atan(pull), yaw + side
                    scene.GetAttribute('physics:gravityDirection').Set(Gf.Vec3f(math.sin(lean) * math.cos(way), math.sin(lean) * math.sin(way), -math.cos(lean)))
                    run(1.0, lambda i: None)
                    at = footprint()[0]
                    run(SECONDS, lambda i: None)
                    held[f'{k} {pull}'] = round(float(np.linalg.norm(footprint()[0] - at)) * 1000, 1)
                    scene.GetAttribute('physics:gravityDirection').Set(down)
                    run(1.0, lambda i: None)
                if held[f'{k} {MECANUM_HOLD}'] > MECANUM_CREEP * 1000:
                    result['problems'].append(f'mecanum held {k} at {MECANUM_HOLD} of its weight: moved {held[f"{k} {MECANUM_HOLD}"]} mm in {SECONDS:.0f} s')
                if held[f'{k} {MECANUM_SLIDE}'] < 0.1:
                    result['problems'].append(f'mecanum leaned {k} at {MECANUM_SLIDE} of its weight: moved only {held[f"{k} {MECANUM_SLIDE}"]} mm in {SECONDS:.0f} s')
            result['mecanum_held_mm'] = held
        node.destroy_node()
        rclpy.shutdown()
        try:
            vram = subprocess.run(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'], capture_output=True, text=True).stdout.strip()
            result['vram_mib'] = int(vram)
        except Exception:  # noqa: BLE001
            pass
    except Exception as e:  # noqa: BLE001
        import traceback
        result['problems'].append(f'{type(e).__name__}: {e}')
        result['trace'] = traceback.format_exc().splitlines()[-6:]
    finally:
        print('RESULT ' + json.dumps(result), flush=True)
        app.close()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = sys.argv[1]
    only = sys.argv[2:]
    try:
        import isaacsim  # noqa: F401
    except ImportError:
        print('isaacsim is not installed in this Python; run through tools/isaac_stage_smoke.sh with ISAACSIM_PYTHON set', file=sys.stderr)
        return 2
    if os.environ.get('PLASTIKCAD_ONE'):
        one(os.environ['PLASTIKCAD_ONE'], os.path.join(root, '..', 'pictures'))
        return 0
    stages = [s for s in (stage_of(f) for f in sorted(glob.glob(os.path.join(root, '*')))) if s]
    if only:
        stages = [s for s in stages if os.path.basename(os.path.dirname(s)) in only]
    if not stages:
        print(f'no stages under {root}', file=sys.stderr)
        return 1
    failed = 0
    for s in stages:
        # One Isaac process per stage: it does not come up twice in one.
        env = dict(os.environ, PLASTIKCAD_ONE=s)
        proc = subprocess.run([sys.executable, __file__, root], env=env, capture_output=True, text=True)
        lines = [l for l in proc.stdout.splitlines() if l.startswith('RESULT ')]
        if not lines:
            failed += 1
            tail = '\n'.join((proc.stdout + proc.stderr).splitlines()[-25:])
            print(f'FAIL {os.path.basename(os.path.dirname(s))}: no result\n{tail}')
            continue
        r = json.loads(lines[-1][7:])
        ok = not r['problems']
        failed += 0 if ok else 1
        summary = {k: v for k, v in r.items() if k not in ('name', 'problems', 'notes', 'trace', 'dofs')}
        print(f"{'ok  ' if ok else 'FAIL'} {r['name']}: {json.dumps(summary)}")
        for p in r['problems']:
            print(f'     - {p}')
        for t in r.get('trace', []):
            print(f'       {t}')
    print(f'{len(stages) - failed} of {len(stages)} stages pass')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
