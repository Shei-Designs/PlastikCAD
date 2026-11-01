# ROS 2 Jazzy with Gazebo Harmonic, ros_gz and ros2_control, for tools/ros_smoke.sh.
# Mesa gives the Gazebo server software rendering, so the sensors work without a GPU or a display.
FROM ros:jazzy-ros-base
RUN apt-get update && apt-get install -y --no-install-recommends \
    ros-jazzy-ros-gz \
    ros-jazzy-gz-ros2-control \
    ros-jazzy-ros2-control \
    ros-jazzy-ros2-controllers \
    ros-jazzy-robot-state-publisher \
    ros-jazzy-joint-state-publisher \
    ros-jazzy-xacro \
    ros-jazzy-rviz2 \
    libgl1-mesa-dri libegl-mesa0 libegl1 libgles2 mesa-utils \
    python3-colcon-common-extensions \
  && rm -rf /var/lib/apt/lists/*
# A virtual display, the joint sliders and a screenshot tool, so RViz can be run and pictured without a monitor.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ros-jazzy-joint-state-publisher-gui \
    xvfb x11-apps imagemagick python3-pil \
  && rm -rf /var/lib/apt/lists/*
