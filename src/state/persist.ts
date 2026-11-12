// Preferences, kept in localStorage. Projects themselves live in the projects
// store (see projects.ts), not here.
import { FILE_FORMAT } from '../appInfo';
import { FORMATS } from '../io/export';
import type { FormatId } from '../io/export';
import { newId } from '../model/ops';
import { nearestSnap, snapSteps } from '../units';
import type { Unit } from '../units';

export type Theme = 'dark' | 'light';

export interface Prefs {
  theme: Theme;
  edges: boolean;
  grid: boolean;
  /** The unit lengths are shown and typed in; the design is in millimeters either way. */
  units: Unit;
  /** Grid step that moves and sizes snap to, in mm, one of the steps of `units`; 0 turns snapping off. */
  snap: number;
  format: FormatId;
  /** What the robot is exported as: a ROS 2 package with a URDF, a Gazebo model with an SDF, or a MuJoCo model. */
  robotFormat: 'urdf' | 'sdf' | 'mjcf' | 'usd';
  /** The unit a link's inertia is shown and typed in; the design keeps g·mm² either way. */
  inertiaUnit: 'gcm2' | 'kgm2';
  /** Robot mode: every joint and sensor is drawn on the plate, not only the picked one. */
  robotMarkers: boolean;
  /** Which tab the left panel shows: the library of shapes and parts, or the design's objects. */
  sidebar: 'library' | 'objects' | 'structure';
  /** Whether each side panel is on show; hidden, its room goes to the plate. */
  leftPanel: boolean;
  rightPanel: boolean;
  /** The folder projects are kept in, when the user picked one (desktop app); null for the default. */
  projectsDir: string | null;
  /** Key of the project that was open last, to open it again at start-up. */
  lastProject: string | null;
  /** This installation, stamped into saves so that sync can tell devices apart. */
  device: string;
  /** Whether the desktop app asks the releases for a newer version when it starts; the About box asks whenever told to. */
  updateCheck: boolean;
}

/** Below this width the side panels lie over the plate instead of beside it (see `.app` in styles.css). */
export const NARROW_WIDTH = 900;
export const narrowWindow = (): boolean => typeof window !== 'undefined' && window.innerWidth <= NARROW_WIDTH;

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
  const units: Unit = saved.units === 'in' ? 'in' : 'mm';
  const prefs: Prefs = {
    theme: saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : prefersLight ? 'light' : 'dark',
    edges: saved.edges ?? true,
    grid: saved.grid ?? true,
    units,
    snap: snapSteps(units).includes(saved.snap as number) ? (saved.snap as number) : nearestSnap(1, units),
    // Any format the app exports: a list of its own here once forgot the newest of them.
    format: FORMATS.find((f) => f.id === saved.format)?.id ?? 'stl',
    robotFormat: saved.robotFormat === 'sdf' || saved.robotFormat === 'mjcf' || saved.robotFormat === 'usd' ? saved.robotFormat : 'urdf',
    inertiaUnit: saved.inertiaUnit === 'kgm2' ? 'kgm2' : 'gcm2',
    robotMarkers: saved.robotMarkers ?? true,
    sidebar: saved.sidebar === 'objects' || saved.sidebar === 'structure' ? saved.sidebar : 'library',
    // On a window too narrow for the panels and the plate side by side, they start out of the way.
    leftPanel: typeof saved.leftPanel === 'boolean' ? saved.leftPanel : !narrowWindow(),
    rightPanel: typeof saved.rightPanel === 'boolean' ? saved.rightPanel : !narrowWindow(),
    projectsDir: typeof saved.projectsDir === 'string' && saved.projectsDir ? saved.projectsDir : null,
    lastProject: typeof saved.lastProject === 'string' && saved.lastProject ? saved.lastProject : null,
    device,
    updateCheck: saved.updateCheck !== false,
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
