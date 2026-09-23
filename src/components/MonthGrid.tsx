import { useEffect, useState, type CSSProperties } from 'react';
import type { BerthDTO, ReservationDTO } from '../../shared/types';
import { daysInMonth } from '../../shared/dates';
import { bookingName, rangeLabel } from '../api';
import { useApp } from '../context';
import Icon from './Icon';
import LengthGauge from './LengthGauge';
import { clipScheduleBooking, scheduleDateWindow } from '../scheduleFilters';

export default function MonthGrid({ month, reservations, berths, focus, from, to }: { month: string; reservations: ReservationDTO[]; berths: BerthDTO[]; focus: string | null; from?: string; to?: string }) {
  const { showBooking, newBooking, selectedLength } = useApp();
  const [selection, setSelection] = useState<{ berthId: string; start: number; end: number } | null>(null);
  const days = Array.from({ length: daysInMonth(month) }, (_, i) => i + 1);
  const window = scheduleDateWindow(month, from, to);
  useEffect(() => setSelection(null), [month, from, to]);
  const date = (day: number) => `${month}-${String(day).padStart(2, '0')}`;
  const inRange = (day: number) => !!window && date(day) >= window.from && date(day) <= window.to;
  const weekend = (day: number) => [0, 6].includes(new Date(`${date(day)}T12:00:00Z`).getUTCDay());
  const visible = berths.filter(b => b.id !== 'unassigned' || reservations.some(r => r.berthId === b.id));
  const finishSelection = () => { if (selection && inRange(selection.start) && inRange(selection.end)) { newBooking({ berthId: selection.berthId, startDate: date(Math.min(selection.start, selection.end)), endDate: date(Math.max(selection.start, selection.end)) }); setSelection(null); } };
  return <div className="grid-scroll"><div className="month-grid" style={{ '--days': days.length } as CSSProperties} onPointerLeave={() => setSelection(null)} onPointerCancel={() => setSelection(null)}>
    <div className="grid-heading"><div className="berth-column-heading">Berth <span>Length / ft</span></div><div className="day-columns">{days.map(day => <div className={`day-heading ${weekend(day) ? 'weekend' : ''} ${!inRange(day) ? 'outside-filter' : ''}`} key={day}><span>{new Intl.DateTimeFormat('en-US', { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(`${date(day)}T12:00:00Z`))}</span><strong>{day}</strong></div>)}</div></div>
    {visible.map((berth, index) => {
      const rows = reservations.filter(r => r.berthId === berth.id).flatMap(r => {
        const clipped = clipScheduleBooking(r, month, from, to);
        return clipped ? [{ r, clipped }] : [];
      }).sort((a, b) => a.clipped.startDate.localeCompare(b.clipped.startDate) || a.r.id.localeCompare(b.r.id));
      const lanes: string[] = [];
      const placed = rows.map(({ r, clipped }) => { let lane = lanes.findIndex(end => end < clipped.startDate); if (lane < 0) lane = lanes.length; lanes[lane] = clipped.endDate; return { r, clipped, lane }; });
      const height = Math.max(84, lanes.length * 35 + 28);
      return <div key={berth.id}>{!berth.isExclusive && (index === 0 || visible[index - 1].isExclusive) && <div className="pool-divider"><Icon name="anchor" size={13}/>Shared resources<span>Multiple bookings allowed</span></div>}<div className={`berth-grid-row ${selectedLength && berth.lengthFt && selectedLength > berth.lengthFt ? 'dimmed' : ''}`} style={{ height }}>
        <div className="berth-heading"><div className="berth-title"><span>{berth.name === 'Small craft slips (institution boats)' ? 'Small craft slips' : berth.name}</span>{berth.lengthFt ? <strong>{berth.lengthFt}<small> ft</small></strong> : <span className="pool-chip">{berth.id === 'unassigned' ? 'Review' : 'Shared'}</span>}</div><LengthGauge length={berth.lengthFt} marker={selectedLength}/>{!berth.isExclusive && <small>{berth.id === 'small-craft-slips' ? 'Institution boats' : berth.id === 'unassigned' ? 'Legacy rows without a berth' : 'No fixed vessel length'}</small>}</div>
        <div className="berth-days"><div className="cell-background day-columns">{days.map(day => <button key={day} disabled={berth.id === 'unassigned' || !inRange(day)} className={`day-cell ${weekend(day) ? 'weekend' : ''} ${!inRange(day) ? 'outside-filter' : ''} ${selection?.berthId === berth.id && day >= Math.min(selection.start, selection.end) && day <= Math.max(selection.start, selection.end) ? 'selected-cell' : ''}`} aria-label={!inRange(day) ? `${date(day)}, outside selected dates` : berth.id === 'unassigned' ? `Unassigned legacy row, ${date(day)}` : `New booking at ${berth.name}, ${date(day)}`} onPointerDown={e => { if (e.button === 0 && inRange(day) && berth.id !== 'unassigned') setSelection({ berthId: berth.id, start: day, end: day }); }} onPointerEnter={() => { if (!inRange(day)) setSelection(null); else if (selection?.berthId === berth.id) setSelection({ ...selection, end: day }); }} onPointerUp={finishSelection} onClick={e => { if (e.detail === 0 && inRange(day) && berth.id !== 'unassigned') newBooking({ berthId: berth.id, startDate: date(day), endDate: date(day) }); }}><span>+</span></button>)}</div>
          <div className="booking-lanes" style={{ gridTemplateRows: `repeat(${Math.max(1, lanes.length)}, 29px)` }}>{placed.map(({ r, clipped, lane }) => {
            const conflict = r.issues.some(i => !i.reviewed && i.type !== 'fit');
            const start = Number(clipped.startDate.slice(-2));
            const end = Number(clipped.endDate.slice(-2));
            return <button key={r.id} id={`booking-${r.id}`} className={`booking-bar kind-${r.kind} ${conflict ? 'conflict' : r.fitStatus === 'violation' ? 'fit-violation' : ''} ${r.startDate < clipped.startDate ? 'continues-before' : ''} ${r.endDate > clipped.endDate ? 'continues-after' : ''} ${focus === r.id ? 'focused-booking' : ''}`} style={{ gridColumn: `${start} / ${end + 1}`, gridRow: lane + 1 }} onClick={() => showBooking(r.id)} aria-label={`${bookingName(r)} at ${berth.name}, ${rangeLabel(r.startDate, r.endDate)}${conflict ? ', unresolved schedule conflict' : ''}${r.fitStatus === 'violation' ? ', vessel too long for berth' : ''}`} title={`${bookingName(r)} · ${rangeLabel(r.startDate, r.endDate)} · ${r.vessel?.lengthFt ? `${r.vessel.lengthFt} ft` : 'Length unknown'} · ${r.fitStatus}${r.sourceRef ? ` · ${r.sourceRef}` : ''}`}><span>{conflict && <span className="bar-warning">△ </span>}{bookingName(r)}</span>{end - start > 6 && r.vessel?.lengthFt && <small>{r.vessel.lengthFt} ft</small>}</button>;
          })}</div>
        </div></div></div>;
    })}
  </div></div>;
}
