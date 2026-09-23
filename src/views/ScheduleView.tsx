import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { IssueDTO, ReservationDTO } from '../../shared/types';
import { addDays, isValidDate, monthEnd, monthStart, todayIn } from '../../shared/dates';
import { allPages, bookingName, dateLabel, issueLabel, params, rangeLabel } from '../api';
import { useApp } from '../context';
import MonthGrid from '../components/MonthGrid';
import AskBar from '../components/AskBar';
import Icon from '../components/Icon';
import { EmptyState, ErrorState, Loading } from '../components/UI';

export default function ScheduleView() {
  const { meta, findBerth, showBooking } = useApp();
  const [search, setSearch] = useSearchParams();
  const raw = search.get('month');
  const month = raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) && isValidDate(`${raw}-01`) ? raw : (meta.dataRange?.to ?? todayIn()).slice(0, 7);
  const from = monthStart(month), to = monthEnd(month);
  const reservations = useQuery({ queryKey: ['reservations', month], queryFn: () => allPages<ReservationDTO>(`/reservations?${params({ from, to })}`) });
  const issues = useQuery({ queryKey: ['issues', month], queryFn: () => allPages<IssueDTO>(`/issues?${params({ from, to })}`) });
  const changeMonth = (next: string) => { if (isValidDate(`${next}-01`)) setSearch({ month: next }); };
  const shift = (direction: number) => { if ((direction < 0 && month === '0001-01') || (direction > 0 && month === '9999-12')) return; changeMonth((direction > 0 ? addDays(to, 1) : addDays(from, -1)).slice(0, 7)); };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if ((event.target as HTMLElement).closest('input,select,textarea,dialog,button')) return; if (event.key === 'ArrowLeft') shift(-1); if (event.key === 'ArrowRight') shift(1); };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, [month]);
  const rows = reservations.data ?? [];
  const focusedId = search.get('focus');
  useEffect(() => {
    if (!focusedId || !reservations.data) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(`booking-${focusedId}`);
      element?.scrollIntoView({ block: 'center', inline: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      element?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedId, reservations.data]);
  const uniqueVessels = new Set(rows.filter(r => r.kind === 'vessel').map(r => r.vesselId)).size;
  const exclusive = meta.berths.filter(b => b.isExclusive);
  const totalDays = Number(to.slice(-2));
  const occupied = exclusive.reduce((sum, b) => sum + new Set(rows.filter(r => r.berthId === b.id).flatMap(r => Array.from({ length: totalDays }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`).filter(d => r.startDate <= d && r.endDate >= d))).size, 0);
  const occupancy = exclusive.length ? Math.round(occupied / (exclusive.length * totalDays) * 100) : 0;
  return <>
    <div className="page-heading"><div><div className="eyebrow">Your harbor, at a glance</div><h1>Berth schedule</h1><p>A clear view of what’s arriving, staying, and heading out.</p></div><div className="archive-indicator"><Icon name="import" size={16}/><div>Legacy schedule<span>{meta.dataRange?.from.slice(0,4)} – {meta.dataRange?.to.slice(0,4)}</span></div></div></div>
    <AskBar viewedMonth={month}/>
    <div className="schedule-stats"><div><span className="stat-icon blue"><Icon name="calendar"/></span><div><strong>{rows.length}<span>bookings this month</span></strong></div></div><div><span className="stat-icon teal"><Icon name="ship"/></span><div><strong>{uniqueVessels}<span>vessels scheduled</span></strong></div></div><div><span className="stat-icon green"><Icon name="anchor"/></span><div><strong>{occupancy}%<span>berth occupancy</span></strong></div></div><div><span className="stat-icon amber"><Icon name="alert"/></span><div><strong>{issues.data?.length ?? '–'}<span>issues to review</span></strong></div></div></div>
    <div className="schedule-layout"><section className="schedule-card" aria-label="Monthly berth schedule"><div className="schedule-toolbar"><div className="month-navigation"><div className="arrow-group"><button className="icon-button" aria-label="Previous month" onClick={() => shift(-1)}><Icon name="left" size={16}/></button><button className="icon-button" aria-label="Next month" onClick={() => shift(1)}><Icon name="right" size={16}/></button></div><label className="month-control"><span>{dateLabel(from, { month: 'long', year: 'numeric' })}</span><Icon name="down" size={14}/><input type="month" aria-label="Choose month" value={month} onChange={e => e.target.value && changeMonth(e.target.value)}/></label></div><div className="month-actions"><button className="button small" onClick={() => changeMonth((meta.dataRange?.to ?? todayIn()).slice(0, 7))}>Latest data</button><button className="button small text-button" onClick={() => changeMonth(todayIn().slice(0, 7))}>Today</button></div></div>
      <div className="grid-information"><span><span className="tiny-dot"/>All berths <span className="muted">· {meta.berths.filter(b => b.id !== 'unassigned').length} resources</span></span><span><Icon name="plus" size={12}/>Click or drag empty days to book</span></div>
      {reservations.isPending ? <Loading/> : reservations.isError ? <ErrorState error={reservations.error} retry={() => void reservations.refetch()}/> : <MonthGrid month={month} reservations={rows} berths={meta.berths} focus={search.get('focus')}/>}
      <div className="grid-legend"><span><i className="legend-vessel"/>Vessel</span><span><i className="legend-event"/>Event</span><span><i className="legend-closure"/>Closure</span><span><i className="legend-hold"/>Hold</span><span className="legend-divider"/><span><i className="legend-conflict"/>Conflict</span><span><i className="legend-fit"/>Fit issue</span><span className="inclusive-note">Dates are inclusive</span></div>
    </section><aside className="schedule-sidebar"><div className="sidebar-card"><div className="sidebar-heading"><h3><Icon name="alert" size={17}/>Issues this month</h3><span className="count-badge">{issues.data?.length ?? '–'}</span></div><p className="sidebar-description">A little attention keeps the schedule clear.</p>{issues.isError ? <ErrorState error={issues.error}/> : issues.data?.length ? <div className="month-issues">{issues.data.slice(0, 4).map(issue => <article className={`compact-issue issue-${issue.type}`} key={issue.id}><div className="issue-type"><span className="tiny-dot"/>{issueLabel(issue.type)}</div><strong>{bookingName(issue.reservation)}</strong><p>{meta.berths.find(b => b.id === (issue.berthId ?? issue.reservation.berthId))?.name}</p><div className="compact-issue-bottom"><span>{dateLabel(issue.startDate)} – {dateLabel(issue.endDate)}</span><button onClick={() => { setSearch({ month, focus: issue.reservation.id }); document.getElementById(`booking-${issue.reservation.id}`)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); }}>Show<Icon name="arrow" size={14}/></button></div></article>)}</div> : <div className="month-clear"><span><Icon name="check" size={23}/></span><strong>All clear this month</strong><p>No unresolved schedule issues.</p></div>}<Link className="sidebar-link" to="/issues">View all issues<Icon name="arrow" size={16}/></Link></div>
      <div className="find-prompt"><div className="compass-graphic"><Icon name="anchor" size={24}/></div><h3>Room for your next arrival?</h3><p>Find an available berth that fits your vessel and your dates.</p><button className="button" onClick={() => findBerth({ start: from, end: addDays(from, 6) })}>Find a berth<Icon name="arrow" size={16}/></button></div>
      <div className="schedule-note"><Icon name="help" size={16}/><p>One booking per berth, per day.<br/>Shared resources allow multiple vessels.</p></div>
    </aside></div>
    {!reservations.isPending && rows.length === 0 && <div className="empty-month-note"><Icon name="calendar"/>There are no bookings in this month. Select “Latest data” to explore the imported schedule.</div>}
  </>;
}
