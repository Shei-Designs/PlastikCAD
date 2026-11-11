// Small questions put to the user in a box of the app's own: a name for an
// export, word of where one went with a choice of what to do next, or a list
// to tick from. The
// box is rendered once, in App (`AskDialog`); these functions open it and
// resolve with the answer.
import { useSyncExternalStore } from 'react';

export interface NameQuestion {
  kind: 'name';
  title: string;
  label: string;
  /** The name as it stands, offered selected for typing over. */
  value: string;
  /** Shown after the box, such as ".stl": the name is given without it. */
  suffix?: string;
  okLabel: string;
  resolve: (name: string | null) => void;
}

export interface ChoiceQuestion {
  kind: 'choice';
  title: string;
  text: string;
  /** Points listed under the text, one line each. */
  lines?: string[];
  /**
   * The last one is the plain way out (Escape, the backdrop); the first is the primary. Each is the
   * English the asker compares the answer with (`mark()` it): the box shows it translated.
   */
  actions: string[];
  resolve: (action: string) => void;
}

export interface PickQuestion {
  kind: 'pick';
  title: string;
  text: string;
  /** What there is to pick from, one line each, none ticked to begin with. */
  items: string[];
  okLabel: string;
  /** With the places in `items` of those ticked; none when the user skipped or backed out. */
  resolve: (picked: number[]) => void;
}

export type Question = NameQuestion | ChoiceQuestion | PickQuestion;

let current: Question | null = null;
const listeners = new Set<() => void>();
const publish = (next: Question | null) => {
  current = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useQuestion = (): Question | null => useSyncExternalStore(subscribe, () => current);

/** Settles the open question; the box closes. */
export function answer(result: string | null): void {
  const q = current;
  if (!q) return;
  publish(null);
  if (q.kind === 'name') q.resolve(result);
  else if (q.kind === 'pick') q.resolve([]);
  else q.resolve(result ?? q.actions[q.actions.length - 1]);
}

/** Settles an open question of which to pick with those ticked; the box closes. */
export function answerPick(picked: number[]): void {
  const q = current;
  if (q?.kind !== 'pick') return;
  publish(null);
  q.resolve(picked);
}

/** Asks for a name. Resolves with it trimmed, or null if the user backed out. */
export function askName(options: Omit<NameQuestion, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    answer(null);
    publish({ kind: 'name', ...options, resolve: (name) => resolve(name === null ? null : name.trim() || null) });
  });
}

/** Tells something and offers what to do about it. Resolves with the action chosen. */
export function tell(options: Omit<ChoiceQuestion, 'kind' | 'resolve'>): Promise<string> {
  return new Promise((resolve) => {
    answer(null);
    publish({ kind: 'choice', ...options, resolve });
  });
}

/** Lists things to tick. Resolves with the places of those ticked, none if the user skipped. */
export function askPick(options: Omit<PickQuestion, 'kind' | 'resolve'>): Promise<number[]> {
  return new Promise((resolve) => {
    answer(null);
    publish({ kind: 'pick', ...options, resolve });
  });
}

