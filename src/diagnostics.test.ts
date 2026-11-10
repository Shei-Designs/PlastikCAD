// The record of what went wrong, and the report made from it.
import { beforeEach, describe, expect, it } from 'vitest';
import { clearDiagnostics, diagnosticEntries, diagnosticsReport, noteDiagnostic, watchWindow } from './diagnostics';

beforeEach(() => clearDiagnostics());

describe('diagnostics', () => {
  it('notes what went wrong, counting what is said again straight away instead of repeating it', () => {
    noteDiagnostic('error', 'Could not save: disk full', 1000);
    noteDiagnostic('error', 'Could not save: disk full', 2000);
    noteDiagnostic('error', 'Could not save: disk full', 3000);
    noteDiagnostic('sync', 'Offline', 4000);
    noteDiagnostic('error', 'Could not save: disk full', 5000);
    expect(diagnosticEntries().map((e) => e.text)).toEqual(['Could not save: disk full (×3)', 'Offline', 'Could not save: disk full']);
    expect(diagnosticEntries()[0].at).toBe(3000);
  });

  it('keeps only the latest of a long run', () => {
    for (let i = 0; i < 250; i++) noteDiagnostic('error', `failure ${i}`);
    expect(diagnosticEntries().length).toBe(200);
    expect(diagnosticEntries()[0].text).toBe('failure 50');
  });

  it('makes a report that says what the app is, when, and what happened, in UTC', () => {
    const at = Date.UTC(2026, 10, 10, 12, 0, 0);
    noteDiagnostic('sync', 'Google Drive could not upload Plate: quota', at);
    const report = diagnosticsReport(['Projects: 12'], at + 60_000);
    expect(report).toMatch(/^PlastikCAD \d+\.\d+\.\d+\n/);
    expect(report).toContain('Report made 2026-11-10T12:01:00.000Z');
    expect(report).toContain('Projects: 12');
    expect(report).toContain('2026-11-10T12:00:00.000Z [sync] Google Drive could not upload Plate: quota');
    clearDiagnostics();
    expect(diagnosticsReport()).toContain('Nothing has gone wrong this session.');
  });

  it('notes an error nothing caught and a promise nobody handled', () => {
    const handlers = new Map<string, (event: never) => void>();
    watchWindow({ addEventListener: (type: string, handler: (event: never) => void) => void handlers.set(type, handler) } as never);
    handlers.get('error')!({ message: 'x is not a function', filename: 'http://tauri.localhost/assets/index-abc.js', lineno: 12 } as never);
    handlers.get('unhandledrejection')!({ reason: { message: 'needs-sign-in' } } as never);
    expect(diagnosticEntries().map((e) => `${e.kind}: ${e.text}`)).toEqual(['crash: x is not a function (index-abc.js:12)', 'crash: Unhandled: needs-sign-in']);
  });
});
