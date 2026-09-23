import { addDays, eachDay, isValidDate, monthEnd, monthStart } from '../shared/dates';
import type { BerthDTO, IssueDTO, IssueType, Kind, ReservationDTO } from '../shared/types';

export interface ScheduleFilters {
  from?: string;
  to?: string;
  berthIds: string[];
  vesselIds: string[];
  q: string;
  kinds: Kind[];
  issueTypes: IssueType[];
}
export type ScheduleFilterKey = 'dates' | 'berthIds' | 'vesselIds' | 'q' | 'kinds' | 'issueTypes';
const filterKeys = ['from', 'to', 'berthIds', 'vesselIds', 'q', 'kinds', 'issueTypes'] as const;
const kinds: Kind[] = ['vessel', 'event', 'closure', 'hold'];
const issueTypes: IssueType[] = ['overlap', 'fit', 'vessel_double'];
const list = (search: URLSearchParams, key: string) => [...new Set(search.getAll(key).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean))];
const validMonth = (month: string | null): month is string => !!month && /^\d{4}-\d{2}$/.test(month) && isValidDate(`${month}-01`);

/** Lists are OR within one field. Different fields, including literal text, are ANDed. */
export function parseScheduleFilters(search: URLSearchParams): ScheduleFilters {
  let from = search.get('from') ?? undefined, to = search.get('to') ?? undefined;
  if (!isValidDate(from)) from = undefined;
  if (!isValidDate(to)) to = undefined;
  if (from && to && from > to) [from, to] = [to, from];
  return {
    from, to,
    berthIds: list(search, 'berthIds'), vesselIds: list(search, 'vesselIds'),
    q: (search.get('q') ?? '').trim().replace(/\s+/g, ' '),
    kinds: list(search, 'kinds').filter((value): value is Kind => kinds.includes(value as Kind)),
    issueTypes: list(search, 'issueTypes').filter((value): value is IssueType => issueTypes.includes(value as IssueType)),
  };
}

export function hasScheduleFilters(filters: ScheduleFilters): boolean {
  return !!(filters.from || filters.to || filters.berthIds.length || filters.vesselIds.length || filters.q || filters.kinds.length || filters.issueTypes.length);
}

/** A shared URL without a month starts at its first selected month; ranges bound navigation. */
export function resolveScheduleMonth(search: URLSearchParams, fallbackMonth: string): string {
  const filters = parseScheduleFilters(search), requested = search.get('month');
  let month = validMonth(requested) ? requested : filters.from?.slice(0, 7) ?? filters.to?.slice(0, 7) ?? fallbackMonth;
  if (!validMonth(month)) throw new RangeError('The schedule needs a valid fallback month.');
  if (filters.from && month < filters.from.slice(0, 7)) month = filters.from.slice(0, 7);
  if (filters.to && month > filters.to.slice(0, 7)) month = filters.to.slice(0, 7);
  return month;
}

export function adjacentScheduleMonth(month: string, direction: -1 | 1, filters: ScheduleFilters): string | null {
  if ((direction === -1 && month === '0001-01') || (direction === 1 && month === '9999-12')) return null;
  const next = addDays(direction === 1 ? monthEnd(month) : monthStart(month), direction).slice(0, 7);
  if ((filters.from && next < filters.from.slice(0, 7)) || (filters.to && next > filters.to.slice(0, 7))) return null;
  return next;
}

export function scheduleMonthSearch(search: URLSearchParams, month: string, clearDateRange = false): URLSearchParams {
  const next = new URLSearchParams(search);
  if (!validMonth(month)) return next;
  next.set('month', month); next.delete('focus');
  if (clearDateRange) { next.delete('from'); next.delete('to'); }
  return next;
}

export function removeScheduleFilter(search: URLSearchParams, key: ScheduleFilterKey, value?: string): URLSearchParams {
  const next = new URLSearchParams(search);
  if (key === 'dates') { next.delete('from'); next.delete('to'); }
  else if (value !== undefined && key !== 'q') {
    const remaining = list(next, key).filter(item => item !== value);
    next.delete(key);
    if (remaining.length) next.set(key, remaining.join(','));
  } else next.delete(key);
  return next;
}

