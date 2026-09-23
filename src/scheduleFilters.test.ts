import { describe, expect, it } from 'vitest';
import type { BerthDTO, IssueDTO, ReservationDTO } from '../shared/types';
import { adjacentScheduleMonth, clearScheduleFilters, clipScheduleBooking, filterScheduleBerths, filterScheduleBookings, filterScheduleIssues, hasScheduleFilters, parseScheduleFilters, removeScheduleFilter, resolveScheduleMonth, scheduleDateWindow, scheduleMonthSearch, scheduleOccupancy } from './scheduleFilters';

const query = (value = '') => new URLSearchParams(value);
const filters = (value = '') => parseScheduleFilters(query(value));
const booking = (overrides: Partial<ReservationDTO> = {}): ReservationDTO => ({
  id: 'one', berthId: 'west', kind: 'vessel', vesselId: 'tern',
  vessel: { id: 'tern', name: 'R/V Clear Tern', lengthFt: 120, lengthStatus: 'known' },
  title: null, startDate: '2000-01-01', endDate: '2000-01-10', notes: null,
  origin: 'legacy', sourceRef: '2000!B6:K6', fitStatus: 'ok', issues: [], createdAt: '', updatedAt: '', ...overrides,
});
const berth = (id: string, isExclusive = true): BerthDTO => ({ id, name: id, isExclusive, lengthFt: isExclusive ? 240 : null, sortOrder: 0 });
const issue = (overrides: Partial<IssueDTO> = {}): IssueDTO => ({ id: 'issue', type: 'overlap', startDate: '2000-01-05', endDate: '2000-01-07', berthId: 'west', reservation: booking(), other: null, details: {}, reviewedAt: null, reviewNote: null, ...overrides });

describe('schedule filter URL contract', () => {
  it('keeps every valid list value and deduplicates repeated keys', () => {
    expect(filters('berthIds=west,east,west&berthIds=pool&vesselIds=tern,heron&kinds=vessel,event&issueTypes=overlap,fit&q=clear%20%20tern')).toEqual({
      from: undefined, to: undefined, berthIds: ['west', 'east', 'pool'], vesselIds: ['tern', 'heron'], kinds: ['vessel', 'event'], issueTypes: ['overlap', 'fit'], q: 'clear tern',
    });
  });
  it('rejects malformed dates and unknown enumerated types without inventing dates', () => {
    expect(filters('from=2019-02-29&to=2020-02-29&kinds=unknown,vessel&issueTypes=other,fit')).toMatchObject({ from: undefined, to: '2020-02-29', kinds: ['vessel'], issueTypes: ['fit'] });
    expect(filters('from=0000-01-01&to=not-a-date')).toMatchObject({ from: undefined, to: undefined });
  });
  it('normalizes a reversed inclusive date range', () => {
    expect(filters('from=2000-12-31&to=2000-01-01')).toMatchObject({ from: '2000-01-01', to: '2000-12-31' });
  });
  it('recognizes date-only and text-only filters', () => {
    expect(hasScheduleFilters(filters())).toBe(false);
    expect(hasScheduleFilters(filters('from=2000-01-01'))).toBe(true);
    expect(hasScheduleFilters(filters('q=tern'))).toBe(true);
  });
  it('removes one chip immediately without dropping other list values or dimensions', () => {
    const search = query('month=2000-06&from=2000-01-01&to=2000-12-31&berthIds=west,east&kinds=vessel,event&q=tern');
    const next = removeScheduleFilter(search, 'berthIds', 'west');
    expect(next.get('berthIds')).toBe('east');
    expect(next.get('kinds')).toBe('vessel,event');
    expect(next.get('q')).toBe('tern');
    expect(removeScheduleFilter(next, 'dates').has('from')).toBe(false);
    expect(removeScheduleFilter(next, 'dates').has('to')).toBe(false);
    expect(search.get('berthIds')).toBe('west,east');
  });
  it('clears filter fields while retaining the selected month', () => {
    expect(clearScheduleFilters(query('month=2000-06&from=2000-01-01&to=2000-12-31&berthIds=west&vesselIds=tern&q=tern&kinds=vessel&issueTypes=fit&focus=one')).toString()).toBe('month=2000-06');
  });
});

