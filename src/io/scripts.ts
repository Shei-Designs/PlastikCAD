// The starter scripts written beside a MuJoCo export: something that moves
// the robot, a Gymnasium environment to train in, and a training run. Plain
// Python the user is meant to read and change.
import { APP_NAME } from '../appInfo';

export type ScriptKind = 'rover' | 'arm' | 'walker';

/** Drives the model: a rover from velocity commands through drive.json, an arm by sweeping its servos, a walker with a simple gait. */
export function drivePy(model: string, kind: ScriptKind): string {
  return `"""Moves the robot in MuJoCo. Made with ${APP_NAME}; change it freely.

    python drive.py                        # opens MuJoCo's viewer and drives
    python drive.py --video out.mp4        # renders a video instead
    python drive.py --headless --seconds 2 # just runs, and reports

A rover follows velocity commands (forward, turn) through drive.json; an arm
sweeps each servo; a walker stands, then wiggles its joints in turn, which is
where a gait of your own, or a trained one (see env.py), goes.
"""
import argparse
import json
import math
import os

import mujoco
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, ${JSON.stringify(model)})
KIND = ${JSON.stringify(kind)}  # rover, arm or walker


def load():
    model = mujoco.MjModel.from_xml_path(MODEL)
    data = mujoco.MjData(model)
    home = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, "home")
    if home >= 0:
        mujoco.mj_resetDataKeyframe(model, data, home)
    # Works out where everything is at the start, so that it can be read before the first step.
    mujoco.mj_forward(model, data)
    return model, data


def actuator_ids(model):
    return {mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_ACTUATOR, a): a for a in range(model.nu)}


def joint_range(model, a):
    """The range of the joint an actuator turns, radians each way about its middle; half a radian when it has none."""
    j = model.actuator_trnid[a, 0]
    if model.jnt_limited[j]:
        lo, hi = model.jnt_range[j]
        return (lo + hi) / 2, (hi - lo) / 2
    return 0.0, 0.5


class Rover:
    """Wheel speeds and steering from a forward speed (m/s) and a turn rate (rad/s), by the drive's kind."""

    def __init__(self, model):
        with open(os.path.join(HERE, "drive.json")) as f:
            self.drive = json.load(f)
        self.ids = actuator_ids(model)
        self.model = model

    def plan(self, t):
        # Forward for two seconds, a turn for two, forward again. Replace with your own commands.
        if t < 2:
            return 0.2, 0.0
        if t < 4:
            return 0.1, 1.0
        return 0.2, 0.0

    def apply(self, data, t):
        v, w = self.plan(t)
        d = self.drive
        r = d["wheelRadius"]
        sep = d["wheelSeparation"]
        roles = d["roles"]
        # A wheel that turns the wrong way has its axle the other way round: flip the joint's axis in ${APP_NAME}.
        if d["kind"] == "differential":
            for name in roles.get("left", []):
                data.ctrl[self.ids[name]] = (v - w * sep / 2) / r
            for name in roles.get("right", []):
                data.ctrl[self.ids[name]] = (v + w * sep / 2) / r
        elif d["kind"] == "ackermann":
            for side in ("left", "right"):
                for name in roles.get(side, []):
                    data.ctrl[self.ids[name]] = v / r
            steer = math.atan(d["wheelBase"] * w / v) if abs(v) > 1e-6 else 0.0
            steer = max(-d["steeringLimit"], min(d["steeringLimit"], steer))
            for name in roles.get("steer-left", []) + roles.get("steer-right", []):
                data.ctrl[self.ids[name]] = steer
        else:  # mecanum: forward, sideways (vy) and turn, lx and ly half the wheelbase and track
            vy = 0.0
            k = (d["wheelBase"] + sep) / 2
            for role, sign_y, sign_w in (("front-left", -1, -1), ("front-right", 1, 1), ("rear-left", 1, -1), ("rear-right", -1, 1)):
                for name in roles.get(role, []):
                    data.ctrl[self.ids[name]] = (v + sign_y * vy + sign_w * k * w) / r


class Arm:
    """Sweeps every servo through its range, each a little out of step with the last."""

    def __init__(self, model):
        self.targets = [(a, *joint_range(model, a)) for a in range(model.nu)]

    def apply(self, data, t):
        for i, (a, mid, half) in enumerate(self.targets):
            data.ctrl[a] = mid + 0.6 * half * math.sin(2 * math.pi * t / 4 + 0.7 * i)


class Walker:
    """Stands for a second, then wiggles the joints in alternating pairs. A real gait, or a trained policy, replaces this."""

    def __init__(self, model):
        self.targets = [(a, *joint_range(model, a)) for a in range(model.nu)]

    def apply(self, data, t):
        for i, (a, mid, half) in enumerate(self.targets):
            swing = 0.0 if t < 1 else 0.3 * half * math.sin(2 * math.pi * (t - 1) / 1.0 + math.pi * ((i // 2) % 2))
            data.ctrl[a] = mid + swing


def controller(model):
    return {"rover": Rover, "arm": Arm, "walker": Walker}[KIND](model)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--video", help="render to this MP4 instead of opening the viewer")
    parser.add_argument("--headless", action="store_true", help="run without a window or a video")
    parser.add_argument("--seconds", type=float, default=6.0)
    args = parser.parse_args()
    model, data = load()
    control = controller(model)
    base = 1
    start = data.subtree_com[base].copy()

    if args.video or args.headless:
        frames = []
        renderer = None
        if args.video:
            model.vis.global_.offwidth, model.vis.global_.offheight = 960, 540
            renderer = mujoco.Renderer(model, height=540, width=960)
            cam = mujoco.MjvCamera()
            cam.type = mujoco.mjtCamera.mjCAMERA_TRACKING
            cam.trackbodyid = base
            cam.distance = 0.6
            cam.azimuth, cam.elevation = 140, -22
        per_frame = max(1, int(round(1 / (30 * model.opt.timestep))))
        for i in range(int(args.seconds / model.opt.timestep)):
            control.apply(data, data.time)
            mujoco.mj_step(model, data)
            if renderer is not None and i % per_frame == 0:
                renderer.update_scene(data, cam)
                frames.append(renderer.render().copy())
        moved = data.subtree_com[base] - start
        print(f"after {args.seconds:.1f} s the robot's center of mass moved {np.round(moved, 3)} m")
        if args.video:
            import imageio.v2 as imageio

            imageio.mimwrite(args.video, frames, fps=30, codec="libx264", quality=8, macro_block_size=1)
            print("wrote", args.video)
        return

    import time

    import mujoco.viewer as mjviewer

    with mjviewer.launch_passive(model, data) as viewer:
        while viewer.is_running() and data.time < args.seconds:
            control.apply(data, data.time)
            mujoco.mj_step(model, data)
            viewer.sync()
            time.sleep(model.opt.timestep)


if __name__ == "__main__":
    main()
`;
}