export function clearScheduleFilters(search: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(search);
  filterKeys.forEach(key => next.delete(key));
  next.delete('focus');
  return next;
}

export function scheduleDateWindow(month: string, from?: string, to?: string): { from: string; to: string } | null {
  const start = from && from > monthStart(month) ? from : monthStart(month);
  const end = to && to < monthEnd(month) ? to : monthEnd(month);
  return start <= end ? { from: start, to: end } : null;
}

export function clipScheduleBooking(booking: Pick<ReservationDTO, 'startDate' | 'endDate'>, month: string, from?: string, to?: string): { startDate: string; endDate: string } | null {
  const window = scheduleDateWindow(month, from, to);
  if (!window) return null;
  const startDate = booking.startDate > window.from ? booking.startDate : window.from;
  const endDate = booking.endDate < window.to ? booking.endDate : window.to;
  return startDate <= endDate ? { startDate, endDate } : null;
}

export function filterScheduleBerths(berths: BerthDTO[], filters: ScheduleFilters): BerthDTO[] {
  return berths.filter(berth => !filters.berthIds.length || filters.berthIds.includes(berth.id));
}

export function filterScheduleBookings(bookings: ReservationDTO[], filters: ScheduleFilters, issueContext?: IssueDTO[]): ReservationDTO[] {
  const text = filters.q.toLowerCase();
  // DTO issue summaries have no dates. When the schedule supplies its month-scoped
  // issue query, a historical problem elsewhere in a long stay must not match here.
  const issueBookings = issueContext ? new Set(issueContext.filter(issue => !issue.reviewedAt
    && filters.issueTypes.includes(issue.type)
    && (!filters.from || issue.endDate >= filters.from)
    && (!filters.to || issue.startDate <= filters.to))
    .flatMap(issue => [issue.reservation.id, ...(issue.other ? [issue.other.id] : [])])) : null;
  return bookings.filter(booking => {
    if (filters.from && booking.endDate < filters.from) return false;
    if (filters.to && booking.startDate > filters.to) return false;
    if (filters.berthIds.length && !filters.berthIds.includes(booking.berthId)) return false;
    if (filters.vesselIds.length && (!booking.vesselId || !filters.vesselIds.includes(booking.vesselId))) return false;
    if (filters.kinds.length && !filters.kinds.includes(booking.kind)) return false;
    if (text && ![booking.vessel?.name, booking.title].some(value => value?.toLowerCase().replace(/\s+/g, ' ').includes(text))) return false;
    if (filters.issueTypes.length && (issueBookings ? !issueBookings.has(booking.id) : !booking.issues.some(issue => !issue.reviewed && filters.issueTypes.includes(issue.type)))) return false;
    return true;
  });
}

export function filterScheduleIssues(issues: IssueDTO[], bookings: ReservationDTO[], filters: ScheduleFilters): IssueDTO[] {
  const visible = new Set(bookings.map(booking => booking.id));
  return issues.filter(issue => !issue.reviewedAt
    && (!filters.issueTypes.length || filters.issueTypes.includes(issue.type))
    && (!filters.from || issue.endDate >= filters.from)
    && (!filters.to || issue.startDate <= filters.to)
    && (visible.has(issue.reservation.id) || (!!issue.other && visible.has(issue.other.id))));
}

/** Counts unique matching occupied days, never the sum of overlapping bars. */
export function scheduleOccupancy(bookings: ReservationDTO[], berths: BerthDTO[], month: string, filters: ScheduleFilters) {
  const window = scheduleDateWindow(month, filters.from, filters.to);
  const days = window ? eachDay(window.from, window.to) : [];
  const exclusive = berths.filter(berth => berth.isExclusive);
  const occupiedDays = exclusive.reduce((total, berth) => total + days.filter(day => bookings.some(booking => booking.berthId === berth.id && booking.startDate <= day && booking.endDate >= day)).length, 0);
  const capacityDays = exclusive.length * days.length;
  return { occupiedDays, capacityDays, berthCount: exclusive.length, dayCount: days.length, percentage: capacityDays ? Math.round(occupiedDays / capacityDays * 100) : null };
}
