import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { AskResponse } from '../../shared/types';
import { monthEnd, monthStart, todayIn } from '../../shared/dates';
import { api, issueLabel, params, rangeLabel } from '../api';
import { useApp } from '../context';
import Icon from './Icon';

export default function AskBar({ viewedMonth }: { viewedMonth: string }) {
  const [q, setQ] = useState(''); const [busy, setBusy] = useState(false); const [response, setResponse] = useState<AskResponse | null>(null); const [error, setError] = useState('');
  const navigate = useNavigate(); const { findBerth, meta } = useApp();
  async function ask(event: FormEvent) {
    event.preventDefault(); if (!q.trim()) return;
    setBusy(true); setError(''); setResponse(null);
    try { setResponse(await api<AskResponse>('/ask', { method: 'POST', body: JSON.stringify({ q, today: todayIn(), viewedMonth }) })); }
    catch(e) { setError(e instanceof Error ? e.message : 'Please try again.'); }
    finally { setBusy(false); }
  }
  function removeChip(key: string) {
    if (!response) return;
    const filters = { ...response.filters };
    if (/date/i.test(key)) { delete filters.dateFrom; delete filters.dateTo; }
    else if (/berth/i.test(key)) delete filters.berthIds;
    else if (/vessel/i.test(key)) { delete filters.vesselQuery; delete filters.vesselIds; }
    else if (/length/i.test(key)) delete filters.lengthFt;
    else if (/kind/i.test(key)) delete filters.kinds;
    else if (/issue/i.test(key)) delete filters.issueTypes;
    setResponse({ ...response, filters, chips: response.chips.filter(chip => chip.key !== key) });
  }
  const filters = response?.filters;
  const hasDates = !!(filters?.dateFrom || filters?.dateTo);
  const from = filters?.dateFrom ?? monthStart(filters?.dateTo ?? viewedMonth);
  const to = filters?.dateTo ?? monthEnd(from);
  const allHistory = response?.intent === 'search' && !hasDates;
  const defaultDates = allHistory
    ? `Dates: All imported history (${meta.dataRange.from.slice(0, 4)}–${meta.dataRange.to.slice(0, 4)})`
    : `Dates: ${rangeLabel(from, to)} (viewed month)`;
  const limitedFilters = [
    ...(filters?.berthIds && filters.berthIds.length > 1 ? [`berth: ${meta.berths.find(berth => berth.id === filters.berthIds![0])?.name ?? filters.berthIds[0]}`] : []),
    ...(filters?.kinds && filters.kinds.length > 1 ? [`kind: ${filters.kinds[0]}`] : []),
    ...(filters?.issueTypes && filters.issueTypes.length > 1 ? [`issue type: ${issueLabel(filters.issueTypes[0])}`] : []),
  ];
  function apply() {
    if (!response) return;
    const f = response.filters;
    const vesselId = f.vesselIds?.length === 1 ? f.vesselIds[0] : undefined;
    if (response.intent === 'navigate') navigate(`/?month=${from.slice(0, 7)}`);
    else if (response.intent === 'availability') findBerth({ start: from, end: to, vesselId, lengthFt: vesselId ? undefined : f.lengthFt });
    else if (response.intent === 'issues') navigate(`/issues?${params({ from, to, type: f.issueTypes?.[0], berthId: f.berthIds?.[0] })}`);
    else if (response.intent === 'search') navigate(`/bookings?${params({ ...(allHistory ? { history: true } : { from, to }), q: f.vesselQuery, berthId: f.berthIds?.[0], kind: f.kinds?.[0] })}`);
  }
  return <div className="ask-container">
    <form className="ask-bar" onSubmit={ask} aria-busy={busy}>
      <span className="ask-symbol"><Icon name="sparkles" size={19}/></span>
      <input aria-label="Ask about the schedule" value={q} maxLength={300} onChange={e => setQ(e.target.value)} placeholder="Ask about the schedule…"/>
      <span className="ask-example">Try “which berths fit a 120 ft boat?”</span>
      <button type="submit" className="ask-submit" disabled={busy || !q.trim()} aria-label={busy ? 'Interpreting schedule question' : 'Ask schedule question'}>{busy ? <span className="spinner"/> : <Icon name="arrow" size={18}/>}</button>
    </form>
    {response && <div className="ask-results" aria-live="polite">
      <span className="muted">{response.source === 'fallback' ? 'Interpreted filters' : 'Suggested filters'}</span>
      {response.chips.map(chip => <button key={chip.key} className="filter-chip" aria-label={`Remove ${chip.label}`} onClick={() => removeChip(chip.key)}>{chip.label}<Icon name="x" size={12}/></button>)}
      {!hasDates && response.intent !== 'unsupported' && <span className="filter-chip">{defaultDates}</span>}
      {response.intent === 'unsupported' ? <span>{response.message || 'Try a date, berth name, vessel name, or vessel length.'}</span> : <button className="button primary small" onClick={apply}>Apply filters<Icon name="arrow" size={14}/></button>}
      <button className="icon-button" aria-label="Clear suggested filters" onClick={() => setResponse(null)}><Icon name="x" size={15}/></button>
      {!!limitedFilters.length && <span className="field-hint">This view applies the first selected {limitedFilters.join('; ')}. Remove a chip to change the selection.</span>}
      {response.intent === 'availability' && filters?.vesselQuery && filters.vesselIds?.length !== 1 && <span className="field-hint">{filters?.vesselIds?.length ? 'Several vessels match.' : 'No vessel matches exactly.'} Choose a vessel in Find a berth before checking its availability.</span>}
    </div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
