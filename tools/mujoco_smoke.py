"""Simulates every exported MuJoCo model under a folder and says whether it behaves.

    ROBOT_FIXTURES_OUT=fixtures/out pnpm exec vitest run src/robot/robots.test.ts
    python3 tools/mujoco_smoke.py fixtures/out

Needs the `mujoco` package (pip install mujoco, or a venv). Each model is
settled for a second, then driven: velocity motors run at their limit and the
base must travel; position servos are sent 0.3 rad and must follow; a free
base must not collapse; and MuJoCo must raise no warnings. Exit code 1 on any
failure, 2 when mujoco is missing.
"""
import glob
import os
import sys

try:
    import mujoco
except ImportError:
    print("mujoco is not installed: pip install mujoco (a venv is fine) and run this with that Python.")
    sys.exit(2)
import numpy as np

root = sys.argv[1] if len(sys.argv) > 1 else "fixtures/out"
xmls = sorted(glob.glob(os.path.join(root, "**", "*.xml"), recursive=True))
if not xmls:
    print(f"no models under {root}")
    sys.exit(1)
failures = 0
for xml in xmls:
    name = os.path.relpath(xml, root)
    try:
        m = mujoco.MjModel.from_xml_path(xml)
    except Exception as e:  # noqa: BLE001
        print(f"FAIL {name}: {e}")
        failures += 1
        continue
    d = mujoco.MjData(m)
    base = 1
    free = any(m.jnt_type[j] == 0 and m.jnt_bodyid[j] == base for j in range(m.njnt))
    steps = lambda seconds: range(int(seconds / m.opt.timestep))  # noqa: E731
    for _ in steps(1.0):
        mujoco.mj_step(m, d)
    # The base frame may sit on the floor: the robot's center of mass says how high it stands.
    start = d.subtree_com[base].copy()
    q0 = d.qpos.copy()
    servos = [a for a in range(m.nu) if m.actuator_biasprm[a, 1] != 0]
    motors = [a for a in range(m.nu) if a not in servos]
    notes = []
    ok = True
    if motors:
        for a in motors:
            d.ctrl[a] = m.actuator_ctrlrange[a, 1] if m.actuator_ctrllimited[a] else 1.0
        for _ in steps(2.0):
            mujoco.mj_step(m, d)
        moved = float(np.linalg.norm((d.subtree_com[base] - start)[:2]))
        notes.append(f"drove {moved * 1000:.0f} mm in 2 s")
        ok &= moved >= 0.01
    elif servos:
        # A walker on its servos must first stand still at its home pose, then follow a small step; an arm follows a larger one.
        if free:
            for _ in steps(1.0):
                mujoco.mj_step(m, d)
            standing = float(d.subtree_com[base][2])
            notes.append(f"stood at {standing * 1000:.1f} mm of {start[2] * 1000:.1f}")
            ok &= standing >= 0.9 * start[2]
        asked = 0.1 if free else 0.3
        for a in servos:
            d.ctrl[a] = asked
        for _ in steps(1.0):
            mujoco.mj_step(m, d)
        adr = [m.jnt_qposadr[m.actuator_trnid[a, 0]] for a in servos]
        swung = max(abs(float(d.qpos[i] - q0[i])) for i in adr)
        notes.append(f"servos swung up to {np.degrees(swung):.1f} deg of {np.degrees(asked):.1f} asked")
        ok &= swung >= asked / 3
    if free:
        height = float(d.subtree_com[base][2])
        notes.append(f"base at {height * 1000:.1f} mm, was {start[2] * 1000:.1f}")
        ok &= height >= 0.7 * start[2]
    warned = [mujoco.mjtWarning(i).name for i, w in enumerate(d.warning) if w.number]
    if warned:
        ok = False
        notes.append("warnings " + ", ".join(warned))
    print("PASS" if ok else "FAIL", name, "·", "; ".join(notes))
    failures += 0 if ok else 1
sys.exit(1 if failures else 0)
