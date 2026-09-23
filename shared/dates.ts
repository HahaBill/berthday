/** Civil dates are ISO strings. Arithmetic always uses UTC, including on a New York laptop. */
const DAY_MS = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})(?:-\d{2})?$/;

export interface DateRange { startDate: string; endDate: string }

// Date.UTC treats years 0..99 as 1900..1999. setUTCFullYear restores the actual ISO year.
function utcDate(year: number, month: number, day: number): Date {
  const result = new Date(Date.UTC(year, month - 1, day));
  if (year < 100) result.setUTCFullYear(year);
  return result;
}

export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = utcDate(year, month, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function parseDate(value: string): Date {
  if (!isValidDate(value)) throw new RangeError(`Invalid ISO date: ${value}`);
  const [year, month, day] = value.split('-').map(Number);
  return utcDate(year, month, day);
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) throw new RangeError('Date is outside years 0001–9999.');
  return `${String(year).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function parseMonth(value: string | number, month?: number): [number, number] {
  let year: number;
  let monthNumber: number;
  if (typeof value === 'number') {
    year = value;
    monthNumber = month ?? 0;
  } else {
    const match = MONTH_PATTERN.exec(value);
    if (!match || (value.length === 10 && !isValidDate(value))) throw new RangeError(`Invalid ISO month: ${value}`);
    year = Number(match[1]);
    monthNumber = Number(match[2]);
  }
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new RangeError('Supply a year and a month from 1 to 12.');
  }
  return [year, monthNumber];
}

export function addDays(value: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError('Days must be an integer.');
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

/** Signed elapsed days from `from` to `to`, excluding the starting day. */
export function diffDays(from: string, to: string): number {
  return (parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS;
}

export function daysInMonth(value: string | number, month?: number): number {
  const [year, monthNumber] = parseMonth(value, month);
  if (monthNumber === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(monthNumber) ? 30 : 31;
}

export function monthStart(value: string | number, month?: number): string {
  const [year, monthNumber] = parseMonth(value, month);
  return `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}-01`;
}

export function monthEnd(value: string | number, month?: number): string {
  return `${monthStart(value, month).slice(0, 8)}${daysInMonth(value, month)}`;
}

export function eachDay(start: string, end: string): string[] {
  const count = diffDays(start, end);
  if (count < 0) return [];
  const date = parseDate(start);
  return Array.from({ length: count + 1 }, () => {
    const day = formatDate(date);
    date.setUTCDate(date.getUTCDate() + 1);
    return day;
  });
}

/** Shared occupied days, including both range endpoints. */
export function sharedDays(a: DateRange, b: DateRange): number {
  const start = a.startDate > b.startDate ? a.startDate : b.startDate;
  const end = a.endDate < b.endDate ? a.endDate : b.endDate;
  return start > end ? 0 : diffDays(start, end) + 1;
}

/** Only the client chooses "today". The optional zone is useful for explicit display and tests. */
export function todayIn(tz?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    ...(tz ? { timeZone: tz } : {}), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
