// Preferences, kept in localStorage. Projects themselves live in the projects
// store (see projects.ts), not here.
import { FILE_FORMAT } from '../app';
import type { FormatId } from '../io/export';

export type Theme = 'dark' | 'light';

export interface Prefs {
  theme: Theme;
  edges: boolean;
  grid: boolean;
  /** Grid step that moves and sizes snap to, in mm; 0 turns snapping off. */
  snap: number;
  format: FormatId;
  /** Which tab the left panel shows: the library of shapes and parts, or the design's objects. */
  sidebar: 'library' | 'objects';
  /** The folder projects are kept in, when the user picked one (desktop app); null for the default. */
  projectsDir: string | null;
  /** Key of the project that was open last, to open it again at start-up. */
  lastProject: string | null;
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
  return {
    theme: saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : prefersLight ? 'light' : 'dark',
    edges: saved.edges ?? true,
    grid: saved.grid ?? true,
    snap: SNAP_STEPS.includes(saved.snap as number) ? (saved.snap as number) : 1,
    format: (['stl', '3mf', 'obj', 'glb', 'svg', 'dxf'] as const).find((f) => f === saved.format) ?? 'stl',
    sidebar: saved.sidebar === 'objects' ? 'objects' : 'library',
    projectsDir: typeof saved.projectsDir === 'string' && saved.projectsDir ? saved.projectsDir : null,
    lastProject: typeof saved.lastProject === 'string' && saved.lastProject ? saved.lastProject : null,
  };
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked; preferences just won't persist.
  }
}
