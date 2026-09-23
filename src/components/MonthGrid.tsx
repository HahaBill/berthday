import { useState, type CSSProperties } from 'react';
import type { BerthDTO, ReservationDTO } from '../../shared/types';
import { daysInMonth, monthEnd, monthStart } from '../../shared/dates';
import { bookingName, rangeLabel } from '../api';
import { useApp } from '../context';
import Icon from './Icon';
import LengthGauge from './LengthGauge';

export default function MonthGrid({ month, reservations, berths, focus }: { month: string; reservations: ReservationDTO[]; berths: BerthDTO[]; focus: string | null }) {
  const { showBooking, newBooking, selectedLength } = useApp();
  const [selection, setSelection] = useState<{ berthId: string; start: number; end: number } | null>(null);
  const days = Array.from({ length: daysInMonth(month) }, (_, i) => i + 1);
  const date = (day: number) => `${month}-${String(day).padStart(2, '0')}`;
  const weekend = (day: number) => [0, 6].includes(new Date(`${date(day)}T12:00:00Z`).getUTCDay());
  const visible = berths.filter(b => b.id !== 'unassigned' || reservations.some(r => r.berthId === b.id));
  const finishSelection = () => { if (selection) { newBooking({ berthId: selection.berthId, startDate: date(Math.min(selection.start, selection.end)), endDate: date(Math.max(selection.start, selection.end)) }); setSelection(null); } };
  return <div className="grid-scroll"><div className="month-grid" style={{ '--days': days.length } as CSSProperties} onPointerLeave={() => setSelection(null)} onPointerCancel={() => setSelection(null)}>
    <div className="grid-heading"><div className="berth-column-heading">Berth <span>Length / ft</span></div><div className="day-columns">{days.map(day => <div className={`day-heading ${weekend(day) ? 'weekend' : ''}`} key={day}><span>{new Intl.DateTimeFormat('en-US', { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(`${date(day)}T12:00:00Z`))}</span><strong>{day}</strong></div>)}</div></div>
    {visible.map((berth, index) => {
      const rows = reservations.filter(r => r.berthId === berth.id).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
      const lanes: string[] = [];
      const placed = rows.map(r => { let lane = lanes.findIndex(end => end < r.startDate); if (lane < 0) lane = lanes.length; lanes[lane] = r.endDate; return { r, lane }; });
      const height = Math.max(84, lanes.length * 35 + 28);
      return <div key={berth.id}>{!berth.isExclusive && (index === 0 || visible[index - 1].isExclusive) && <div className="pool-divider"><Icon name="anchor" size={13}/>Shared resources<span>Multiple bookings allowed</span></div>}<div className={`berth-grid-row ${selectedLength && berth.lengthFt && selectedLength > berth.lengthFt ? 'dimmed' : ''}`} style={{ height }}>
        <div className="berth-heading"><div className="berth-title"><span>{berth.name === 'Small craft slips (institution boats)' ? 'Small craft slips' : berth.name}</span>{berth.lengthFt ? <strong>{berth.lengthFt}<small> ft</small></strong> : <span className="pool-chip">{berth.id === 'unassigned' ? 'Review' : 'Shared'}</span>}</div><LengthGauge length={berth.lengthFt} marker={selectedLength}/>{!berth.isExclusive && <small>{berth.id === 'small-craft-slips' ? 'Institution boats' : berth.id === 'unassigned' ? 'Legacy rows without a berth' : 'No fixed vessel length'}</small>}</div>
        <div className="berth-days"><div className="cell-background day-columns">{days.map(day => <button key={day} disabled={berth.id === 'unassigned'} className={`day-cell ${weekend(day) ? 'weekend' : ''} ${selection?.berthId === berth.id && day >= Math.min(selection.start, selection.end) && day <= Math.max(selection.start, selection.end) ? 'selected-cell' : ''}`} aria-label={berth.id === 'unassigned' ? `Unassigned legacy row, ${date(day)}` : `New booking at ${berth.name}, ${date(day)}`} onPointerDown={e => { if (e.button === 0) setSelection({ berthId: berth.id, start: day, end: day }); }} onPointerEnter={() => { if (selection?.berthId === berth.id) setSelection({ ...selection, end: day }); }} onPointerUp={finishSelection} onClick={e => { if (e.detail === 0) newBooking({ berthId: berth.id, startDate: date(day), endDate: date(day) }); }}><span>+</span></button>)}</div>
          <div className="booking-lanes" style={{ gridTemplateRows: `repeat(${Math.max(1, lanes.length)}, 29px)` }}>{placed.map(({ r, lane }) => {
            const conflict = r.issues.some(i => !i.reviewed && i.type !== 'fit');
            const start = r.startDate < monthStart(month) ? 1 : Number(r.startDate.slice(-2));
            const end = r.endDate > monthEnd(month) ? days.length : Number(r.endDate.slice(-2));
            return <button key={r.id} id={`booking-${r.id}`} className={`booking-bar kind-${r.kind} ${conflict ? 'conflict' : r.fitStatus === 'violation' ? 'fit-violation' : ''} ${r.startDate < monthStart(month) ? 'continues-before' : ''} ${r.endDate > monthEnd(month) ? 'continues-after' : ''} ${focus === r.id ? 'focused-booking' : ''}`} style={{ gridColumn: `${start} / ${end + 1}`, gridRow: lane + 1 }} onClick={() => showBooking(r.id)} title={`${bookingName(r)} · ${rangeLabel(r.startDate, r.endDate)} · ${r.vessel?.lengthFt ? `${r.vessel.lengthFt} ft` : 'Length unknown'} · ${r.fitStatus}${r.sourceRef ? ` · ${r.sourceRef}` : ''}`}><span>{conflict && <span className="bar-warning">△ </span>}{bookingName(r)}</span>{end - start > 6 && r.vessel?.lengthFt && <small>{r.vessel.lengthFt} ft</small>}</button>;
          })}</div>
        </div></div></div>;
    })}
  </div></div>;
}
