// A short record of what went wrong lately, for a report the user can copy
// out of the About box. It is kept in memory for the session and goes
// nowhere by itself: the app has no telemetry.
import { APP_NAME, APP_VERSION } from './appInfo';
import { asError } from './errors';

export interface DiagnosticEntry {
  /** When, in ms since the epoch. */
  at: number;
  kind: 'error' | 'sync' | 'crash';
  text: string;
}

const KEEP = 200;
const entries: DiagnosticEntry[] = [];

/** Notes something for the report. The same thing said again straight away is counted, not repeated. */
export function noteDiagnostic(kind: DiagnosticEntry['kind'], text: string, now = Date.now()): void {
  const last = entries[entries.length - 1];
  if (last && last.kind === kind && last.text.replace(/ \(×\d+\)$/, '') === text) {
    const count = Number(/ \(×(\d+)\)$/.exec(last.text)?.[1] ?? 1) + 1;
    last.text = `${text} (×${count})`;
    last.at = now;
    return;
  }
  entries.push({ at: now, kind, text });
  if (entries.length > KEEP) entries.shift();
}

export const diagnosticEntries = (): readonly DiagnosticEntry[] => entries;
export const clearDiagnostics = (): void => void entries.splice(0);

/** Where the app is running, as far as the page can tell. */
function surroundings(): string[] {
  if (typeof navigator === 'undefined') return [];
  const lines = [`Browser: ${navigator.userAgent}`, `Language: ${navigator.language}`];
  try {
    lines.push(`Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  } catch {
    // Not every engine says.
  }
  if (typeof window !== 'undefined') lines.push(`Window: ${window.innerWidth} × ${window.innerHeight} at ${window.devicePixelRatio}x`, `Pointer: ${window.matchMedia?.('(pointer: coarse)').matches ? 'touch' : 'mouse'}`);
  return lines;
}

/** The report as text: the app, where it runs, anything `extra` adds, and what was noted, oldest first, in UTC. */
export function diagnosticsReport(extra: string[] = [], now = Date.now()): string {
  const head = [`${APP_NAME} ${APP_VERSION}`, `Report made ${new Date(now).toISOString()}`, ...surroundings(), ...extra];
  const body = entries.length ? entries.map((e) => `${new Date(e.at).toISOString()} [${e.kind}] ${e.text}`) : ['Nothing has gone wrong this session.'];
  return withoutNames([...head, '', ...body].join('\n'));
}

/**
 * The report without the name of whoever is signed in to the computer, which every path below a home folder
 * carries (`/home/ann/…`, `C:\Users\ann\…`): the report is pasted where others read it.
 */
export const withoutNames = (text: string): string => text.replace(/(\/home\/|\/Users\/|[A-Za-z]:\\Users\\)(?:[^/\\\n"']+(?=[/\\])|[^/\\\s"']+)/g, '$1…');

/** Notes what the page itself reports as going wrong: an error nothing caught, a promise nobody handled. */
export function watchWindow(target: Pick<Window, 'addEventListener'> = window): void {
  target.addEventListener('error', (event) => noteDiagnostic('crash', `${event.message}${event.filename ? ` (${event.filename.split('/').pop()}:${event.lineno})` : ''}`));
  target.addEventListener('unhandledrejection', (event) => noteDiagnostic('crash', `Unhandled: ${asError(event.reason).message}`));
}
