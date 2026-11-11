// Drives the bundled desktop binary through WebKitWebDriver. The app is the real one (native side, content
// policy, bundled files); its web bundle is built with the tests' hook (window.__plastikcadModules, see
// src/e2eHook.ts), and the native pickers and questions, which no driver can press, are answered in the page: a
// save or open dialog gives the path queued for it, a question the answer queued for it (yes when none is).
import { sleep } from './steps.mjs';

const HOOK = `
(function () {
  if (window.__t) return 'already';
  const t = (window.__t = { calls: [], errors: [], violations: [], saves: [], opens: [], answers: [], asked: [] });
  // The bridge itself cannot be replaced (Tauri defines it read-only); what it sends goes through fetch, which can.
  const realFetch = window.fetch;
  const answer = (v) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'Tauri-Response': 'ok', 'content-type': 'application/json' } }));
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    if (!url.startsWith('ipc://')) return realFetch.apply(this, arguments);
    const cmd = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    if (cmd === 'plugin:dialog|save') { const p = t.saves.length ? t.saves.shift() : null; t.calls.push('save -> ' + p); return answer(p); }
    if (cmd === 'plugin:dialog|open') { const p = t.opens.length ? t.opens.shift() : null; t.calls.push('open -> ' + JSON.stringify(p)); return answer(p); }
    if (cmd === 'plugin:dialog|message') {
      let args = {};
      try { args = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)); } catch (e) { t.calls.push('ERR reading a question: ' + e); }
      const b = args.buttons;
      const yes = t.answers.length ? t.answers.shift() : true;
      let label = 'Ok';
      if (b === 'YesNo') label = yes ? 'Yes' : 'No';
      else if (b === 'OkCancel') label = yes ? 'Ok' : 'Cancel';
      else if (b && b.OkCancelCustom) label = yes ? b.OkCancelCustom[0] : b.OkCancelCustom[1];
      else if (b && b.OkCustom) label = b.OkCustom;
      else if (b && b.YesNoCancelCustom) label = yes ? b.YesNoCancelCustom[0] : b.YesNoCancelCustom[1];
      t.asked.push({ message: args.message, answered: label });
      return answer(label);
    }
    t.calls.push(cmd);
    return realFetch.call(this, input, init).then((response) => {
      if (response.headers.get('Tauri-Response') !== 'ok') response.clone().text().then((text) => t.calls.push('ERR ' + cmd + ': ' + text.slice(0, 240)), () => undefined);
      return response;
    });
  };
  document.addEventListener('securitypolicyviolation', (e) => t.violations.push(e.violatedDirective + ' ' + e.blockedURI + ' ' + e.sourceFile));
  window.addEventListener('error', (e) => t.errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => t.errors.push('rejection: ' + String(e.reason && e.reason.message ? e.reason.message : e.reason)));
  for (const kind of ['error', 'warn']) {
    const was = console[kind];
    console[kind] = function (...a) { t.errors.push(kind + ': ' + a.map((x) => (x && x.message) || String(x)).join(' ').slice(0, 300)); return was.apply(this, a); };
  }
  return 'hooked';
})()`.trim();

