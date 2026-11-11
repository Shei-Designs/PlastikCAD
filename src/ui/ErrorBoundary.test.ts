// The boundary's message, rendered to a string: no browser needed.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Crashed, ErrorBoundary } from './ErrorBoundary';
import type { CrashFrame } from './ErrorBoundary';

const actions = { onReload: () => undefined, onSaveCopy: () => undefined };
const crashed = (frame: CrashFrame, message = 'x is not a function') => renderToStaticMarkup(createElement(Crashed, { frame, error: new Error(message), ...actions }));

describe('ErrorBoundary', () => {
  it('draws its children while nothing has failed', () => {
    const html = renderToStaticMarkup(createElement(ErrorBoundary, { frame: 'inspector', ...actions, children: createElement('p', null, 'All well') }));
    expect(html).toBe('<p>All well</p>');
  });

  it('turns a thrown error into the state its message is drawn from', () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error('boom')).error?.message).toBe('boom');
    // Anything can be thrown, not only an Error.
    expect(ErrorBoundary.getDerivedStateFromError('boom').error?.message).toBe('boom');
  });

  it('draws the message in place of the children once it has failed', () => {
    const boundary = new ErrorBoundary({ frame: 'viewport', ...actions, children: createElement('p', null, 'All well') });
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('boom'));
    const html = renderToStaticMarkup(boundary.render());
    expect(html).not.toContain('All well');
    expect(html).toContain('The 3D view stopped working.');
    expect(html).toContain('boom');
  });
});

describe('Crashed', () => {
  it('says what failed and offers Reload and Save a copy', () => {
    const html = crashed('viewport');
    expect(html).toContain('role="alert"');
    expect(html).toContain('The 3D view stopped working.');
    expect(html).toContain('x is not a function');
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
    expect(html).toMatch(/<button[^>]*>Save a copy…<\/button>/);
  });

  it('takes the place of the panel it stands in for, so the window keeps its layout', () => {
    expect(crashed('sidebar')).toMatch(/^<aside class="sidebar crashed">/);
    expect(crashed('inspector')).toMatch(/^<aside class="inspector crashed">/);
    expect(crashed('viewport')).toMatch(/^<div class="viewport crashed">/);
    expect(crashed('window')).toMatch(/^<div class="crashed whole">/);
  });
});
