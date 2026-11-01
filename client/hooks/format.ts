import { useTranslation } from 'react-i18next';
import { useEmployees } from './task.ts';
import { useViewAs } from './viewAs.ts';

// Moments are shown in the time zone of the profile, not of the browser: days
// are counted in it, and a day must not show times of another (decision 99).
let current = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The signed-in employee's time zone, set once they are known (App). */
export function setZone(zone: string) {
  current = zone;
}

/**
 * The time zone moments are shown in: the signed-in employee's, or, on a
 * report's page (ViewAs), the report's — their days are theirs.
 */
export function useZone(): string {
  const { as } = useViewAs();
  const employees = useEmployees();
  return (as === undefined ? undefined : employees.get(as)?.timeZone) ?? current;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The wall clock of a moment in a time zone. */
export function clockOf(at: Date, zone: string = current) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

/** The moment a wall clock shows in a time zone (the later one on a clock moved back). */
export function zoned(year: number, month: number, day: number, hour = 0, minute = 0, zone: string = current): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (at: number) => {
    const c = clockOf(new Date(at), zone);
    return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - Math.floor(at / 1000) * 1000;
  };
  const first = wall - offset(wall);
  return new Date(wall - offset(first));
}

/** The day a moment falls on in a time zone, YYYY-MM-DD. */
export function dayOf(at: Date, zone: string = current): string {
  const c = clockOf(at, zone);
  return `${c.year}-${pad(c.month)}-${pad(c.day)}`;
}

/** The midnight that starts a day YYYY-MM-DD in a time zone. */
export function midnightOf(value: string, zone: string = current): Date {
  const [y, m, d] = value.split('-').map(Number);
  return zoned(y!, m!, d!, 0, 0, zone);
}

/** Minutes, deadlines and moments in the interface language and the profile's time zone. */
export function useFormat() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const zone = useZone();
  const thisYear = clockOf(new Date(), zone).year;

  const minutes = (value: number): string => {
    const h = Math.floor(value / 60);
    const m = value % 60;
    return [h > 0 && t('task.minutes.h', { count: h }), (m > 0 || h === 0) && t('task.minutes.m', { count: m })]
      .filter(Boolean)
      .join(' ');
  };

  const date = (value: Date): string =>
    value.toLocaleString(locale, {
      timeZone: zone,
      day: 'numeric',
      month: 'short',
      ...(clockOf(value, zone).year !== thisYear && { year: 'numeric' }),
    });

  const dateTime = (value: Date): string =>
    value.toLocaleString(locale, {
      timeZone: zone,
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      ...(clockOf(value, zone).year !== thisYear && { year: 'numeric' }),
    });

  const time = (value: Date): string => value.toLocaleTimeString(locale, { timeZone: zone, hour: '2-digit', minute: '2-digit' });

  /** A day YYYY-MM-DD, short: "14 Oct". A day is a date, no time zone moves it. */
  const dayDate = (value: string): string => {
    const d = fromDay(value);
    return d.toLocaleDateString(locale, {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      ...(d.getUTCFullYear() !== thisYear && { year: 'numeric' }),
    });
  };

  /** A day of History, YYYY-MM-DD: "Wednesday, 14 October". */
  const day = (value: string): string => {
    const d = fromDay(value);
    return d.toLocaleDateString(locale, {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      ...(d.getUTCFullYear() !== thisYear && { year: 'numeric' }),
    });
  };

  /** "in 6 days", "2 hours ago". */
  const relative = (value: Date): string => {
    const diff = value.getTime() - Date.now();
    const units: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]];
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const [unit, ms] of units) {
      if (Math.abs(diff) >= ms || unit === 'minute') return rtf.format(Math.round(diff / ms), unit);
    }
    return '';
  };

  return { minutes, date, dateTime, time, dayDate, day, relative };
}

/**
 * "1h 30m", "1ч30м", "2д 4ч", "90" -> minutes; null when it does not parse.
 * A day is a working day, 8 hours: plans and entries are work, not calendar
 * time. `allowZero` — for a lag.
 */
export function parseMinutes(text: string, allowZero = false): number | null {
  const s = text.trim().toLowerCase().replace(',', '.');
  if (/^\d+$/.test(s)) return Number(s) || (allowZero ? 0 : null);
  const match = /^(?:(\d+(?:\.\d+)?)\s*[dд])?\s*(?:(\d+(?:\.\d+)?)\s*[hч])?\s*(?:(\d+)\s*[mм])?$/.exec(s);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const total = Math.round(Number(match[1] ?? 0) * 480 + Number(match[2] ?? 0) * 60) + Number(match[3] ?? 0);
  return total > 0 || allowZero ? total : null;
}

/** Today in the signed-in employee's time zone, YYYY-MM-DD. */
export function today(): string {
  return dayOf(new Date());
}

/** YYYY-MM-DD -> that date at UTC midnight: for its weekday and its name, never for a moment. */
export function fromDay(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

/** A moment for <input type="datetime-local">: YYYY-MM-DDTHH:mm in the profile's time zone. */
export function toLocalInput(value: Date, zone: string = current): string {
  const c = clockOf(value, zone);
  return `${c.year}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}`;
}

/** The value of <input type="datetime-local"> back to a moment in the profile's time zone; null when empty or invalid. */
export function fromLocalInput(value: string, zone: string = current): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  return zoned(y!, mo!, d!, h!, mi!, zone);
}
