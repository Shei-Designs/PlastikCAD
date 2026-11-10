// Small pictures drawn on a canvas and used as textures: the letters of the
// axis triad, the grips and dots of the handles, the padlock badge and the
// figure on a measuring line.
import { CanvasTexture, SRGBColorSpace } from 'three';

/** Rim of the padlock badge: the warm color the hot align dot uses, for something that will not follow a drag. */
export const LOCK_COLOR = '#ff9f4d';

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, size: number) => void): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (g) draw(g, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export function labelTexture(letter: string, color: string): CanvasTexture {
  return canvasTexture(64, (g, size) => {
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.font = 'bold 38px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(letter, size / 2, size / 2 + 2);
  });
}

/** Square grip: light with a dark rim (corners) or the reverse (edges). */
export function gripTexture(fill: string, rim: string): CanvasTexture {
  return canvasTexture(64, (g, size) => {
    g.fillStyle = rim;
    g.fillRect(6, 6, size - 12, size - 12);
    g.fillStyle = fill;
    g.fillRect(14, 14, size - 28, size - 28);
  });
}

/** A round dot: an align anchor or a snap point. */
export function dotTexture(fill: string, rim = '#ffffff'): CanvasTexture {
  return canvasTexture(64, (g, size) => {
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = rim;
    g.stroke();
  });
}

/** Padlock badge for a selected object that is locked: a drag leaves it where it is. */
export function lockTexture(): CanvasTexture {
  return canvasTexture(64, (g, size) => {
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 5, 0, Math.PI * 2);
    g.fillStyle = '#14171c';
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = LOCK_COLOR;
    g.stroke();
    // Shackle, then body.
    g.lineWidth = 5;
    g.strokeStyle = '#ffffff';
    g.beginPath();
    g.arc(32, 28, 8, Math.PI, 0);
    g.stroke();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.roundRect(19, 28, 26, 20, 4);
    g.fill();
    g.fillStyle = '#14171c';
    g.beginPath();
    g.arc(32, 37, 3, 0, Math.PI * 2);
    g.fill();
  });
}

/** The figure on a measuring line: a rounded pill with the text, sized to fit it. */
export function textTexture(text: string, theme: 'dark' | 'light'): { texture: CanvasTexture; aspect: number } {
  const canvas = document.createElement('canvas');
  const height = 64;
  const g = canvas.getContext('2d');
  const font = `600 ${height * 0.5}px system-ui, sans-serif`;
  if (g) g.font = font;
  const width = Math.ceil((g?.measureText(text).width ?? height) + height * 0.8);
  canvas.width = width;
  canvas.height = height;
  if (g) {
    g.font = font;
    const r = height / 2;
    g.beginPath();
    g.moveTo(r, 0);
    g.arcTo(width, 0, width, height, r);
    g.arcTo(width, height, 0, height, r);
    g.arcTo(0, height, 0, 0, r);
    g.arcTo(0, 0, width, 0, r);
    g.closePath();
    g.fillStyle = theme === 'dark' ? '#14171c' : '#ffffff';
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = theme === 'dark' ? '#17cdd3' : '#0d9297';
    g.stroke();
    g.fillStyle = theme === 'dark' ? '#e8ecef' : '#1b1f27';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, width / 2, height / 2 + 1);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return { texture, aspect: width / height };
}
