// The date on a project's card, on devices in different time zones and with clocks that disagree.
import { afterEach, describe, expect, it } from 'vitest';
import { when } from './when';

const zone = process.env.TZ;
afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

describe('when a project was saved', () => {
  const now = Date.UTC(2026, 10, 10, 12, 0, 0);

  it('counts minutes, whatever the time zone', () => {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Europe/Paris']) {
      process.env.TZ = tz;
      expect(when(now - 20_000, now), tz).toBe('Just now');
      expect(when(now - 12 * 60_000, now), tz).toBe('12 min ago');
    }
  });

  it('says today or yesterday by the calendar where the device is', () => {
    // 07:00 UTC is the same day as noon UTC in Paris and in Tokyo, and the evening before in Los Angeles is still "today" there.
    process.env.TZ = 'Europe/Paris';
    expect(when(now - 5 * 3_600_000, now)).toMatch(/^Today /);
    expect(when(now - 20 * 3_600_000, now)).toMatch(/^Yesterday /);
    process.env.TZ = 'Asia/Tokyo';
    // Noon UTC is 21:00 in Tokyo; 14 hours earlier is 07:00 the same day there.
    expect(when(now - 14 * 3_600_000, now)).toMatch(/^Today /);
    process.env.TZ = 'America/Los_Angeles';
    // Noon UTC is 04:00 in Los Angeles; five hours earlier is 23:00 the day before.
    expect(when(now - 5 * 3_600_000, now)).toMatch(/^Yesterday /);
  });

  it('is not thrown by the day the clocks change', () => {
    process.env.TZ = 'Europe/Paris';
    // The night of 25 to 26 October 2025 has 25 hours there. At 00:30 on the 27th, 23:00 on the 25th is two days back, not yesterday.
    const monday = new Date(2025, 9, 27, 0, 30).getTime();
    expect(when(new Date(2025, 9, 26, 23, 0).getTime(), monday)).toMatch(/^Yesterday /);
    expect(when(new Date(2025, 9, 25, 23, 0).getTime(), monday)).not.toMatch(/^Yesterday /);
  });

  it('reads a save from a device whose clock runs ahead as just now, and no date as nothing', () => {
    expect(when(now + 5 * 60_000, now)).toBe('Just now');
    expect(when(now + 3 * 86_400_000, now)).toBe('Just now');
    expect(when(0, now)).toBe('');
    expect(when(Number.NaN, now)).toBe('');
  });
});
