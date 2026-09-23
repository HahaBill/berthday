import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AvailabilityResponse, VesselDTO } from '../../shared/types';
import { addDays, todayIn } from '../../shared/dates';
import { allPages, api, bookingName, params, rangeLabel } from '../api';
import { useApp, type FindDraft } from '../context';
import { EmptyState, ErrorState, Loading, Modal, Status } from './UI';
import Icon from './Icon';
import LengthGauge from './LengthGauge';

export default function FindBerthPanel({ draft, onClose }: { draft: FindDraft; onClose: () => void }) {
  const { newBooking, setSelectedLength } = useApp();
  const [start, setStart] = useState(draft.start ?? todayIn()); const [end, setEnd] = useState(draft.end ?? addDays(draft.start ?? todayIn(), 6));
  const [length, setLength] = useState(String(draft.lengthFt ?? '')); const [vesselId, setVesselId] = useState(draft.vesselId ?? '');
  const currentQuery = params({ start, end, vesselId, lengthFt: !vesselId && length ? Number(length) : undefined });
  const [query, setQuery] = useState(draft.lengthFt || draft.vesselId ? currentQuery : '');
  const resultsCurrent = query === currentQuery;
  const vessels = useQuery({ queryKey: ['vessels', 'options'], queryFn: () => allPages<VesselDTO>('/vessels') });
  const vessel = vessels.data?.find(v => v.id === vesselId);
  const selectedLength = vesselId ? vessel?.lengthFt ?? null : Number(length) || null;
  useEffect(() => { setSelectedLength(selectedLength); }, [selectedLength]);
  const availability = useQuery({ queryKey: ['availability', query], queryFn: () => api<AvailabilityResponse>(`/availability?${query}`), enabled: !!query && resultsCurrent });
  function search(event: FormEvent) { event.preventDefault(); setQuery(currentQuery); }
  const availableCount = availability.data?.items.filter(i => i.status === 'available').length;
  return <Modal title="Find a berth" onClose={onClose} className="drawer find-drawer"><div className="drawer-body"><p className="drawer-intro">The right space for your vessel, for every day of its stay.</p><form className="find-form" onSubmit={search}><div className="field-pair"><label className="field">Arrival date<input type="date" aria-label="Arrival date" value={start} required onChange={e => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }}/></label><label className="field">Last day at berth<input type="date" aria-label="Last day at berth" min={start} value={end} required onChange={e => setEnd(e.target.value)}/></label></div><label className="field">Vessel <span className="muted">(optional)</span><select aria-label="Vessel" value={vesselId} onChange={e => setVesselId(e.target.value)}><option value="">Search by length instead</option>{vessels.data?.map(v => <option key={v.id} value={v.id}>{v.name}{v.lengthFt ? ` · ${v.lengthFt} ft` : ''}</option>)}</select></label><label className="field">Vessel length (ft)<input type="number" aria-label="Vessel length (ft)" placeholder="e.g. 120" min="1" max="1000" disabled={!!vesselId} value={vesselId ? vessel?.lengthFt ?? '' : length} onChange={e => setLength(e.target.value)}/></label><button className="button primary full-width" type="submit"><Icon name="search"/>Check availability</button></form>
    {!query || !resultsCurrent ? <EmptyState icon="anchor" title={query ? "Check the updated search" : "Make room for your next arrival"}>{query ? "Your dates or vessel have changed. Check availability again to see current results." : "Choose your dates and vessel length to see which berths are available."}</EmptyState> : availability.isPending ? <Loading label="Checking berths…"/> : availability.isError ? <ErrorState error={availability.error}/> : <div className="availability-results"><div className="section-title"><h3>{availableCount} {availableCount === 1 ? 'berth' : 'berths'} available</h3><span className="muted">{selectedLength ? `${selectedLength} ft vessel` : 'Length not specified'}</span></div>{availability.data.items.map(({ berth, status, conflicts }) => <article className={`availability-card ${status === 'too_short' ? 'short-berth' : ''}`} key={berth.id}><div className="section-title"><h3>{berth.name}</h3><Status value={status}/></div><div className="availability-length"><span>{berth.lengthFt ? `${berth.lengthFt} ft capacity` : 'Shared resource'}</span><Icon name="anchor" size={14}/></div><LengthGauge length={berth.lengthFt} marker={selectedLength} large/>{conflicts.length > 0 && <p className="conflict-summary">{conflicts.slice(0, 2).map(c => `${bookingName(c)} · ${rangeLabel(c.startDate, c.endDate)}`).join('; ')}</p>}{['available', 'unverified', 'shared'].includes(status) && <button className="text-link" onClick={() => { onClose(); newBooking({ berthId: berth.id, startDate: start, endDate: end, vesselId: vesselId || undefined }); }}>Book this berth<Icon name="arrow" size={16}/></button>}</article>)}</div>}
  </div></Modal>;
}
