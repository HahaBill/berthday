import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { IssueDTO, ReservationDTO, VesselDTO } from '../../shared/types';
import { addDays, monthEnd, monthStart, todayIn } from '../../shared/dates';
import { allPages, bookingName, dateLabel, issueLabel, params, rangeLabel } from '../api';
import { useApp } from '../context';
import { adjacentScheduleMonth, clearScheduleFilters, filterScheduleBerths, filterScheduleBookings, filterScheduleIssues, hasScheduleFilters, parseScheduleFilters, removeScheduleFilter, resolveScheduleMonth, scheduleDateWindow, scheduleMonthSearch, scheduleOccupancy, type ScheduleFilterKey } from '../scheduleFilters';
import MonthGrid from '../components/MonthGrid';
import AskBar from '../components/AskBar';
import Icon from '../components/Icon';
import { EmptyState, ErrorState, Loading } from '../components/UI';
import '../styles/schedule-filters.css';

export default function ScheduleView() {
  const { meta, findBerth } = useApp();
  const [search, setSearch] = useSearchParams();
  const searchKey = search.toString();
  const filters = useMemo(() => parseScheduleFilters(search), [searchKey]);
  const filtered = hasScheduleFilters(filters);
  const month = resolveScheduleMonth(search, (meta.dataRange?.to ?? todayIn()).slice(0, 7));
  const from = monthStart(month), to = monthEnd(month);
  // Fetch the complete month, then filter the display. Original issues remain on each
  // booking even when another side of its conflict is hidden by the current filters.
  const reservations = useQuery({ queryKey: ['reservations', month], queryFn: () => allPages<ReservationDTO>(`/reservations?${params({ from, to })}`) });
  const issues = useQuery({ queryKey: ['issues', month], queryFn: () => allPages<IssueDTO>(`/issues?${params({ from, to })}`) });
  const vessels = useQuery({ queryKey: ['vessels', 'options'], queryFn: () => allPages<VesselDTO>('/vessels'), enabled: filters.vesselIds.length > 0 });
  const rows = useMemo(() => {
    const window = scheduleDateWindow(month, filters.from, filters.to);
    return window ? filterScheduleBookings(reservations.data ?? [], { ...filters, ...window }, issues.data ?? []) : [];
  }, [reservations.data, issues.data, filters, month]);
  const bookingsPending = reservations.isPending || (filters.issueTypes.length > 0 && issues.isPending);
  const bookingsError = reservations.error ?? (filters.issueTypes.length > 0 ? issues.error : null);
  const bookingsReady = !bookingsPending && !bookingsError;
  const berths = useMemo(() => filterScheduleBerths(meta.berths, filters), [meta.berths, filters]);
  const visibleIssues = useMemo(() => filterScheduleIssues(issues.data ?? [], rows, filters), [issues.data, rows, filters]);
  const visibleIds = new Set(rows.map(row => row.id));
  const previousMonth = adjacentScheduleMonth(month, -1, filters), nextMonth = adjacentScheduleMonth(month, 1, filters);
  const changeMonth = (next: string, clearDates = false) => setSearch(current => scheduleMonthSearch(current, next, clearDates));
  const removeFilter = (key: ScheduleFilterKey, value?: string) => setSearch(current => {
    const next = removeScheduleFilter(current, key, value); next.set('month', month); return next;
  });
  const resetFilters = () => setSearch(current => { const next = clearScheduleFilters(current); next.set('month', month); return next; });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof HTMLElement && event.target.closest('input,select,textarea,dialog,button,[contenteditable="true"]'))) return;
      const next = event.key === 'ArrowLeft' ? previousMonth : event.key === 'ArrowRight' ? nextMonth : null;
      if (next) { event.preventDefault(); changeMonth(next); }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, [month, searchKey]);
  const focusedId = search.get('focus');
  useEffect(() => {
    if (!focusedId || !rows.some(row => row.id === focusedId)) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(`booking-${focusedId}`);
      element?.scrollIntoView({ block: 'center', inline: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      element?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedId, rows]);
  const uniqueVessels = new Set(rows.filter(row => row.kind === 'vessel').map(row => row.vesselId)).size;
  const occupancy = scheduleOccupancy(rows, berths, month, filters);
  const issuesPending = reservations.isPending || issues.isPending;
  const issuesError = reservations.error ?? issues.error;
  const issueCount = issuesPending || issuesError ? '–' : visibleIssues.length;
  const bookingCount = bookingsReady ? rows.length : '–';
  const dateChip = filters.from && filters.to ? `Dates: ${rangeLabel(filters.from, filters.to)}` : filters.from ? `From: ${dateLabel(filters.from, { day: 'numeric', month: 'short', year: 'numeric' })}` : filters.to ? `Through: ${dateLabel(filters.to, { day: 'numeric', month: 'short', year: 'numeric' })}` : null;
  const chips: { key: ScheduleFilterKey; value?: string; label: string }[] = [
    ...(dateChip ? [{ key: 'dates' as const, label: dateChip }] : []),
    ...filters.berthIds.map(id => ({ key: 'berthIds' as const, value: id, label: `Berth: ${meta.berths.find(berth => berth.id === id)?.name ?? id}` })),
    ...filters.vesselIds.map(id => ({ key: 'vesselIds' as const, value: id, label: `Vessel: ${vessels.data?.find(vessel => vessel.id === id)?.name ?? rows.find(row => row.vesselId === id)?.vessel?.name ?? id}` })),
    ...(filters.q ? [{ key: 'q' as const, label: `Search: ${filters.q}` }] : []),
    ...filters.kinds.map(kind => ({ key: 'kinds' as const, value: kind, label: `Kind: ${kind[0].toUpperCase() + kind.slice(1)}` })),
    ...filters.issueTypes.map(type => ({ key: 'issueTypes' as const, value: type, label: `Issue: ${issueLabel(type)}` })),
  ];
  const resourceCount = berths.filter(berth => berth.id !== 'unassigned' || rows.some(row => row.berthId === berth.id)).length;
  return <>
    <div className="page-heading"><div><div className="eyebrow">Your harbor, at a glance</div><h1>Berth schedule</h1><p>A clear view of what’s arriving, staying, and heading out.</p></div><div className="archive-indicator"><Icon name="import" size={16}/><div>Legacy schedule<span>{meta.dataRange?.from.slice(0,4)} – {meta.dataRange?.to.slice(0,4)}</span></div></div></div>
    <AskBar viewedMonth={month}/>
    {filtered && <section className="schedule-filter-panel" aria-label="Active schedule filters"><div className="schedule-filter-chips"><span className="schedule-filter-label"><Icon name="filter" size={15}/>Filters</span>{chips.map(chip => <button key={`${chip.key}:${chip.value ?? ''}`} className="filter-chip" onClick={() => removeFilter(chip.key, chip.value)} aria-label={`Remove ${chip.label}`}><span>{chip.label}</span><Icon name="x" size={12}/></button>)}<button className="button small text-button clear-schedule-filters" onClick={resetFilters}>Clear filters</button></div><p className="schedule-filter-explanation">The grid updates immediately. Month arrows keep these filters; choosing a month, Today, or Latest data clears the date range.</p></section>}
    <div className="schedule-stats"><div><span className="stat-icon blue"><Icon name="calendar"/></span><div><strong>{bookingCount}<span>{filtered ? 'matching bookings' : 'bookings this month'}</span></strong></div></div><div><span className="stat-icon teal"><Icon name="ship"/></span><div><strong>{bookingsReady ? uniqueVessels : '–'}<span>{filtered ? 'matching vessels' : 'vessels scheduled'}</span></strong></div></div><div><span className="stat-icon green"><Icon name="anchor"/></span><div><strong>{bookingsReady && occupancy.percentage != null ? `${occupancy.percentage}%` : '–'}<span>{filtered ? 'matching occupancy' : 'berth occupancy'}</span></strong></div></div><div><span className="stat-icon amber"><Icon name="alert"/></span><div><strong>{issueCount}<span>{filtered ? 'matching issues' : 'issues to review'}</span></strong></div></div></div>
    {filtered && bookingsReady && <p className="filtered-occupancy-note">Occupancy uses matching bookings across {occupancy.berthCount} exclusive {occupancy.berthCount === 1 ? 'berth' : 'berths'} and {occupancy.dayCount} selected {occupancy.dayCount === 1 ? 'day' : 'days'} in this month. Hidden bookings may still occupy these berths.</p>}
    <div className="schedule-layout"><section className="schedule-card" aria-label="Monthly berth schedule"><div className="schedule-toolbar"><div className="month-navigation"><div className="arrow-group"><button className="icon-button" aria-label="Previous month" disabled={!previousMonth} onClick={() => previousMonth && changeMonth(previousMonth)}><Icon name="left" size={16}/></button><button className="icon-button" aria-label="Next month" disabled={!nextMonth} onClick={() => nextMonth && changeMonth(nextMonth)}><Icon name="right" size={16}/></button></div><label className="month-control"><span>{dateLabel(from, { month: 'long', year: 'numeric' })}</span><Icon name="down" size={14}/><input type="month" aria-label="Choose month" value={month} onChange={event => event.target.value && changeMonth(event.target.value, true)}/></label></div><div className="month-actions"><button className="button small" onClick={() => changeMonth((meta.dataRange?.to ?? todayIn()).slice(0, 7), true)}>Latest data</button><button className="button small text-button" onClick={() => changeMonth(todayIn().slice(0, 7), true)}>Today</button></div></div>
      <div className="grid-information"><span><span className="tiny-dot"/>{filters.berthIds.length ? 'Selected berths' : 'All berths'} <span className="muted">· {resourceCount} {resourceCount === 1 ? 'resource' : 'resources'}</span></span><span><Icon name="plus" size={12}/>{filtered ? 'Click a day to start a booking' : 'Click or drag empty days to book'}</span></div>
      {bookingsPending ? <Loading/> : bookingsError ? <ErrorState error={bookingsError} retry={() => { void reservations.refetch(); void issues.refetch(); }}/> : !berths.length ? <EmptyState icon="filter" title="No berths match these filters">Remove a berth filter to restore its schedule row.</EmptyState> : <MonthGrid month={month} reservations={rows} berths={berths} focus={focusedId} from={filters.from} to={filters.to}/>}
      {bookingsReady && rows.length === 0 && <div className="schedule-empty-filter" role="status"><Icon name={filtered ? 'filter' : 'calendar'} size={18}/><div><strong>{filtered ? 'No bookings match these filters in this month.' : 'No bookings are scheduled in this month.'}</strong><p>{filtered ? 'Use the month arrows to explore the selected dates, remove a filter, or clear all filters.' : 'Select Latest data to explore the imported schedule, or choose a day to add a booking.'}</p></div>{filtered && <button className="button small" onClick={resetFilters}>Clear filters</button>}</div>}
      <div className="grid-legend"><span><i className="legend-vessel"/>Vessel</span><span><i className="legend-event"/>Event</span><span><i className="legend-closure"/>Closure</span><span><i className="legend-hold"/>Hold</span><span className="legend-divider"/><span><i className="legend-conflict"/>Conflict</span><span><i className="legend-fit"/>Fit issue</span><span className="inclusive-note">Dates are inclusive</span></div>
    </section><aside className="schedule-sidebar"><div className="sidebar-card"><div className="sidebar-heading"><h3><Icon name="alert" size={17}/>{filtered ? 'Matching issues' : 'Issues this month'}</h3><span className="count-badge">{issueCount}</span></div><p className="sidebar-description">{filtered ? 'Unreviewed issues affecting the bookings shown.' : 'Review unconfirmed changes and booking conflicts.'}</p>
      {issuesPending ? <Loading label="Checking schedule issues…"/> : issuesError ? <ErrorState error={issuesError} retry={() => { void reservations.refetch(); void issues.refetch(); }}/> : visibleIssues.length ? <div className="month-issues">{visibleIssues.slice(0, 4).map(issue => {
        const selected = visibleIds.has(issue.reservation.id) ? issue.reservation : issue.other ?? issue.reservation;
        return <article className={`compact-issue issue-${issue.type}`} key={issue.id}><div className="issue-type"><span className="tiny-dot"/>{issueLabel(issue.type)}</div><strong>{bookingName(selected)}</strong><p>{meta.berths.find(berth => berth.id === selected.berthId)?.name}</p><div className="compact-issue-bottom"><span>{dateLabel(issue.startDate)} – {dateLabel(issue.endDate)}</span><button onClick={() => setSearch(current => { const next = new URLSearchParams(current); next.set('month', month); next.set('focus', selected.id); return next; })}>Show<Icon name="arrow" size={14}/></button></div></article>;
      })}</div> : <div className="month-clear"><span><Icon name="check" size={23}/></span><strong>{filtered ? 'No matching issues' : 'All clear this month'}</strong><p>{filtered ? 'No unreviewed issues affect the bookings shown.' : 'No unresolved schedule issues.'}</p></div>}
      <Link className="sidebar-link" to="/issues">View all issues<Icon name="arrow" size={16}/></Link></div>
      <div className="find-prompt"><div className="compass-graphic"><Icon name="anchor" size={24}/></div><h3>Room for your next arrival?</h3><p>Find an available berth that fits your vessel and your dates.</p><button className="button" onClick={() => findBerth({ start: from, end: addDays(from, 6) })}>Find a berth<Icon name="arrow" size={16}/></button></div>
      <div className="schedule-note"><Icon name="help" size={16}/><p>One booking per berth, per day.<br/>Shared resources allow multiple vessels.</p></div>
    </aside></div>
  </>;
}
