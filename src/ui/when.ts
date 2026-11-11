// How long ago, in words, for the cards of the projects browser.

/**
 * "Just now", "12 min ago", or the date, for the card, in the device's own time and words. A time
 * ahead of this device's clock (saved on a device whose clock runs ahead) reads as just now, and
 * no time at all as nothing.
 */
export function when(modified: number, now = Date.now()): string {
  if (!Number.isFinite(modified) || modified <= 0) return '';
  const minutes = Math.round((now - modified) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const date = new Date(modified);
  const today = new Date(now);
  // Whole days between the two dates on the calendar here, which a day of 23 or 25 hours does not throw off.
  const days = Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86_400_000);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return date.toLocaleDateString(undefined, { year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' });
}
