// The files around a URDF that make it a ROS 2 package: `colcon build` it,
// source the workspace, and the launch file shows the robot in RViz with
// sliders for its joints. Plain text, written once per export.
import { APP_NAME } from '../appInfo';
import { fmt } from './format';
import { escapeXml } from './format';

export interface PackageNeeds {
  /** The package carries a Gazebo launch with the bridge, so it depends on ros_gz. */
  gazebo: boolean;
  /** ros2_control is in the URDF. */
  control: boolean;
}

export function packageXml(name: string, description: string, needs: PackageNeeds = { gazebo: true, control: false }): string {
  const extra = [
    ...(needs.gazebo ? ['ros_gz_sim', 'ros_gz_bridge'] : []),
    ...(needs.control ? ['gz_ros2_control', 'controller_manager', 'joint_state_broadcaster', 'joint_trajectory_controller'] : []),
  ];
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
${extra.map((d) => `  <exec_depend>${d}</exec_depend>`).join('\n')}

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

install(DIRECTORY urdf meshes launch rviz config worlds
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
        robot_description = f.read().replace('${SHARE_PLACEHOLDER}', share)

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

/**
 * An RViz layout with the robot model and its frames, fixed on the base link,
 * the view and the frame markers sized to the robot (`center` and `extent` in
 * meters, in the base link's frame): a palm-sized robot is not lost under
 * meter-long axes two meters away.
 */
export function rvizConfig(baseLink: string, center: [number, number, number] = [0, 0, 0.1], extent = 0.5): string {
  const size = Math.max(extent, 0.05);
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
      Marker Scale: ${fmt(size / 2, 3)}
  Global Options:
    Fixed Frame: ${baseLink}
    Frame Rate: 30
  Tools:
    - Class: rviz_default_plugins/MoveCamera
    - Class: rviz_default_plugins/Select
  Views:
    Current:
      Class: rviz_default_plugins/Orbit
      Distance: ${fmt(size * 3, 3)}
      Pitch: 0.5
      Yaw: 0.8
      Focal Point:
        X: ${fmt(center[0], 4)}
        Y: ${fmt(center[1], 4)}
        Z: ${fmt(center[2], 4)}
Window Geometry:
  Height: 800
  Width: 1200
`;
}

/** Where the URDF says "the package's share folder": the launch files fill it in, so no xacro is needed. */
export const SHARE_PLACEHOLDER = '__PACKAGE_SHARE__';

export interface GazeboLaunchNeeds {
  /** Controllers to spawn after the robot, in order (ros2_control). */
  controllers: string[];
  /** How far above the floor the robot's root frame is (m): it is spawned that high, and a little more to settle from. */
  height?: number;
}

/** Gazebo through ros_gz: the package's world, the robot spawned into it, the bridge, and any controllers. */
export function gazeboLaunch(name: string, needs: GazeboLaunchNeeds = { controllers: [] }): string {
  const spawners = needs.controllers
    .map(
      (c) => `
        Node(
            package='controller_manager',
            executable='spawner',
            arguments=['${c}', '--controller-manager', '/controller_manager'],
        ),`,
    )
    .join('');
  return `# Made with ${APP_NAME}. Spawns the robot in Gazebo (Harmonic or later, through ros_gz) with the bridge to ROS 2:
#   ros2 launch ${name} gazebo.launch.py
# On a machine without a display, headless:=true runs the server alone, sensors included:
#   ros2 launch ${name} gazebo.launch.py headless:=true
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import AppendEnvironmentVariable, DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PythonExpression
from launch_ros.actions import Node


def generate_launch_description():
    share = get_package_share_directory('${name}')
    urdf = os.path.join(share, 'urdf', '${name}.urdf')
    world = os.path.join(share, 'worlds', '${name}.sdf')
    bridge_config = os.path.join(share, 'config', 'bridge.yaml')
    with open(urdf, 'r') as f:
        robot_description = f.read().replace('${SHARE_PLACEHOLDER}', share)

    headless = LaunchConfiguration('headless')
    gz_sim = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(os.path.join(get_package_share_directory('ros_gz_sim'), 'launch', 'gz_sim.launch.py')),
        launch_arguments={'gz_args': [PythonExpression(["'-r -s --headless-rendering' if '", headless, "' == 'true' else '-r'"]), f' {world}']}.items(),
    )

    return LaunchDescription([
        DeclareLaunchArgument('headless', default_value='false', description='Run the Gazebo server without the window'),
        # So that Gazebo can find package://${name}/meshes/..., beside whatever is on its path already
        AppendEnvironmentVariable('GZ_SIM_RESOURCE_PATH', os.path.dirname(share)),
        gz_sim,
        Node(
            package='robot_state_publisher',
            executable='robot_state_publisher',
            parameters=[{'robot_description': robot_description, 'use_sim_time': True}],
        ),
        Node(
            package='ros_gz_sim',
            executable='create',
            arguments=['-name', '${name}', '-topic', 'robot_description', '-z', '${fmt((needs.height ?? 0) + 0.05, 6)}'],
        ),
        Node(
            package='ros_gz_bridge',
            executable='parameter_bridge',
            parameters=[{'config_file': bridge_config, 'use_sim_time': True}],
        ),${spawners}
    ])
`;
}

export interface BridgeTopic {
  ros: string;
  gz: string;
  rosType: string;
  gzType: string;
  direction: 'GZ_TO_ROS' | 'ROS_TO_GZ' | 'BIDIRECTIONAL';
}

/** The ros_gz_bridge configuration: which Gazebo topics become which ROS topics. */
export function bridgeYaml(topics: BridgeTopic[]): string {
  return topics
    .map((t) => `- ros_topic_name: ${t.ros}\n  gz_topic_name: ${t.gz}\n  ros_type_name: ${t.rosType}\n  gz_type_name: ${t.gzType}\n  direction: ${t.direction}\n`)
    .join('');
}

/** ros2_control: a joint state broadcaster and one trajectory controller over the given joints. */
export function controllersYaml(joints: string[]): string {
  return `controller_manager:
  ros__parameters:
    update_rate: 100
    use_sim_time: true
    joint_state_broadcaster:
      type: joint_state_broadcaster/JointStateBroadcaster
    arm_controller:
      type: joint_trajectory_controller/JointTrajectoryController

arm_controller:
  ros__parameters:
    joints:
${joints.map((j) => `      - ${j}`).join('\n')}
    command_interfaces:
      - position
    state_interfaces:
      - position
      - velocity
    state_publish_rate: 50.0
    action_monitor_rate: 20.0
    allow_partial_joints_goal: false
`;
}

export function readme(name: string, robot: string, footprint?: { name: string; base: string }): string {
  return `# ${robot}

A ROS 2 package made with ${APP_NAME}. Copy this folder into the \`src\` of a
ROS 2 workspace, then:

    colcon build --packages-select ${name}
    source install/setup.bash
    ros2 launch ${name} display.launch.py      # RViz, with a slider for every joint
    ros2 launch ${name} gazebo.launch.py       # Gazebo (needs ros_gz); add headless:=true on a machine without a display

The robot is \`urdf/${name}.urdf\`. Visual meshes are OBJ files with their
colors, collision meshes STL, all in meters with Z up, each in the frame of
its link. Masses and inertias come from the shapes and the materials chosen
in ${APP_NAME}; check any that were estimated rather than weighed.
${footprint ? `\nThe root link is \`${footprint.name}\`, facing the robot's forward along +X as ROS\nexpects; \`${footprint.base}\` under it is the design's own frame, and the drive's\nodometry is published against \`${footprint.name}\`.\n` : ''}
Gazebo reads the sensors, the drive and the friction from the \`<gazebo>\`
blocks in the URDF. \`worlds/${name}.sdf\` is a flat floor with the sensor
systems switched on, a stand-in until the robot is spawned into a world of
your own; \`config/bridge.yaml\` tells ros_gz_bridge which
topics to carry across (sensors, clock, joint states, cmd_vel and odom for a
drive), and \`config/controllers.yaml\` sets up ros2_control when the robot
has joints under it: \`/arm_controller\` takes joint trajectories. The URDF
says \`${SHARE_PLACEHOLDER}\` where it means the package's share folder; the
launch files fill that in, so no xacro is needed.

For Isaac Sim, export the robot from ${APP_NAME} as an Isaac Sim stage: it
opens and runs as it is, with the drives, the sensors and a ROS 2 graph
written in. The URDF can still be imported there (File > Import), with
\`${name}\` and this folder on the importer's ROS package list so the
\`package://\` mesh paths resolve.
`;
}
