// Exact money handling in integer centavos. Values from PostgreSQL NUMERIC
// arrive as strings and are parsed without going through floating point.

const MONEY_TEXT = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const text = typeof value === 'number' ? value.toFixed(2) : String(value).trim();
  const match = MONEY_TEXT.exec(text.replace(/(\.\d{2})0+$/, '$1'));
  if (!match) throw new Error(`Invalid money value: ${text}`);
  const cents = Number(match[2]) * 100 + Number((match[3] || '').padEnd(2, '0'));
  return match[1] ? -cents : cents;
}

export function centsToString(cents) {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

// Parses user input that must be a non-negative amount with at most 2 decimals.
export function parseMoneyInput(value, { allowZero = false, max = 100000000 } = {}) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = toCents(text);
  if ((!allowZero && cents <= 0) || cents > max * 100) return null;
  return cents;
}

export function money(value) {
  return Number(value ?? 0);
}
