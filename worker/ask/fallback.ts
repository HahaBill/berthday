import { addDays, diffDays, isValidDate, monthEnd, monthStart } from '../../shared/dates';
import type { AskIntent, AskRequest } from '../../shared/types';

export const berthAliases: Record<string, string[]> = {
  'north-pier-west': ['north pier west', 'npw'],
  'north-pier-face': ['north pier face', 'npf'],
  'north-pier-east': ['north pier east', 'npe'],
  'inner-channel': ['inner channel', 'ic'],
  'south-float-west': ['south float west', 'sfw'],
  'south-float-east': ['south float east', 'sfe'],
  'small-craft-slips': ['small craft slips', 'slips'],
  'north-finger-piers': ['north finger piers', 'finger piers'],
  unassigned: ['unassigned'],
};
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthPattern = months.map(month => `${month.slice(0, 3)}(?:${month.slice(3)})?`).join('|');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const monthNumber = (name: string) => months.findIndex(m => m.startsWith(name.toLowerCase())) + 1;
const iso = (year: number, month: number, day: number) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** A small, predictable grammar. It never uses booking rows or guesses availability. */
function parseQuery(input: AskRequest): AskIntent {
  const q = input.q.toLowerCase().trim();
  const result: AskIntent = { intent: 'search' };
  const berths = Object.entries(berthAliases).filter(([, aliases]) => aliases.some(alias => new RegExp(`\\b${escape(alias)}\\b`, 'i').test(q))).map(([id]) => id);
  if (berths.length) result.berthIds = berths;
  const length = /(\d+)\s*(?:ft\b|feet\b|')/i.exec(q);
  if (length && Number(length[1]) >= 1 && Number(length[1]) <= 1000) result.lengthFt = Number(length[1]);

  if (/vessel.{0,15}(two places|two berths)|two places/.test(q)) {
    result.intent = 'issues'; result.issueTypes = ['vessel_double'];
  } else if (/too long|fit violations?/.test(q)) {
    result.intent = 'issues'; result.issueTypes = ['fit'];
  } else if (/conflict|double|overlap/.test(q)) {
    result.intent = 'issues'; result.issueTypes = ['overlap'];
  } else if (/\b(free|available|availability|fit|space)\b/.test(q)) result.intent = 'availability';
  else if (/\bgo to\b/.test(q) || new RegExp(`\\bshow me\\s+(?:${monthPattern})\\b`).test(q)) result.intent = 'navigate';

  const dates = q.match(/\b\d{4}-\d{2}-\d{2}\b/g)?.filter(isValidDate);
  const dayRange = new RegExp(`\\b(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})\\s+(${monthPattern})(?:\\s+(\\d{4}))?\\b`, 'i').exec(q);
  const monthFirstRange = new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`, 'i').exec(q);
  const singleDay = new RegExp(`\\b(\\d{1,2})\\s+(${monthPattern})(?:\\s+(\\d{4}))?\\b`, 'i').exec(q);
  const namedMonth = new RegExp(`\\b(${monthPattern})(?:\\s+(\\d{4}))?\\b`, 'i').exec(q);
  const fallbackYear = Number(input.viewedMonth.slice(0, 4));
  if (dates?.length) {
    result.dateFrom = dates[0]; result.dateTo = dates[1] ?? dates[0];
  } else if (dayRange || monthFirstRange) {
    const m = dayRange ?? monthFirstRange!;
    const month = monthNumber(dayRange ? m[3] : m[1]), year = Number(m[4] ?? fallbackYear);
    const start = iso(year, month, Number(dayRange ? m[1] : m[2]));
    const end = iso(year, month, Number(dayRange ? m[2] : m[3]));
    if (isValidDate(start) && isValidDate(end)) { result.dateFrom = start; result.dateTo = end; }
    else return { intent: 'unsupported', reason: 'Those dates do not exist. Enter a valid date range.' };
  } else if (/\bnext week\b/.test(q)) {
    const weekday = ((diffDays('1970-01-05', input.today) % 7) + 7) % 7;
    result.dateFrom = addDays(input.today, 7 - weekday); result.dateTo = addDays(result.dateFrom, 6);
  } else if (/\bthis month\b/.test(q)) {
    result.dateFrom = monthStart(input.today); result.dateTo = monthEnd(input.today);
  } else if (singleDay) {
    const value = iso(Number(singleDay[3] ?? fallbackYear), monthNumber(singleDay[2]), Number(singleDay[1]));
    if (isValidDate(value)) { result.dateFrom = value; result.dateTo = value; }
    else return { intent: 'unsupported', reason: 'That date does not exist. Enter a valid date.' };
  } else if (namedMonth) {
    const month = `${String(namedMonth[2] ?? fallbackYear).padStart(4, '0')}-${String(monthNumber(namedMonth[1])).padStart(2, '0')}`;
    result.dateFrom = monthStart(month);
    if (result.intent !== 'navigate') result.dateTo = monthEnd(month);
  } else {
    const year = /\b(19\d{2}|20\d{2}|2100)\b/.exec(q)?.[1];
    if (year) { result.dateFrom = `${year}-01-01`; result.dateTo = `${year}-12-31`; }
  }
  const quoted = /["“]([^"”]+)["”]/.exec(input.q)?.[1];
  const prefixed = /\b(?:R\/V|M\/V|S\/V|S\/Y|M\/Y|OS\/V|OSV|F\/V|TUG|BARGE)\s+.+?(?=\s+(?:at|on|in|from|between|during|for)\b|$)/i.exec(input.q)?.[0];
  const everything = /\b(?:everything|bookings|reservations)\s+for\s+(.+?)(?=\s+(?:at|on|in|from|during)\b|$)/i.exec(input.q)?.[1];
  if (quoted || prefixed || everything) result.vesselQuery = (quoted ?? prefixed ?? everything)!.trim();
  if (/\bclosures?\b|maintenance/.test(q)) result.kinds = ['closure'];
  else if (/\bevents?\b/.test(q)) result.kinds = ['event'];
  else if (/\bholds?\b/.test(q)) result.kinds = ['hold'];
  if (result.intent === 'search' && !result.dateFrom && !result.berthIds && !result.vesselQuery && !result.kinds) {
    return { intent: 'unsupported', reason: 'Try a berth, vessel name, or date, such as “Inner Channel in July 2010”.' };
  }
  if (result.dateFrom && result.dateTo && result.dateFrom > result.dateTo) [result.dateFrom, result.dateTo] = [result.dateTo, result.dateFrom];
  return result;
}

export function parseFallback(input: AskRequest): AskIntent {
  try { return parseQuery(input); } catch (error) {
    if (error instanceof RangeError) return { intent: 'unsupported', reason: 'Enter a valid date or month between 1997 and 2100.' };
    throw error;
  }
}

export const fallback = parseFallback;
