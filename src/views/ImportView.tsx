import { useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { ImportIssueDTO } from '../../shared/types';
import { api, params, rangeLabel } from '../api';
import { useApp } from '../context';
import Icon from '../components/Icon';
import { EmptyState, ErrorState, Loading } from '../components/UI';
import '../styles/views.css';

type Severity = 'info' | 'warn' | 'error';
type Code = { code: string; count: number; severity: Severity };
type ImportPage = { items: ImportIssueDTO[]; total: number; limit: number; offset: number };
const descriptions: Record<string, { title: string; detail: string }> = {
  UNLABELLED_ROW: { title: 'Rows without a berth name', detail: 'Bookings beneath an empty berth label were preserved under Unassigned for review.' },
  DAY_NUMBERS_ARE_FORMULAS: { title: 'Formula day numbers', detail: 'Day-number formulas had no cached values; dates were derived from column positions.' },
  DUPLICATE_BERTH_ROW: { title: 'Duplicate berth rows', detail: 'Several rows describe the same berth. Their bookings were kept and checked for overlaps.' },
  HEADER_INVALID_DAY: { title: 'Impossible dates in a header', detail: 'The source lists a day outside the actual month. Cells under that day were not imported.' },
  OUT_OF_RANGE_TEXT: { title: 'Text beyond the last day', detail: 'Text outside the valid month grid was logged rather than treated as a booking.' },
  ORPHAN_NOTE: { title: 'Notes without a booking', detail: 'Timing or service notes could not be attached to a booking and were preserved in this log.' },
  NOTE_ROW: { title: 'Standalone note rows', detail: 'A row of timing or service notes was not interpreted as another berth or booking.' },
  HEADER_YEAR_MISMATCH: { title: 'Month headings with the wrong year', detail: 'A heading disagrees with its annual sheet. The year in the sheet name was used.' },
  HEADER_DAY_CONFLICT: { title: 'Conflicting day-number rows', detail: 'Numeric headers disagree on where day 1 begins; the most common column alignment was used.' },
  HEADER_ROW_TEXT: { title: 'Text in day or weekday headers', detail: 'Text mixed into the calendar header was logged and left out of the booking grid.' },
  PRE_GRID_LABEL: { title: 'Names before the calendar grid', detail: 'A name appears before day 1. It was logged without assuming that it represents a dated booking.' },
  HEADER_MISSING_DAY: { title: 'Incomplete day headers', detail: 'The printed day numbers stop early; the remaining dates were derived from column positions.' },
  UNLABELLED_POOL_ROW: { title: 'Extra shared-resource rows', detail: 'Unlabelled rows under a shared resource were imported as part of that resource.' },
  CARRYOVER_MISMATCH: { title: 'Copied December disagrees', detail: 'A sheet repeats the previous December and disagrees with it; the original was kept.' },
  CARRYOVER_DUPLICATE: { title: 'Repeated December', detail: 'An identical copy of the previous December was skipped to avoid duplicate bookings.' },
  SHEET_NOT_IMPORTED: { title: 'Reference and reporting sheets', detail: 'Non-annual sheets were excluded from the booking grid; Science and Yachts still supplied vessel lengths.' },
  ORPHAN_SPEC_ROW: { title: 'Specifications without a vessel name', detail: 'A length appears on its own row without an identified vessel and was not assigned by guesswork.' },
  VESSEL_LENGTH_DISPUTED: { title: 'Conflicting vessel lengths', detail: 'More than one length was recorded for a vessel. The larger value is used until it is verified.' },
  UNLABELLED_BLOCK: { title: 'Coloured blocks without a name', detail: 'Coloured booking bars with no vessel or event name were preserved as holds.' },
  VESSEL_LENGTH_UNKNOWN: { title: 'Missing vessel lengths', detail: 'Vessels without a length remain bookable with fit unverified until a length is entered.' },
  SUMMARY_NOT_IMPORTED: { title: 'Summary suggests shared use', detail: 'The summary credits North Pier West with more occupied days than a year contains. Confirm whether length sharing is needed.' },
  BERTH_LENGTH_CHANGED: { title: 'Changing berth lengths', detail: 'A berth has different lengths in the workbook; the first recorded length was retained for review.' },
  NO_DAY_HEADER: { title: 'Calendar header could not be read', detail: 'A month block without usable day numbers was logged and skipped.' },
};
const severityLabel: Record<Severity, string> = { info: 'Information', warn: 'Review', error: 'Error' };

function LogEntries({ code }: { code: string }) {
  const { showBooking } = useApp();
  const query = useInfiniteQuery({ queryKey: ['import', 'entries', code], queryFn: ({ pageParam }) => api<ImportPage>(`/import/issues?${params({ code, limit: 25, offset: pageParam })}`), initialPageParam: 0, getNextPageParam: last => last.offset + last.items.length < last.total ? last.offset + last.limit : undefined });
  const entries = query.data?.pages.flatMap(page => page.items) ?? [];
  if (query.isPending) return <Loading label="Loading source notes…"/>;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()}/>;
  return <div className="import-log-entries">{entries.map(entry => <article className="import-log-entry" key={entry.id}><div className="log-source"><Icon name="import" size={14}/><code>{entry.sheet ? `${entry.sheet}${entry.cell ? `!${entry.cell}` : ''}` : 'Workbook'}</code></div><div><p>{entry.message}</p>{entry.reservationId && <button className="subtle-link" onClick={() => showBooking(entry.reservationId!)}>View booking<Icon name="arrow" size={12}/></button>}</div></article>)}{query.hasNextPage && <div className="pagination"><span className="muted">{entries.length} of {query.data?.pages[0].total} entries</span><button className="button small" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? 'Loading…' : 'Load more entries'}<Icon name="down" size={13}/></button></div>}</div>;
}

