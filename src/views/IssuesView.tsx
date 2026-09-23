import { useRef, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { IssueDTO, IssueType } from '../../shared/types';
import { todayIn } from '../../shared/dates';
import { allPages, params } from '../api';
import { useApp } from '../context';
import Icon from '../components/Icon';
import IssueList from '../components/IssueList';
import { EmptyState, ErrorState, Loading } from '../components/UI';
import '../styles/views.css';

const tabs: { type: IssueType; label: string; explanation: string }[] = [
  { type: 'overlap', label: 'Double-bookings', explanation: 'An exclusive berth can hold one booking per day. These bookings share at least one day on the same berth.' },
  { type: 'fit', label: 'Too long for berth', explanation: 'A vessel’s recorded length cannot exceed its berth’s length. Disputed lengths use the larger recorded value.' },
  { type: 'vessel_double', label: 'Vessel in two places', explanation: 'A vessel may share one shift day between berths. These bookings overlap on different berths for two or more days.' },
];

export default function IssuesView() {
  const { meta } = useApp();
  const [search, setSearch] = useSearchParams();
  const rawType = search.get('type');
  const type: IssueType = tabs.some(tab => tab.type === rawType) ? rawType as IssueType : 'overlap';
  const filters = { from: search.get('from'), to: search.get('to'), berthId: search.get('berthId'), includeReviewed: search.get('includeReviewed') === 'true' };
  const [visibleCount, setVisibleCount] = useState(20);
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const query = useQuery({ queryKey: ['issues', 'review-queue', filters], queryFn: () => allPages<IssueDTO>(`/issues?${params(filters)}`) });
  const change = (key: string, value: string) => { setVisibleCount(20); setSearch(current => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); return next; }, { replace: true }); };
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    change('type', tabs[next].type);
    tabButtons.current[next]?.focus();
  }
  const fromYear = Number(meta.dataRange.from.slice(0, 4)), toYear = Math.max(Number(meta.dataRange.to.slice(0, 4)), Number(todayIn().slice(0, 4)));
  const years = Array.from({ length: toYear - fromYear + 1 }, (_, index) => toYear - index);
  const selectedYear = filters.from && filters.to && filters.from.slice(0, 4) === filters.to.slice(0, 4) && filters.from.endsWith('-01-01') && filters.to.endsWith('-12-31') ? filters.from.slice(0, 4) : filters.from || filters.to ? 'custom' : '';
  const rows = (query.data ?? []).filter(issue => issue.type === type);
  return <section className="secondary-view issues-view">
    <div className="page-heading"><div><span className="eyebrow">A clearer record</span><h1>Schedule issues <span className="heading-count">{query.data?.length ?? '—'}</span></h1><p>Review the exceptions found in the legacy schedule, with the original context intact.</p></div><div className="page-context"><Icon name="import"/><span>Imported history<span>{meta.dataRange.from.slice(0, 4)} – {meta.dataRange.to.slice(0, 4)}</span></span></div></div>
    <div className="tab-bar issue-tabs" role="tablist" aria-label="Issue type" aria-orientation="horizontal">{tabs.map((item, index) => <button key={item.type} ref={element => { tabButtons.current[index] = element; }} id={`issue-tab-${item.type}`} role="tab" aria-selected={type === item.type} aria-controls={`issue-panel-${item.type}`} tabIndex={type === item.type ? 0 : -1} className={type === item.type ? 'active' : ''} onClick={() => change('type', item.type)} onKeyDown={event => onTabKeyDown(event, index)}>{item.label}<span>{query.data?.filter(issue => issue.type === item.type).length ?? '—'}</span></button>)}</div>
    <div className="filter-bar issue-filters"><label className="field"><span>Year</span><select value={selectedYear} onChange={e => { setVisibleCount(20); setSearch(current => { const next = new URLSearchParams(current); if (e.target.value) { next.set('from', `${e.target.value}-01-01`); next.set('to', `${e.target.value}-12-31`); } else { next.delete('from'); next.delete('to'); } return next; }, { replace: true }); }}><option value="">All years</option>{selectedYear === 'custom' && <option value="custom">Custom date range</option>}{years.map(year => <option key={year} value={year}>{year}</option>)}</select></label><label className="field"><span>Berth</span><select value={filters.berthId ?? ''} onChange={e => change('berthId', e.target.value)}><option value="">All berths</option>{meta.berths.map(berth => <option key={berth.id} value={berth.id}>{berth.name}</option>)}</select></label><label className="checkbox-field"><input type="checkbox" checked={filters.includeReviewed} onChange={e => change('includeReviewed', e.target.checked ? 'true' : '')}/>Include reviewed</label><span className="filter-note">Newest issues first</span></div>
    {tabs.map(panel => <section key={panel.type} id={`issue-panel-${panel.type}`} role="tabpanel" aria-labelledby={`issue-tab-${panel.type}`} aria-describedby={`issue-rule-${panel.type}`} hidden={type !== panel.type} tabIndex={0}>
      <div className="rule-explainer"><Icon name="help" size={18}/><p id={`issue-rule-${panel.type}`}>{panel.explanation}</p></div>
      {type === panel.type && (query.isPending ? <Loading label="Loading schedule issues…"/> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()}/> : !rows.length ? <div className="card"><EmptyState icon="check" title="No issues in this view">{filters.includeReviewed ? 'Try another year, berth, or issue type.' : 'There are no unreviewed issues matching these filters. Include reviewed issues to see past decisions.'}</EmptyState></div> : <><IssueList issues={rows.slice(0, visibleCount)}/><div className="pagination"><span className="muted">Showing {Math.min(visibleCount, rows.length)} of {rows.length} {rows.length === 1 ? 'issue' : 'issues'}</span>{visibleCount < rows.length && <button className="button small" onClick={() => setVisibleCount(count => count + 20)}>Load more issues<Icon name="down" size={14}/></button>}</div></>)}
    </section>)}
  </section>;
}
