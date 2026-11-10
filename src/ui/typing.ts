/**
 * Lets a box being typed in commit its value now (boxes commit when they are
 * left), before something else changes what the box edits: a save takes the
 * number on screen, and a press on the plate applies it to the object it was
 * typed for rather than the one about to be selected.
 */
export const commitTyping = (): void => {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) active.blur();
};
