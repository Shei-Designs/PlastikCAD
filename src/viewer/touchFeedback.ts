// What a finger is shown of a gesture that has no other sign: the ring that
// fills while a long press builds, and the word in the middle of the view
// after a tap of two or three fingers. Both are elements laid over the canvas
// that take no pointer; their look is in styles.css.
import { LONG_PRESS_MS } from './gesture';

/** How long the word stays, in ms. */
const NOTE_MS = 900;
const SVG = 'http://www.w3.org/2000/svg';

export class TouchFeedback {
  private ring: HTMLElement | null = null;
  private note: HTMLElement | null = null;
  private noteTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly container: HTMLElement) {}

  /** Starts the ring round a finger that has just come to rest there. */
  showRing(clientX: number, clientY: number): void {
    if (!this.ring) {
      this.ring = document.createElement('div');
      this.ring.className = 'hold-ring';
      // The ring fills in the time a long press takes; the stylesheet does not know how long that is.
      this.ring.style.setProperty('--hold', `${LONG_PRESS_MS}ms`);
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('viewBox', '0 0 80 80');
      svg.setAttribute('aria-hidden', 'true');
      for (const part of ['halo', 'track', 'fill']) {
        const circle = document.createElementNS(SVG, 'circle');
        circle.setAttribute('class', part);
        circle.setAttribute('cx', '40');
        circle.setAttribute('cy', '40');
        circle.setAttribute('r', '36');
        svg.appendChild(circle);
      }
      this.ring.appendChild(svg);
      this.container.appendChild(this.ring);
    }
    const rect = this.container.getBoundingClientRect();
    // Shown afresh, the filling starts again from nothing.
    Object.assign(this.ring.style, { display: 'block', left: `${clientX - rect.left}px`, top: `${clientY - rect.top}px` });
  }

  hideRing(): void {
    if (this.ring) this.ring.style.display = 'none';
  }

  /** Says a word in the middle of the view for a moment. */
  say(text: string): void {
    if (!this.note) {
      this.note = document.createElement('div');
      this.note.className = 'readout touch-note';
      this.note.style.setProperty('--stay', `${NOTE_MS}ms`);
      this.container.appendChild(this.note);
    }
    // Taken out and put back, so that a second word starts its fading again.
    this.note.hidden = true;
    this.note.textContent = text;
    void this.note.offsetWidth;
    this.note.hidden = false;
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      if (this.note) this.note.hidden = true;
    }, NOTE_MS);
  }

  /** Takes both out of the page. */
  remove(): void {
    clearTimeout(this.noteTimer);
    this.ring?.remove();
    this.note?.remove();
    this.ring = this.note = null;
  }
}
