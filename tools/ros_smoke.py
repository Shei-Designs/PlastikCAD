#!/usr/bin/env python3
"""Runs PlastikCAD's exported ROS and SDF packages through ROS 2 + Gazebo.

Meant to run inside the tools/ros Docker image (tools/ros_smoke.sh does that):

    python3 ros_smoke.py <dir of ROS packages> [<dir of SDF model packages>]

For every ROS package: colcon builds it, display.launch.py runs on a virtual
display (every link must get a TF frame, RViz must stay up without errors
and its screenshot, saved beside the camera pictures, must show the robot),
Gazebo converts the URDF (gz sdf -p)
and checks the world, then gazebo.launch.py runs headless; the robot must
publish its joints, every bridged sensor must publish, a drive must move the
robot in Gazebo when told to on /cmd_vel, and ros2_control's controllers must
come up and track a trajectory, a loop taking its passive joints along. Every SDF package is checked and its world
run, the model must appear and a drive must move it. Exits non-zero on any
failure, and reports the [Err] lines Gazebo printed on the way.

Whatever is timed is timed by the simulation's own clock, read from the poses
Gazebo publishes as it steps: a command is in force for so many seconds of the
simulation, the robot is at rest before the next one, a joint is given so many
seconds of the simulation to arrive. A busy machine slows the simulation and
this script alike, and the figures stay what they are. The clock on the wall
only bounds how long something may take to appear at all (a topic, a
controller, a window), and such a bound can fail a run but never pass one.
"""
import glob
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET

import rclpy
import yaml
from geometry_msgs.msg import Twist as RosTwist
from gz.msgs10.double_pb2 import Double
from gz.msgs10.model_pb2 import Model
from gz.msgs10.pose_v_pb2 import Pose_V
from gz.msgs10.twist_pb2 import Twist as GzTwist
from gz.transport13 import Node as GzNode
from nav_msgs.msg import Odometry
from rclpy.executors import SingleThreadedExecutor
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import JointState
from trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint

WS = '/tmp/ros_smoke_ws'
failures = []
ROS = None  # this script's own ROS node, made in main()


# A mecanum drive told to slide goes at least this share of what it went when told forward, and strays no more than
# this share of it along its own forward.
MECANUM_LEAST, MECANUM_STRAY = 0.8, 0.1
# A rover on tracks (a differential drive with a row of wheels each side) told to turn on the spot at this rate
# (rad/s) for this long turns at between these shares of it, by the simulation's own time: a long contact
# skids (Gazebo gave 75 % in the trial, plain Coulomb friction gives 70 to 80 %). It moves no farther than this (m).
TRACK_TURN, TRACK_SECONDS, TRACK_SHARE, TRACK_DRIFT = 1.0, 3.0, (0.5, 1.05), 0.05
# A rover on two wheels a side turns by sliding them sideways. Told to turn on the spot at this rate (rad/s) for
# this long, it turns at between these shares of what Gazebo's friction gives, by the simulation's own time:
# t/(t + L) of the rate told, t from side to side and L from axle to axle, since that friction is a square laid on
# the wheels' diagonals (see `check_friction_frames`) where plain friction is a circle. That is 56 % for the
# reference rover and 33 % for the long one. Each wheel stands on a ridge round its middle, and the SDF model and
# the ROS package then both turn the two 100.2 % and 99.8 % of that, without moving. (On plain cylinders the model
# turned 101 % and 99 % and the package 109 % and 94 %: a cylinder lying exactly flat, as the package's reaches
# Gazebo, has its load shared along its width as the physics pleases, and one a hair off flat, as the model's was
# written, stands on one end; each figure was the same to three places over seven runs.) It moves no farther than this (m).
SKID_TURN, SKID_SECONDS, SKID_SHARE, SKID_DRIFT = 1.0, 3.0, (0.95, 1.05), 0.01
# How long, by the clock on the wall, anything may take to appear or the simulation to get through a stretch of
# its own time, on however busy a machine (s). Reaching it is a failure, so its size decides no figure.
BOUND = 300
# A robot is at rest when, over this much of the simulation's time (s), it has moved no more than this (m) and
# turned no more than this (rad) about any axis.
REST_WINDOW, REST_MOVE, REST_TURN = 0.5, 0.001, 0.003


def fail(pkg, what):
    failures.append(f'{pkg}: {what}')
    print(f'  FAIL {what}', flush=True)


def ok(what):
    print(f'  ok   {what}', flush=True)


def run(cmd, timeout=300, env=None, check=False):
    r = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout, env=env)
    if check and r.returncode:
        raise RuntimeError(f'{cmd}\n{r.stdout}\n{r.stderr}')
    return r


