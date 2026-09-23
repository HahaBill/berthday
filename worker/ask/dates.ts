import { addDays, diffDays, isValidDate, monthEnd, monthStart } from '../../shared/dates';
import type { AskRequest } from '../../shared/types';

const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export const monthPattern = months.map(month => `${month.slice(0, 3)}(?:${month.slice(3)})?`).join('|');
const monthNumber = (name: string) => months.findIndex(month => month.startsWith(name.toLowerCase())) + 1;
const iso = (year: number, month: number, day: number) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

export interface ParsedDates { from?: string; to?: string; error?: string }

/** Creation never inherits a historical viewed month or invents a day from a month-only request. */
export function parseDates(q: string, input: AskRequest, creation = false): ParsedDates {
  const fallbackYear = Number((creation ? input.today : input.viewedMonth).slice(0, 4));
  const result: ParsedDates = {};
  const dates = q.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  const dayRange = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:[-–—]|to|through)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?:,?\\s+(\\d{4}))?\\b`, 'i').exec(q);
  const monthRange = new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*(\\d{4}))?\\s*(?:[-–—]|to|through)\\s*(?:(${monthPattern})\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i').exec(q);
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?:,?\\s+(\\d{4}))?\\b`, 'i').exec(q);
  const monthFirst = new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'i').exec(q);
  const namedMonth = new RegExp(`\\b(${monthPattern})\\.?\\s*(\\d{4})?\\b`, 'i').exec(q);
  if (creation) {
    const mentions = [...q.matchAll(new RegExp(`\\b(?:${monthPattern})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${monthPattern})\\b`, 'gi'))];
    if ((!monthRange && !dayRange && mentions.length > 1) || (dates?.length && mentions.length)) {
      return { error: 'Describe one continuous booking with a start date and last day at berth. Separate dates need separate bookings.' };
    }
    if (dates?.length === 2) {
      const between = q.slice(q.indexOf(dates[0]) + dates[0].length, q.lastIndexOf(dates[1]));
      if (!/\b(?:to|through|until)\b|[-–—]/i.test(between)) return { error: 'Describe one continuous date range. Separate dates need separate bookings.' };
    }
  }
  if (dates?.length) {
    if (dates.some(date => !isValidDate(date))) return { error: 'That date does not exist. Enter a valid date.' };
    if (creation && dates.length > 2) return { error: 'Describe one booking with a start date and last day at berth.' };
    result.from = dates[0]; result.to = dates[1] ?? dates[0];
  } else if (dayRange) {
    const year = Number(dayRange[4] ?? fallbackYear), month = monthNumber(dayRange[3]);
    result.from = iso(year, month, Number(dayRange[1])); result.to = iso(year, month, Number(dayRange[2]));
  } else if (monthRange) {
    const year = Number(monthRange[3] ?? monthRange[6] ?? fallbackYear);
    result.from = iso(year, monthNumber(monthRange[1]), Number(monthRange[2]));
    result.to = iso(Number(monthRange[6] ?? year), monthNumber(monthRange[4] ?? monthRange[1]), Number(monthRange[5]));
  } else if (/\bnext week\b/i.test(q)) {
    const weekday = ((diffDays('1970-01-05', input.today) % 7) + 7) % 7;
    result.from = addDays(input.today, 7 - weekday); result.to = addDays(result.from, 6);
  } else if (/\btomorrow\b/i.test(q)) {
    result.from = addDays(input.today, 1); result.to = result.from;
  } else if (/\btoday\b/i.test(q)) {
    result.from = input.today; result.to = result.from;
  } else if (/\bthis month\b/i.test(q)) {
    if (!creation) { result.from = monthStart(input.today); result.to = monthEnd(input.today); }
  } else if (dayFirst || monthFirst) {
    const match = dayFirst ?? monthFirst!;
    result.from = iso(Number(match[3] ?? fallbackYear), monthNumber(dayFirst ? match[2] : match[1]), Number(dayFirst ? match[1] : match[2]));
    result.to = result.from;
  } else if (namedMonth && !creation) {
    const month = `${String(namedMonth[2] ?? fallbackYear).padStart(4, '0')}-${String(monthNumber(namedMonth[1])).padStart(2, '0')}`;
    result.from = monthStart(month); result.to = monthEnd(month);
  } else if (!creation) {
    const year = /\b(19\d{2}|20\d{2}|2100)\b/.exec(q)?.[1];
    if (year) { result.from = `${year}-01-01`; result.to = `${year}-12-31`; }
  }
  if ((result.from && !isValidDate(result.from)) || (result.to && !isValidDate(result.to))) return { error: 'Those dates do not exist. Enter a valid date range.' };
  if (creation && result.from === result.to && /\bfrom\b/i.test(q) && !/\b(?:to|through|until)\b/i.test(q)) delete result.to;
  if (creation && result.from === result.to && /\buntil\b/i.test(q) && !/\bfrom\b/i.test(q)) delete result.from;
  if (result.from && result.to && result.from > result.to) {
    if (creation) return { error: 'The last day must be on or after the start date. Describe the booking dates again.' };
    [result.from, result.to] = [result.to, result.from];
  }
  return result;
}