describe('month navigation through a filtered range', () => {
  it('starts a whole-year question in January and preserves the full year', () => {
    const search = query('from=2000-01-01&to=2000-12-31&berthIds=west,east');
    expect(resolveScheduleMonth(search, '2019-12')).toBe('2000-01');
    const next = scheduleMonthSearch(search, '2000-02');
    expect(next.get('from')).toBe('2000-01-01');
    expect(next.get('to')).toBe('2000-12-31');
    expect(next.get('berthIds')).toBe('west,east');
  });
  it('bounds arrow navigation to the first and last selected months', () => {
    const range = filters('from=2000-01-20&to=2000-12-10');
    expect(adjacentScheduleMonth('2000-01', -1, range)).toBeNull();
    expect(adjacentScheduleMonth('2000-01', 1, range)).toBe('2000-02');
    expect(adjacentScheduleMonth('2000-12', 1, range)).toBeNull();
    expect(adjacentScheduleMonth('2000-12', -1, range)).toBe('2000-11');
  });
  it('clamps out-of-range shared URLs and rejects invalid month inputs', () => {
    expect(resolveScheduleMonth(query('month=2019-12&from=2000-01-01&to=2000-12-31'), '2019-12')).toBe('2000-12');
    expect(resolveScheduleMonth(query('month=2000-99&from=2000-01-01'), '2019-12')).toBe('2000-01');
    expect(resolveScheduleMonth(query('month=0000-01'), '2019-12')).toBe('2019-12');
  });
  it('lets deliberate month selection clear dates while preserving other filters', () => {
    const next = scheduleMonthSearch(query('month=2000-01&from=2000-01-01&to=2000-12-31&q=tern&vesselIds=one,two&issueTypes=fit&focus=one'), '2026-09', true);
    expect(next.get('month')).toBe('2026-09');
    expect(next.has('from')).toBe(false); expect(next.has('to')).toBe(false);
    expect(next.get('q')).toBe('tern'); expect(next.get('vesselIds')).toBe('one,two'); expect(next.get('issueTypes')).toBe('fit');
    expect(next.has('focus')).toBe(false);
  });
  it('handles the first and final supported months without overflowing date math', () => {
    expect(adjacentScheduleMonth('0001-01', -1, filters())).toBeNull();
    expect(adjacentScheduleMonth('9999-12', 1, filters())).toBeNull();
  });
});

describe('spreadsheet-style booking filters', () => {
  it('combines dimensions with AND and values within one field with OR', () => {
    const rows = [booking(), booking({ id: 'two', berthId: 'east', vesselId: 'heron', vessel: { id: 'heron', name: 'M/V Heron', lengthFt: 100, lengthStatus: 'known' } }), booking({ id: 'three', berthId: 'south' })];
    expect(filterScheduleBookings(rows, filters('berthIds=west,east&vesselIds=tern,heron&kinds=vessel')).map(row => row.id)).toEqual(['one', 'two']);
    expect(filterScheduleBookings(rows, filters('berthIds=west,east&vesselIds=tern,heron&q=heron')).map(row => row.id)).toEqual(['two']);
  });
  it('matches literal vessel names and non-vessel titles without regex or wildcard semantics', () => {
    const rows = [booking(), booking({ id: 'event', kind: 'event', vesselId: null, vessel: null, title: 'Community sail [50%]' })];
    expect(filterScheduleBookings(rows, filters('q=CLEAR%20TERN'))[0].id).toBe('one');
    expect(filterScheduleBookings(rows, filters('q=%5B50%25%5D'))[0].id).toBe('event');
    expect(filterScheduleBookings(rows, filters('q=nonexistent'))).toEqual([]);
  });
  it('includes a shared endpoint and bookings crossing the selected date window', () => {
    const rows = [booking(), booking({ id: 'before', endDate: '2000-01-04' }), booking({ id: 'after', startDate: '2000-01-11', endDate: '2000-01-20' })];
    expect(filterScheduleBookings(rows, filters('from=2000-01-05&to=2000-01-10')).map(row => row.id)).toEqual(['one']);
  });
  it('matches only unreviewed issues and preserves the original DTO and conflict signals', () => {
    const row = booking({ issues: [{ id: 'overlap', type: 'overlap', reviewed: false }, { id: 'fit', type: 'fit', reviewed: true }] });
    expect(filterScheduleBookings([row], filters('issueTypes=overlap,vessel_double'))[0]).toBe(row);
    expect(filterScheduleBookings([row], filters('issueTypes=fit'))).toEqual([]);
    expect(row.issues).toHaveLength(2);
  });
  it('does not treat a long stay as a current issue match when its issue is outside the visible window', () => {
    const row = booking({ endDate: '2000-12-31', issues: [{ id: 'january-overlap', type: 'overlap', reviewed: false }] });
    const januaryIssue = issue({ id: 'january-overlap', reservation: row, startDate: '2000-01-05', endDate: '2000-01-07' });
    // July's issue query contains no January issue, even though the booking spans both months.
    expect(filterScheduleBookings([row], filters('issueTypes=overlap'), [])).toEqual([]);
    expect(filterScheduleBookings([row], filters('issueTypes=overlap&from=2000-07-01&to=2000-07-31'), [januaryIssue])).toEqual([]);
  });
  it('uses the actual issue days within a selected range and includes one shared endpoint', () => {
    const row = booking({ endDate: '2000-01-31', issues: [{ id: 'issue', type: 'overlap', reviewed: false }] });
    const overlap = issue({ reservation: row, startDate: '2000-01-05', endDate: '2000-01-07' });
    expect(filterScheduleBookings([row], filters('issueTypes=overlap&from=2000-01-08&to=2000-01-10'), [overlap])).toEqual([]);
    expect(filterScheduleBookings([row], filters('issueTypes=overlap&from=2000-01-07&to=2000-01-10'), [overlap])).toEqual([row]);
  });
  it('filters berth rows only when berths were explicitly selected', () => {
    const berths = [berth('west'), berth('east'), berth('pool', false)];
    expect(filterScheduleBerths(berths, filters('q=tern'))).toHaveLength(3);
    expect(filterScheduleBerths(berths, filters('berthIds=west,pool')).map(row => row.id)).toEqual(['west', 'pool']);
    expect(filterScheduleBerths(berths, filters('berthIds=unknown'))).toEqual([]);
  });
});

