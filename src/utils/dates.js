import { TIME_ZONE } from '../config/env.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

// Today's calendar date in the cooperative's time zone as YYYY-MM-DD.
export function todayDateOnly(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

// The time of day in the cooperative's time zone as HH:MM (00:00 to 23:59).
export function nowClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.hour}:${lookup.minute}`;
}

export function formatDateOnly(value) {
  if (!isValidDateOnly(value)) return String(value ?? '');
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(Date.UTC(year, month - 1, day)));
}
