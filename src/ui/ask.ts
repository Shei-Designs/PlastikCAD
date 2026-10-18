// Small questions put to the user in a box of the app's own: a name for an
// export, or word of where one went with a choice of what to do next. The
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
  /** The last one is the plain way out (Escape, the backdrop); the first is the primary. */
  actions: string[];
  resolve: (action: string) => void;
}

export type Question = NameQuestion | ChoiceQuestion;

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
  else q.resolve(result ?? q.actions[q.actions.length - 1]);
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
