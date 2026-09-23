import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReservationDTO } from '../../shared/types';
import { diffDays } from '../../shared/dates';
import { api, bookingName, issueLabel, rangeLabel } from '../api';
import { useApp } from '../context';
import { ErrorState, Loading, Modal, Status } from './UI';
import LengthGauge from './LengthGauge';
import Icon from './Icon';

export default function BookingDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { meta, editBooking, notify } = useApp(); const client = useQueryClient();
  const booking = useQuery({ queryKey: ['reservation', id], queryFn: () => api<ReservationDTO>(`/reservations/${id}`) });
  const [confirmDelete, setConfirmDelete] = useState(false); const [deleting, setDeleting] = useState(false); const [error, setError] = useState<unknown>(null);
  const r = booking.data; const berth = meta.berths.find(b => b.id === r?.berthId);
  async function remove() { setDeleting(true); try { await api(`/reservations/${id}`, { method: 'DELETE' }); await client.invalidateQueries(); notify('Booking deleted.'); onClose(); } catch(e) { setError(e); } finally { setDeleting(false); } }
  return <Modal title="Booking details" onClose={onClose} className="drawer"><div className="drawer-body">{booking.isPending ? <Loading label="Loading booking…"/> : booking.isError ? <ErrorState error={booking.error}/> : r && <>
    <span className={`booking-kind-pill kind-${r.kind}`}><Icon name={r.kind === 'vessel' ? 'ship' : 'calendar'} size={15}/>{r.kind[0].toUpperCase() + r.kind.slice(1)} booking</span><h2 className="booking-name">{bookingName(r)}</h2><p className="booking-location"><Icon name="anchor"/>{berth?.name}</p>
    <div className="detail-date-card"><Icon name="calendar" size={22}/><div><strong>{rangeLabel(r.startDate, r.endDate)}</strong><span>{diffDays(r.startDate, r.endDate) + 1} days at berth · last day included</span></div></div>
    <section className="detail-section"><div className="section-title"><h3>Vessel fit</h3><Status value={r.fitStatus}/></div>{r.kind === 'vessel' ? <><div className="fit-comparison"><span>Vessel length<strong>{r.vessel?.lengthFt ? `${r.vessel.lengthFt} ft` : 'Unknown'}</strong></span><span>Berth capacity<strong>{berth?.lengthFt ? `${berth.lengthFt} ft` : 'Shared resource'}</strong></span></div><LengthGauge length={berth?.lengthFt ?? null} marker={r.vessel?.lengthFt} large/>{r.vessel?.lengthStatus === 'disputed' && <p className="amber-text">This vessel has a disputed length. The larger recorded value is used.</p>}{r.fitStatus === 'unverified' && <p className="muted">Fit is unverified while a vessel or berth length is unknown.</p>}</> : <p className="muted">Events, closures, and holds occupy the berth without a vessel fit check.</p>}</section>
    {!!r.issues.length && <section className="detail-section"><h3>Schedule issues</h3>{r.issues.map(i => <Link key={i.id} className="detail-issue" to={`/issues?type=${i.type}`} onClick={onClose}><Icon name="alert" size={16}/>{issueLabel(i.type)}{i.reviewed && <small>Reviewed</small>}<Icon name="arrow" size={15}/></Link>)}</section>}
    <section className="detail-section"><h3>Notes</h3><p className="booking-notes">{r.notes || 'No notes for this booking.'}</p></section>
    <section className="detail-section provenance"><Icon name="import" size={17}/><div><h3>{r.origin === 'legacy' ? 'Imported from the legacy workbook' : 'Created in Berthday'}</h3><p>{r.sourceRef || 'This booking was created in the app.'}</p></div></section>
    <Link className="button full-width" to={`/?month=${r.startDate.slice(0,7)}&focus=${r.id}`} onClick={onClose}><Icon name="calendar" size={16}/>Show on schedule<Icon name="arrow" size={16}/></Link>
    {error ? <ErrorState error={error}/> : null}
    {confirmDelete && <div className="booking-error"><strong>Delete this booking?</strong><p>This removes the booking and its schedule issues.</p><div className="button-row"><button className="button small" onClick={() => setConfirmDelete(false)}>Keep booking</button><button className="button danger small" onClick={remove} disabled={deleting}>{deleting ? 'Deleting…' : 'Confirm delete'}</button></div></div>}
    <div className="drawer-actions"><button className="button danger-text" onClick={() => setConfirmDelete(true)}>Delete booking</button><button className="button primary" onClick={() => editBooking(r)}><Icon name="edit" size={16}/>Edit booking</button></div>
  </>}</div></Modal>;
}