export default function ImportView() {
  const { meta } = useApp();
  const summary = meta.importSummary;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [severity, setSeverity] = useState('');
  const [search, setSearch] = useState('');
  const codes = useQuery({ queryKey: ['import', 'codes'], queryFn: () => api<{ items: Code[] }>('/import/codes') });
  const totalIssues = Object.values(summary.schedule_issues_by_type).reduce((sum, count) => sum + (count ?? 0), 0);
  const totalEntries = Object.values(summary.import_issues_by_code).reduce((sum, count) => sum + count, 0);
  const displayed = (codes.data?.items ?? []).filter(code => (!severity || code.severity === severity) && `${code.code} ${descriptions[code.code]?.title ?? ''} ${descriptions[code.code]?.detail ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const toggle = (code: string) => setExpanded(current => { const next = new Set(current); if (next.has(code)) next.delete(code); else next.add(code); return next; });
  return <section className="secondary-view import-view"><div className="page-heading"><div><span className="eyebrow">History, with its context</span><h1>Migration report</h1><p>Twenty-three years of dock schedules, preserved and made reviewable.</p></div><span className="import-complete"><Icon name="check" size={16}/>Import complete</span></div>
    <div className="migration-source"><span className="source-file-icon"><Icon name="import" size={24}/></span><div><strong>{summary.source_file ?? 'dock_schedule.xlsx'}</strong><p>{summary.sheets_parsed} annual sheets · {summary.month_blocks} month blocks · {rangeLabel(summary.data_range.from, summary.data_range.to)}</p></div><span className="source-preserved"><Icon name="check" size={14}/>Source references preserved</span></div>
    <div className="summary-cards migration-summary"><article className="stat-card"><span className="stat-card-label"><Icon name="calendar" size={16}/>Reservations</span><strong>{summary.reservations.toLocaleString()}</strong><p>{summary.reservations_by_kind.vessel?.toLocaleString() ?? 0} vessel bookings</p><div className="stat-breakdown"><span>{summary.reservations_by_kind.event ?? 0} events</span><span>{summary.reservations_by_kind.closure ?? 0} closures</span><span>{summary.reservations_by_kind.hold ?? 0} holds</span></div></article><article className="stat-card"><span className="stat-card-label"><Icon name="ship" size={16}/>Vessels</span><strong>{summary.vessels.toLocaleString()}</strong><p>{summary.vessels_by_length_status.known ?? 0} with a known length</p><div className="stat-breakdown"><span>{summary.vessels_by_length_status.unknown ?? 0} missing</span><span>{summary.vessels_by_length_status.disputed ?? 0} disputed</span></div></article><article className="stat-card"><span className="stat-card-label"><Icon name="alert" size={16}/>Schedule issues</span><strong>{totalIssues}</strong><p>Preserved for coordinator review</p><div className="stat-breakdown"><span>{summary.schedule_issues_by_type.overlap ?? 0} overlaps</span><span>{summary.schedule_issues_by_type.fit ?? 0} fit</span><span>{summary.schedule_issues_by_type.vessel_double ?? 0} location</span></div></article><article className="stat-card"><span className="stat-card-label"><Icon name="anchor" size={16}/>Resources</span><strong>{summary.berths}</strong><p>6 exclusive berths · 2 shared pools</p><div className="stat-breakdown"><span>1 unassigned resource</span></div></article></div>
    <div className="migration-explanation"><Icon name="help" size={19}/><p><strong>The history is preserved, including its problems.</strong> Original bookings were imported without moving vessels or shortening stays. The log below explains each interpretation, and the issues queue holds the resulting scheduling conflicts.</p><Link to="/issues" className="button small">Review issues<Icon name="arrow" size={14}/></Link></div>
    <section className="migration-log card"><div className="log-heading"><div><h2>Migration log</h2><p>{totalEntries.toLocaleString()} source notes, grouped into {Object.keys(summary.import_issues_by_code).length} categories</p></div><span className="muted">Select a category to inspect the source</span></div><div className="filter-bar log-filters"><label className="field search-field"><span className="sr-only">Search migration categories</span><div className="input-with-icon"><Icon name="search"/><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search migration notes"/></div></label><label className="field"><span className="sr-only">Severity</span><select value={severity} onChange={e => setSeverity(e.target.value)}><option value="">All notes</option><option value="warn">Needs review</option><option value="info">Information</option><option value="error">Errors</option></select></label></div>
      {codes.isPending ? <Loading label="Loading migration log…"/> : codes.isError ? <ErrorState error={codes.error} retry={() => void codes.refetch()}/> : !displayed.length ? <EmptyState icon="search" title="No matching categories">Try another search or select all notes.</EmptyState> : <div className="import-groups">{displayed.map(code => { const description = descriptions[code.code] ?? { title: code.code.toLowerCase().replaceAll('_', ' '), detail: 'Inspect the source notes for this migration category.' }; return <article className={`import-group${expanded.has(code.code) ? ' expanded' : ''}`} key={code.code}><button className="import-group-toggle" aria-expanded={expanded.has(code.code)} aria-controls={`log-${code.code}`} onClick={() => toggle(code.code)}><span className={`log-severity-icon severity-${code.severity}`}><Icon name={code.severity === 'info' ? 'import' : 'alert'} size={18}/></span><span className="import-group-label"><strong>{description.title}</strong><span>{description.detail}</span><code>{code.code}</code></span><span className={`severity-pill severity-${code.severity}`}>{severityLabel[code.severity]}</span><span className="log-count">{code.count}</span><Icon name="down" size={16} className="expand-chevron"/></button>{expanded.has(code.code) && <div id={`log-${code.code}`}><LogEntries code={code.code}/></div>}</article>; })}</div>}
    </section><p className="migration-footnote"><Icon name="clock" size={14}/>Longest imported stay: {summary.max_span_days} days. New bookings are limited to 366 days. {summary.carryover_blocks_skipped} copied December blocks were compared and skipped.</p></section>;
}
