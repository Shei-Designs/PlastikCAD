// Preferences, kept in localStorage. Projects themselves live in the projects
// store (see projects.ts), not here.
import { FILE_FORMAT } from '../app';
import type { FormatId } from '../io/export';
import { newId } from '../model/ops';

export type Theme = 'dark' | 'light';

export interface Prefs {
  theme: Theme;
  edges: boolean;
  grid: boolean;
  /** Grid step that moves and sizes snap to, in mm; 0 turns snapping off. */
  snap: number;
  format: FormatId;
  /** What the robot is exported as: a ROS 2 package with a URDF, a Gazebo model with an SDF, or a MuJoCo model. */
  robotFormat: 'urdf' | 'sdf' | 'mjcf';
  /** Robot mode: every joint and sensor is drawn on the plate, not only the picked one. */
  robotMarkers: boolean;
  /** Which tab the left panel shows: the library of shapes and parts, or the design's objects. */
  sidebar: 'library' | 'objects' | 'structure';
  /** The folder projects are kept in, when the user picked one (desktop app); null for the default. */
  projectsDir: string | null;
  /** Key of the project that was open last, to open it again at start-up. */
  lastProject: string | null;
  /** This installation, stamped into saves so that sync can tell devices apart. */
  device: string;
}

export const SNAP_STEPS = [0, 0.1, 0.25, 0.5, 1, 2, 5, 10];

const PREFS_KEY = `${FILE_FORMAT}:prefs:v1`;

export function loadPrefs(): Prefs {
  let saved: Partial<Prefs> = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {};
  } catch {
    // Corrupt or unavailable storage: start from defaults.
  }
  const prefersLight = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  const device = typeof saved.device === 'string' && /^[a-z0-9]{8,32}$/.test(saved.device) ? saved.device : newId();
  const prefs: Prefs = {
    theme: saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : prefersLight ? 'light' : 'dark',
    edges: saved.edges ?? true,
    grid: saved.grid ?? true,
    snap: SNAP_STEPS.includes(saved.snap as number) ? (saved.snap as number) : 1,
    format: (['stl', '3mf', 'obj', 'glb', 'svg', 'dxf'] as const).find((f) => f === saved.format) ?? 'stl',
    robotFormat: saved.robotFormat === 'sdf' || saved.robotFormat === 'mjcf' ? saved.robotFormat : 'urdf',
    robotMarkers: saved.robotMarkers ?? true,
    sidebar: saved.sidebar === 'objects' || saved.sidebar === 'structure' ? saved.sidebar : 'library',
    projectsDir: typeof saved.projectsDir === 'string' && saved.projectsDir ? saved.projectsDir : null,
    lastProject: typeof saved.lastProject === 'string' && saved.lastProject ? saved.lastProject : null,
    device,
  };
  // A device id just made is kept at once, so that it never changes.
  if (device !== saved.device) savePrefs(prefs);
  return prefs;
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked; preferences just won't persist.
  }
}
