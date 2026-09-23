import type { AskIntent, AskRequest, BookingDraft, Kind } from '../../shared/types';
import { monthPattern, parseDates } from './dates';

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
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const creationPrefix = /^(?:(?:please|can you|could you|would you|i want to|i'd like to|i would like to)\s+)*(?:create|add|schedule|book|reserve)\b\s*/i;
const creationVerb = /\b(?:create|add|schedule|book|reserve)\b/i;
const negatedCreation = /\b(?:do not|don't|dont|never|not|no need to)(?:\s+(?:want|need|wish))?(?:\s+you)?(?:\s+to)?\s+(?:create|add|schedule|book|reserve)\b|\bwithout\s+(?:creating|adding|scheduling|booking|reserving)\b/i;
const quotedText = /["“]([^"”]+)["”]/;
const outsideQuotes = (q: string) => q.replace(/["“][^"”]*["”]/g, match => ' '.repeat(match.length));
const matchedBerths = (q: string) => Object.entries(berthAliases).filter(([, aliases]) => aliases.some(alias => new RegExp(`\\b${escape(alias)}\\b`, 'i').test(q))).map(([id]) => id);

function parseCreation(input: AskRequest): AskIntent {
  const noteIndex = outsideQuotes(input.q).search(/\bnotes?\s*:/i);
  const command = noteIndex < 0 ? input.q : input.q.slice(0, noteIndex);
  const notes = noteIndex < 0 ? undefined : input.q.slice(noteIndex).replace(/^notes?\s*:\s*/i, '').trim();
  const context = outsideQuotes(command), remaining = command.replace(creationPrefix, '').trim();
  const explicitKind = /^(?:an?\s+|the\s+)?(?:new\s+)?(event|closure|hold|vessel)\b/i.exec(remaining)?.[1].toLowerCase();
  const isVessel = /\b(?:R\/V|M\/V|S\/V|S\/Y|M\/Y|OS\/V|OSV|F\/V|TUG|BARGE)\s+/i.test(remaining);
  const kind: Kind = explicitKind as Kind | undefined ?? (isVessel ? 'vessel' : 'event');
  const draft: BookingDraft = { kind };
  const dates = parseDates(context, input, true);
  if (dates.error) return { intent: 'unsupported', reason: dates.error };
  if (dates.from) draft.startDate = dates.from;
  if (dates.to) draft.endDate = dates.to;
  const berths = matchedBerths(context);
  if (berths.length === 1 && berths[0] !== 'unassigned') draft.berthId = berths[0];
  if (notes) draft.notes = notes;
  let label = quotedText.exec(command)?.[1]?.trim();
  if (!label) {
    label = remaining.replace(/^(?:an?\s+|the\s+)?(?:new\s+)?(?:(?:event|closure|hold|vessel(?:\s+booking)?|booking|reservation)\b\s*)?(?:(?:called|named)\s+)?/i, '');
    label = label.split(/(?:^|\s+)(?:at|on|from|during|between|until|notes?:)\b/i)[0];
    for (const aliases of Object.values(berthAliases)) for (const alias of aliases) label = label.replace(new RegExp(`(?:^|\\s+)${escape(alias)}\\b.*$`, 'i'), '');
    label = label.replace(new RegExp(`(?:^|\\s+)(?:${monthPattern})\\b.*$`, 'i'), '')
      .replace(new RegExp(`(?:^|\\s+)\\d{1,2}\\s*(?:[-–—]\\s*\\d{1,2}\\s*)?(?:${monthPattern})\\b.*$`, 'i'), '')
      .replace(/(?:^|\s+)\d{4}-\d{2}-\d{2}\b.*$|(?:^|\s+)(?:today|tomorrow|next week|this month)\b.*$/i, '')
      .replace(/[\s.,;:]+$/, '').replace(/\s+(?:in|for)$/i, '').trim();
  }
  const reason = berths.length > 1 ? 'More than one berth was mentioned. Choose the berth in the booking form.'
    : berths[0] === 'unassigned' ? 'Unassigned is for legacy records. Choose a berth in the booking form.'
      : /\bat\s+/i.test(context) && !berths.length ? 'The berth name was not recognized. Choose a berth in the booking form.' : undefined;
  if (kind === 'vessel') return { intent: 'create_booking', draft, ...(label ? { vesselQuery: label } : {}), ...(reason ? { reason } : {}) };
  if (label && !/^(?:event|closure|hold|booking|reservation)$/i.test(label)) draft.title = label;
  return { intent: 'create_booking', draft, ...(reason ? { reason } : {}) };
}

/** Explicit navigation and drafting are commands, so an optional model cannot change them. */
function deterministicQuery(input: AskRequest): AskIntent | null {
  if (negatedCreation.test(outsideQuotes(input.q).split(/\bnotes?\s*:/i)[0]) && creationVerb.test(input.q)) return { intent: 'unsupported', reason: 'No booking draft was opened. To prepare one, describe the event, berth, and dates without a negation.' };
  if (creationPrefix.test(input.q)) return parseCreation(input);
  const navigation = /^(?:please\s+)?(?:go\s*to|navigate to|jump to)\b/i.test(input.q)
    || new RegExp(`^(?:please\\s+)?show(?:\\s+me)?\\s+(?:${monthPattern})(?:\\s|\\d|$)`, 'i').test(input.q);
  if (navigation) {
    const dates = parseDates(input.q, input);
    if (dates.error || !dates.from) return { intent: 'unsupported', reason: dates.error ?? 'Choose a month and year, such as “Go to January 2000”.' };
    return { intent: 'navigate', dateFrom: dates.from };
  }
  return null;
}

export function parseDeterministic(input: AskRequest): AskIntent | null {
  try {
    const command = deterministicQuery(input);
    if (command) return command;
    // Indirect creation requests may need the model to identify their intent.
    if (creationVerb.test(input.q)) return null;
    const parsed = parseQuery(input);
    if (parsed.intent === 'unsupported') return null;
    if (parsed.vesselQuery) return parsed;
    let remaining = input.q.toLowerCase();
    for (const aliases of Object.values(berthAliases)) for (const alias of aliases) remaining = remaining.replace(new RegExp(`\\b${escape(alias)}\\b`, 'gi'), ' ');
    remaining = remaining.replace(new RegExp(`\\b(?:${monthPattern})(?:\\s*\\d{4})?\\b`, 'gi'), ' ')
      .replace(/\b(?:who|what|where|when|which|was|were|is|are|at|on|in|from|to|through|until|between|for|the|a|an|me|please|show|all|everything|find|search|bookings?|reservations?|schedule|events?|closures?|maintenance|holds?|berths?|boats?|vessels?|free|available|availability|fit|space|conflicts?|double|overlaps?|too|long|two|places|next|week|this|month|today|tomorrow|year|ft|feet)\b/g, ' ')
      .replace(/[\d\s.,!?"'“”:;_\-–—/()]+/g, '');
    return remaining ? null : parsed;
  } catch (error) {
    if (error instanceof RangeError) return { intent: 'unsupported', reason: 'Enter a valid date or month.' };
    throw error;
  }
}

/** AI may identify an indirect request, but draft fields still come from the user's own words. */
export function groundCreation(input: AskRequest): AskIntent | null {
  if (negatedCreation.test(input.q)) return parseDeterministic(input);
  const verb = creationVerb.exec(input.q);
  return verb ? parseDeterministic({ ...input, q: input.q.slice(verb.index) }) : null;
}

/** A small, predictable grammar. It never uses booking rows or guesses availability. */
function parseQuery(input: AskRequest): AskIntent {
  const q = input.q.toLowerCase().trim();
  const syntax = outsideQuotes(q);
  const result: AskIntent = { intent: 'search' };
  const berths = matchedBerths(syntax);
  if (berths.length) result.berthIds = berths;
  const length = /(\d+)\s*(?:ft\b|feet\b|')/i.exec(syntax);
  if (length && Number(length[1]) >= 1 && Number(length[1]) <= 1000) result.lengthFt = Number(length[1]);

  if (/vessel.{0,15}(two places|two berths)|two places/.test(syntax)) {
    result.intent = 'issues'; result.issueTypes = ['vessel_double'];
  } else if (/too long|fit violations?/.test(syntax)) {
    result.intent = 'issues'; result.issueTypes = ['fit'];
  } else if (/conflict|double|overlap/.test(syntax)) {
    result.intent = 'issues'; result.issueTypes = ['overlap'];
  } else if (/\b(free|available|availability|fit|space)\b/.test(syntax)) result.intent = 'availability';
  else if (/\bgo to\b/.test(syntax) || new RegExp(`\\bshow me\\s+(?:${monthPattern})\\b`).test(syntax)) result.intent = 'navigate';

  const dates = parseDates(syntax, input);
  if (dates.error) return { intent: 'unsupported', reason: dates.error };
  if (dates.from) result.dateFrom = dates.from;
  if (dates.to && result.intent !== 'navigate') result.dateTo = dates.to;
  const quoted = /["“]([^"”]+)["”]/.exec(input.q)?.[1];
  const prefixed = /\b(?:R\/V|M\/V|S\/V|S\/Y|M\/Y|OS\/V|OSV|F\/V|TUG|BARGE)\s+.+?(?=\s+(?:at|on|in|from|between|during|for)\b|$)/i.exec(input.q)?.[0];
  const everything = /\b(?:everything|bookings|reservations)\s+for\s+(.+?)(?=\s+(?:at|on|in|from|during)\b|$)/i.exec(input.q)?.[1];
  const dateWords = everything?.toLowerCase().replace(new RegExp(`\\b(?:${monthPattern})(?:\\s*\\d{4})?\\b`, 'gi'), ' ')
    .replace(/\b(?:from|to|through|until|on|in|during|the|year|month|of|next|this|week|today|tomorrow)\b/g, ' ').replace(/[\d\s,.;_\-–—/]+/g, '');
  const vesselText = quoted ?? prefixed ?? (dates.from && !dateWords ? undefined : everything);
  if (vesselText) result.vesselQuery = vesselText.trim();
  if (/\bclosures?\b|maintenance/.test(syntax)) result.kinds = ['closure'];
  else if (/\bevents?\b/.test(syntax)) result.kinds = ['event'];
  else if (/\bholds?\b/.test(syntax)) result.kinds = ['hold'];
  if (result.intent === 'search' && !result.dateFrom && !result.berthIds && !result.vesselQuery && !result.kinds) {
    return { intent: 'unsupported', reason: 'Try a berth, vessel name, or date, such as “Inner Channel in July 2010”.' };
  }
  if (result.dateFrom && result.dateTo && result.dateFrom > result.dateTo) [result.dateFrom, result.dateTo] = [result.dateTo, result.dateFrom];
  return result;
}

export function parseFallback(input: AskRequest): AskIntent {
  try { return parseDeterministic(input) ?? parseQuery(input); } catch (error) {
    if (error instanceof RangeError) return { intent: 'unsupported', reason: 'Enter a valid date or month between 1997 and 2100.' };
    throw error;
  }
}

export const fallback = parseFallback;
