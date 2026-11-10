import { describe, expect, it } from 'vitest';
import { pressedOutside, TOUCH_ENTRY } from './outside';

/** A stand-in for an element: `inside` lists the selectors of the things it sits in. */
const element = (...inside: string[]) => ({ closest: (selector: string) => (inside.includes(selector) ? {} : null) });

describe('pressedOutside', () => {
  const inPanel = element();
  const root = { contains: (node: unknown) => node === inPanel };

  it('keeps the panel open for a press inside it', () => {
    expect(pressedOutside(root, inPanel)).toBe(false);
  });

  it('closes it for a press anywhere else', () => {
    expect(pressedOutside(root, element())).toBe(true);
    expect(pressedOutside(root, null)).toBe(true);
    expect(pressedOutside(null, element())).toBe(true);
  });

  it('keeps it open for a press on the touch entry sheet or its backdrop', () => {
    expect(pressedOutside(root, element(TOUCH_ENTRY))).toBe(false);
  });

  it('copes with a target that is not an element', () => {
    expect(pressedOutside(root, {})).toBe(true);
  });
});
