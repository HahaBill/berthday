import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { AvailabilityResponse, Kind, ReservationDTO, VesselDTO } from '../../shared/types';
import { isValidDate, todayIn } from '../../shared/dates';
import { allPages, api, ApiError, bookingName, params, rangeLabel } from '../api';
import { useApp, type BookingDraft } from '../context';
import { Modal, Status } from './UI';
import Icon from './Icon';
import LengthGauge from './LengthGauge';

export default function BookingForm({ draft, onClose }: { draft: BookingDraft; onClose: () => void }) {
  const { meta, notify, setSelectedLength } = useApp();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind>(draft.kind ?? 'vessel');
  const [berthId, setBerthId] = useState(draft.berthId ?? meta.berths.find(b => b.isExclusive)?.id ?? '');
  const [vesselId, setVesselId] = useState(draft.vesselId ?? '');
  const [vesselSearch, setVesselSearch] = useState('');
  const [title, setTitle] = useState(draft.title ?? '');
  const [startDate, setStartDate] = useState(draft.startDate ?? todayIn());
  const [endDate, setEndDate] = useState(draft.endDate ?? draft.startDate ?? todayIn());
  const [notes, setNotes] = useState(draft.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [addVessel, setAddVessel] = useState(false);
  const [vesselName, setVesselName] = useState('');
  const [vesselLength, setVesselLength] = useState('');
  const [addingVessel, setAddingVessel] = useState(false);
  const vessels = useQuery({ queryKey: ['vessels', 'options'], queryFn: () => allPages<VesselDTO>('/vessels') });
  const vessel = vessels.data?.find(v => v.id === vesselId);
  const berth = meta.berths.find(b => b.id === berthId);
  const [availableQuery, setAvailableQuery] = useState('');
  useEffect(() => { setSelectedLength(kind === 'vessel' ? vessel?.lengthFt ?? null : null); }, [vessel?.lengthFt, kind]);
  useEffect(() => { const timer = setTimeout(() => { setAvailableQuery(isValidDate(startDate) && isValidDate(endDate) && endDate >= startDate ? params({ start: startDate, end: endDate, vesselId: kind === 'vessel' ? vesselId : undefined, excludeId: draft.id }) : ''); }, 300); return () => clearTimeout(timer); }, [startDate, endDate, vesselId, kind, draft.id]);
  const availability = useQuery({ queryKey: ['availability', availableQuery], queryFn: () => api<AvailabilityResponse>(`/availability?${availableQuery}`), enabled: !!availableQuery });
  const berthStatus = availability.data?.items.find(row => row.berth.id === berthId);
  const fitStatus = kind !== 'vessel' && berthStatus?.status === 'unverified' ? 'available' : berthStatus?.status;
  async function save(event: FormEvent) {
    event.preventDefault();
    const values = { kind, berthId, vesselId: kind === 'vessel' ? vesselId : null, title: kind === 'vessel' ? null : title.trim(), startDate, endDate, notes: notes.trim() || null };
    const payload = draft.id ? Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== (draft[key as keyof BookingDraft] ?? null))) : values;
    if (draft.id && Object.keys(payload).length === 0) { onClose(); return; }
    setSaving(true); setError(null);
    try {
      const saved = await api<ReservationDTO>(draft.id ? `/reservations/${draft.id}` : '/reservations', { method: draft.id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      await client.invalidateQueries(); notify(draft.id ? 'Booking updated.' : 'Booking saved.'); onClose();
      if (draft.showOnSave) navigate(`/?month=${saved.startDate.slice(0, 7)}&focus=${encodeURIComponent(saved.id)}`);
    } catch (e) { setError(e instanceof Error ? e : new Error('Could not save the booking.')); }
    finally { setSaving(false); }
  }
  async function createVessel() {
    setError(null); setAddingVessel(true);
    try { const result = await api<VesselDTO>('/vessels', { method: 'POST', body: JSON.stringify({ name: vesselName, lengthFt: Number(vesselLength) }) }); await client.invalidateQueries({ queryKey: ['vessels'] }); setVesselId(result.id); setVesselSearch(''); setAddVessel(false); notify(`${result.name} added to the vessel registry.`); }
    catch (e) { setError(e instanceof Error ? e : new Error('Could not add the vessel.')); } finally { setAddingVessel(false); }
  }
  return <Modal title={draft.id ? 'Edit booking' : draft.fromAsk ? `Review ${kind === 'event' ? 'event' : 'booking'}` : 'New booking'} onClose={onClose} className="booking-dialog"><form onSubmit={save} className="booking-form">
    {draft.fromAsk && <p className="booking-draft-note"><Icon name="sparkles" size={17}/>Review the details from your request, complete any missing fields, and save the booking.</p>}
    <div className="kind-segment" role="group" aria-label="Booking kind">{(['vessel', 'event', 'closure', 'hold'] as Kind[]).map(k => <button key={k} type="button" className={kind === k ? 'active' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}><Icon name={k === 'vessel' ? 'ship' : k === 'event' ? 'calendar' : k === 'closure' ? 'alert' : 'clock'} size={16}/>{k[0].toUpperCase() + k.slice(1)}</button>)}</div>
    {kind === 'vessel' ? <div className="field"><div className="field-label-row"><label htmlFor="booking-vessel">Vessel</label><button type="button" className="text-link" onClick={() => setAddVessel(!addVessel)}><Icon name="plus" size={13}/>Add vessel</button></div>{addVessel ? <div className="inline-vessel"><label className="field">Vessel name<input value={vesselName} onChange={e => setVesselName(e.target.value)} placeholder="e.g. R/V Clear Tern"/></label><label className="field">Length (ft)<input type="number" min="1" max="1000" value={vesselLength} onChange={e => setVesselLength(e.target.value)}/></label><button type="button" className="button small" disabled={!vesselName.trim() || !Number(vesselLength) || addingVessel} onClick={createVessel}>{addingVessel ? 'Adding…' : 'Add vessel'}</button></div> : <><input aria-label="Search vessels" type="search" placeholder="Search the vessel registry…" value={vesselSearch} onChange={e => setVesselSearch(e.target.value)}/><select id="booking-vessel" value={vesselId} required onChange={e => setVesselId(e.target.value)}><option value="">Select a vessel</option>{(vessels.data ?? []).filter(v => v.id === vesselId || v.name.toLowerCase().includes(vesselSearch.toLowerCase())).map(v => <option key={v.id} value={v.id}>{v.name} · {v.lengthFt ? `${v.lengthFt} ft` : 'Length unknown'}{v.lengthStatus === 'disputed' ? ' (disputed)' : ''}</option>)}</select>{vessel?.lengthNote && <span className="field-hint amber-text">{vessel.lengthNote}</span>}</>}</div> : <label className="field">{kind === 'event' ? 'Event name' : kind === 'closure' ? 'Reason for closure' : 'Hold title'}<input required maxLength={300} value={title} onChange={e => setTitle(e.target.value)} placeholder={kind === 'event' ? 'e.g. Community sail day' : kind === 'closure' ? 'e.g. Pier maintenance' : 'e.g. Reserved for visiting vessel'}/></label>}
    <label className="field">Berth<select aria-label="Berth" value={berthId} required onChange={e => setBerthId(e.target.value)}><option value="">Select a berth</option>{meta.berths.filter(b => b.id !== 'unassigned' || draft.berthId === 'unassigned').map(b => <option key={b.id} value={b.id}>{b.name}{b.lengthFt ? ` · ${b.lengthFt} ft` : ' · Shared resource'}{kind === 'vessel' && vessel?.lengthFt && b.lengthFt && vessel.lengthFt > b.lengthFt ? ' — too short' : ''}</option>)}</select></label>
    {berth && <div className="form-gauge"><span>{vessel?.lengthFt && kind === 'vessel' ? `${vessel.lengthFt} ft vessel` : 'Berth capacity'}<strong>{berth.lengthFt ? `${berth.lengthFt} ft` : 'Shared resource'}</strong></span><LengthGauge length={berth.lengthFt} marker={kind === 'vessel' ? vessel?.lengthFt : null} large/></div>}
    <div className="field-pair"><label className="field">Arrival date<input type="date" aria-label="Arrival date" value={startDate} required onChange={e => { setStartDate(e.target.value); if (endDate && e.target.value > endDate) setEndDate(e.target.value); }}/></label><label className="field">Last day at berth<input type="date" aria-label="Last day at berth" value={endDate} min={startDate} required onChange={e => setEndDate(e.target.value)}/><span className="field-hint">Inclusive — this day is occupied.</span></label></div>
    {berthStatus && fitStatus && <div className={`availability-hint ${fitStatus}`}><Status value={fitStatus}/><span>{fitStatus === 'busy' ? `Booked by ${berthStatus.conflicts.map(bookingName).join(', ')}` : fitStatus === 'too_short' ? `${vessel?.lengthFt} ft vessel; ${berth?.lengthFt} ft berth` : fitStatus === 'unverified' ? 'Enter a vessel length to verify fit.' : fitStatus === 'shared' ? 'Multiple bookings are permitted on this resource.' : 'This berth is free for the selected dates.'}</span></div>}
    <label className="field">Notes <span className="muted">(optional)</span><textarea rows={3} value={notes} maxLength={5000} onChange={e => setNotes(e.target.value)} placeholder="Arrival details, equipment, or anything the team should know…"/></label>
    {error && <div className="booking-error" role="alert"><strong><Icon name="alert" size={17}/>{error.message}</strong>{error instanceof ApiError && <>{error.conflicts.map(c => <p key={c.id}>{bookingName(c)} · {rangeLabel(c.startDate, c.endDate)}</p>)}{(error.alternatives.berths.length > 0 || error.alternatives.dateShifts.length > 0) && <div className="alternative-actions"><span>Available alternatives</span>{error.alternatives.berths.map(b => <button className="button small" type="button" key={b.berthId} onClick={() => { setBerthId(b.berthId); setError(null); }}>Use {b.berthName} ({b.lengthFt ?? '?'} ft)</button>)}{error.alternatives.dateShifts.map(d => <button className="button small" type="button" key={d.direction} onClick={() => { setStartDate(d.startDate); setEndDate(d.endDate); setError(null); }}>Move to {rangeLabel(d.startDate, d.endDate)}</button>)}</div>}</>}</div>}
    <div className="dialog-footer"><span><Icon name="help" size={14}/>Availability is checked when you save.</span><div><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={saving || addingVessel || (kind === 'vessel' && !vesselId)} type="submit">{saving ? 'Saving…' : 'Save booking'}</button></div></div>
  </form></Modal>;
}