describe('clipping, visible issues, and filtered occupancy', () => {
  it('clips bar dates to both the month and selected range without changing original dates', () => {
    const row = booking({ startDate: '1999-12-20', endDate: '2000-02-10' });
    expect(clipScheduleBooking(row, '2000-01', '2000-01-05', '2000-01-09')).toEqual({ startDate: '2000-01-05', endDate: '2000-01-09' });
    expect(row.startDate).toBe('1999-12-20'); expect(row.endDate).toBe('2000-02-10');
  });
  it('supports one-day filters and leap days, and rejects disjoint windows', () => {
    expect(scheduleDateWindow('2000-02', '2000-02-29', '2000-02-29')).toEqual({ from: '2000-02-29', to: '2000-02-29' });
    expect(scheduleDateWindow('2000-01', '2000-02-01', '2000-02-29')).toBeNull();
    expect(clipScheduleBooking(booking(), '2000-01', '2000-01-20')).toBeNull();
  });
  it('keeps an issue when its other booking is the visible side and respects its actual overlap dates', () => {
    const visible = booking({ id: 'visible' });
    const pair = issue({ reservation: booking({ id: 'hidden' }), other: visible });
    expect(filterScheduleIssues([pair], [visible], filters('from=2000-01-05&to=2000-01-05'))).toEqual([pair]);
    expect(filterScheduleIssues([pair], [visible], filters('from=2000-01-08'))).toEqual([]);
    expect(filterScheduleIssues([pair], [visible], filters('issueTypes=fit'))).toEqual([]);
    expect(filterScheduleIssues([{ ...pair, reviewedAt: '2026-01-01' }], [visible], filters())).toEqual([]);
  });
  it('counts unique occupied days over selected exclusive berths and selected days', () => {
    const rows = [booking(), booking({ id: 'overlap', startDate: '2000-01-03', endDate: '2000-01-08' }), booking({ id: 'pool', berthId: 'pool' })];
    expect(scheduleOccupancy(rows, [berth('west'), berth('east'), berth('pool', false)], '2000-01', filters('from=2000-01-05&to=2000-01-09'))).toMatchObject({ occupiedDays: 5, capacityDays: 10, percentage: 50, berthCount: 2, dayCount: 5 });
  });
  it('does not present shared-pool activity as exclusive-berth occupancy', () => {
    expect(scheduleOccupancy([booking({ berthId: 'pool' })], [berth('pool', false)], '2000-01', filters()).percentage).toBeNull();
  });
});
