import { useTranslation } from 'react-i18next';

/** Minutes, deadlines and moments in the interface language. */
export function useFormat() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const minutes = (value: number): string => {
    const h = Math.floor(value / 60);
    const m = value % 60;
    return [h > 0 && t('task.minutes.h', { count: h }), (m > 0 || h === 0) && t('task.minutes.m', { count: m })]
      .filter(Boolean)
      .join(' ');
  };

  const date = (value: Date): string =>
    value.toLocaleString(locale, {
      day: 'numeric',
      month: 'short',
      ...(value.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
    });

  const dateTime = (value: Date): string =>
    value.toLocaleString(locale, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      ...(value.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
    });

  const time = (value: Date): string => value.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

  /** A day of History, YYYY-MM-DD: "Wednesday, 14 October". */
  const day = (value: string): string => {
    const d = fromDay(value);
    return d.toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
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

  return { minutes, date, dateTime, time, day, relative };
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

const pad = (n: number) => String(n).padStart(2, '0');

/** Today in the browser's time zone, YYYY-MM-DD. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD -> local midnight of that day. */
export function fromDay(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

/** A moment for <input type="datetime-local">: YYYY-MM-DDTHH:mm in the browser's time zone. */
export function toLocalInput(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/** The value of <input type="datetime-local"> back to a moment; null when empty or invalid. */
export function fromLocalInput(value: string): Date | null {
  const d = new Date(value);
  return value && !Number.isNaN(d.getTime()) ? d : null;
}