def topic_once(topic, timeout=15):
    """One message of a ROS topic as a dict, or None."""
    try:
        r = run(['ros2', 'topic', 'echo', '--once', topic], timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    if r.returncode or not r.stdout.strip():
        return None
    # The echo may print QoS warnings ahead of the message, and ends with a "---" separator.
    lines = r.stdout.splitlines()
    start = next((i for i, l in enumerate(lines) if re.match(r'^[A-Za-z_]\w*:', l)), 0)
    try:
        return next((d for d in yaml.safe_load_all('\n'.join(lines[start:])) if isinstance(d, dict)), None)
    except yaml.YAMLError:
        return None

IMAGE_STATS = r"""
import json, math, struct, sys
import rclpy
from PIL import Image as Picture
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import CameraInfo, Image, PointCloud2
from sensor_msgs_py import point_cloud2

topic, kind, save = sys.argv[1], sys.argv[2], sys.argv[4] if len(sys.argv) > 4 else ''
rclpy.init()
node = Node('plastikcad_smoke_grab')
got = {}

def on_image(m):
    n = m.width * m.height
    out = {'width': m.width, 'height': m.height, 'encoding': m.encoding, 'frame': m.header.frame_id, 'bytes': len(m.data)}
    if m.encoding == '32FC1' and len(m.data) == n * 4:
        v = struct.unpack('<%df' % n, bytes(m.data))
        finite = [x for x in v if math.isfinite(x)]
        # Gazebo writes -inf for nearer than the near clip and +inf for farther than the far one.
        out.update(finite=len(finite), near=min(finite) if finite else None, far=max(finite) if finite else None, too_near=sum(1 for x in v if x == -math.inf))
        # The middle column, row by row from the top: where the floor starts and how it runs away upwards.
        column = [v[r * m.width + m.width // 2] for r in range(m.height)]
        rows = [r for r, x in enumerate(column) if math.isfinite(x)]
        out['floor_rows'] = [rows[0], rows[-1]] if rows else None
        out['floor_top'] = column[rows[0]] if rows else None
        out['floor_bottom'] = column[rows[-1]] if rows else None
        if save:
            far = out['far'] or 1
            Picture.frombytes('L', (m.width, m.height), bytes(255 - min(255, int(255 * x / far)) if math.isfinite(x) else 0 for x in v)).save(save)
    elif len(m.data) == n * 3:
        px = bytes(m.data)
        out['distinct'] = len(set(px[i:i + 3] for i in range(0, len(px), 3)))
        # Mean of the top and bottom rows: sky above, floor below; the horizon is where the rows change most.
        stride = m.width * 3
        means = [sum(px[r * stride:(r + 1) * stride]) / stride for r in range(m.height)]
        out['top'] = means[0]
        out['bottom'] = means[-1]
        out['horizon'] = max(range(1, m.height), key=lambda r: abs(means[r] - means[r - 1]))
        if save:
            Picture.frombytes('RGB', (m.width, m.height), px).save(save)
    got['msg'] = out

def on_info(m):
    got['msg'] = {'width': m.width, 'height': m.height, 'fx': m.k[0], 'cx': m.k[2], 'frame': m.header.frame_id, 'distortion': m.distortion_model}

def on_cloud(m):
    pts = list(point_cloud2.read_points(m, field_names=('x', 'y', 'z'), skip_nans=True))
    finite = [p for p in pts if all(math.isfinite(float(c)) for c in p)]
    got['msg'] = {'width': m.width, 'height': m.height, 'fields': [f.name for f in m.fields], 'points': len(finite), 'frame': m.header.frame_id,
                  'nearest': min((math.sqrt(sum(float(c) ** 2 for c in p)) for p in finite), default=None)}

cls, cb = {'image': (Image, on_image), 'info': (CameraInfo, on_info), 'cloud': (PointCloud2, on_cloud)}[kind]
node.create_subscription(cls, topic, cb, qos_profile_sensor_data)
end = node.get_clock().now().nanoseconds + int(float(sys.argv[3]) * 1e9)
while rclpy.ok() and 'msg' not in got and node.get_clock().now().nanoseconds < end:
    rclpy.spin_once(node, timeout_sec=0.2)
node.destroy_node()
rclpy.shutdown()
print(json.dumps(got.get('msg')))
"""


def grab(topic, kind, env, timeout=15, save=''):
    """One message of an image, camera-info or point-cloud topic, summarised by a small rclpy node: a dict, or None.
    An image is also saved as a PNG at `save` when given."""
    try:
        r = run(['python3', '-c', IMAGE_STATS, topic, kind, str(timeout), save], timeout=timeout + 15, env=env)
    except subprocess.TimeoutExpired:
        return None
    try:
        return json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else None
    except (json.JSONDecodeError, IndexError):
        return None


def wait_for(predicate, timeout, step=0.5):
    """Waits, by the clock on the wall, for something to be there at all: a bound on a failure, never a measure."""
    end = time.time() + timeout
    while time.time() < end:
        v = predicate()
        if v:
            return v
        time.sleep(step)
    return None


class Sim:
    """What Gazebo itself tells of a model as it steps, listened to in this process: its pose at each moment of
    the simulation's time (some sixty a second, from the world's pose/info), and its joints where the model has
    Gazebo's own joint state publisher. Nothing is asked of the server (asking it for a pose holds it up), and
    the time is the simulation's own, so neither the reading nor the waiting depends on how busy the machine is."""

    def __init__(self, world, model, joints_topic=None):
        self.model, self.lock = model, threading.Lock()
        self.track = []  # (time, x, y, z, roll, pitch, yaw)
        self.joints, self.joints_seen, self.unrest = {}, 0, None
        self.node = GzNode()
        self.pubs = {}
        self.node.subscribe(Pose_V, f'/world/{world}/pose/info', self._poses)
        if joints_topic:
            self.node.subscribe(Model, joints_topic, self._joints)

    def _poses(self, msg):
        t = msg.header.stamp.sec + msg.header.stamp.nsec * 1e-9
        for p in msg.pose:
            if p.name == self.model:
                q = p.orientation
                x, y, z, w = q.x, q.y, q.z, q.w
                roll = math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
                pitch = math.asin(max(-1.0, min(1.0, 2 * (w * y - z * x))))
                yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
                with self.lock:
                    # The stream is in the order of the simulation's time; a message out of it is of no use.
                    if not self.track or t > self.track[-1][0]:
                        self.track.append((t, p.position.x, p.position.y, p.position.z, roll, pitch, yaw))
                return

    def _joints(self, msg):
        found = {j.name: j.axis1.position for j in msg.joint}
        with self.lock:
            self.joints, self.joints_seen = found, self.joints_seen + 1

    def count(self):
        with self.lock:
            return len(self.track)

    def since(self, index):
        with self.lock:
            return self.track[index:]

    def now(self):
        """The simulation's time at the last pose heard (s), or None before the first."""
        with self.lock:
            return self.track[-1][0] if self.track else None

    def pose(self):
        """The model's last pose: (x, y, z, roll, pitch, yaw), or None before the first."""
        with self.lock:
            return self.track[-1][1:] if self.track else None

    def appear(self, timeout=60):
        return wait_for(self.pose, timeout, 0.1)

    def until(self, predicate, seconds):
        """Waits for `predicate` to hold, for at most `seconds` of the simulation's time: its value, or None."""
        start, end = self.now(), time.time() + BOUND
        while True:
            v = predicate()
            if v:
                return v
            if start is None or self.now() - start >= seconds or time.time() > end:
                return None
            time.sleep(0.02)

    def wait(self, seconds):
        """Lets `seconds` of the simulation's time pass. False where the simulation did not get that far."""
        start = self.now()
        return bool(start is not None and self.until(lambda: self.now() - start >= seconds, seconds + 1))

    def rest(self, meanwhile=None, seconds=30):
        """Waits for the model to be at rest (see REST_WINDOW), for at most `seconds` of the simulation's time,
        calling `meanwhile` as it waits. Returns its pose there, or None where it never came to rest."""
        def still():
            if meanwhile:
                meanwhile()
            with self.lock:
                last = self.track[-1][0] if self.track else 0.0
                window = [p for p in self.track[-400:] if p[0] >= last - REST_WINDOW]
            if len(window) < 5 or window[-1][0] - window[0][0] < 0.8 * REST_WINDOW:
                return None
            spans = [max(p[i] for p in window) - min(p[i] for p in window) for i in range(1, 6)]
            yaws = [(p[6] - window[0][6] + math.pi) % (2 * math.pi) - math.pi for p in window]
            self.unrest = (max(spans[:3]), max(spans[3:] + [max(yaws) - min(yaws)]))
            if self.unrest[0] > REST_MOVE or self.unrest[1] > REST_TURN:
                return None
            return window[-1][1:]
        return self.until(still, seconds)

    def moving(self):
        """How far from rest the model was when last looked at, in words, for a failure."""
        return f'still moving {1000 * self.unrest[0]:.1f} mm and turning {math.degrees(self.unrest[1]):.2f}° in {REST_WINDOW} s' if self.unrest else 'no pose heard'

    def joint_positions(self, timeout=BOUND):
        """Every joint's position as the model's joint state publisher next tells it, by name; None when nothing is heard."""
        with self.lock:
            seen = self.joints_seen

        def fresh():
            with self.lock:
                return dict(self.joints) if self.joints_seen > seen else None
        return wait_for(fresh, timeout, 0.02)

    def publisher(self, topic, kind):
        """A publisher on a Gazebo topic that something is listening to, or None where nothing came to listen:
        a message sent before the listener is found is lost, and one sent after is not."""
        if topic not in self.pubs:
            self.pubs[topic] = self.node.advertise(topic, kind)
        pub = self.pubs[topic]
        return pub if wait_for(pub.has_connections, 60, 0.05) else None


class Ros:
    """This script's own ROS node, kept through the run: it tells /cmd_vel and a trajectory controller, and
    hears /joint_states and /odom, without starting a process for each message (which takes seconds on a busy
    machine, and so cannot time anything)."""

    def __init__(self):
        rclpy.init()
        self.node = rclpy.create_node('plastikcad_smoke')
        self.lock = threading.Lock()
        self.joints, self.heard_at, self.messages, self.odom, self.odom_seen = {}, {}, 0, None, 0
        self.cmd_vel = self.node.create_publisher(RosTwist, '/cmd_vel', 10)
        self.node.create_subscription(JointState, '/joint_states', self._joints, qos_profile_sensor_data)
        self.node.create_subscription(Odometry, '/odom', self._odom, qos_profile_sensor_data)
        self.trajectories = {}
        self.executor = SingleThreadedExecutor()
        self.executor.add_node(self.node)
        threading.Thread(target=self.executor.spin, daemon=True).start()

    def _joints(self, msg):
        with self.lock:
            self.messages += 1
            for joint, at in zip(msg.name, msg.position):
                self.joints[joint], self.heard_at[joint] = at, self.messages

    def _odom(self, msg):
        with self.lock:
            p = msg.pose.pose.position
            self.odom, self.odom_seen = (p.x, p.y, msg.header.frame_id, msg.child_frame_id), self.odom_seen + 1

    def joint_positions(self, names, timeout=BOUND):
        """Where the joints `names` are, each as /joint_states tells it after this is asked: by name, with whatever
        else was told meanwhile. Those not told of within `timeout` are left out. More than one node may publish
        the topic, each its own joints (ros2_control's broadcaster those it has, Gazebo's bridge all of the
        model's), so no single message need carry them all."""
        with self.lock:
            since = self.messages

        def told():
            with self.lock:
                return dict(self.joints) if all(self.heard_at.get(j, 0) > since for j in names) else None

        got = wait_for(told, timeout, 0.02)
        if got is not None:
            return got
        with self.lock:
            return {j: v for j, v in self.joints.items() if self.heard_at.get(j, 0) > since}

    def odometry(self, timeout=60):
        """The next /odom to come: (x, y, frame, child frame), or None when none comes."""
        with self.lock:
            seen = self.odom_seen

        def fresh():
            with self.lock:
                return self.odom if self.odom_seen > seen else None
        return wait_for(fresh, timeout, 0.02)

    def heard(self, pub, timeout=60):
        """Whether something has come to listen to a publisher of this node's."""
        return bool(wait_for(lambda: pub.get_subscription_count() > 0, timeout, 0.05))

    def twist(self, x, y, z):
        m = RosTwist()
        m.linear.x, m.linear.y, m.angular.z = float(x), float(y), float(z)
        self.cmd_vel.publish(m)

    def trajectory(self, controller, joints, positions, seconds=1):
        """Sends a controller one point to reach; False where the controller is not listening."""
        if controller not in self.trajectories:
            self.trajectories[controller] = self.node.create_publisher(JointTrajectory, f'/{controller}/joint_trajectory', 10)
        pub = self.trajectories[controller]
        if not self.heard(pub):
            return False
        m = JointTrajectory()
        m.joint_names = list(joints)
        point = JointTrajectoryPoint()
        point.positions = [float(v) for v in positions]
        point.time_from_start.sec = int(seconds)
        m.points = [point]
        pub.publish(m)
        return True


class Launched:
    """A launch file or gz server running in its own process group, with its output in a log."""

    def __init__(self, cmd, log, env=None):
        self.log = open(log, 'w')
        self.proc = subprocess.Popen(cmd, stdout=self.log, stderr=subprocess.STDOUT, env=env, preexec_fn=os.setsid)
        self.path = log

    def stop(self):
        try:
            os.killpg(self.proc.pid, signal.SIGINT)
            self.proc.wait(15)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.log.close()
        # Gazebo leaves its server behind when the launch is interrupted.
        subprocess.run(['pkill', '-9', '-f', 'gz sim'], capture_output=True)
        subprocess.run(['pkill', '-9', '-f', 'ruby'], capture_output=True)
        time.sleep(1)

    def errors(self):
        with open(self.path, errors='replace') as f:
            text = f.read()
        lines = [l for l in text.splitlines() if '[Err]' in l or 'ERROR' in l or 'error' in l.lower() and 'no error' not in l.lower()]
        # Noise that does not come from the robot.
        noise = ('XDG_RUNTIME_DIR', 'libEGL warning', 'Unable to find or download file', 'already exists')
        return [l for l in lines if not any(n in l for n in noise)]


def camera_turn(urdf_path, sensor):
    """How a camera's fixed joint turns it in the level body: (pitch down, roll) in radians, or None."""
    tree = ET.parse(urdf_path)
    for j in tree.getroot().findall('joint'):
        if j.get('name') == f'{sensor}_joint':
            rpy = [float(v) for v in (j.find('origin').get('rpy') or '0 0 0').split()]
            return rpy[1], rpy[0]
    return None


def upside_down(urdf, sensor):
    turn = camera_turn(urdf, sensor)
    return bool(turn) and abs(abs(turn[1]) - math.pi) < 0.01


def horizon_check(name, topic, urdf, sensor, w, h, horizon):
    """The horizon must sit where the camera's tilt, roll and field of view put it (a camera rolled 180° sees the floor above the sky)."""
    hfov, turn = camera_hfov(urdf, sensor), camera_turn(urdf, sensor)
    if hfov is None or turn is None or horizon is None:
        return ''
    pitch, roll = turn
    if abs(roll) > 0.01 and not upside_down(urdf, sensor):
        return f', horizon at row {horizon} (not checked: camera rolled {math.degrees(roll):.0f}°)'
    fx = w / 2 / math.tan(hfov / 2)
    expected = h / 2 + (fx * math.tan(pitch) if upside_down(urdf, sensor) else -fx * math.tan(pitch))
    how = f'a {math.degrees(pitch):.0f}° tilt' + (', upside down' if upside_down(urdf, sensor) else '')
    detail = f', horizon at row {horizon} (expected {expected:.0f} for {how})'
    if abs(horizon - expected) > max(4, 0.02 * h):
        fail(name, f'{topic} puts the horizon at row {horizon}, not {expected:.0f}: the camera is not turned as designed ({how})')
    return detail


def camera_hfov(urdf_path, sensor):
    """The horizontal field of view a camera sensor in the URDF's Gazebo blocks was given, in radians, or None."""
    with open(urdf_path) as f:
        text = f.read()
    m = re.search(r'<sensor name="%s" type="(?:depth_)?camera">.*?<horizontal_fov>([-\d.e+]+)</horizontal_fov>' % re.escape(sensor), text, re.S)
    return float(m.group(1)) if m else None


def check_friction_frames(name, sdf):
    """A wheel's friction laid along a direction of its own names the link whose frame the direction is in. Gazebo
    takes a name it does not know in silence and lays the friction along the world's axes, so the name must be a
    link of the model as Gazebo has it (`sdf`: the model's text)."""
    frames = set(re.findall(r"""gz:expressed_in=['"]([^'"]+)['"]""", sdf))
    lost = sorted(frames - set(re.findall(r"""<link name=['"]([^'"]+)['"]""", sdf)))
    if lost:
        fail(name, f'a friction direction is told in {lost}, no link of the model as Gazebo has it')
    elif frames:
        ok(f'friction directions are told in the frame of {sorted(frames)}, a link Gazebo keeps')


def moving_joints(urdf_path):
    tree = ET.parse(urdf_path)
    return [j.get('name') for j in tree.getroot().findall('joint') if j.get('type') != 'fixed']


def initial_values(urdf_path):
    """Where each joint under ros2_control begins, for those the URDF gives an initial position."""
    out = {}
    for joint in ET.parse(urdf_path).getroot().findall('ros2_control/joint'):
        for state in joint.findall('state_interface'):
            value = state.find("param[@name='initial_value']")
            if state.get('name') == 'position' and value is not None:
                out[joint.get('name')] = float(value.text)
    return out


def effort_joints(urdf_path):
    """The joints under ros2_control that take an effort command beside the position."""
    return [j.get('name') for j in ET.parse(urdf_path).getroot().findall('ros2_control/joint') if any(c.get('name') == 'effort' for c in j.findall('command_interface'))]


def bridged(pkg_dir):
    with open(os.path.join(pkg_dir, 'config', 'bridge.yaml')) as f:
        return yaml.safe_load(f) or []


def move(sim, send, x, y, z, seconds):
    """Tells the robot a velocity through `send(x, y, z)` for `seconds` of the simulation's time, from rest and
    to rest again. Returns (the pose before, the pose after, how long the command was in force by the
    simulation's time, the poses heard from the first telling on), or None where the robot was not at rest
    before or never came to rest after. The command is told again and again, as a teleop would, and the stop
    likewise until the robot stands."""
    before = sim.rest()
    if not before:
        return None
    first, start, end = sim.count(), sim.now(), time.time() + BOUND
    while sim.now() - start < seconds and time.time() < end:
        send(x, y, z)
        time.sleep(0.02)
    took = sim.now() - start
    after = sim.rest(lambda: send(0.0, 0.0, 0.0))
    if not after or took < seconds:
        return None
    return before, after, took, sim.since(first)


def turn_of(seen):
    """How far a model turned about the vertical through the poses `seen`, added up from one pose to the next.
    A turn read from the pose before and the pose after comes back within half a turn either way, so one past
    180° reads as a turn the other way; added up from poses a sixtieth of a second apart it cannot.
    Returns (the turn in radians, the longest of the simulation's time between two poses in s, the rate of the
    turn in rad/s). The rate is taken over the middle of the turn, from a tenth of it to nine tenths, by the
    simulation's own time: neither the start nor the stop enters into it."""
    sums = [0.0]
    for a, b in zip(seen, seen[1:]):
        sums.append(sums[-1] + (b[6] - a[6] + math.pi) % (2 * math.pi) - math.pi)
    turned = sums[-1]
    middle = [i for i, v in enumerate(sums) if 0.1 * abs(turned) <= abs(v) <= 0.9 * abs(turned)]
    took = seen[middle[-1]][0] - seen[middle[0]][0] if middle else 0.0
    rate = (sums[middle[-1]] - sums[middle[0]]) / took if took > 0 else 0.0
    return turned, max((b[0] - a[0] for a, b in zip(seen, seen[1:])), default=0.0), rate


def followed(name, gap, rate):
    """Whether the poses came often enough to add a turn at `rate` (rad/s) up from them; a failure where they did not."""
    if gap * abs(rate) < 0.5 * math.pi:
        return True
    fail(name, f'could not follow the turn: {gap:.2f} s of the simulation passed between two poses, in which a robot told to turn {abs(rate):.1f} rad/s may turn too far to tell which way')
    return False


def check_drive(name, sim, send, text, what):
    """A drive told forward for three seconds of the simulation's time moves the robot (`what`: "robot" or
    "model"), which stays upright; a mecanum drive then slides and turns, and one on tracks turns on the spot.
    `text` is the robot's file, which tells the kind of drive. `send(x, y, z)` tells it a velocity once."""
    seconds = 3.0
    went = move(sim, send, 0.2, 0.0, 0.0, seconds)
    if not went:
        return fail(name, f'the {what} was not at rest before the drive, or did not come to rest after it ({sim.moving()})')
    before, after, took, _ = went
    # A command in force a little longer than asked moved the robot that much farther: told as for the time asked.
    dist = math.hypot(after[0] - before[0], after[1] - before[1]) * seconds / took
    if dist < 0.15:
        return fail(name, f'{what} moved only {dist:.3f} m in Gazebo on cmd_vel x = 0.2 for 3 s')
    heading = math.degrees(math.atan2(after[1] - before[1], after[0] - before[0]))
    ok(f'cmd_vel drove the {what} {dist:.3f} m in 3 s of the simulation, heading {heading:.0f}° (yaw {math.degrees(after[5]):.0f}°)')
    if abs(after[3]) > 0.3 or abs(after[4]) > 0.3:
        return fail(name, f'{what} tipped: roll {math.degrees(after[3]):.0f}°, pitch {math.degrees(after[4]):.0f}°')
    if 'MecanumDrive' in text:
        check_mecanum(name, sim, send, dist, after, before)
    if on_tracks(text):
        check_tracks(name, sim, send)
    skid = skid_turn(text)
    if skid:
        check_skid(name, sim, send, skid)


def skid_turn(text):
    """What Gazebo's friction turns a rover on two wheels a side, as a share of the turn asked: t/(t + L), t from
    side to side and L from axle to axle, read from a robot's file (URDF or SDF). None for any other robot."""
    sides = [re.findall(rf'<{side}_joint>([^<]+)</{side}_joint>', text) for side in ('left', 'right')]
    across = re.search(r'<wheel_separation>([^<]+)</wheel_separation>', text)
    if 'DiffDrive' not in text or not across or any(len(side) != 2 for side in sides):
        return None
    corners = []
    for joint in sides[0] + sides[1]:
        block = re.search(rf'<joint name="{re.escape(joint)}"[\s\S]*?</joint>', text)
        # A URDF joint says where it is; an SDF joint is where its child link is.
        at = block and re.search(r'<origin xyz="([^"]+)"', block.group(0))
        child = block and re.search(r'<child>([^<]+)</child>', block.group(0))
        if not at and child:
            at = re.search(rf'<link name="{re.escape(child.group(1))}">\s*<pose>([^<]+)</pose>', text)
        if not at:
            return None
        corners.append([float(v) for v in at.group(1).split()[:2]])
    t = float(across.group(1))
    diagonal = max(math.dist(a, b) for a in corners for b in corners)
    return t / (t + math.sqrt(max(diagonal**2 - t**2, 0.0)))


def check_skid(name, sim, send, share):
    """A rover on two wheels a side, after its run forward: told to turn on the spot it turns at about the
    `share` of the rate told that its wheels' sliding allows, where it stands. The rate is read by the
    simulation's own time (see `turn_of`)."""
    spin = move(sim, send, 0.0, 0.0, SKID_TURN, SKID_SECONDS)
    if not spin:
        return fail(name, f'the robot did not come to rest around the turn ({sim.moving()})')
    start, spun, _, seen = spin
    turned, gap, rate = turn_of(seen)
    if not followed(name, gap, SKID_TURN):
        return
    drift = math.hypot(spun[0] - start[0], spun[1] - start[1])
    of = rate / (share * SKID_TURN)
    told = f'turned {math.degrees(turned):.0f}° at {rate:.3f} rad/s ({100 * of:.1f} % of the {share * SKID_TURN:.3f} rad/s its sliding wheels allow of the {SKID_TURN:.1f} told)'
    if not SKID_SHARE[0] <= of <= SKID_SHARE[1] or drift > SKID_DRIFT:
        fail(name, f'told to turn left on the spot, the robot on two wheels a side {told} and moved {drift:.3f} m')
    else:
        ok(f'cmd_vel z turned the robot on two wheels a side: it {told}, {drift:.3f} m of drift')


def check_mecanum(name, sim, send, forward, after, before):
    """A mecanum drive, after its run forward (`before` to `after`, `forward` m in three seconds): told to slide
    to its left it goes sideways about as far as it went forward, and told to turn it turns on the spot. Each
    move starts from rest and is in force for three seconds of the simulation's time, as the run forward was."""
    seconds = 3.0
    length = math.hypot(after[0] - before[0], after[1] - before[1])
    ahead = ((after[0] - before[0]) / length, (after[1] - before[1]) / length)
    left = (-ahead[1], ahead[0])
    slide = move(sim, send, 0.0, 0.2, 0.0, seconds)
    if not slide:
        return fail(name, f'the robot did not come to rest around the slide ({sim.moving()})')
    start, slid, took, _ = slide
    d = ((slid[0] - start[0]) * seconds / took, (slid[1] - start[1]) * seconds / took)
    sideways, along = d[0] * left[0] + d[1] * left[1], d[0] * ahead[0] + d[1] * ahead[1]
    yawed = (slid[5] - start[5] + math.pi) % (2 * math.pi) - math.pi
    if sideways < MECANUM_LEAST * forward or abs(along) > MECANUM_STRAY * forward or abs(yawed) > 0.15:
        fail(name, f'told to slide left, the robot went {sideways:.3f} m to its left, {along:.3f} m forward and turned {math.degrees(yawed):.0f}° (it went {forward:.3f} m forward when told to)')
    else:
        ok(f'cmd_vel y slid the robot {sideways:.3f} m to its left ({along:+.3f} m forward, turned {math.degrees(yawed):+.0f}°)')
    spin = move(sim, send, 0.0, 0.0, 0.5, seconds)
    if not spin:
        return fail(name, f'the robot did not come to rest around the turn ({sim.moving()})')
    start, spun, took, seen = spin
    turned, gap, _ = turn_of(seen)
    if not followed(name, gap, 0.5):
        return
    turned *= seconds / took
    drift = math.hypot(spun[0] - start[0], spun[1] - start[1])
    if turned < 0.8 or drift > 0.05:
        fail(name, f'told to turn left on the spot, the robot turned {math.degrees(turned):.0f}° and moved {drift:.3f} m')
    else:
        ok(f'cmd_vel z turned the robot {math.degrees(turned):.0f}° to the left on the spot ({drift:.3f} m of drift)')


def on_tracks(text):
    """Whether a robot file's differential drive turns a row of wheels each side: a rover on tracks."""
    return 'DiffDrive' in text and min(text.count('<left_joint>'), text.count('<right_joint>')) >= 3


def check_tracks(name, sim, send):
    """A rover on tracks, after its run forward: told to turn on the spot it turns at most of the rate it was
    told, where it stands. The rate is read by the simulation's own time (see `turn_of`)."""
    spin = move(sim, send, 0.0, 0.0, TRACK_TURN, TRACK_SECONDS)
    if not spin:
        return fail(name, f'the robot did not come to rest around the turn ({sim.moving()})')
    start, spun, _, seen = spin
    turned, gap, rate = turn_of(seen)
    if not followed(name, gap, TRACK_TURN):
        return
    drift = math.hypot(spun[0] - start[0], spun[1] - start[1])
    share = rate / TRACK_TURN
    if not TRACK_SHARE[0] <= share <= TRACK_SHARE[1] or drift > TRACK_DRIFT:
        fail(name, f'told to turn left on the spot, the robot on tracks turned {math.degrees(turned):.0f}° at {rate:.2f} rad/s ({100 * share:.0f} % of the rate it was told) and moved {drift:.3f} m')
    else:
        ok(f'cmd_vel z turned the robot on its tracks {math.degrees(turned):.0f}° to the left on the spot at {rate:.2f} rad/s ({100 * share:.0f} % of the rate it was told, {drift:.3f} m of drift)')


def check_rviz(name, urdf, env):
    """display.launch.py on a virtual display: every link gets a frame, RViz stays up with no error, and a screenshot shows the robot in color."""
    links = [l.get('name') for l in ET.parse(urdf).getroot().findall('link')]
    base = ET.parse(urdf).getroot()
    xvfb = subprocess.Popen(['Xvfb', ':99', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    denv = dict(env, DISPLAY=':99', LIBGL_ALWAYS_SOFTWARE='1', QT_X11_NO_MITSHM='1', XDG_RUNTIME_DIR='/tmp/runtime-smoke')
    os.makedirs('/tmp/runtime-smoke', exist_ok=True)
    wait_for(lambda: os.path.exists('/tmp/.X11-unix/X99'), 30, 0.1)
    launched = Launched(['ros2', 'launch', name, 'display.launch.py'], f'/tmp/{name}.display.log', env=denv)
    try:
        # A robot with no moving joint of its own (a rover on two tracks) has no joint states to publish: its frames are all fixed.
        if moving_joints(urdf) and not ROS.joint_positions(moving_joints(urdf)[:1], 120):
            fail(name, 'display.launch.py published no /joint_states within 120 s (joint_state_publisher_gui)')
            return
        # Frames: fixed joints go out once on /tf_static, moving ones with every joint state.
        def frames():
            seen = set()
            try:
                r = run(['ros2', 'topic', 'echo', '--once', '--qos-durability', 'transient_local', '--qos-reliability', 'reliable', '/tf_static'], timeout=10, env=denv)
                seen.update(re.findall(r'child_frame_id: (\S+)', r.stdout))
            except subprocess.TimeoutExpired:
                pass
            tf = topic_once('/tf', 10)
            if tf:
                seen.update(t.get('child_frame_id') for t in tf.get('transforms', []))
            return seen
        got = wait_for(lambda: (lambda f: f if len(f) >= len(links) - 1 else None)(frames()), 120) or frames()
        missing = [l for l in links if l not in got and base.find(f"joint/child[@link='{l}']") is not None]
        if missing:
            fail(name, f"TF lacks frames for: {', '.join(missing)}")
        else:
            ok(f'robot_state_publisher gives every link a frame ({len(got)} transforms)')
        # RViz takes its time to load the meshes, the longer the busier the machine: its window is pictured until
        # the picture shows the robot, not just the grid, and it must still be up then.
        picture = os.path.join(os.environ.get('SMOKE_PICTURES', '/tmp'), f'rviz_{name}.png')
        # The robot's own colors from the URDF, so the frame axes and the grid do not pass for it.
        colors = sorted({m.get('rgba') for m in base.iter('color') if m.get('rgba')})
        last = {}

        def shown():
            if run(['pgrep', '-f', 'rviz2'], env=denv).returncode:
                last.update(gone=True)
                return last
            r = run(f'xwd -root -silent -display :99 | convert xwd:- png:{picture}', timeout=120, env=denv)
            if r.returncode or not os.path.exists(picture):
                last.update(error=r.stderr.strip()[:200])
                return None
            r = run(['python3', '-c', PICTURE_STATS, picture, json.dumps(colors)], timeout=120)
            last.update(json.loads(r.stdout.strip() or '{}') if r.returncode == 0 else {})
            return last if last.get('robot', 0) >= 300 else None

        wait_for(shown, BOUND, 2)
        if last.get('gone') or run(['pgrep', '-f', 'rviz2'], env=denv).returncode:
            fail(name, 'rviz2 is no longer running')
            return
        if 'robot' not in last:
            fail(name, f"no screenshot of RViz: {last.get('error', '')}")
        elif last['robot'] < 300:
            fail(name, f"RViz's picture shows {last['robot']} pixels in the robot's colors: it did not render ({picture})")
        else:
            ok(f"RViz shows the robot: {last['robot']} pixels in its colors of {last['total']} ({picture})")
    finally:
        errs = [l for l in launched.errors() if 'joint_state_publisher_gui' not in l or 'error' in l.lower()]
        launched.stop()
        subprocess.run(['pkill', '-9', '-f', 'rviz2'], capture_output=True)
        subprocess.run(['pkill', '-9', '-f', 'joint_state_publisher'], capture_output=True)
        subprocess.run(['pkill', '-9', '-f', 'robot_state_publisher'], capture_output=True)
        xvfb.terminate()
        time.sleep(1)
        if errs:
            print(f'  RViz/ROS reported {len(errs)} error line(s):')
            for l in errs[:12]:
                print('       ' + l.strip()[:220])
            fail(name, f'{len(errs)} error line(s) in the display launch log')


PICTURE_STATS = r"""
import colorsys, json, sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
# The robot's colors as hues; a pixel of one of them, shaded or not, is the robot. Grey materials cannot be told from the grid and are skipped.
hues = []
for rgba in json.loads(sys.argv[2]):
    r, g, b = [float(v) for v in rgba.split()[:3]]
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    if s > 0.25:
        hues.append(h)
robot = 0
for r, g, b in im.getdata():
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    if s > 0.2 and v > 0.15 and any(min(abs(h - x), 1 - abs(h - x)) < 0.04 for x in hues):
        robot += 1
print(json.dumps({'total': im.width * im.height, 'robot': robot, 'hues': len(hues)}))
"""


def check_ros_package(pkg_dir, env):
    name = os.path.basename(pkg_dir)
    print(f'\n== {name} (ROS package)', flush=True)
    share = os.path.join(WS, 'install', name, 'share', name)
    urdf = os.path.join(share, 'urdf', f'{name}.urdf')
    world = os.path.join(share, 'worlds', f'{name}.sdf')
    if not os.path.exists(urdf):
        return fail(name, f'{urdf} was not installed')
    check_rviz(name, urdf, env)

    # Gazebo's own reading of the URDF and the world.
    with open(urdf) as f:
        text = f.read().replace('__PACKAGE_SHARE__', share)
    tmp = tempfile.NamedTemporaryFile('w', suffix='.urdf', delete=False)
    tmp.write(text)
    tmp.close()
    r = run(['gz', 'sdf', '-p', tmp.name], env=env)
    if r.returncode or '<model' not in r.stdout:
        fail(name, f'gz sdf -p rejected the URDF: {r.stderr.strip() or r.stdout[-400:]}')
    else:
        ok('gz sdf -p converts the URDF to SDF')
        check_friction_frames(name, r.stdout)
    if r.stderr.strip():
        print('       ' + r.stderr.strip().replace('\n', '\n       '))
    r = run(['gz', 'sdf', '-k', world], env=env)
    if r.returncode:
        fail(name, f'gz sdf -k rejected the world: {r.stderr.strip()}')
    else:
        ok('gz sdf -k accepts the world')

    joints = moving_joints(urdf)
    topics = bridged(os.path.join(pkg_dir))
    controllers = os.path.join(share, 'config', 'controllers.yaml')

    world_name = ET.parse(world).getroot().find('world').get('name')
    sim = Sim(world_name, name)
    launched = Launched(['ros2', 'launch', name, 'gazebo.launch.py', 'headless:=true'], f'/tmp/{name}.launch.log', env=env)
    try:
        # The robot is in when its joints are published.
        js = ROS.joint_positions(joints, 180) if joints else None
        if not joints:
            ok("no moving joint of the robot's own, so no /joint_states")
        elif not js:
            fail(name, 'no /joint_states within 180 s of launch')
        else:
            missing = sorted(set(joints) - set(js))
            if missing:
                fail(name, f'/joint_states lacks {missing}')
            else:
                ok(f'/joint_states carries all {len(joints)} moving joints')
        pose = sim.appear(120)
        if not pose:
            fail(name, "Gazebo's poses do not tell of the robot")
        else:
            ok(f'robot in Gazebo at z = {pose[2]:.3f} m')

        cfg, wanted, listing = None, [], []
        if os.path.exists(controllers):
            with open(controllers) as f:
                cfg = yaml.safe_load(f)
            wanted = [k for k in cfg['controller_manager']['ros__parameters'] if isinstance(cfg['controller_manager']['ros__parameters'][k], dict)]

        def controllers_up():
            """ros2_control's own listing once every controller in it is active, or None; asked for once."""
            def active():
                try:
                    r = run(['ros2', 'control', 'list_controllers'], timeout=60, env=env)
                except subprocess.TimeoutExpired:
                    return None
                return r.stdout if all(re.search(rf'{c}\b.*\bactive', r.stdout) for c in wanted) else None
            if not listing:
                listing.append(wait_for(active, BOUND, 2))
            return listing[0]

        # A joint with a start begins there and its controller holds it: read once the controllers are up and
        # have had three seconds of the simulation's time to pull it away, were they to.
        starts = initial_values(urdf)
        if starts and pose and controllers_up():
            at = ROS.joint_positions(list(starts), 60) if sim.wait(3.0) else {}
            off = sorted(f'{j} at {at.get(j, float("nan")):.3f}, start {v:.3f}' for j, v in starts.items() if not abs(at.get(j, float('nan')) - v) < 0.15)
            if off:
                fail(name, f'joints not at their starts: {off}')
            else:
                settled = sim.pose()
                ok(f'{len(starts)} joints hold their starts' + (f', robot at z = {settled[2]:.3f} m' if settled else ''))

        # The robot is put into the world a little above the floor: its sensors are read once it stands there,
        # which its poses tell (an IMU reads gravity alone only at rest).
        if pose and not sim.rest():
            fail(name, f'the robot did not come to rest in the world ({sim.moving()})')

        # Sensors: every topic bridged from Gazebo to ROS must publish.
        for t in topics:
            if t['direction'] != 'GZ_TO_ROS' or t['ros_topic_name'] in ('/clock', '/joint_states', '/tf', '/odom'):
                continue
            heavy = {'sensor_msgs/msg/Image': 'image', 'sensor_msgs/msg/CameraInfo': 'info', 'sensor_msgs/msg/PointCloud2': 'cloud'}.get(t['ros_type_name'])
            # Pictures and clouds are too big to echo as YAML: a node sums them up instead.
            picture = os.path.join(os.environ['SMOKE_PICTURES'], f'{name}{t["ros_topic_name"].replace("/", "_")}.png') if heavy == 'image' and os.environ.get('SMOKE_PICTURES') else ''
            msg = wait_for(lambda: grab(t['ros_topic_name'], heavy, env, 30, picture), 120) if heavy else wait_for(lambda: topic_once(t['ros_topic_name'], 30), 120)
            if not msg:
                fail(name, f'{t["ros_topic_name"]} ({t["ros_type_name"]}) published nothing')
                continue
            detail = ''
            if t['ros_type_name'] == 'sensor_msgs/msg/LaserScan':
                ranges = msg.get('ranges', [])
                finite = [v for v in ranges if isinstance(v, (int, float)) and math.isfinite(v)]
                # In an empty world the only thing to see is the floor, far off: a low lidar catches it near its range's end.
                low = [v for v in finite if v < 0.8 * msg.get('range_max', 0)]
                detail = f', {len(ranges)} rays, {len(finite)} returns (floor at {min(finite):.1f}-{max(finite):.1f} m)' if finite else f', {len(ranges)} rays, nothing in range'
                if not ranges:
                    fail(name, f'{t["ros_topic_name"]} has no ranges')
                elif low:
                    fail(name, f'{t["ros_topic_name"]} sees something at {min(low):.2f} m in an empty world')
            elif t['ros_type_name'] == 'sensor_msgs/msg/Image':
                w, h = msg.get('width') or 0, msg.get('height') or 0
                sensor_name = t['ros_topic_name'].split('/')[1]
                detail = f', {w}x{h} {msg.get("encoding")}, frame {msg.get("frame")}'
                # ROS reads a picture in the camera's optical frame (Z out along the line of sight), which the URDF has.
                if msg.get('frame') != f'{sensor_name}_optical_frame':
                    fail(name, f'{t["ros_topic_name"]} is stamped with {msg.get("frame")}, not {sensor_name}_optical_frame')
                if not w or not h:
                    fail(name, f'{t["ros_topic_name"]} is an empty image')
                elif msg.get('encoding') == '32FC1':
                    # A depth picture of the floor ahead: sky (infinite) above the horizon, the floor below it
                    # running away upwards, so the lowest floor row is the nearest and the highest the farthest.
                    rows = msg.get('floor_rows')
                    detail += f', {msg["finite"]} of {w * h} pixels in range, {msg["near"]:.2f}-{msg["far"]:.2f} m, floor in rows {rows[0]}-{rows[1]} of {h} at {msg["floor_top"]:.2f}-{msg["floor_bottom"]:.2f} m' if rows else ', nothing in range'
                    if msg.get('too_near'):
                        detail += f', {msg["too_near"]} pixels nearer than the near clip'
                    if not rows:
                        fail(name, f'{t["ros_topic_name"]} sees nothing: not even the floor')
                    elif upside_down(urdf, sensor_name):
                        # Mounted upside down: the floor fills the top of the picture, nearest at the very top.
                        if rows[0] > h // 4 or rows[1] > h * 3 // 4 or not msg['floor_top'] < msg['floor_bottom']:
                            fail(name, f'{t["ros_topic_name"]} does not look out over the floor upside down{detail}')
                    elif rows[0] < h // 4 or rows[1] < h * 3 // 4 or not msg['floor_bottom'] < msg['floor_top']:
                        fail(name, f'{t["ros_topic_name"]} does not look out over the floor{detail}')
                    if rows:
                        detail += horizon_check(name, t['ros_topic_name'], urdf, sensor_name, w, h, rows[1] + 1 if upside_down(urdf, sensor_name) else rows[0])
                elif msg.get('distinct') is not None:
                    detail += f', {msg["distinct"]} colours, top row {msg["top"]:.0f} bottom row {msg["bottom"]:.0f}'
                    if msg['distinct'] < 2 or msg['bytes'] != w * h * 3:
                        fail(name, f'{t["ros_topic_name"]} renders a blank picture{detail}')
                    else:
                        detail += horizon_check(name, t['ros_topic_name'], urdf, sensor_name, w, h, msg.get('horizon'))
                    if picture:
                        detail += f', saved as {os.path.basename(picture)}'
                else:
                    fail(name, f'{t["ros_topic_name"]} has {msg.get("bytes")} bytes of {msg.get("encoding")} for {w}x{h}')
            elif t['ros_type_name'] == 'sensor_msgs/msg/CameraInfo':
                detail = f', {msg.get("width")}x{msg.get("height")} fx {msg.get("fx", 0):.1f} cx {msg.get("cx", 0):.1f}, frame {msg.get("frame")}'
                if msg.get('frame') != f'{t["ros_topic_name"].split("/")[1]}_optical_frame':
                    fail(name, f'{t["ros_topic_name"]} is stamped with {msg.get("frame")}, not the optical frame')
                # The focal length follows from the field of view the design gave the camera.
                hfov = camera_hfov(urdf, t['ros_topic_name'].split('/')[1])
                if hfov and msg.get('width'):
                    expected = msg['width'] / 2 / math.tan(hfov / 2)
                    if abs(msg.get('fx', 0) - expected) > 0.02 * expected:
                        fail(name, f'{t["ros_topic_name"]} focal length {msg.get("fx", 0):.1f} px does not match a {math.degrees(hfov):.0f}° field of view ({expected:.1f} px)')
            elif t['ros_type_name'] == 'sensor_msgs/msg/PointCloud2':
                detail = f', {msg.get("points")} points ({", ".join(msg.get("fields") or [])}), frame {msg.get("frame")}'
                if msg.get('nearest') is not None:
                    detail += f', nearest {msg["nearest"]:.2f} m'
                # Gazebo's points are in the sensor's own frame (X out along the line of sight), so that is the frame they keep.
                if msg.get('frame') != f'{t["ros_topic_name"].split("/")[1]}_link':
                    fail(name, f'{t["ros_topic_name"]} is stamped with {msg.get("frame")}, not the sensor\'s own frame')
                # A lidar's cloud is empty when its scan has nothing in range, as in an empty world; a depth camera always sees the floor.
                if not msg.get('points') and not t['ros_topic_name'].endswith('scan/points'):
                    fail(name, f'{t["ros_topic_name"]} carries no points')
            elif t['ros_type_name'] == 'sensor_msgs/msg/Imu':
                # Standing still: gravity alone, straight up, and no turning.
                a = msg.get('linear_acceleration', {})
                w = msg.get('angular_velocity', {})
                g = math.sqrt(sum(a.get(k, 0) ** 2 for k in 'xyz'))
                spin = math.sqrt(sum(w.get(k, 0) ** 2 for k in 'xyz'))
                detail = f', accel {g:.2f} m/s2 with z = {a.get("z", 0):.2f}, turning {spin:.3f} rad/s, frame {msg.get("header", {}).get("frame_id")}'
                if abs(g - 9.81) > 0.5 or a.get('z', 0) < 9 or spin > 0.1:
                    fail(name, f'{t["ros_topic_name"]} does not read gravity straight up at rest{detail}')
            elif t['ros_type_name'] == 'ros_gz_interfaces/msg/Contacts':
                detail = f', {len(msg.get("contacts") or [])} contact(s)'
            ok(f'{t["ros_topic_name"]} publishes ({t["ros_type_name"].split("/")[-1]}{detail})')

        # Drive.
        if any(t['ros_topic_name'] == '/cmd_vel' for t in topics) and pose:
            with open(urdf) as f:
                text = f.read()
            if not ROS.heard(ROS.cmd_vel):
                fail(name, 'nothing listens to /cmd_vel')
            else:
                odom0 = ROS.odometry()
                check_drive(name, sim, ROS.twist, text, 'robot')
                odom1 = ROS.odometry()
                if odom0 and odom1:
                    od = math.hypot(odom1[0] - odom0[0], odom1[1] - odom0[1])
                    frames = f'{odom1[2]} -> {odom1[3]}'
                    if od < 0.1:
                        fail(name, f'/odom moved only {od:.3f} m ({frames})')
                    else:
                        ok(f'/odom moved {od:.3f} m ({frames})')
                else:
                    fail(name, '/odom published nothing')

        # ros2_control.
        if cfg:
            if not controllers_up():
                fail(name, f'controllers {wanted} did not all become active')
            else:
                ok(f'controllers active: {", ".join(wanted)}')
                # A joint commanded by torque offers its effort to a controller of the user's, beside the position this one holds.
                efforts = effort_joints(urdf)
                if efforts:
                    offered = run(['ros2', 'control', 'list_hardware_interfaces'], timeout=120, env=env).stdout
                    lacking = [j for j in efforts if not re.search(rf'{re.escape(j)}/effort \[available\]', offered)]
                    if lacking:
                        fail(name, f'no effort command interface offered for {lacking}')
                    else:
                        ok(f'{len(efforts)} joints offer an effort command, unclaimed')
                ctrl = next((k for k in wanted if k != 'joint_state_broadcaster'), None)
                cjoints = cfg[ctrl]['ros__parameters']['joints']
                target = [0.3] + [0.0] * (len(cjoints) - 1)

                def reached():
                    return ROS.joint_positions(cjoints[:1], 60).get(cjoints[0])

                # The trajectory takes one second; the joint has ten of the simulation's to be there.
                if not ROS.trajectory(ctrl, cjoints, target):
                    fail(name, f'nothing listens to /{ctrl}/joint_trajectory')
                    got = None
                else:
                    got = sim.until(lambda: (lambda v: v if v is not None and abs(v - 0.3) < 0.05 else None)(reached()), 10)
                    if got is None:
                        fail(name, f'{cjoints[0]} reached {reached()} rad of 0.3 asked through /{ctrl}')
                if got is not None:
                    ok(f'/{ctrl} moved {cjoints[0]} to {got:.3f} rad of 0.3')
                    # A loop, which Gazebo closes by a weld, takes its passive joints along: with the controlled
                    # joint moved, the joints no controller has are no longer where they began.
                    looped = 'gz::sim::systems::DetachableJoint' in open(urdf).read()
                    free = [j for j in joints if j not in cjoints]
                    if looped and free:
                        def carried():
                            at = ROS.joint_positions(free, 60)
                            moved = {j: at[j] for j in free if j in at and abs(at[j]) > 0.1}
                            return moved or None

                        moved = sim.until(carried, 10)
                        if not moved:
                            fail(name, f'the loop did not carry its passive joints {free} when {cjoints[0]} moved')
                        else:
                            ok('the loop carried ' + ', '.join(f'{j} to {v:.3f} rad' for j, v in sorted(moved.items())))
    finally:
        errs = launched.errors()
        launched.stop()
        if errs:
            print(f'  Gazebo/ROS reported {len(errs)} error line(s):')
            for l in errs[:12]:
                print('       ' + l.strip()[:220])
            fail(name, f'{len(errs)} error line(s) in the launch log')
        os.unlink(tmp.name)


def check_sdf_holders(name, model, model_name, sim):
    """The joints Gazebo's own position controller holds: each must reach its start, stay there, and follow a command."""
    plugins = [p for p in ET.parse(model).getroot().iter('plugin') if 'JointPositionController' in (p.get('name') or '')]
    starts = {p.findtext('joint_name'): float(p.findtext('initial_position') or 0) for p in plugins}
    if not starts:
        return

    def off():
        now = sim.joint_positions(60)
        return None if now is None else max(abs(now.get(j, float('inf')) - at) for j, at in starts.items())

    # Three seconds of the simulation's time to fall away from the starts, were the joints not held, and twenty more to be there.
    sim.wait(3.0)
    worst = sim.until(lambda: (lambda v: v is not None and v < 0.05 and [v])(off()), 20)
    if not worst:
        return fail(name, f'the joints did not reach their starts: off by {off()} rad')
    began = sum(1 for at in starts.values() if at)
    ok(f'{len(starts)} joints held by Gazebo within {worst[0]:.3f} rad of their starts ({began} away from zero)')
    pose = sim.pose()
    if pose and (abs(pose[3]) > 0.3 or abs(pose[4]) > 0.3):
        fail(name, f'the model fell over at its starts: roll {pose[3]:.2f}, pitch {pose[4]:.2f}')
    # One joint sent a little further follows: told once its controller is listening, and given fifteen
    # seconds of the simulation's time to be there.
    joint, at = next(iter(starts.items()))
    want = at + 0.1
    topic = f'/model/{model_name}/joint/{joint}/0/cmd_pos'
    pub = sim.publisher(topic, Double)
    if not pub:
        return fail(name, f'nothing listens to {topic}')
    pub.publish(Double(data=want))
    reached = sim.until(lambda: (lambda now: now is not None and abs(now.get(joint, 9) - want) < 0.03)(sim.joint_positions(60)), 15)
    if reached:
        ok(f'"{joint}" follows a position sent on {topic}')
    else:
        fail(name, f'"{joint}" did not follow {topic}: at {(sim.joint_positions(60) or {}).get(joint)} of {want:.3f}')


def check_sdf_package(pkg_dir, env):
    name = os.path.basename(pkg_dir)
    print(f'\n== {name} (SDF model)', flush=True)
    model = os.path.join(pkg_dir, 'model.sdf')
    worlds = glob.glob(os.path.join(pkg_dir, 'worlds', '*.sdf'))
    r = run(['gz', 'sdf', '-k', model], env=env)
    if r.returncode:
        fail(name, f'gz sdf -k rejected model.sdf: {r.stderr.strip()}')
    else:
        ok('gz sdf -k accepts model.sdf')
    with open(model) as f:
        check_friction_frames(name, f.read())
    if not worlds:
        return fail(name, 'no world')
    world = worlds[0]
    world_name = ET.parse(world).getroot().find('world').get('name')
    # The model carries the design's name, not the folder's.
    model_name = ET.parse(model).getroot().find('model').get('name')
    env = dict(env, GZ_SIM_RESOURCE_PATH=os.path.dirname(pkg_dir))
    sim = Sim(world_name, model_name, '/joint_states')
    launched = Launched(['gz', 'sim', '-s', '-r', '--headless-rendering', world], f'/tmp/{name}.sdf.log', env=env)
    try:
        pose = sim.appear(180)
        if not pose:
            fail(name, f'model "{model_name}" did not appear in the world')
        else:
            ok(f'model in the world at z = {pose[2]:.3f} m')
            check_sdf_holders(name, model, model_name, sim)
            with open(model) as f:
                text = f.read()
            if 'cmd_vel' in text:
                pub = sim.publisher('/cmd_vel', GzTwist)

                def send(x, y, z):
                    m = GzTwist()
                    m.linear.x, m.linear.y, m.angular.z = x, y, z
                    pub.publish(m)

                if not pub:
                    fail(name, 'nothing listens to /cmd_vel')
                else:
                    check_drive(name, sim, send, text, 'model')
    finally:
        errs = launched.errors()
        launched.stop()
        if errs:
            print(f'  Gazebo reported {len(errs)} error line(s):')
            for l in errs[:12]:
                print('       ' + l.strip()[:220])
            fail(name, f'{len(errs)} error line(s) in the gz log')


def main():
    ros_dir = sys.argv[1]
    sdf_dir = sys.argv[2] if len(sys.argv) > 2 else None
    env = dict(os.environ, GZ_SIM_RESOURCE_PATH=os.path.join(WS, 'install'))
    env.setdefault('ROS_DOMAIN_ID', '42')
    os.environ.setdefault('ROS_DOMAIN_ID', '42')
    global ROS
    ROS = Ros()

    packages = sorted(d for d in glob.glob(os.path.join(ros_dir, '*')) if os.path.isfile(os.path.join(d, 'package.xml')))
    if packages:
        shutil.rmtree(WS, ignore_errors=True)
        os.makedirs(os.path.join(WS, 'src'))
        for p in packages:
            shutil.copytree(p, os.path.join(WS, 'src', os.path.basename(p)))
        print(f'colcon build of {len(packages)} package(s)...', flush=True)
        r = run(['bash', '-c', f'cd {WS} && colcon build --symlink-install'], timeout=600)
        if r.returncode:
            print(r.stdout[-2000:], r.stderr[-2000:])
            fail('workspace', 'colcon build failed')
            packages = []
        else:
            print('  ok   colcon build')
        setup = os.path.join(WS, 'install', 'setup.bash')
        r = run(['bash', '-c', f'source {setup} && env'], timeout=30)
        env.update(l.split('=', 1) for l in r.stdout.splitlines() if '=' in l and not l.startswith('BASH_FUNC'))
        env['GZ_SIM_RESOURCE_PATH'] = os.path.join(WS, 'install')
        for p in packages:
            check_ros_package(p, env)

    if sdf_dir:
        for p in sorted(glob.glob(os.path.join(sdf_dir, '*'))):
            if os.path.isfile(os.path.join(p, 'model.sdf')):
                check_sdf_package(p, env)

    print()
    if failures:
        print(f'{len(failures)} failure(s):')
        for f in failures:
            print('  ' + f)
        sys.exit(1)
    print('All packages pass.')


if __name__ == '__main__':
    main()
