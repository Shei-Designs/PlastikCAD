// What the app is being driven with: a hardware keyboard, or fingers and the
// on-screen keypad. On Android the input plugin reports it from the system
// and says when it changes (a keyboard docked or undocked, the keypad coming
// up); everywhere else there is a keyboard. Boxes tapped with a finger type
// in place when there is a keyboard and open the entry sheet when there is not.
import { useSyncExternalStore } from 'react';
import { addPluginListener, invoke } from '@tauri-apps/api/core';
import { isAndroid } from '../platform';

export interface InputState {
  hardwareKeyboard: boolean;
  keypadVisible: boolean;
  /** Height of the keypad over the page, in CSS pixels. */
  keypadHeight: number;
}

/** Unknown until the plugin has answered; a desktop or a browser is taken to have a keyboard. */
let state: InputState | null = isAndroid() ? null : { hardwareKeyboard: true, keypadVisible: false, keypadHeight: 0 };
const listeners = new Set<(state: InputState) => void>();

function take(next: InputState): void {
  if (state && state.hardwareKeyboard === next.hardwareKeyboard && state.keypadVisible === next.keypadVisible && state.keypadHeight === next.keypadHeight) return;
  state = next;
  for (const l of listeners) l(next);
}

/** Asks the plugin and keeps listening. Safe to call where there is no plugin. */
export async function initInput(): Promise<void> {
  if (!isAndroid()) return;
  try {
    take(await invoke<InputState>('plugin:device|state'));
    await addPluginListener<InputState>('device', 'change', take);
  } catch (e) {
    console.warn('The input plugin did not answer; boxes will use the entry sheet.', e);
  }
}

export const inputState = (): InputState | null => state;

/** Asks the plugin again (it reads the system afresh), for moments when a change may have gone by unheard. */
export async function refreshInput(): Promise<void> {
  if (!isAndroid()) return;
  try {
    take(await invoke<InputState>('plugin:device|state'));
  } catch (e) {
    console.warn('The input plugin did not answer.', e);
  }
}

/** Whether typing can go into a box where it is: there is a keyboard. Unknown counts as none, the safer reading on a tablet. */
export const keyboardAttached = (): boolean => state?.hardwareKeyboard ?? false;

export function onInputChange(listener: (state: InputState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests and the browser: pretends the plugin said so. */
export const setInputState = (next: InputState): void => take(next);

/** For React: whether there is a keyboard, kept up to date as one is docked or taken away. */
export const useKeyboardAttached = (): boolean => useSyncExternalStore(onInputChange, keyboardAttached);

const COARSE = '(pointer: coarse)';

/** Whether the pointer is a finger rather than a mouse. */
const coarsePointer = (): boolean => typeof matchMedia === 'function' && matchMedia(COARSE).matches;

function onPointerChange(listener: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const query = matchMedia(COARSE);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** For React: whether the pointer is a finger, kept up to date as a mouse or trackpad comes and goes. */
export const useCoarsePointer = (): boolean => useSyncExternalStore(onPointerChange, coarsePointer);
