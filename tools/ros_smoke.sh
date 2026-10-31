#!/usr/bin/env bash
# Runs the exported ROS and SDF packages of the reference robots through a real
# ROS 2 Jazzy + Gazebo Harmonic, in Docker. Needs the packages written first:
#   ROBOT_FIXTURES_OUT=fixtures/out pnpm exec vitest run src/robot/robots.test.ts
#   tools/ros_smoke.sh [fixtures/out]
# The first run builds the image (a few GB of downloads); later runs reuse it.
# The cameras' pictures land in <out>/pictures.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(cd "${1:-fixtures/out}" && pwd)
image=plastikcad-ros:jazzy
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "Building $image..."
  docker build -t "$image" "$here/ros"
fi
mkdir -p "$out/pictures"
exec docker run --rm -e ROS_DOMAIN_ID=42 -e SMOKE_PICTURES=/pictures -v "$out:/out:ro" -v "$out/pictures:/pictures" -v "$here:/tools:ro" "$image" \
  bash -c "source /opt/ros/jazzy/setup.bash && python3 /tools/ros_smoke.py /out/ros /out/sdf"