/** A Gymnasium environment over the model, with the spaces wired and a reward to replace. */
export function envPy(model: string): string {
  return `"""A Gymnasium environment over the robot, for reinforcement learning. Made with ${APP_NAME}.

    pip install gymnasium mujoco
    python env.py   # a few random steps, to see the shapes

Observations: every joint's position and velocity, and for a free base its
orientation, turn rate and velocity (the model's sensors, in order), then the
touch sensors and each lidar's rays (a distance, or -1 where nothing is hit).
Actions: one per actuator in -1..1, scaled to a velocity motor's
range or a servo's joint range. The reward is a stub to replace: speed along
the robot's own forward (the way its wheels face, from drive.json; +Y of the
base when it has none) less a little for effort.
"""
import json
import os

import gymnasium as gym
import mujoco
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, ${JSON.stringify(model)})
DRIVE = os.path.join(HERE, "drive.json")


class RobotEnv(gym.Env):
    metadata = {"render_modes": ["rgb_array"], "render_fps": 50}

    def __init__(self, frame_skip=5, render_mode=None, max_steps=1000):
        self.model = mujoco.MjModel.from_xml_path(MODEL)
        self.data = mujoco.MjData(self.model)
        self.frame_skip = frame_skip
        self.render_mode = render_mode
        self.max_steps = max_steps
        self.home = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_KEY, "home")
        self.base = 1
        # The way the robot faces in its base frame: from drive.json when it has wheels, +Y otherwise.
        self.forward = np.array([0.0, 1.0, 0.0])
        if os.path.exists(DRIVE):
            with open(DRIVE) as f:
                self.forward = np.array(json.load(f).get("forward", self.forward), dtype=float)
        self.free = any(self.model.jnt_type[j] == mujoco.mjtJoint.mjJNT_FREE for j in range(self.model.njnt))
        self.action_space = gym.spaces.Box(-1.0, 1.0, (self.model.nu,), np.float32)
        self.observation_space = gym.spaces.Box(-np.inf, np.inf, (self.model.nsensordata,), np.float64)
        self._renderer = None
        self._steps = 0
        self.reset()
        self._home_height = float(self.data.subtree_com[self.base][2])

    def _obs(self):
        return self.data.sensordata.copy()

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        if self.home >= 0:
            mujoco.mj_resetDataKeyframe(self.model, self.data, self.home)
        else:
            mujoco.mj_resetData(self.model, self.data)
        self.data.qvel[:] = self.np_random.normal(0, 0.01, self.model.nv)
        mujoco.mj_forward(self.model, self.data)
        self._steps = 0
        return self._obs(), {}

    def _ctrl(self, action):
        m = self.model
        ctrl = np.zeros(m.nu)
        for a in range(m.nu):
            x = float(np.clip(action[a], -1, 1))
            if m.actuator_biasprm[a, 1] != 0:  # a position servo: aim within the joint's range
                j = m.actuator_trnid[a, 0]
                lo, hi = (m.jnt_range[j] if m.jnt_limited[j] else (-0.5, 0.5))
                ctrl[a] = (lo + hi) / 2 + x * (hi - lo) / 2
            else:  # a velocity motor: a share of its speed limit
                top = m.actuator_ctrlrange[a, 1] if m.actuator_ctrllimited[a] else 1.0
                ctrl[a] = x * top
        return ctrl

    def step(self, action):
        self.data.ctrl[:] = self._ctrl(action)
        for _ in range(self.frame_skip):
            mujoco.mj_step(self.model, self.data)
        self._steps += 1
        # Reward: how fast the base moves the way it faces, less a little for effort. Replace with what you want the robot to do.
        forward = 0.0
        if self.free:
            heading = self.data.xmat[self.base].reshape(3, 3) @ self.forward
            forward = float(np.dot(self.data.cvel[self.base][3:], heading))
        reward = forward - 0.001 * float(np.sum(np.square(action)))
        fell = self.free and float(self.data.subtree_com[self.base][2]) < 0.5 * self._home_height
        terminated = bool(fell)
        truncated = self._steps >= self.max_steps
        return self._obs(), reward, terminated, truncated, {}

    def render(self):
        if self._renderer is None:
            self.model.vis.global_.offwidth, self.model.vis.global_.offheight = 640, 480
            self._renderer = mujoco.Renderer(self.model, height=480, width=640)
        self._renderer.update_scene(self.data)
        return self._renderer.render()


if __name__ == "__main__":
    env = RobotEnv()
    obs, _ = env.reset()
    total = 0.0
    for _ in range(100):
        obs, reward, terminated, truncated, _ = env.step(env.action_space.sample())
        total += reward
        if terminated or truncated:
            break
    print(f"observation {obs.shape}, actions {env.action_space.shape}, reward over 100 random steps {total:.3f}")
`;
}

