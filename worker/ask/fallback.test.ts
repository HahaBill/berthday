import { describe, expect, it } from 'vitest';
import { parseDeterministic, parseFallback } from './fallback';

const parse = (q: string) => parseFallback({ q, today: '2026-09-22', viewedMonth: '2019-12' });

describe('deterministic Ask parser', () => {
  it('finds a berth and a month', () => expect(parse('who was at inner channel in july 2010')).toEqual({ intent: 'search', berthIds: ['inner-channel'], dateFrom: '2010-07-01', dateTo: '2010-07-31' }));
  it('extracts availability, length, and an inclusive day range', () => expect(parse('which berths fit a 120 ft boat 3–10 July 2026')).toEqual({ intent: 'availability', lengthFt: 120, dateFrom: '2026-07-03', dateTo: '2026-07-10' }));
  it('finds double-bookings for an entire year', () => expect(parse('double bookings in 2017')).toEqual({ intent: 'issues', issueTypes: ['overlap'], dateFrom: '2017-01-01', dateTo: '2017-12-31' }));
  it('extracts an unprefixed vessel name', () => expect(parse('everything for clear tern')).toEqual({ intent: 'search', vesselQuery: 'clear tern' }));
  it('navigates to a month', () => expect(parse('go to march 2012')).toEqual({ intent: 'navigate', dateFrom: '2012-03-01' }));
  it('uses client today for next calendar week', () => expect(parse('available next week')).toMatchObject({ dateFrom: '2026-09-28', dateTo: '2026-10-04' }));
  it('uses client today for this month', () => expect(parse('free this month')).toMatchObject({ dateFrom: '2026-09-01', dateTo: '2026-09-30' }));
  it('recognizes aliases and two ISO dates', () => expect(parse('NPW 2026-08-10 to 2026-08-03')).toMatchObject({ berthIds: ['north-pier-west'], dateFrom: '2026-08-03', dateTo: '2026-08-10' }));
  it('recognizes quoted and prefixed vessel names', () => {
    expect(parse('everything for "Clear Tern"')).toMatchObject({ vesselQuery: 'Clear Tern' });
    expect(parse('R/V Clear Tern in July 2010')).toMatchObject({ vesselQuery: 'R/V Clear Tern' });
  });
  it('declines invalid calendar ranges and unrelated requests', () => {
    expect(parse('fit a boat 30–31 February 2026').intent).toBe('unsupported');
    expect(parse('write a poem').intent).toBe('unsupported');
  });

  it.each(['Go to January 2000', 'Go to January2000', 'Go to Jan 2000', 'Show me January2000'])('handles explicit navigation: %s', query => {
    expect(parse(query)).toEqual({ intent: 'navigate', dateFrom: '2000-01-01' });
    expect(parseDeterministic({ q: query, today: '2026-09-22', viewedMonth: '2019-12' })).toEqual({ intent: 'navigate', dateFrom: '2000-01-01' });
  });

  it.each([
    ['bookings in 2000', { intent: 'search', dateFrom: '2000-01-01', dateTo: '2000-12-31' }],
    ['bookings for 2000', { intent: 'search', dateFrom: '2000-01-01', dateTo: '2000-12-31' }],
    ['bookings for July 2010', { intent: 'search', dateFrom: '2010-07-01', dateTo: '2010-07-31' }],
    ['events in July 2010', { intent: 'search', kinds: ['event'], dateFrom: '2010-07-01', dateTo: '2010-07-31' }],
    ['Inner Channel July 2010', { intent: 'search', berthIds: ['inner-channel'], dateFrom: '2010-07-01', dateTo: '2010-07-31' }],
  ])('parses structural filters before AI: %s', (q, expected) => {
    expect(parseDeterministic({ q, today: '2026-09-22', viewedMonth: '2019-12' })).toEqual(expected);
  });

  it('keeps unknown vessel words available to the model', () => {
    expect(parseDeterministic({ q: 'Clear Tern in 2000', today: '2026-09-22', viewedMonth: '2019-12' })).toBeNull();
  });

  it('keeps quoted vessel names separate from date and berth keywords', () => {
    expect(parse('everything for "July 2010"')).toEqual({ intent: 'search', vesselQuery: 'July 2010' });
    expect(parse('everything for "North Pier Face"')).toEqual({ intent: 'search', vesselQuery: 'North Pier Face' });
  });

  it('drafts the requested community sail event with month-first dates', () => {
    expect(parse('Create a community sail day at North Pier Face on July 10, 2026')).toEqual({ intent: 'create_booking', draft: {
      kind: 'event', title: 'community sail day', berthId: 'north-pier-face', startDate: '2026-07-10', endDate: '2026-07-10',
    } });
  });

  it('drafts a quoted title, berth alias, and a month-first range', () => {
    expect(parse('Add event "Open day" at NPF July 10–12 2026')).toEqual({ intent: 'create_booking', draft: {
      kind: 'event', title: 'Open day', berthId: 'north-pier-face', startDate: '2026-07-10', endDate: '2026-07-12',
    } });
  });

  it('uses the client current year for a creation day without a year', () => {
    expect(parse('Schedule Open day at NPF on July 10')).toMatchObject({ draft: { title: 'Open day', startDate: '2026-07-10', endDate: '2026-07-10' } });
  });

  it.each([
    ['today', '2026-09-22', '2026-09-22'],
    ['tomorrow', '2026-09-23', '2026-09-23'],
    ['next week', '2026-09-28', '2026-10-04'],
    ['2026-07-10 to 2026-07-12', '2026-07-10', '2026-07-12'],
    ['3–10 July 2026', '2026-07-03', '2026-07-10'],
  ])('uses explicit creation dates: %s', (words, startDate, endDate) => {
    expect(parse(`Create event "Open day" at NPF ${words}`)).toMatchObject({ draft: { startDate, endDate } });
  });

  it('leaves unstated title, berth, and dates absent instead of borrowing the historical month', () => {
    expect(parse('Add event Open day')).toEqual({ intent: 'create_booking', draft: { kind: 'event', title: 'Open day' } });
    expect(parse('Create event at NPF')).toEqual({ intent: 'create_booking', draft: { kind: 'event', berthId: 'north-pier-face' } });
    expect(parse('Add event Open day in July')).toMatchObject({ draft: { kind: 'event', title: 'Open day' } });
    expect(parse('Add event Open day in July').draft?.startDate).toBeUndefined();
    expect(parse('Create event Open day at NPF from July 10').draft?.endDate).toBeUndefined();
  });

  it('requires a berth choice when names are unknown or ambiguous', () => {
    for (const phrase of ['at Mystery Dock', 'at NPF or SFE', 'at unassigned']) {
      const result = parse(`Create event Open day ${phrase} on July 10, 2026`);
      expect(result.intent).toBe('create_booking'); expect(result.draft?.berthId).toBeUndefined(); expect(result.reason).toBeTruthy();
    }
  });

  it('does not interpret title text as a berth or date', () => {
    expect(parse('Create event "NPF today celebration" at SFE on July 10, 2026')).toMatchObject({ draft: {
      title: 'NPF today celebration', berthId: 'south-float-east', startDate: '2026-07-10', endDate: '2026-07-10',
    } });
  });

  it('does not interpret notes text as a date, berth, or open-ended range', () => {
    for (const notes of ['follow-up 2026-07-12', 'came from South Float West']) {
      expect(parse(`Create event "Arrival" at North Pier Face on 2026-07-10 notes: ${notes}`)).toMatchObject({ draft: {
        kind: 'event', title: 'Arrival', berthId: 'north-pier-face', startDate: '2026-07-10', endDate: '2026-07-10', notes,
      } });
    }
  });

  it('creates vessel drafts without inventing a registry ID', () => {
    expect(parse('Book R/V Clear Tern at NPF July 10, 2026')).toEqual({ intent: 'create_booking', vesselQuery: 'R/V Clear Tern', draft: {
      kind: 'vessel', berthId: 'north-pier-face', startDate: '2026-07-10', endDate: '2026-07-10',
    } });
  });

  it.each(['Do not create an event', "Don't add event Open day", "I don't want to create an event", 'Create event Open day on February 30, 2026', 'Create event Open day July 12–10 2026', 'Create event Open day on July 10 2026 and August 20 2026', 'Create event Open day on 2026-07-10 and 2026-07-12'])('declines unsafe or invalid drafting: %s', query => {
    expect(parse(query).intent).toBe('unsupported'); expect(parse(query).draft).toBeUndefined();
  });
});
