import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import type { PaginatedResponse, ReservationDTO } from '../../shared/types';
import { addDays, diffDays, isValidDate, monthEnd, monthStart } from '../../shared/dates';
import { allPages, api, bookingName, dateLabel, params } from '../api';
import { useApp } from '../context';
import Icon from '../components/Icon';
import { EmptyState, ErrorState, Loading, Status } from '../components/UI';
import '../styles/views.css';

type Window = { from: string; to: string };
type PagePosition = { windowIndex: number; cursor: string | null };
type BookingPage = { items: ReservationDTO[]; nextPage: PagePosition | null };

function dateWindows(from: string, to: string): Window[] {
  const windows: Window[] = [];
  for (let start = from; start <= to;) {
    const end = addDays(start, 399) < to ? addDays(start, 399) : to;
    windows.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return windows;
}
function csvCell(value: unknown) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export default function BookingsView() {
  const { meta, newBooking, showBooking, notify } = useApp();
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useSearchParams();
  const latestMonth = meta.dataRange.to.slice(0, 7);
  const history = search.get('history') === 'true' && !search.has('from') && !search.has('to');
  const from = history ? meta.dataRange.from : search.get('from') ?? monthStart(latestMonth);
  const to = history ? meta.dataRange.to : search.get('to') ?? monthEnd(latestMonth);
  const filters = { berthId: search.get('berthId'), vesselId: search.get('vesselId'), kind: search.get('kind'), q: search.get('q'), hasIssues: search.get('hasIssues') === 'true' ? true : undefined };
  const validRange = isValidDate(from) && isValidDate(to) && to >= from && (history || diffDays(from, to) <= 400);
  const windows = validRange ? history ? dateWindows(from, to) : [{ from, to }] : [];
  const query = useInfiniteQuery({
    queryKey: ['reservations', 'list', filters, from, to, history],
    queryFn: async ({ pageParam }): Promise<BookingPage> => {
      let position: PagePosition | null = pageParam;
      // Each API request remains bounded, even when the visible search spans decades.
      // Empty windows and continuations already displayed in an earlier window are skipped.
      while (position) {
        const window: Window = windows[position.windowIndex];
        const page: PaginatedResponse<ReservationDTO> = await api<PaginatedResponse<ReservationDTO>>(`/reservations?${params({ ...filters, ...window, limit: 50, cursor: position.cursor })}`);
        const items = page.items.filter(row => position!.windowIndex === 0 || row.startDate >= window.from);
        const nextPage: PagePosition | null = page.nextCursor ? { ...position, cursor: page.nextCursor } : position.windowIndex + 1 < windows.length ? { windowIndex: position.windowIndex + 1, cursor: null } : null;
        if (items.length || !nextPage) return { items, nextPage };
        position = nextPage;
      }
      return { items: [], nextPage: null };
    },
    initialPageParam: { windowIndex: 0, cursor: null } as PagePosition,
    getNextPageParam: last => last.nextPage ?? undefined,
    enabled: validRange,
  });
  const change = (key: string, value: string) => setSearch(current => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); return next; }, { replace: true });
  const setRangeMode = (allHistory: boolean) => setSearch(current => {
    const next = new URLSearchParams(current);
    if (allHistory) { next.set('history', 'true'); next.delete('from'); next.delete('to'); }
    else { next.delete('history'); next.set('from', monthStart(latestMonth)); next.set('to', monthEnd(latestMonth)); }
    return next;
  }, { replace: true });
  const rows = [...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(row => [row.id, row])).values()];
  async function exportHistory() {
    setExporting(true);
    try {
      const records = new Map<string, ReservationDTO>();
      for (const window of windows) {
        for (const row of await allPages<ReservationDTO>(`/reservations?${params({ ...filters, ...window })}`)) records.set(row.id, row);
      }
      const headers = ['id', 'berthId', 'kind', 'vesselId', 'vessel', 'title', 'startDate', 'endDate', 'notes', 'origin', 'sourceRef', 'fitStatus', 'issues', 'createdAt', 'updatedAt'] as const;
      const csv = [headers.map(csvCell).join(','), ...[...records.values()].map(row => headers.map(key => csvCell(row[key])).join(','))].join('\r\n');
      const url = URL.createObjectURL(new Blob([`\uFEFF${csv}\r\n`], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `berthday-history-${from}-${to}.csv`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`Exported ${records.size.toLocaleString()} matching bookings from the imported history.`);
    } catch (error) { notify(error instanceof Error ? `Export failed: ${error.message}` : 'The export could not be completed. Please try again.'); }
    finally { setExporting(false); }
  }
  const filtered = !!(filters.berthId || filters.kind || filters.q || filters.hasIssues || filters.vesselId);
  return <section className="secondary-view bookings-view">
    <div className="page-heading"><div><span className="eyebrow">Every stay, in one place</span><h1>Bookings</h1><p>Search the schedule, check the details, and plan the next arrival.</p></div><div className="heading-actions"><Link className="button" to="/import"><Icon name="import"/>Import Excel</Link><>{history ? <button className="button" onClick={() => void exportHistory()} disabled={exporting}><Icon name="download"/>{exporting ? 'Exporting…' : 'Export CSV'}</button> : <a className={`button${validRange ? '' : ' disabled'}`} href={validRange ? `/api/export.csv?${params({ ...filters, from, to })}` : undefined} aria-disabled={!validRange} download><Icon name="download"/>Export CSV</a>}</><button className="button primary" disabled={!validRange} onClick={() => newBooking(history ? undefined : { startDate: from, endDate: from })}><Icon name="plus"/>New booking</button></div></div>
    <div className="filter-bar booking-filters">
      <label className="field search-field"><span>Search bookings</span><div className="input-with-icon"><Icon name="search"/><input type="search" value={filters.q ?? ''} maxLength={300} placeholder="Vessel or booking title" onChange={e => change('q', e.target.value)}/></div></label>
      <label className="field"><span>Date range</span><select value={history ? 'history' : 'dates'} onChange={e => setRangeMode(e.target.value === 'history')}><option value="dates">Selected dates</option><option value="history">All imported history</option></select></label>
      <label className="field"><span>From</span><input type="date" value={from} disabled={history} onChange={e => change('from', e.target.value)}/></label>
      <label className="field"><span>Through</span><input type="date" value={to} disabled={history} min={from} onChange={e => change('to', e.target.value)}/></label>
      <label className="field"><span>Berth</span><select value={filters.berthId ?? ''} onChange={e => change('berthId', e.target.value)}><option value="">All berths</option>{meta.berths.map(berth => <option key={berth.id} value={berth.id}>{berth.name}</option>)}</select></label>
      <label className="field"><span>Kind</span><select value={filters.kind ?? ''} onChange={e => change('kind', e.target.value)}><option value="">All kinds</option><option value="vessel">Vessel</option><option value="event">Event</option><option value="closure">Closure</option><option value="hold">Hold</option></select></label>
      <label className="checkbox-field"><input type="checkbox" checked={!!filters.hasIssues} onChange={e => change('hasIssues', e.target.checked ? 'true' : '')}/>Has issues</label>
    </div>
    {!validRange && <p className="inline-error" role="alert">Choose valid start and end dates, with the last date no more than 400 days after the start.</p>}
    <div className="table-card"><div className="table-caption"><div><strong>{rows.length.toLocaleString()} {query.hasNextPage || query.isPending ? 'bookings loaded' : 'bookings'}</strong><span className="muted">{history ? 'All imported history · ' : ''}{validRange ? `${dateLabel(from, { month: 'short', day: 'numeric', year: 'numeric' })} – ${dateLabel(to, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Select a date range'} · Dates are inclusive</span></div>{filtered && <button className="text-button small button" onClick={() => setSearch(history ? { history: 'true' } : { from, to })}>Clear filters<Icon name="x" size={14}/></button>}</div>
      {query.isPending && validRange ? <Loading label="Loading bookings…"/> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()}/> : !rows.length ? <EmptyState icon="calendar" title="No bookings in this view">{history ? 'No bookings match across the full imported history. Try another vessel name or clear the filters.' : 'Try another date range or clear the filters to see more of the schedule.'}</EmptyState> : <div className="table-scroll"><table className="data-table bookings-table"><thead><tr><th>Vessel / booking</th><th>Berth</th><th>First day</th><th>Last day</th><th>Stay</th><th>Fit</th><th>Issues</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map(row => <tr key={row.id} onClick={() => showBooking(row.id)} className="clickable-row"><td><button className="row-name" onClick={e => { e.stopPropagation(); showBooking(row.id); }}><span className={`booking-kind-mark kind-${row.kind}`}><Icon name={row.kind === 'vessel' ? 'ship' : row.kind === 'event' ? 'calendar' : row.kind === 'closure' ? 'alert' : 'clock'} size={17}/></span><span><strong>{bookingName(row)}</strong><small>{row.kind[0].toUpperCase() + row.kind.slice(1)}{row.origin === 'legacy' ? ' · Imported' : ''}</small></span></button></td><td>{meta.berths.find(berth => berth.id === row.berthId)?.name ?? row.berthId}</td><td className="date-cell">{dateLabel(row.startDate, { month: 'short', day: 'numeric', year: 'numeric' })}</td><td className="date-cell">{dateLabel(row.endDate, { month: 'short', day: 'numeric', year: 'numeric' })}</td><td className="number-cell">{diffDays(row.startDate, row.endDate) + 1}d</td><td><Status value={row.fitStatus}/></td><td>{row.issues.filter(issue => !issue.reviewed).length ? <span className="issue-count"><Icon name="alert" size={13}/>{row.issues.filter(issue => !issue.reviewed).length}</span> : <span className="muted">—</span>}</td><td><Icon name="right" size={15}/></td></tr>)}</tbody></table></div>}
      {!!rows.length && <div className="pagination"><span className="muted">{query.hasNextPage ? history ? 'Continue through the imported history.' : 'More bookings are available.' : history ? 'All imported years searched; each booking appears once.' : 'You’re viewing all matching bookings.'}</span>{query.hasNextPage && <button className="button small" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? 'Loading…' : 'Load more bookings'}<Icon name="down" size={14}/></button>}</div>}
    </div>
  </section>;
}