/** Trains a PPO policy on the environment with Stable-Baselines3. */
export function trainPy(): string {
  return `"""Trains a policy on env.py with Stable-Baselines3 PPO. Made with ${APP_NAME}.

    pip install gymnasium stable-baselines3 mujoco
    python train.py [steps]     # trains (100000 steps by default) and saves policy.zip
    python train.py --watch     # runs the saved policy and renders watch.mp4

The reward in env.py is a stub; write the one for your robot before training for long.
"""
import sys

from env import RobotEnv


def train(steps):
    from stable_baselines3 import PPO

    env = RobotEnv()
    model = PPO("MlpPolicy", env, verbose=1)
    model.learn(total_timesteps=steps)
    model.save("policy")
    print("saved policy.zip")


def watch():
    import imageio.v2 as imageio
    from stable_baselines3 import PPO

    env = RobotEnv(render_mode="rgb_array")
    policy = PPO.load("policy")
    obs, _ = env.reset()
    frames = []
    for _ in range(600):
        action, _ = policy.predict(obs, deterministic=True)
        obs, _, terminated, truncated, _ = env.step(action)
        frames.append(env.render())
        if terminated or truncated:
            break
    imageio.mimwrite("watch.mp4", frames, fps=50, codec="libx264", quality=8, macro_block_size=1)
    print("wrote watch.mp4")


if __name__ == "__main__":
    if "--watch" in sys.argv:
        watch()
    else:
        train(int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 100_000)
`;
}