/** Starts the app in a session of the driver at `base`. */
export async function open(base, binary, args = []) {
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (j.value && j.value.error) throw new Error(`${path}: ${j.value.error} ${String(j.value.message).slice(0, 600)}`);
    return j.value;
  };
  const session = await call('POST', '/session', { capabilities: { alwaysMatch: { 'webkitgtk:browserOptions': { binary, args } } } });
  const id = session.sessionId;
  await call('POST', `/session/${id}/timeouts`, { script: 180000 });
  /**
   * Runs the body of an async function in the page: `args` are its arguments, `S` the store, `M` the app's
   * modules, `t` the hook. One at a time: the driver queues a second behind the first, which then never ends
   * if the first waits on the second.
   */
  const run = (body, ...fnArgs) =>
    call('POST', `/session/${id}/execute/async`, {
      script: `const done = arguments[arguments.length - 1]; const args = [...arguments].slice(0, -1);
        (async () => { const M = window.__plastikcadModules || {}; const S = M['/src/state/store.ts']; const t = window.__t; ${body} })().then((v) => done({ ok: v === undefined ? null : v }), (e) => done({ failed: (String(e) + ' | ' + String(e && e.stack)).slice(0, 900) }));`,
      args: fnArgs,
    }).then((r) => {
      if (r && 'failed' in r) throw new Error(r.failed);
      return r ? r.ok : r;
    });
  const hook = async () => {
    for (let i = 0; i < 120; i++) {
      const ready = await call('POST', `/session/${id}/execute/sync`, { script: `return Boolean(window.__TAURI_INTERNALS__ && window.__plastikcadModules && document.querySelector('canvas'));`, args: [] });
      if (ready) break;
      if (i === 119) throw new Error('The app did not come up: no page with the tests\' hook after a minute. Was the web bundle built with --mode e2e?');
      await sleep(500);
    }
    return call('POST', `/session/${id}/execute/sync`, { script: `return ${HOOK};`, args: [] });
  };
  const app = {
    run,
    hook,
    /** Waits until the page's check gives something truthy and returns it; null when the time is up. */
    until: async (body, seconds = 60, ...fnArgs) => {
      for (let i = 0; i < seconds * 2; i++) {
        const v = await run(body, ...fnArgs);
        if (v) return v;
        await sleep(500);
      }
      return null;
    },
    /** Waits until the app is neither working nor saving. */
    idle: (seconds = 150) => app.until(`const s = S.getState(); return !s.busy && !s.saving ? 'idle' : null;`, seconds),
    reload: async () => {
      await call('POST', `/session/${id}/refresh`, {});
      await sleep(1500);
      return hook();
    },
    /** Hands the app files as a native drop does. */
    drop: (paths) => run(`await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://drag-drop', payload: { paths: args[0], position: { x: 700, y: 400 } } }); return 'dropped';`, paths),
    /** What went wrong in the page since the last look, as lines. */
    faults: () =>
      run(`const out = [...t.errors.splice(0), ...t.violations.splice(0).map((v) => 'content policy: ' + v), ...t.calls.filter((c) => c.startsWith('ERR')).map((c) => 'native call: ' + c.slice(4))]; t.calls = t.calls.filter((c) => !c.startsWith('ERR')); return out;`),
    /** The questions the app asked through the system's boxes since the last look, and what each was answered. */
    asked: () => run(`return t.asked.splice(0);`),
    /** The app's own box, if one is open: its text, and a press on the button whose label matches. */
    box: (label) =>
      run(
        `const d = document.querySelector('dialog[open]'); if (!d) return null; const text = d.textContent.trim().replace(/\\s+/g, ' ').slice(0, 300); const b = args[0] ? [...d.querySelectorAll('button')].find((x) => new RegExp(args[0]).test(x.textContent.trim())) : null; if (b) b.click(); return { text, pressed: Boolean(b) };`,
        label ?? null,
      ),
    /** A key pressed and let go, as the keyboard would: 'Escape', or a character. */
    key: (key) => call('POST', `/session/${id}/actions`, { actions: [{ type: 'key', id: 'keys', actions: [{ type: 'keyDown', value: key === 'Escape' ? '\uE00C' : key }, { type: 'keyUp', value: key === 'Escape' ? '\uE00C' : key }] }] }),
    /** A key held for a while. */
    hold: (key, ms) => call('POST', `/session/${id}/actions`, { actions: [{ type: 'key', id: 'keys', actions: [{ type: 'keyDown', value: key }, { type: 'pause', duration: ms }, { type: 'keyUp', value: key }] }] }),
    notice: () => run(`const n = S.getState().notice; return n ? n.text + ' [' + n.kind + ']' : null;`),
    count: () => run(`return S.getState().doc.scene.length;`),
    close: () => call('DELETE', `/session/${id}`).catch(() => undefined),
  };
  await hook();
  return app;
}
