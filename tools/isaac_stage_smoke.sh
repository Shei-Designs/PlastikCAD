#!/usr/bin/env bash
# Runs every exported Isaac Sim stage under a folder (see isaac_stage_smoke.py)
# with Isaac's own Python, and with its bundled ROS 2 Jazzy libraries when no
# ROS 2 environment is sourced: the dynamic loader reads LD_LIBRARY_PATH only
# at start, so it has to be set out here.
set -euo pipefail
PY="${ISAACSIM_PYTHON:-$HOME/isaacsim-env/bin/python}"
if [ -z "${ROS_DISTRO:-}" ]; then
  CORE="$("$PY" -c 'import importlib.util, os; print(os.path.dirname(importlib.util.find_spec("isaacsim").origin))')/exts/isaacsim.ros2.core"
  export ROS_DISTRO=jazzy RMW_IMPLEMENTATION=rmw_fastrtps_cpp LD_LIBRARY_PATH="$CORE/jazzy/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
export OMNI_KIT_ACCEPT_EULA=YES
exec "$PY" "$(dirname "$0")/isaac_stage_smoke.py" "$@"
