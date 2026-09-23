import { describe, expect, it } from 'vitest';
import { parseFallback } from './fallback';

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
});
