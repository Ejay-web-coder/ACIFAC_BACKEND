import { TIME_ZONE } from '../config/env.js';

// When the ACIFAC office receives loan payments: weekdays during office hours,
// Monday to Friday 8:00 AM to 5:00 PM in the cooperative's time zone.
// LOAN_PAYMENT_HOURS changes it, e.g. "Mon-Sat 08:00-12:00" or
// "Mon,Wed,Fri 09:00-16:30" (closing time exclusive). It is read on every use.
const DEFAULT_HOURS = 'Mon-Fri 08:00-17:00';
// ISO weekdays: 1 = Monday ... 7 = Sunday.
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const dayNumber = (text) => DAY_NAMES.findIndex((name) => name.slice(0, 3).toLowerCase() === text.trim().slice(0, 3).toLowerCase()) + 1;
const clock = (minutes) => {
  const hours = Math.floor(minutes / 60) % 24;
  return `${hours % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
};

function parseHours(value) {
  const match = /^\s*([A-Za-z ,-]+?)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(value || ''));
  if (!match) return null;
  const days = new Set();
  for (const part of match[1].split(',')) {
    const [from, to = from] = part.split('-').map(dayNumber);
    if (!from || !to) return null;
    for (let day = from; ; day = (day % 7) + 1) {
      days.add(day);
      if (day === to) break;
    }
  }
  const open = Number(match[2]) * 60 + Number(match[3]);
  const close = Number(match[4]) * 60 + Number(match[5]);
  if (Number(match[3]) > 59 || Number(match[5]) > 59 || open >= close || close > 24 * 60) return null;
  return { days: [...days].sort((a, b) => a - b), open, close };
}

function describe({ days, open, close }) {
  const consecutive = days.every((day, index) => index === 0 || day === days[index - 1] + 1);
  const dayText = days.length === 7 ? 'Every day'
    : consecutive && days.length > 2 ? `${DAY_NAMES[days[0] - 1]} to ${DAY_NAMES[days.at(-1) - 1]}`
      : days.map((day) => DAY_NAMES[day - 1]).join(', ');
  const timeText = open === 0 && close === 24 * 60 ? 'any time' : `${clock(open)} to ${clock(close)}`;
  return `${dayText}, ${timeText}`;
}

let warned = false;

// { days: ISO weekdays, open and close in minutes after midnight, label }
export function paymentHours() {
  const configured = parseHours(process.env.LOAN_PAYMENT_HOURS);
  if (process.env.LOAN_PAYMENT_HOURS && !configured && !warned) {
    warned = true;
    console.warn(`LOAN_PAYMENT_HOURS "${process.env.LOAN_PAYMENT_HOURS}" is not like "${DEFAULT_HOURS}"; using ${DEFAULT_HOURS}.`);
  }
  const hours = configured || parseHours(DEFAULT_HOURS);
  return { ...hours, label: describe(hours) };
}

// ISO weekday (1 = Monday) of a YYYY-MM-DD date.
export function isoWeekday(dateOnly) {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

export const weekdayName = (dateOnly) => DAY_NAMES[isoWeekday(dateOnly) - 1];

export const isPaymentDay = (dateOnly, hours = paymentHours()) => hours.days.includes(isoWeekday(dateOnly));

// Whether the office is open now, in the cooperative's time zone.
export function officeOpenNow(hours = paymentHours(), now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((part) => [part.type, part.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return hours.days.includes(dayNumber(parts.weekday)) && minutes >= hours.open && minutes < hours.close;
}
