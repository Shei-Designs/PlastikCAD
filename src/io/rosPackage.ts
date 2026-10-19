// The files around a URDF that make it a ROS 2 package: `colcon build` it,
// source the workspace, and the launch file shows the robot in RViz with
// sliders for its joints. Plain text, written once per export.
import { APP_NAME } from '../app';
import { escapeXml } from './format';

export function packageXml(name: string, description: string): string {
  return `<?xml version="1.0"?>
<?xml-model href="http://download.ros.org/schema/package_format3.xsd" schematypens="http://www.w3.org/2001/XMLSchema"?>
<package format="3">
  <name>${escapeXml(name)}</name>
  <version>0.1.0</version>
  <description>${escapeXml(description)}</description>
  <maintainer email="maintainer@example.com">${escapeXml(name)} maintainer</maintainer>
  <license>Apache-2.0</license>

  <buildtool_depend>ament_cmake</buildtool_depend>

  <exec_depend>robot_state_publisher</exec_depend>
  <exec_depend>joint_state_publisher_gui</exec_depend>
  <exec_depend>rviz2</exec_depend>
  <exec_depend>xacro</exec_depend>

  <export>
    <build_type>ament_cmake</build_type>
  </export>
</package>
`;
}

export function cmakeLists(name: string): string {
  return `cmake_minimum_required(VERSION 3.8)
project(${name})

find_package(ament_cmake REQUIRED)

install(DIRECTORY urdf meshes launch rviz
  DESTINATION share/\${PROJECT_NAME}
)

ament_package()
`;
}

/** RViz with the robot model, a joint state publisher with sliders, and the robot state publisher between them. */
export function displayLaunch(name: string): string {
  return `# Made with ${APP_NAME}. Shows the robot in RViz with a slider for every joint:
#   ros2 launch ${name} display.launch.py
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    share = get_package_share_directory('${name}')
    urdf = os.path.join(share, 'urdf', '${name}.urdf')
    rviz_config = os.path.join(share, 'rviz', 'display.rviz')
    with open(urdf, 'r') as f:
        robot_description = f.read()

    return LaunchDescription([
        DeclareLaunchArgument('gui', default_value='true', description='Show joint sliders'),
        Node(
            package='robot_state_publisher',
            executable='robot_state_publisher',
            parameters=[{'robot_description': robot_description}],
        ),
        Node(
            package='joint_state_publisher_gui',
            executable='joint_state_publisher_gui',
            condition=IfCondition(LaunchConfiguration('gui')),
        ),
        Node(
            package='rviz2',
            executable='rviz2',
            arguments=['-d', rviz_config],
        ),
    ])
`;
}

/** An RViz layout with the robot model and its frames, fixed on the base link. */
export function rvizConfig(baseLink: string): string {
  return `Panels:
  - Class: rviz_common/Displays
    Name: Displays
Visualization Manager:
  Class: ""
  Displays:
    - Class: rviz_default_plugins/Grid
      Name: Grid
      Enabled: true
      Cell Size: 0.1
      Plane Cell Count: 20
    - Class: rviz_default_plugins/RobotModel
      Name: RobotModel
      Enabled: true
      Description Source: Topic
      Description Topic:
        Value: /robot_description
      Visual Enabled: true
      Collision Enabled: false
    - Class: rviz_default_plugins/TF
      Name: TF
      Enabled: true
      Show Names: true
  Global Options:
    Fixed Frame: ${baseLink}
    Frame Rate: 30
  Tools:
    - Class: rviz_default_plugins/MoveCamera
    - Class: rviz_default_plugins/Select
  Views:
    Current:
      Class: rviz_default_plugins/Orbit
      Distance: 1.5
      Pitch: 0.5
      Yaw: 0.8
      Focal Point:
        X: 0
        Y: 0
        Z: 0.1
Window Geometry:
  Height: 800
  Width: 1200
`;
}

/** Gazebo through ros_gz: starts an empty world and spawns the robot from its description. */
export function gazeboLaunch(name: string): string {
  return `# Made with ${APP_NAME}. Spawns the robot in Gazebo (Harmonic or later, through ros_gz):
#   ros2 launch ${name} gazebo.launch.py
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription, SetEnvironmentVariable
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch_ros.actions import Node


def generate_launch_description():
    share = get_package_share_directory('${name}')
    urdf = os.path.join(share, 'urdf', '${name}.urdf')
    with open(urdf, 'r') as f:
        robot_description = f.read()

    gz_sim = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(os.path.join(get_package_share_directory('ros_gz_sim'), 'launch', 'gz_sim.launch.py')),
        launch_arguments={'gz_args': '-r empty.sdf'}.items(),
    )

    return LaunchDescription([
        # So that Gazebo can find package://${name}/meshes/...
        SetEnvironmentVariable('GZ_SIM_RESOURCE_PATH', os.path.dirname(share)),
        gz_sim,
        Node(
            package='robot_state_publisher',
            executable='robot_state_publisher',
            parameters=[{'robot_description': robot_description, 'use_sim_time': True}],
        ),
        Node(
            package='ros_gz_sim',
            executable='create',
            arguments=['-name', '${name}', '-topic', 'robot_description', '-z', '0.1'],
        ),
    ])
`;
}

export function readme(name: string, robot: string): string {
  return `# ${robot}

A ROS 2 package made with ${APP_NAME}. Copy this folder into the \`src\` of a
ROS 2 workspace, then:

    colcon build --packages-select ${name}
    source install/setup.bash
    ros2 launch ${name} display.launch.py      # RViz, with a slider for every joint
    ros2 launch ${name} gazebo.launch.py       # Gazebo (needs ros_gz)

The robot is \`urdf/${name}.urdf\`. Visual meshes are OBJ files with their
colors, collision meshes STL, all in meters with Z up, each in the frame of
its link. Masses and inertias come from the shapes and the materials chosen
in ${APP_NAME}; check any that were estimated rather than weighed.
`;
}
